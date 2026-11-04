import type { AppSpecV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { appNamespace, dbInstanceName, moduleRefOf } from "../common/base.js";
import { AdapterError } from "../common/errors.js";
import { boundedName } from "../common/names.js";
import type { RunnerResource, ResourceState } from "../common/runner.js";
import { envRef, fromOut, nameSeed, migrationSeed, regionOf, tenantOf, type Target } from "../common/target.js";
import { azureMockAdapter } from "../azure-mock/index.js";
import { fakeUuid, MOCK_SUBSCRIPTION, resourceGroupOf } from "../azure-mock/ids.js";
import { asV1Name, assertRenderable, identitiesOf, K8S_RENDER_CAPS, postgresOf, UNSUPPORTED_V2 } from "./shared.js";
import { cacheVars, cachesOf, objectStoreVars, objectStoresOf, queueVars, queuesOf } from "./data.js";
import { secretStoreName } from "./capability-checks.js";
import { buildWorkloadValues } from "./cloud.js";

// TA10 (설계 27번 A10): Azure Mock 도착 Builder v2 = capability 표 + mock plan 만. 아키텍처 전제: Azure 는 모양 + Mock, apply 안 함.
// DRAFT(ai): Azure 엔 v2 고정 루트(azure/root·kinds)가 없다 → v1 통짜 모듈 infra/modules/azure/app 변수를 v2 명세에서 만든다
//   (validate 만 하는 모듈이라 루트를 새로 짜지 않음). 그래서 v1 모듈이 담을 수 있는 모양만 받는다:
//   신원 1개(serviceAccount 하나) · postgres 0~1개. 그 밖은 capability 로 막는다(UNSUPPORTED_V2)

// 이 Builder 가 그릴 수 있는 것. "mock" 은 화면 배지(실자원 아님)
// TA12 STUB: 데이터 자원은 Mock 이라 "모양만" 그린다 (Azure Cache·Storage·Service Bus 이름·ARM id 를 결정적으로). 진짜 모듈 없음 — Azure 는 어댑터 모양과 Mock 만 (CLAUDE.md 0-1)
// A8: 권한은 가짜 (역할 할당 모양만, resourceTypesV2). precheck warn
// TA12c: link.* = 데이터 자원 링크의 의도 요약 (실제 권한은 grants 로 그림)
const CAPS = [...K8S_RENDER_CAPS, "volume.pvc", "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "mock", "kind.cache.redis", "kind.cache.valkey", "kind.cache.cluster", "kind.objectStore", "kind.queue", "render.grants", "posture.permissions", "kind.queue.dlqMixedOrder", "kind.cache.auth", "link.read", "link.write", "link.readwrite", "link.admin"];

// v1 통짜 모듈이 담지 못하는 모양 → UNSUPPORTED_V2 (capability 표 밖과 같은 오류)
// E2E-v5: precheck(v2PrecheckItems)도 같은 검사를 불러 계획 단계 failed 대신 block(명세 검토로 되돌림)으로 먼저 알린다
export function azureShapeBlockers(spec: AppSpecV2): string[] {
  const ids = identitiesOf(spec);
  return ids.length > 1 ? [`도착 렌더 미지원: azure_mock 은 신원 1개만 (serviceAccount ${ids.map((i) => i.serviceAccount).join(",")})`] : [];
}
function assertAzureShape(spec: AppSpecV2): void {
  assertRenderable(spec, CAPS);
  const [why] = azureShapeBlockers(spec);
  if (why) throw new AdapterError(UNSUPPORTED_V2, why);
}

// v1 resourceTypes 와 같은 종류 (Key Vault·신원·연합 자격 + DB 있으면 Flexible Server·DB)
export function resourceTypesV2(spec: AppSpecV2): string[] {
  const t = ["azurerm_key_vault", "azurerm_user_assigned_identity", "azurerm_federated_identity_credential"];
  if (postgresOf(spec).length) t.push("azurerm_postgresql_flexible_server", "azurerm_postgresql_flexible_server_database");
  if (cachesOf(spec).length) t.push("azurerm_redis_cache");
  if (objectStoresOf(spec).length) t.push("azurerm_storage_account");
  const qs = queuesOf(spec);
  if (qs.length) t.push("azurerm_servicebus_namespace");
  if (qs.some((q) => q.props.model === "queue")) t.push("azurerm_servicebus_queue");
  if (qs.some((q) => q.props.model === "topic")) t.push("azurerm_servicebus_topic");
  return t.sort();
}

const DATA_MOCK_TYPES = new Set(["azurerm_redis_cache", "azurerm_storage_account", "azurerm_servicebus_namespace", "azurerm_servicebus_queue", "azurerm_servicebus_topic"]);
// 데이터 자원 이름 (data.ts 와 같은 규칙·같은 seed). Service Bus 네임스페이스는 앱 하나에 하나
export const sbNamespaceName = (spec: AppSpecV2, t: Target) => boundedName({ prefix: "sb", app: spec.app.name, seed: [nameSeed(t), spec.app.name, "servicebus", ...migrationSeed(t)], max: 50 });

const names = (spec: AppSpecV2, t: Target) => ({
  // Key Vault 이름은 전 세계 유일 3~24자 (v1 과 같은 규칙·같은 seed → 같은 이름)
  keyVault: boundedName({ prefix: "kv", app: spec.app.name, seed: [nameSeed(t), spec.app.name, ...migrationSeed(t)], max: 24 }),
  dbServer: dbInstanceName(asV1Name(spec), t, 63),
});

function toTerraformV2(spec: AppSpecV2, t: Target): TfRootCall {
  assertAzureShape(spec);
  const n = names(spec, t);
  const [pg] = postgresOf(spec);
  const ns = appNamespace(asV1Name(spec));
  const ident = identitiesOf(spec)[0];
  const ref = moduleRefOf("azure/app", t);
  return {
    root: ref,
    modules: [],   // 통짜 모듈 하나 (종류 모듈 없음)
    vars: {
      location: regionOf(t),
      app_name: spec.app.name,
      tenant_id: tenantOf(t),
      k8s_namespace: ns,
      aks_oidc_issuer_url: envRef("aksOidcIssuerUrl"),
      resource_group: envRef("resourceGroup"),
      delegated_subnet_id: envRef("delegatedSubnetId"),
      private_dns_zone_id: envRef("privateDnsZoneId"),
      azure_tenant_id: envRef("azureTenantId"),
      name_key_vault: n.keyVault,
      name_db_server: n.dbServer,
      db_enabled: Boolean(pg),
      db_version: pg?.props.majorVersion ?? "16",
      // DRAFT(ai): Flexible Server 최소 32GiB (v1 과 같은 올림)
      db_storage_mb: Math.max(32768, (pg?.props.storageGb ?? 32) * 1024),
      // 데이터 자원이 없으면 변수를 아예 안 넣음 (v1 통짜 모듈 변수와 같은 모양 유지)
      ...(cachesOf(spec).length ? { cache_json: cacheVars(spec, t) } : {}),
      ...(objectStoresOf(spec).length ? { object_store_json: objectStoreVars(spec, t) } : {}),
      ...(queuesOf(spec).length ? { queue_json: queueVars(spec, t) } : {}),
    },
    // 매트릭스 줄은 다른 클라우드와 같은 종류 이름. 모듈은 통짜 하나
    instances: [
      ...(pg ? [{ kind: "postgres" as const, id: pg.id, module: "azure/app" }] : []),
      ...(ident ? [{ kind: "identity" as const, id: ident.id, module: "azure/app" }] : []),
      ...cachesOf(spec).map((c) => ({ kind: "cache" as const, id: c.id, module: "azure/app" })),
      ...objectStoresOf(spec).map((c) => ({ kind: "objectStore" as const, id: c.id, module: "azure/app" })),
      ...queuesOf(spec).map((c) => ({ kind: "queue" as const, id: c.id, module: "azure/app" })),
      { kind: "namespace" as const, id: ns, module: "azure/app" },
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
  };
}

// infra/modules/azure/app 출력 3개와 같은 키 + v2 link_outputs 펼친 키(link.<id>.<출력>). 결정적 (v1 mockOutputs 와 같은 값)
export function mockOutputsV2(spec: AppSpecV2, t: Target): TfOutputs {
  const tf = toTerraformV2(spec, t);
  const out: TfOutputs = {
    app_identity_client_id: fakeUuid("identity", t.envId, spec.app.name),
    db_fqdn: tf.vars.db_enabled ? `${String(tf.vars.name_db_server)}.postgres.database.azure.com` : "",
    key_vault_uri: `https://${String(tf.vars.name_key_vault)}.vault.azure.net/`,
  };
  const [pg] = postgresOf(spec);
  if (pg) {
    out[`link.${pg.id}.host`] = out.db_fqdn!;
    out[`link.${pg.id}.port`] = "5432";
    out[`link.${pg.id}.reader`] = out.db_fqdn!;   // CNPG-RO: 읽기 복제본 없음 → 주 서버
    // v1 모듈은 비밀번호 없이 Entra(AAD) 인증만 → 접속 사용자 = 앱 관리 신원 id-<앱>. DB 이름 = 앱 이름의 - 를 _ 로 (모듈 규칙)
    out[`link.${pg.id}.user`] = `id-${spec.app.name}`;
    out[`link.${pg.id}.url`] = `postgresql://id-${spec.app.name}@${out.db_fqdn}:5432/${spec.app.name.replace(/-/g, "_")}`;
  }
  // TA12 STUB: 데이터 자원 link 출력 (모양만 실제 Azure 와 같게, 값은 이름에서 결정적으로)
  for (const [c, j] of cachesOf(spec).map((x, i) => [x, (JSON.parse(String(tf.vars.cache_json)) as Array<{ name: string }>)[i]!] as const)) {
    const host = `${j.name}.redis.cache.windows.net`;
    out[`link.${c.id}.host`] = host; out[`link.${c.id}.port`] = "6380"; out[`link.${c.id}.url`] = `rediss://${host}:6380`;
  }
  for (const [c, j] of objectStoresOf(spec).map((x, i) => [x, (JSON.parse(String(tf.vars.object_store_json)) as Array<{ name: string }>)[i]!] as const)) {
    out[`link.${c.id}.name`] = j.name; out[`link.${c.id}.url`] = `https://${j.name.replace(/[^a-z0-9]/g, "").slice(0, 24)}.blob.core.windows.net/${j.name}`;
  }
  for (const [c, j] of queuesOf(spec).map((x, i) => [x, (JSON.parse(String(tf.vars.queue_json)) as Array<{ name: string }>)[i]!] as const)) {
    out[`link.${c.id}.name`] = j.name; out[`link.${c.id}.url`] = `sb://${sbNamespaceName(spec, t)}.servicebus.windows.net/${j.name}`;
  }
  return out;
}

// STUB: mock plan — 실행기를 부르지 않고 "진짜 Terraform plan 이면 나왔을 자원 목록"을 결정적으로 만든다 (v1 Mock 실행기와 같은 ARM id 규칙)
export interface AzureMockPlanV2 {
  provider: "azure_mock"; mock: true; region: string;
  root: TfRootCall["root"]; vars: TfRootCall["vars"]; instances: TfRootCall["instances"];
  summary: { add: number; change: number; destroy: number };
  resources: RunnerResource[];
}
export function mockPlanV2(spec: AppSpecV2, t: Target, state: ResourceState = "Creating"): AzureMockPlanV2 {
  const tf = toTerraformV2(spec, t);
  const rg = resourceGroupOf(t.envId);
  const app = spec.app.name, db = String(tf.vars.name_db_server);
  const arm = (p: string, name: string) => `/subscriptions/${MOCK_SUBSCRIPTION}/resourceGroups/${rg}/providers/${p}/${name}`;
  const row: Record<string, [string, string]> = {
    azurerm_key_vault: ["Microsoft.KeyVault/vaults", String(tf.vars.name_key_vault)],
    azurerm_user_assigned_identity: ["Microsoft.ManagedIdentity/userAssignedIdentities", `id-${app}`],
    azurerm_federated_identity_credential: [`Microsoft.ManagedIdentity/userAssignedIdentities/id-${app}/federatedIdentityCredentials`, `fic-${app}`],
    azurerm_postgresql_flexible_server: ["Microsoft.DBforPostgreSQL/flexibleServers", db],
    azurerm_postgresql_flexible_server_database: [`Microsoft.DBforPostgreSQL/flexibleServers/${db}/databases`, app],
  };
  const resources = resourceTypesV2(spec).filter((type) => !DATA_MOCK_TYPES.has(type)).map((type) => {
    const [p, name] = row[type]!;
    return { type, name, id: arm(p, name), state };
  });
  // TA12 STUB: 데이터 자원은 컴포넌트마다 한 줄 (Service Bus 는 네임스페이스 1 + 큐·토픽)
  const nameOf = (json: unknown, i: number) => (JSON.parse(String(json)) as Array<{ name: string }>)[i]!.name;
  cachesOf(spec).forEach((_c, i) => { const n = nameOf(tf.vars.cache_json, i); resources.push({ type: "azurerm_redis_cache", name: n, id: arm("Microsoft.Cache/redis", n), state }); });
  objectStoresOf(spec).forEach((_c, i) => { const n = nameOf(tf.vars.object_store_json, i).replace(/[^a-z0-9]/g, "").slice(0, 24); resources.push({ type: "azurerm_storage_account", name: n, id: arm("Microsoft.Storage/storageAccounts", n), state }); });
  if (queuesOf(spec).length) { const sb = sbNamespaceName(spec, t); resources.push({ type: "azurerm_servicebus_namespace", name: sb, id: arm("Microsoft.ServiceBus/namespaces", sb), state });
    queuesOf(spec).forEach((q, i) => { const n = nameOf(tf.vars.queue_json, i); const topic = q.props.model === "topic";
      resources.push({ type: topic ? "azurerm_servicebus_topic" : "azurerm_servicebus_queue", name: n, id: arm(`Microsoft.ServiceBus/namespaces/${sb}/${topic ? "topics" : "queues"}`, n), state }); }); }
  resources.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { provider: "azure_mock", mock: true, region: regionOf(t), root: tf.root, vars: tf.vars, instances: tf.instances,
    summary: { add: resources.length, change: 0, destroy: 0 }, resources };
}

export const azureMockTarget: TargetBuilder = {
  provider: "azure_mock",
  version: "azure-mock-target@0.1.0",
  capabilities: () => [...CAPS].sort(),
  imageRef: (src, t) => azureMockAdapter.imageRef(src, t),
  operateActionsV2: () => [],   // Mock 이라 실행 권한 없음 (v1 과 같음)
  toTerraformV2,
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertAzureShape(spec);
    const [pg] = postgresOf(spec);
    const v = buildWorkloadValues(spec, out, t, {
      imageRef: (src) => azureMockAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: secretStoreName("azure_mock", out) },   // CL-4: env 출력 secret_store_name 이 있으면 그것
      // DRAFT(ai): Key Vault 비밀 이름은 영숫자·- 만 → 소문자·_ 를 - 로
      remoteKey: (s) => `${spec.app.name}-${s.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      saAnnotations: () => ({}),   // 아래에서 앱 SA 하나로 바꿔 씀
      postgres: pg ? [{ id: pg.id, mode: "external", host: fromOut(out, `link.${pg.id}.host`), port: 5432, passwordSecret: "db-password", secretName: `${spec.app.name}-${pg.id}-app` }] : [],
    }) as { workloads: Array<{ name: string; serviceAccount: { name: string } }>; warnings: string[] };
    // v1 모듈의 연합 자격 subject = system:serviceaccount:<ns>:<앱 이름> → k8s SA 이름을 앱 이름으로 맞춘다 (출발과 달라짐 줄)
    // DRAFT(ai): Mock 이라 진짜로 붙진 않지만 값 모양은 실제 Azure 와 같게. 출발 SA 그대로 쓰려면 azure/root(A10 다음)가 SA 이름 변수를 받아야 함
    const sa = { name: spec.app.name, create: true, annotations: { "azure.workload.identity/client-id": fromOut(out, "app_identity_client_id") } };
    for (const w of v.workloads) {
      if (w.serviceAccount.name !== spec.app.name) v.warnings.push(`${w.name}: 서비스 계정 ${w.serviceAccount.name} → ${spec.app.name} (Azure 연합 자격 규칙, 출발과 달라짐)`);
      w.serviceAccount = sa;
    }
    v.warnings = [...new Set(v.warnings)].sort();
    return v;
  },
};

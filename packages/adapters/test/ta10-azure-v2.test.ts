import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { AdapterError, azure, azureMockOutputsV2, azureMockPlanV2, azureResourceTypesV2, azureRunner, targetBuilderFor, UNSUPPORTED_V2, type Target } from "../src/index.js";
import { PINNED_AZURE_V1 } from "./pinned-azure-v1.js";

// TA10 (설계 27번 A10): Azure Mock Builder v2 — capability 표 + mock plan. v1 Mock 과 같은 이름·자원·출력이 나와야 한다
// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":2,"max":2},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[{"name":"DATABASE_PASSWORD","fromSecret":{"secret":"DATABASE_PASSWORD","key":"password"}}]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["shop.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const T = { envId: "33333333-3333-4333-8333-333333333333", provider: "azure_mock", region: "default", tenantId: "11111111-1111-4111-8111-111111111111",
  migrationId: "22222222-2222-4222-8222-222222222222" } as Target;
const b = targetBuilderFor("azure_mock");
const v2 = (): AppSpecV2 => structuredClone(BASE);

test("정상: upconvert 판 → v1 통짜 모듈 변수와 같은 값, mock plan 자원·출력도 v1 Mock 실행기와 같음", async () => {
  const a = PINNED_AZURE_V1.tf, tf = b.toTerraformV2(v2(), T);
  // G8-1: Key Vault 이름 seed 에 이전 번호가 붙어 v1 고정값과 이름만 다르다 (같은 회사 재이전도 안 겹침). 나머지는 같다
  const oldKv = String(a.vars.name_key_vault), newKv = String(tf.vars.name_key_vault);
  assert.notEqual(newKv, oldKv);
  assert.match(newKv, /^kvshop-[0-9a-f]{6}$/);
  const asV1 = <X>(x: X): X => JSON.parse(JSON.stringify(x).replaceAll(newKv, oldKv)) as X;
  assert.deepEqual(asV1(tf.vars), a.vars);
  assert.deepEqual(tf.root, a.moduleRef);
  assert.deepEqual(tf.modules, []);
  assert.deepEqual(tf.instances.map((i) => `${i.kind}:${i.id}:${i.module}`), ["identity:shop:azure/app", "namespace:app-shop:azure/app", "postgres:db:azure/app"]);
  const plan = azureMockPlanV2(v2(), T);
  const v1plan = PINNED_AZURE_V1.plan;
  assert.deepEqual(asV1(plan.resources), v1plan.resources);
  assert.deepEqual(plan.summary, v1plan.summary);
  assert.equal(plan.mock, true);
  assert.deepEqual(azureResourceTypesV2(v2()), PINNED_AZURE_V1.types);
  const out = azureMockOutputsV2(v2(), T), o1 = PINNED_AZURE_V1.outputs;
  for (const k of Object.keys(o1)) assert.equal(asV1(out[k]), o1[k], k);
  assert.equal(out["link.db.host"], o1.db_fqdn);
  assert.ok(b.capabilities().includes("mock"));
  assert.deepEqual(b.operateActionsV2(v2(), "apply"), []);
});

test("정상: 값 — Key Vault 저장소, SA 는 앱 이름(연합 자격 규칙) + 출발과 달라짐 경고, DB 주소는 mock 출력으로 채움", () => {
  const s = v2();
  const v = b.toWorkloadValues(s, azureMockOutputsV2(s, T), T) as Record<string, any>;
  assert.equal(v.externalSecrets.store.name, "azure-key-vault");
  const w = v.workloads[0];
  assert.deepEqual(w.serviceAccount, { name: "shop", create: true, annotations: { "azure.workload.identity/client-id": azureMockOutputsV2(s, T).app_identity_client_id } });
  assert.match(v.warnings.join(), /default → shop/);
  assert.equal(v.postgres[0].host, azureMockOutputsV2(s, T).db_fqdn);
  // 결정성
  assert.deepEqual(b.toWorkloadValues(s, {}, T), b.toWorkloadValues(v2(), {}, T));
  assert.deepEqual(azureMockPlanV2(s, T), azureMockPlanV2(v2(), T));
});

test("거부: 신원 2개·DB 2개·cache 는 UNSUPPORTED_V2 (v1 통짜 모듈이 못 담음). permissions 는 A8 부터 가짜로 받음", () => {
  const two = v2();
  two.components.push({ ...structuredClone(two.components[0]!), id: "worker", props: { ...structuredClone((two.components[0] as any).props), serviceAccount: "worker" } } as never);
  const db2 = v2(); db2.components.push({ id: "db2", kind: "postgres", props: { majorVersion: "16", storageGb: 20 } });
  const cache = v2(); cache.components.push({ id: "c", kind: "cache", props: { engine: "memcached", memoryMiB: 256, tls: true, auth: true } });
  const perm = v2(); perm.posture.permissions.push({ subject: "shop", source: "iam:x", effect: "Allow", actions: ["*"], resources: ["*"], mode: "mirror" });
  for (const [name, s] of [["신원 2", two], ["DB 2", db2], ["cache", cache]] as const) {
    for (const f of [() => b.toTerraformV2(s, T), () => b.toWorkloadValues(s, {}, T), () => azureMockPlanV2(s, T)])
      assert.throws(f, (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2, name);
  }
  // A8: 권한은 가짜 (그리는 값 없음) → 막지 않고, 변수도 권한 없는 판과 같음
  assert.deepEqual(b.toTerraformV2(perm, T).vars, b.toTerraformV2(v2(), T).vars);
});

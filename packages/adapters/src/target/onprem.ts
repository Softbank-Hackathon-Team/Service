import type { AppSpecV2, ComponentV2, EnvVarV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { actionsFor, type PermTable } from "../common/actions.js";
import { appNamespace } from "../common/base.js";
import { hash6 } from "../common/names.js";
import { envRef, regionOf, tenantOf, type Target } from "../common/target.js";
import { onpremAdapter, PERMS as V1_PERMS } from "../onprem/index.js";
import { asV1Name, assertRenderable, compact, k8sResources, instancesOf, K8S_RENDER_CAPS, kindJson, postgresOf, refV2, secretNamesOf, workloadsOf } from "./shared.js";
import { secretStoreName } from "./capability-checks.js";
import { buildWorkloadValues } from "./cloud.js";
import { cachesOf } from "./data.js";
import { dbIdentityFor } from "./data-fit.js";
import { onpremSubstitutes, valkeyLine, VALKEY_IMAGES } from "./onprem-substitutes.js";

// DRAFT(ai): 온프레(k3s) 도착 Builder v2 (설계 27번 A1·A2b). 클라우드 IAM 없음, DB = 차트 CNPG (Terraform 아님).
//   루트 = infra/modules/onprem/root, 종류 = kinds/{namespace,netpol}. netpol 은 posture allow-all 이면 안 만듦(= mirror)

// v1 RBAC 표 + v2 가 더 쓰는 것 (CronJob)
const PERMS: PermTable = {
  ...V1_PERMS,
  "batch/cronjobs": { read: ["batch/cronjobs:get"], write: ["batch/cronjobs:create", "batch/cronjobs:patch"], remove: ["batch/cronjobs:delete"] },
};
// DRAFT(ai): 온프레 어댑터 설계 H-1: redis·valkey 캐시 = 차트 Valkey (Terraform 아님, onprem-substitutes.ts). 클러스터 모드는 단일 서버로 그리고 승인 항목에 적는다.
//   kind.cache.auth 는 안 준다: 값을 넣을 비밀 저장소 길이 정해지기 전까지 AUTH 출발은 v2Blockers 가 사람에게 묻는다.
// TODO(human): objectStore·queue 대체물을 실제로 그릴지 (설계 H-2·H-3). 정하기 전까지 capability 를 안 줘서
//   v2Blockers 가 "도착 렌더 미지원: kind.objectStore" 등으로 막는다 (조용히 빼먹지 않음). memcached 도 같다
// A8 STUB: 온프레엔 클라우드 IAM 이 없다 → 권한은 안 그리고(k8s ServiceAccount 만) precheck warn 으로 검토 표시
const CAPS = [...K8S_RENDER_CAPS, "volume.pvc", "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "kind.cache.redis", "kind.cache.valkey", "kind.cache.cluster", "db.cnpg", "render.grants", "posture.permissions"];

export function resourceTypesV2(spec: AppSpecV2): string[] {
  const r = new Set(["core/namespaces", "core/resourcequotas", "networking.k8s.io/networkpolicies", "core/serviceaccounts"]);
  const ws = workloadsOf(spec);
  if (ws.some((w) => w.kind === "service") || cachesOf(spec).length) ["apps/deployments", "core/services"].forEach((x) => r.add(x));
  if (ws.some((w) => w.kind === "job")) r.add("batch/cronjobs");
  if (ws.some((w) => secretNamesOf(w).length)) r.add("external-secrets.io/externalsecrets");
  if (postgresOf(spec).length) r.add("postgresql.cnpg.io/clusters");
  return [...r].sort();
}

// CNPG Cluster 이름 = <앱>-<id> (id 가 "db" 면 v1 <앱>-db 그대로). 접속 서비스 = <cluster>-rw, 비밀 = <cluster>-app
// VTA1: 50자 넘으면 앞 43자 + 해시6 (CNPG Pod 이름 접미어·접속 서비스 -rw 로 63자를 안 넘게). 짧으면 v1 이름 그대로
export const cnpgName = (spec: AppSpecV2, id: string) => {
  const base = `${spec.app.name}-${id}`;
  return base.length <= 50 ? base : `${base.slice(0, 43).replace(/-+$/, "")}-${hash6(spec.app.name, id)}`;
};
// Valkey 이름 규칙은 CNPG 와 같다. CNPG 가 만드는 Service(<cluster>-rw·-ro·-r)와 겹치면 해시를 붙인다 (예: postgres db + 캐시 db-rw)
// 포트 = 출발 포트 그대로 (Valkey 는 고를 수 있음). 서버가 평문이라 언제나 redis://
const valkeyName = (spec: AppSpecV2, id: string) => {
  const name = cnpgName(spec, id);
  const taken = postgresOf(spec).some((p) => ["rw", "ro", "r"].some((s) => `${cnpgName(spec, p.id)}-${s}` === name));
  return taken ? `${name}-${hash6(spec.app.name, id)}` : name;
};
const cachePort = (c: Extract<ComponentV2, { kind: "cache" }>) => c.props.port ?? 6379;
const dataLink = (spec: AppSpecV2) => (c: ComponentV2, output: string): string | undefined => {
  if (c.kind === "cache") {
    const host = valkeyName(spec, c.id), port = cachePort(c);
    return ({ host, port: String(port), url: `redis://${host}:${port}` } as Record<string, string>)[output];
  }
  if (c.kind !== "postgres") return undefined;
  const host = `${cnpgName(spec, c.id)}-rw`;
  // DBN-1·E10-2: initdb 소유자·DB = IR 앱 계정·DB 이름 (클라우드 도착과 같은 규칙 dbIdentityFor). 못 읽으면 app·<앱>_ + 사전 점검 경고
  const { db, user } = dbIdentityFor(spec, c);
  // CNPG-RO: 읽기 전용 = CNPG 가 만드는 <cluster>-ro Service (대기·복제본이 없으면 주 서버로 감)
  return ({ host, reader: `${cnpgName(spec, c.id)}-ro`, port: "5432", user, url: `postgresql://${user}@${host}:5432/${db}` } as Record<string, string>)[output];
};

// 할당량 = Σ(요청량 × 최대 레플리카 × 2) + DB 몫. 요청량이 하나라도 없으면 null (지어내지 않음)
//   DB 몫 = DB 마다 인스턴스 수 × 2 × (CNPG 에 그리는 요청량). 요청량은 아래 workloadValues 의 CNPG resources 와 같은 값
//   (IR compute, 없으면 차트 기본 500m·1Gi). 예전 고정값(DB 하나 1000m·2048Mi)은 기본값일 때와 같고,
//   출발 DB 크기를 가져오면(예: 2000m) initdb 파드가 "exceeded quota" 로 못 떴다 (2026-11-04 VM 실측)
const CNPG_DEFAULT_CPU_MILLI = 500, CNPG_DEFAULT_MEM_MIB = 1024;   // gitops/charts/app/templates/cnpg.yaml 기본값과 같게
const cnpgInstances = (c: ReturnType<typeof postgresOf>[number]) => 1 + (c.props.ha ? 1 : 0) + (c.props.readReplicas ?? 0);
// DRAFT(ai): Valkey 파드 크기. maxmemory = 출발 메모리, 파드 한도는 25% 여유 (넘치면 OOM). 출발 메모리를 못 읽으면 256Mi 에 maxmemory 없음
const VALKEY_CPU_MILLI = 100;
const valkeyMemMi = (c: ReturnType<typeof cachesOf>[number]) => (c.props.memoryMiB === null ? 256 : Math.ceil(c.props.memoryMiB * 1.25));
function quota(spec: AppSpecV2): { cpu: number | null; mem: number | null } {
  let cpu: number | null = 0, mem: number | null = 0;
  for (const w of workloadsOf(spec)) {
    const n = w.kind === "service" ? w.props.replicas.max : 1;
    const rq = w.props.resources.request;
    cpu = cpu === null || rq?.cpuMilli == null ? null : cpu + rq.cpuMilli * n * 2;
    mem = mem === null || rq?.memMiB == null ? null : mem + rq.memMiB * n * 2;
  }
  let dbCpu = 0, dbMem = 0;
  for (const c of postgresOf(spec)) {
    const n = cnpgInstances(c) * 2;
    dbCpu += (c.props.compute?.cpuMilli ?? CNPG_DEFAULT_CPU_MILLI) * n;
    dbMem += (c.props.compute?.memMiB ?? CNPG_DEFAULT_MEM_MIB) * n;
  }
  for (const c of cachesOf(spec)) {
    dbCpu += VALKEY_CPU_MILLI * 2;
    dbMem += valkeyMemMi(c) * 2;
  }
  return { cpu: cpu === null ? null : cpu + dbCpu, mem: mem === null ? null : mem + dbMem };
}

// W3: 온프레 바닥(할당량)을 git 으로. 차트 floor.yaml 이 floor.enabled == "1" 일 때만 ResourceQuota(platform-quota, Terraform 과 같은 이름·값)를 그린다
//   켜기는 배포 때 워커 envFacts 의 onpremFloorViaGit (ONPREM_FLOOR_VIA_GIT=1). 켜면 apply 가 온프레 Terraform 을 건너뛴다 (워커가 클러스터에 안 들어감)
//   네임스페이스는 고객 Argo CD 가 CreateNamespace + managed-by=platform 라벨로 만든다 (deploy/helm/onprem-agent ApplicationSet)
//   NetworkPolicy 는 더하지 않는다: 지금 규칙은 "정책 0개 = 출발처럼 열림"(toTerraformV2 netpol_json) 이고, 기본 차단은 팀 결정이다
function floorValues(spec: AppSpecV2) {
  const q = quota(spec);
  return { enabled: envRef("onpremFloorViaGit"), quota: compact({ cpuMilli: q.cpu ?? undefined, memoryMi: q.mem ?? undefined }) };
}
// W3: 바닥을 git 으로 할 때 apply 가 Terraform 대신 내는 출력. onprem/root 모듈 출력과 같은 모양 (맵 출력은 JSON 글자, plan-v2 flattenTfOutputsV2)
export function onpremGitFloorOutputs(spec: AppSpecV2): TfOutputs {
  return { link_outputs: "{}", namespace: appNamespace(asV1Name(spec)) };
}

export const onpremTarget: TargetBuilder = {
  provider: "onprem",
  version: "onprem-target@0.1.0",
  capabilities: () => [...CAPS].sort(),
  imageRef: (src, t) => onpremAdapter.imageRef(src, t),
  operateActionsV2: (spec, purpose) => actionsFor(PERMS, resourceTypesV2(spec), purpose),
  substitutionsV2: onpremSubstitutes,
  toTerraformV2(spec: AppSpecV2, t: Target): TfRootCall {
    assertRenderable(spec, CAPS);
    const ns = appNamespace(asV1Name(spec));
    const q = quota(spec);
    const instances = instancesOf("onprem", [{ kind: "namespace", id: ns }]);
    return {
      root: refV2("onprem/root", t),
      modules: [refV2("onprem/kinds/namespace", t)],
      vars: {
        kube_context: regionOf(t) === "local" ? "k3s-onprem" : regionOf(t),
        app_name: spec.app.name,
        tenant_id: tenantOf(t),
        k8s_namespace: ns,
        namespace_json: kindJson("namespace", [{ name: ns, quota_cpu_m: q.cpu, quota_memory_mi: q.mem }]),
        // posture.networkPolicy(as-declared)는 capability 밖이라 여기 안 옴 → 정책 0개 = 출발처럼 다 열림
        netpol_json: kindJson("netpol", []),   // TF4-3: 계약(NetpolTfVars)을 거친다
      },
      instances,
    };
  },
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertRenderable(spec, CAPS);
    return { ...workloadValues(spec, out, t), floor: floorValues(spec) };
  },
};

// 온프레 DB 비밀번호 (온프레 영역 결정 2026-11-04): 온프레 도착에서는 앱이 CNPG 가 만든 <cluster>-app 비밀(키 password)로 DB 에 붙는다.
//   출발 비밀(예: shop-db-app)을 저장소에서 가져오면 그 값과 CNPG 가 만든 비밀번호가 달라 앱이 인증에 실패했다 (2026-11-04 VM 실측: 두 값 다름).
//   클라우드 도착의 같은 문제는 cloud.ts TODO(human) 그대로 둔다.
// DRAFT(ai): 바꿔 끼우는 줄 = 이 워크로드가 connect 링크로 이어진 postgres 가 정확히 하나이고, env 이름이 DB 비밀번호 꼴이며 fromSecret 인 줄.
//   그 밖(연결 주소 통째 비밀, envFrom 비밀, postgres 가 둘 이상)은 바꾸지 않고 계획서 경고로 사람에게 넘긴다
const DB_PASSWORD_ENV = /^(DB|DATABASE|POSTGRES|POSTGRESQL|PG)_?(PASS|PASSWORD|PASSWD)$/i;
const DB_URL_ENV = /^(DB|DATABASE|POSTGRES|POSTGRESQL|PG)_?(URL|URI|DSN)$/i;
export function useCnpgPasswords(spec: AppSpecV2): { spec: AppSpecV2; notes: string[]; cnpgSecrets: string[] } {
  const pgs = postgresOf(spec);
  const pgIds = new Set(pgs.map((c) => c.id));
  const cnpgSecrets = pgs.map((c) => `${cnpgName(spec, c.id)}-app`);
  const notes: string[] = [];
  const dbsOf = (id: string) => [...new Set(spec.links.filter((l) => l.from === id && typeof l.to === "string" && pgIds.has(l.to)).map((l) => l.to as string))];
  const components = spec.components.map((c) => {
    if (c.kind !== "service" && c.kind !== "job") return c;
    const dbs = dbsOf(c.id);
    const swap = (env: EnvVarV2[]): EnvVarV2[] => env.map((e) => {
      if (!("fromSecret" in e)) return e;
      if (DB_URL_ENV.test(e.name)) { notes.push(`온프레 DB 비밀번호: ${c.id} 의 ${e.name} 은 연결 주소 통째 비밀이라 바꾸지 않음 → CNPG 비밀(${cnpgSecrets.join(", ")})의 uri 로 바꿀지 사람이 확인`); return e; }
      if (!DB_PASSWORD_ENV.test(e.name)) return e;
      if (dbs.length !== 1) { notes.push(`온프레 DB 비밀번호: ${c.id} 의 ${e.name} 은 이어진 postgres 가 ${dbs.length}개라 어느 CNPG 비밀인지 못 정함 → 사람이 확인`); return e; }
      return { name: e.name, fromSecret: { secret: `${cnpgName(spec, dbs[0]!)}-app`, key: "password" } };
    });
    const p = c.props as { env: EnvVarV2[]; sidecars?: Array<{ env: EnvVarV2[] }>; initContainers?: Array<{ env: EnvVarV2[] }> };
    return { ...c, props: { ...c.props, env: swap(p.env),
      ...(p.sidecars ? { sidecars: p.sidecars.map((x) => ({ ...x, env: swap(x.env) })) } : {}),
      ...(p.initContainers ? { initContainers: p.initContainers.map((x) => ({ ...x, env: swap(x.env) })) } : {}) } } as ComponentV2;
  });
  return { spec: { ...spec, components }, notes: [...new Set(notes)].sort(), cnpgSecrets };
}

function workloadValues(spec0: AppSpecV2, out: TfOutputs, t: Target) {
    const { spec: spec, notes, cnpgSecrets } = useCnpgPasswords(spec0);
    const v = buildWorkloadValues(spec, out, t, {
      imageRef: (src) => onpremAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: secretStoreName("onprem", out) },   // CL-4: env 출력 secret_store_name 이 있으면 그것
      remoteKey: (s) => `${spec.app.name}-${s.toLowerCase().replace(/_/g, "-")}`,
      saAnnotations: () => ({}),
      postgres: postgresOf(spec).map((c) => compact({
        id: c.id, mode: "cnpg" as const, name: cnpgName(spec, c.id),
        // DRAFT(ai): instances = 주 1 + (ha 면 대기 1) + 읽기 복제본. 아무것도 없으면 1 (v1 과 같음)
        instances: cnpgInstances(c),
        majorVersion: c.props.majorVersion, storageGb: c.props.storageGb,
        ...(c.props.walStorageGb ? { walStorageGb: c.props.walStorageGb } : {}),   // DM-8 → 차트 cnpg.yaml walStorage (CNPG-V2)
        // CNPG-V2 DRAFT(ai): IR compute → CNPG resources (요청=한도, 출발 DB 크기 그대로). 없으면 차트 기본(500m·1Gi, 할당량 DB 몫 안)
        ...(c.props.compute && (c.props.compute.cpuMilli != null || c.props.compute.memMiB != null) ? { resources: {
          requests: { ...(c.props.compute.cpuMilli != null ? { cpu: `${c.props.compute.cpuMilli}m` } : {}), ...(c.props.compute.memMiB != null ? { memory: `${c.props.compute.memMiB}Mi` } : {}) },
          ...(c.props.compute.memMiB != null ? { limits: { memory: `${c.props.compute.memMiB}Mi` } } : {}) } } : {}),
        parameters: c.props.parameters,
        host: `${cnpgName(spec, c.id)}-rw`, port: 5432, passwordSecret: `${cnpgName(spec, c.id)}-app`,
        // DBN-1·E10-2: CNPG bootstrap.initdb 의 database·owner (차트 cnpg.yaml v2 갈래가 읽음, CNPG-V2)
        database: dbIdentityFor(spec, c).db, owner: dbIdentityFor(spec, c).user,
        // DRAFT(ai): 온프레 도착은 DB 를 언제나 논리 복제로 받는다 (리플랫폼 전제) → CNPG 마다 이전 전용 역할을 켠다.
        //   superuser 없음: 역할 = LOGIN REPLICATION CREATEROLE + pg_create_subscription + initdb 소유 역할 (차트 cnpg.yaml 머리 주석).
        //   비밀번호 비밀·서버 인증서(certificates)·터널(dbTunnel)·봉인 비밀(sealedSecrets)·validUntil·ensure 는 여기서 안 낸다.
        //   이전마다 다른 값이라 워커가 배포 값에 더한다 (계약 ChartPgReplication·ChartDbTunnel·ChartSealedSecret)
        replication: { enabled: true, role: "svc_migrate", passwordSecret: `${cnpgName(spec, c.id)}-migrate` },
      })),
      link: dataLink(spec),
    });
    const caches = cachesOf(spec);
    const dataServices = caches.map((c) => compact({
      id: c.id, kind: "valkey" as const, name: valkeyName(spec, c.id), image: VALKEY_IMAGES[valkeyLine(c)], port: cachePort(c),
      maxmemoryMi: c.props.memoryMiB ?? undefined,
      resources: { requests: { cpu: `${VALKEY_CPU_MILLI}m`, memory: `${valkeyMemMi(c)}Mi` }, limits: { memory: `${valkeyMemMi(c)}Mi` } },
    }));
    // CNPG 가 만드는 비밀은 저장소에서 가져오지 않는다 (ExternalSecret 이 같은 이름을 덮어쓰면 CNPG 와 다툰다)
    const vv = v as typeof v & { externalSecrets?: { secrets: Array<{ name: string }> }; warnings?: string[]; ingress?: { mode: string } };
    const es = vv.externalSecrets;
    // DRAFT(ai): 트래픽 판정 지표 (#245). 입구가 cloudflared 이고 이전 번호가 있으면 cloudflared 지표를 켜고 이 이전 표시를 붙인다.
    //   고객 클러스터 수집기(deploy/helm/onprem-agent metrics, 환경 토큰 하나)가 그 표시로 긁어 env=target·migration 라벨로 보낸다.
    //   이전 번호가 없으면(시험·상태 조회) 안 켠다: migration 라벨이 없는 지표는 게이트웨이가 버린다
    const ingress = vv.ingress?.mode === "cloudflared" && t.migrationId
      ? { ...vv.ingress, metrics: { migration: t.migrationId, env: "target" as const } } : vv.ingress;
    return { ...vv, ...(es ? { externalSecrets: { ...es, secrets: es.secrets.filter((x) => !cnpgSecrets.includes(x.name)) } } : {}),
      ...(ingress ? { ingress } : {}), ...(dataServices.length ? { dataServices } : {}),
      warnings: [...new Set([...(vv.warnings ?? []), ...notes])].sort() };
}


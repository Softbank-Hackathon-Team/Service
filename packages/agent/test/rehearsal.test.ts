import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { RehearsalResult, SandboxRunPhase, type RehearsalInput } from "@svc/contracts";
import {
  asHostKube, createVcluster, DEADLINE_RESERVE_MS, diagnose, leftoverRehearsal, loadVendorCrds, mockRehearsalResult, REHEARSAL_KINDS, runRehearsal, STAND_IN_LABEL, sweepSandboxes,
  type RehearsalBackend,
} from "../src/index.js";
import { fakeHelm, fakeHost, fakeVirtual } from "./fake-kube.js";

const CRDS = loadVendorCrds(fileURLToPath(new URL("../../../apps/agent-worker/vendor/crds", import.meta.url)));
const RUN = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const TENANT = "0a1b2c3d-4e5f-4061-8283-a4b5c6d7e8f9";
const NAME = "sbx-rehearsal-7a6b5c4d3e2f";
const REG = "reg.onprem.example/platform/t1";

interface Shape { web?: string; api?: string; job?: string; webPrivileged?: boolean; extraOriginal?: object[]; extraApply?: object[]; dbMajor?: string }
const deployment = (name: string, image: string, port: number, path: string, extra: object = {}) => ({
  apiVersion: "apps/v1", kind: "Deployment", metadata: { name },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: {
    serviceAccountName: `shop-${name}`,
    containers: [{ name, image, ports: [{ name: "http", containerPort: port }], readinessProbe: { httpGet: { path, port: "http" } },
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } }, ...extra }] } } },
});
const service = (name: string, app: string, port: number, targetPort: string | number) =>
  ({ apiVersion: "v1", kind: "Service", metadata: { name }, spec: { selector: { app }, ports: [{ port, targetPort }] } });
const job = (image: string) => ({ apiVersion: "batch/v1", kind: "Job", metadata: { name: "migrate" },
  spec: { template: { spec: { restartPolicy: "Never", containers: [{ name: "migrate", image }] } } } });

function sample(s: Shape = {}): RehearsalInput {
  const web = deployment("web", s.web ?? `${REG}/shop-web@sha256:cd`, 8080, "/healthz", s.webPrivileged ? { securityContext: { privileged: true } } : {});
  const api = deployment("api", s.api ?? `${REG}/shop-api@sha256:ab`, 3000, "/ready");
  const common = [{ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app-config" }, data: { "app.json": "{}" } },
    web, service("shop-web", "web", 80, "http"), api, service("shop-api", "api", 80, "http"), job(s.job ?? `${REG}/shop-api@sha256:ab`)];
  const original = [...common,
    { apiVersion: "external-secrets.io/v1", kind: "ExternalSecret", metadata: { name: "shop-secrets" },
      spec: { secretStoreRef: { kind: "ClusterSecretStore", name: "vault" }, target: { name: "shop-secrets" }, data: [{ secretKey: "JWT_SECRET", remoteRef: { key: "jwt" } }] } },
    { apiVersion: "postgresql.cnpg.io/v1", kind: "Cluster", metadata: { name: "shop-db" },
      spec: { instances: 1, imageName: "ghcr.io/cloudnative-pg/postgresql:16", storage: { size: "20Gi" }, bootstrap: { initdb: { database: "shop", owner: "app" } } } },
    ...(s.extraOriginal ?? [])];
  // 워커 치환본 모양: CNPG Cluster → Secret <cluster>-app 만 (Postgres 객체는 없다. databases[] 로 agent-worker 가 만든다)
  const apply = [...common,
    { apiVersion: "v1", kind: "Secret", metadata: { name: "shop-secrets" }, stringData: { JWT_SECRET: "fake" } },
    { apiVersion: "v1", kind: "Secret", metadata: { name: "shop-db-app" }, stringData: { password: "fake", username: "app" } },
    ...(s.extraApply ?? [])];
  const toDocs = (xs: object[]) => [{ path: "manifests/app.yaml", yaml: xs.map((x) => stringify(x)).join("---\n") }];
  return {
    version: 1, target: "onprem-k3s", app: "shop", namespace: "app-shop", bundleSha256: "b".repeat(64), k8sMinor: "1.35",
    original: toDocs(original), apply: toDocs(apply),
    images: [{ ref: `${REG}/shop-web@sha256:cd`, sandboxRef: "ecr.example/sandbox/t1/shop-web@sha256:cd" }], imagesMirrored: true, runBudgetSec: 1200,
    databases: [{ service: "shop-db-rw", majorVersion: s.dbMajor ?? "16", database: "shop", owner: "app", secretName: "shop-db-app", secretKeys: ["password", "username"] }],
    targetPodSecurity: "baseline", targetQuota: null,
    edges: [{ from: "web", host: "shop-api", port: 80 }, { from: "api", host: "shop-db-rw", port: 5432 }],
    fidelity: { version: 1, target: "onprem-k3s", bundleSha256: "b".repeat(64), items: [
      { id: "manifests", status: "identical", real: "렌더 결과", sandbox: "같은 바이트", reason: "지문", refs: [] },
      { id: "database", status: "substituted", real: "CNPG Cluster shop-db", sandbox: "Postgres 16 emptyDir", reason: "결정(리드)", refs: ["Cluster/shop-db"] },
    ] },
  };
}

const T0 = 1_800_000_000_000;
function backend(o: { virtual?: Parameters<typeof fakeVirtual>[0]; helm?: Parameters<typeof fakeHelm>[1]; seed?: Parameters<typeof fakeHost>[0];
  failDelete?: string[]; allocatable?: RehearsalBackend["allocatable"] } = {}) {
  let t = T0;
  const now = () => t;
  const sleep = async (ms: number) => { t += ms; };
  const host = fakeHost(o.seed);
  for (const n of o.failDelete ?? []) host.failDelete.add(n);
  const helm = fakeHelm(host, o.helm);
  const virtual = fakeVirtual({ warning: 'would violate PodSecurity "restricted:latest": allowPrivilegeEscalation != false', ...o.virtual });
  const h = { kube: asHostKube(host.kube), helm, chart: "/app/vendor/vcluster-0.37.6.tgz", workDir: mkdtempSync(join(tmpdir(), "rh-")),
    connect: () => virtual.kube, now, sleep };
  const phases: string[] = [];
  const b: RehearsalBackend = {
    create: (spec) => createVcluster(h, spec), sweepLeftovers: (keep) => sweepSandboxes(h.kube, leftoverRehearsal(keep)),
    crds: CRDS, ttlSec: 1800, now, sleep, allocatable: o.allocatable,
  };
  return { b, host, helm, virtual, phases, elapsed: () => t - T0,
    run: (input: RehearsalInput, deadlineAt?: Date) => runRehearsal(input, { id: RUN, tenantId: TENANT, deadlineAt, onPhase: (p) => { phases.push(p); } }, b) };
}

test("리허설 통과: 만들기 → dry-run → 도착 정책 → DB 대체물 먼저 → 롤아웃·잡 → 재시작 → 준비 → 연결 → 지우기", async () => {
  const k = backend({ seed: [{ name: "sbx-rehearsal-deadrun00000", labels: { "platform.svc/sandbox": "true", "platform.svc/sandbox-purpose": "rehearsal", "platform.svc/expires-at": "9999999999" } }] });
  const r = await k.run(sample());
  assert.equal(r.verdict, "passed", JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.failureCode, null);
  assert.ok(RehearsalResult.safeParse(r).success);
  assert.deepEqual(k.phases, ["creating", "applying", "checking", "deleting"]);
  assert.deepEqual(r.sandbox, { podSecurity: "baseline", runtimeClass: null, name: NAME, hostNamespace: NAME, chart: "vcluster-0.37.6", k8sVersion: "v1.35.0", mock: false });
  assert.equal(r.deleted, true);
  assert.deepEqual([...k.host.namespaces.keys()], [], "남은 리허설과 이번 샌드박스 모두 지워짐");
  assert.match(r.checks.find((c) => c.id === "sandbox_ready")!.detail, /남은 것 1개 지움/);

  for (const id of ["apply", "rollout", "restarts", "ready"])
    assert.match(r.checks.find((c) => c.id === id && c.subject === "Deployment/shop-db-rw")!.detail, /샌드박스 DB 대체물/, `${id}: 대체물 줄이 고객 객체와 갈린다`);
  const ids = new Set(r.checks.map((c) => c.id));
  for (const id of ["unsupported_kind", "quota", "sandbox_ready", "dry_run", "target_policy", "apply", "rollout", "job_complete", "restarts", "ready", "service_http", "edge_http"])
    assert.ok(ids.has(id as never), `검사 ${id}`);
  assert.equal(r.checks.filter((c) => c.id === "dry_run").length, 8, "원본 8개 전부 dry-run");
  assert.deepEqual(r.checks.filter((c) => c.id === "edge_http").map((c) => [c.subject, c.ok]), [["web→shop-api:80", true], ["api→shop-db-rw:5432", true]]);
  assert.ok(r.checks.filter((c) => c.required).every((c) => c.ok));

  const applies = k.virtual.requests.filter((x) => x.startsWith("PATCH") && !x.includes("dryRun") && x.includes("/deployments/"));
  assert.ok(applies.findIndex((x) => x.includes("/shop-db-rw?")) >= 0, "DB 대체물을 적용");
  assert.ok(applies.findIndex((x) => x.includes("/shop-db-rw?")) < applies.findIndex((x) => x.includes("/web?")), "DB 대체물을 먼저 적용");
  assert.deepEqual(k.helm.values[0].sync.toHost.pods.translateImage, { [`${REG}/shop-web@sha256:cd`]: "ecr.example/sandbox/t1/shop-web@sha256:cd" });
  assert.equal(k.virtual.namespaces.get("app-shop")?.["pod-security.kubernetes.io/enforce"], "baseline");
  assert.ok(r.warnings.some((w) => /restricted/.test(w)), "PSA warn 경고를 모은다");

  const f = new Map(r.fidelity.items.map((i) => [i.id, i]));
  assert.equal(f.get("database")?.status, "substituted", "워커 몫은 그대로");
  assert.equal(f.get("sandbox_pod_security")?.status, "identical", "온프레 도착 baseline = 리허설 baseline");
  assert.equal(f.get("runtime_isolation")?.status, "substituted");
});

// 관리형 DB (EKS RDS · GKE Cloud SQL): 워커가 앱의 DB 주소를 sbx-db-<id>.<ns>.svc.cluster.local 로 바꾸고, 비밀은 앱이 원래 읽던 것
function managed(): RehearsalInput {
  const base = sample({ extraApply: [{ apiVersion: "v1", kind: "Secret", metadata: { name: "orders-db" }, stringData: { password: "fake" } }] });
  return {
    ...base, target: "aws-eks", targetPodSecurity: "privileged", edges: [{ from: "web", host: "shop-api", port: 80 }],
    databases: [{ service: "sbx-db-orders", majorVersion: "17", database: "orders", owner: "orders_app", secretName: "orders-db", secretKeys: ["password"] }],
    fidelity: { ...base.fidelity, target: "aws-eks" },
  };
}

test("DB 대체물: databases[] 한 줄마다 공식 Postgres(메이저 태그@다이제스트) Deployment + 같은 이름 Service 5432, trust, emptyDir, 플랫폼 라벨", async () => {
  for (const [input, svc, major, db, owner] of [[sample(), "shop-db-rw", "16", "shop", "app"], [managed(), "sbx-db-orders", "17", "orders", "orders_app"]] as const) {
    const k = backend();
    const r = await k.run(input);
    assert.equal(r.verdict, "passed", JSON.stringify(r.checks.filter((c) => !c.ok)));
    const dep = k.virtual.objects.get(`app-shop/deployments/${svc}`);
    const svcObj = k.virtual.objects.get(`app-shop/services/${svc}`);
    assert.ok(dep && svcObj, `${svc}: Deployment·Service 를 만들었다`);
    const pod = dep.spec.template;
    const c = pod.spec.containers[0];
    assert.match(c.image, new RegExp(`^docker\\.io/library/postgres:${major}@sha256:[0-9a-f]{64}$`));
    const env = Object.fromEntries(c.env.map((e: any) => [e.name, e.value]));
    assert.deepEqual([env.POSTGRES_DB, env.POSTGRES_USER, env.POSTGRES_HOST_AUTH_METHOD], [db, owner, "trust"]);
    assert.ok(env.PGDATA.startsWith(c.volumeMounts[0].mountPath + "/"), "PGDATA 는 붙인 볼륨 아래");
    assert.deepEqual(pod.spec.volumes, [{ name: c.volumeMounts[0].name, emptyDir: {} }], "PGDATA 는 emptyDir");
    assert.ok(c.readinessProbe, "준비 검사가 있다");
    assert.ok(c.resources.requests.cpu && c.resources.requests.memory, "요청량이 적혀 있다");
    assert.deepEqual(svcObj.spec.ports.map((p: any) => p.port), [5432]);
    assert.deepEqual(svcObj.spec.selector, pod.metadata.labels, "Service 가 대체물 파드를 고른다");
    for (const o of [dep, pod, svcObj]) assert.equal(o.metadata.labels[STAND_IN_LABEL], svc, "플랫폼이 만든 객체 표시");
    // 도착 baseline·샌드박스 restricted 경고 어느 쪽에도 걸리지 않는 모양 (PSS restricted 필수 칸)
    assert.deepEqual([pod.spec.securityContext.runAsNonRoot, pod.spec.securityContext.seccompProfile.type, c.securityContext.allowPrivilegeEscalation, c.securityContext.capabilities.drop],
      [true, "RuntimeDefault", false, ["ALL"]]);
  }
});

test("실패는 정해진 코드로 끝나고, 샌드박스는 언제나 지운다", async () => {
  const policyEvent = { involvedObject: { kind: "ReplicaSet", name: "web-7d9c" }, reason: "FailedCreate",
    message: 'pods "web-7d9c-x" is forbidden: violates PodSecurity "baseline:latest": privileged' };
  const cases: Array<{ name: string; input: RehearsalInput; k?: Parameters<typeof backend>[0]; code: string; verdict: "failed" | "error"; created?: boolean; detail?: RegExp }> = [
    { name: "적용 거부", input: sample(), k: { virtual: { reject: (o, dry) => (!dry && o.metadata.name === "web" ? "admission webhook denied the request" : null) } }, code: "REHEARSAL_DRY_RUN_REJECTED", verdict: "failed" },
    { name: "원본 dry-run 거부", input: sample(), k: { virtual: { reject: (o, dry) => (dry && o.metadata.name === "api" ? 'Deployment.apps "api" is invalid: spec.template.spec.containers[0].ports[0].containerPort: Invalid value: 70000' : null) } }, code: "REHEARSAL_DRY_RUN_REJECTED", verdict: "failed" },
    { name: "롤아웃 시간 초과", input: sample({ web: `${REG}/shop-web-slow@sha256:cd` }), code: "REHEARSAL_ROLLOUT_FAILED", verdict: "failed" },
    { name: "컨테이너 설정 오류", input: sample({ web: `${REG}/shop-web-config-error@sha256:cd` }), code: "REHEARSAL_ROLLOUT_FAILED", verdict: "failed" },
    { name: "재시작 반복", input: sample({ api: `${REG}/shop-api-crash@sha256:ab` }), code: "REHEARSAL_CRASHLOOP", verdict: "failed" },
    { name: "연결 실패", input: sample(), k: { virtual: { unreachable: ["shop-api"] } }, code: "REHEARSAL_CONNECTIVITY_FAILED", verdict: "failed" },
    { name: "이미지 받기 실패", input: sample({ web: `${REG}/shop-web-pull-fail@sha256:cd` }), code: "REHEARSAL_IMAGE_MIRROR_FAILED", verdict: "error" },
    { name: "마이그레이션 잡 실패", input: sample({ job: `${REG}/shop-api-job-fail@sha256:ab` }), code: "REHEARSAL_JOB_FAILED", verdict: "failed" },
    { name: "샌드박스 파드 보안", input: sample({ web: `${REG}/shop-web-slow@sha256:cd` }), k: { virtual: { events: [policyEvent] } }, code: "REHEARSAL_POLICY_DENIED", verdict: "failed" },
    { name: "도착 파드 보안", input: sample({ webPrivileged: true }), code: "REHEARSAL_TARGET_POLICY_DENIED", verdict: "failed" },
    { name: "샌드박스 DB 대체물 고장", input: sample(), k: { virtual: { crash: ["shop-db-rw"] } }, code: "REHEARSAL_SANDBOX_UNAVAILABLE", verdict: "error" },
    { name: "DB 대체물이 없는 Postgres 판", input: sample({ dbMajor: "18" }), code: "REHEARSAL_UNSUPPORTED_KIND", verdict: "failed", created: false },
    { name: "DB 대체물 이름이 적용 묶음과 겹침", input: sample({ extraApply: [service("shop-db-rw", "api", 5432, 5432)] }), code: "REHEARSAL_UNSUPPORTED_KIND", verdict: "failed", created: false },
    { name: "helm 실패", input: sample(), k: { helm: { failInstall: "Error: deployments.apps is forbidden" } }, code: "REHEARSAL_SANDBOX_UNAVAILABLE", verdict: "error" },
    { name: "남은 리허설을 못 지움", input: sample(), k: { seed: [{ name: "sbx-rehearsal-stuck0000000", labels: { "platform.svc/sandbox": "true", "platform.svc/sandbox-purpose": "rehearsal", "platform.svc/expires-at": "9999999999" } }], failDelete: ["sbx-rehearsal-stuck0000000"] }, code: "REHEARSAL_SANDBOX_UNAVAILABLE", verdict: "error", created: false },
    { name: "노드 할당량 부족", input: sample(), k: { allocatable: { cpuM: 300, memoryMi: 3400 } }, code: "REHEARSAL_SANDBOX_UNAVAILABLE", verdict: "error", created: false },
    // 앱 300m + 검사 10m + 제어판 220m = 530m 은 들어가고, DB 대체물 50m 까지 580m 이면 안 들어간다
    { name: "DB 대체물 요청량도 센다", input: sample(), k: { allocatable: { cpuM: 560, memoryMi: 3400 } }, code: "REHEARSAL_SANDBOX_UNAVAILABLE", verdict: "error", created: false, detail: /CPU 580m/ },
    { name: "도착 한도 초과", input: { ...sample(), targetQuota: { basis: "limits", cpuM: null, memoryMi: 100 } }, code: "REHEARSAL_QUOTA_EXCEEDED", verdict: "failed", created: false },
    // 온프레 할당량은 requests 기준. 예시의 migrate 잡과 CNPG Cluster 는 요청량이 없어 도착 API 서버가 파드를 거부한다
    { name: "도착 할당량(requests)이 세는 칸이 빈 컨테이너", input: { ...sample(), targetQuota: { basis: "requests", cpuM: 100_000, memoryMi: null } }, code: "REHEARSAL_QUOTA_EXCEEDED", verdict: "failed", created: false,
      detail: /요청량 cpu 가 빈 컨테이너 Job\/migrate\/migrate, Cluster\/shop-db\/postgres \(도착 할당량 requests\.cpu 가 파드를 거부\)/ },
    { name: "지원 목록 밖 종류", input: sample({ extraOriginal: [{ apiVersion: "v1", kind: "Pod", metadata: { name: "debug" } }] }), code: "REHEARSAL_UNSUPPORTED_KIND", verdict: "failed", created: false },
    // 흉내 워커(MOCK_SANDBOX=1)는 이미지를 복사하지 않는다. 진짜 샌드박스가 고객 원본 주소로 받으러 가지 않게 만들기 전에 멈춘다
    { name: "이미지를 복사하지 않은 입력", input: { ...sample(), imagesMirrored: false }, code: "REHEARSAL_IMAGE_MIRROR_FAILED", verdict: "error", created: false },
  ];
  for (const c of cases) {
    const k = backend(c.k);
    const r = await k.run(c.input);
    assert.equal(r.failureCode, c.code, `${c.name}: ${JSON.stringify(r.checks.filter((x) => !x.ok))}`);
    assert.equal(r.verdict, c.verdict, c.name);
    assert.ok(RehearsalResult.safeParse(r).success, c.name);
    const installed = k.helm.calls.some((a) => a[0] === "upgrade");
    assert.equal(installed, c.created !== false, `${c.name}: helm 을 불렀나 (순수 검사에서 멈추면 안 부른다)`);
    assert.equal(k.host.namespaces.has(NAME), false, `${c.name}: 이번 샌드박스 네임스페이스가 남지 않음`);
    assert.equal(r.checks.filter((x) => x.required && !x.ok).length > 0, true, `${c.name}: 실패 줄이 보인다`);
    if (c.detail) assert.match(r.checks.find((x) => !x.ok)!.detail, c.detail, c.name);
  }
});

// 온프레 바닥 (ONPREM_FLOOR_VIA_GIT, gitops floor.yaml). 워커 치환이 바꾸지 않고 넘긴다
const FLOOR = { apiVersion: "v1", kind: "ResourceQuota", metadata: { name: "platform-quota" }, spec: { hard: { "requests.cpu": "4000m", "requests.memory": "8192Mi" } } };
const floored = (s: Shape = {}) => sample({ ...s, extraOriginal: [FLOOR], extraApply: [FLOOR] });
const applied = (k: ReturnType<typeof backend>) => k.virtual.requests.filter((x) => x.startsWith("PATCH") && !x.includes("dryRun=All"));

test("온프레 바닥 할당량: 묶음 ResourceQuota 를 가장 먼저 그대로 적용하고, 상태(status.hard)가 잡힌 뒤 DB 대체물·앱을 만든다", async () => {
  const k = backend();
  const r = await k.run(floored());
  assert.equal(r.verdict, "passed", JSON.stringify(r.checks.filter((c) => !c.ok)));
  const writes = applied(k).filter((x) => /\/namespaces\/app-shop\//.test(x));
  assert.match(writes[0]!, /\/resourcequotas\/platform-quota\?/, `첫 적용이 할당량: ${writes[0]}`);
  const synced = k.virtual.requests.findIndex((x) => x === "GET /api/v1/namespaces/app-shop/resourcequotas/platform-quota");
  const firstPodOwner = k.virtual.requests.findIndex((x) => x.startsWith("PATCH") && !x.includes("dryRun=All") && /\/(deployments|jobs)\//.test(x));
  assert.ok(synced >= 0 && synced < firstPodOwner, "할당량 상태를 확인한 뒤 파드를 만드는 객체를 적용");
  assert.deepEqual(k.virtual.objects.get("app-shop/resourcequotas/platform-quota")?.spec, FLOOR.spec, "바꾸지 않고 그대로");
  assert.ok(r.checks.some((c) => c.id === "apply" && c.subject === "ResourceQuota/platform-quota" && c.ok));
});

test("온프레 바닥 할당량: 상태가 안 잡히면 파드를 만들기 전에 우리 쪽 문제(REHEARSAL_SANDBOX_UNAVAILABLE)로 멈춘다", async () => {
  const k = backend({ virtual: { quotaStatus: false } });
  const r = await k.run(floored());
  assert.deepEqual([r.verdict, r.failureCode], ["error", "REHEARSAL_SANDBOX_UNAVAILABLE"], JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.match(r.checks.find((c) => !c.ok)!.detail, /status\.hard.*30초/);
  assert.equal(applied(k).some((x) => /\/(deployments|jobs)\//.test(x)), false, "파드를 만드는 객체는 적용하지 않음");
  assert.equal(r.deleted, true);
});

test("묶음 할당량이 파드를 거부하면(failed/exceeded quota: platform-quota) 도착도 거부한다: REHEARSAL_QUOTA_EXCEEDED, 롤아웃 기한을 안 기다림", async () => {
  const quotaEvent = { involvedObject: { kind: "ReplicaSet", name: "web-7d9c" }, reason: "FailedCreate",
    message: 'pods "web-7d9c-x" is forbidden: failed quota: platform-quota: must specify requests.cpu for: web' };
  const k = backend({ virtual: { events: [quotaEvent] } });
  const r = await k.run(floored({ web: `${REG}/shop-web-slow@sha256:cd` }));
  assert.deepEqual([r.verdict, r.failureCode], ["failed", "REHEARSAL_QUOTA_EXCEEDED"], JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(k.elapsed() < 60_000, `걸린 시간 ${k.elapsed()}ms`);
  assert.match(r.checks.find((c) => !c.ok)!.detail, /도착 할당량: .*must specify requests\.cpu/);

  // 같은 모양이어도 묶음에 없는 할당량(샌드박스 상한)이면 예전처럼 우리 쪽 문제로 본다
  const host = { ...quotaEvent, message: 'pods "web-7d9c-x" is forbidden: exceeded quota: vc-sbx-rehearsal-7a6b, requested: requests.cpu=100m' };
  assert.equal(diagnose({ pods: [], events: [host], quotas: ["platform-quota"] })?.code, "REHEARSAL_SANDBOX_UNAVAILABLE");
  assert.equal(diagnose({ pods: [], events: [quotaEvent], quotas: [] })?.code, undefined, "묶음 할당량이 없는 실행은 이 줄로 판정하지 않음");
});

test("재시작이 쌓이거나 컨테이너를 못 만들면 롤아웃 기한(300초)을 다 기다리지 않고 끝낸다", async () => {
  for (const [shape, code] of [[{ api: `${REG}/shop-api-crash@sha256:ab` }, "REHEARSAL_CRASHLOOP"], [{ web: `${REG}/shop-web-config-error@sha256:cd` }, "REHEARSAL_ROLLOUT_FAILED"]] as const) {
    const k = backend();
    const r = await k.run(sample(shape));
    assert.equal(r.failureCode, code);
    assert.ok(k.elapsed() < 60_000, `${code}: 걸린 시간 ${k.elapsed()}ms`);
    if (code === "REHEARSAL_CRASHLOOP") assert.ok(r.timingsMs.check > 0, `실패한 단계의 시간도 남긴다 ${JSON.stringify(r.timingsMs)}`);
  }
});

test("실행 기한: 기한 전에 스스로 멈춰(REHEARSAL_TIMEOUT) 지우고 결과를 낸다. 롤아웃 기한(300초)이 남아도 기다리지 않는다", async () => {
  const k = backend();
  const r = await k.run(sample({ web: `${REG}/shop-web-slow@sha256:cd` }), new Date(T0 + 200_000));
  assert.deepEqual([r.verdict, r.failureCode], ["error", "REHEARSAL_TIMEOUT"], JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(k.elapsed() <= 200_000 - DEADLINE_RESERVE_MS, `기한 ${DEADLINE_RESERVE_MS / 1000}초 전까지 멈춤: ${k.elapsed()}ms`);
  assert.equal(r.deleted, true);
  assert.equal(k.host.namespaces.has(NAME), false);
  assert.match(r.checks.find((c) => c.required && !c.ok)!.detail, /실행 기한/);
  // 기한이 넉넉하면 같은 입력이 롤아웃 기한까지 기다려 앱 쪽 코드로 끝난다
  assert.equal((await backend().run(sample({ web: `${REG}/shop-web-slow@sha256:cd` }), new Date(T0 + 3_600_000))).failureCode, "REHEARSAL_ROLLOUT_FAILED");
});

test("단계 목록 = 실제로 쓰는 단계 (실행기가 알리는 단계 + 끝난 줄의 done). 아무도 안 쓰는 값이 계약에 없다", async () => {
  const k = backend();
  await k.run(sample());
  assert.deepEqual(new Set([...k.phases, "done"]), new Set(SandboxRunPhase.options));
});

test("dry-run 전용 종류마다 이미지에 넣은 CRD 가 있다", () => {
  const vendored = new Set(CRDS.map((c) => `${c.spec.group}/${c.spec.names.kind}`));
  for (const [key, info] of Object.entries(REHEARSAL_KINDS)) {
    if (info.applies) continue;
    const [group, , kind] = key.split("/");
    assert.ok(vendored.has(`${group}/${kind}`), key);
  }
});

test("MOCK_SANDBOX 결과: 같은 입력이면 같은 결과, fail 이면 REHEARSAL_CRASHLOOP", () => {
  const input = sample();
  const pass = mockRehearsalResult(input, RUN, "pass");
  assert.deepEqual(mockRehearsalResult(input, RUN, "pass"), pass);
  assert.equal(pass.verdict, "passed");
  assert.equal(pass.sandbox.mock, true);
  assert.equal(pass.sandbox.name, NAME);
  const fail = mockRehearsalResult(input, RUN, "fail");
  assert.deepEqual([fail.verdict, fail.failureCode], ["failed", "REHEARSAL_CRASHLOOP"]);
  assert.equal(fail.checks.find((c) => !c.ok)?.subject, "Deployment/web");
  assert.ok(RehearsalResult.safeParse(fail).success);
});

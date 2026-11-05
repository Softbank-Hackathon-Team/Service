import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asHostKube, createVcluster, cpuMilli, expiredSandbox, helmRunner, KubeError, kubectlPortForward, leftoverRehearsal, memoryMi,
  originalUsage, parseManifests, sandboxQuotaPlan, sweepSandboxes, vclusterValues, type VclusterSpec,
} from "../src/index.js";
import { fakeHelm, fakeHost, fakeVirtual } from "./fake-kube.js";

const RUN = "0f1e2d3c-4b5a-4968-8776-655443322110";
const TENANT = "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4";
const spec = (o: Partial<VclusterSpec> = {}): VclusterSpec => ({
  kind: "rehearsal", runId: RUN, tenantId: TENANT, isolation: { podSecurity: "baseline", runtimeClass: null }, k8sMinor: "1.35",
  quota: { requests: { cpuM: 900, memoryMi: 1200 }, limitsMemoryMi: 3000, pods: 9, storageMi: 1024 },
  images: [{ ref: "reg.example/platform/t1/web@sha256:aa", sandboxRef: "ecr.example/sandbox/t1/web@sha256:aa" }], ttlSec: 1800, ...o,
});
const clock = () => { let t = 1_800_000_000_000; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

test("vCluster 만들기: 라벨 네임스페이스 → sbx-operator 묶기 → 나가기 기본 거부 → helm → 준비 → 지우기 (helm uninstall 뒤 네임스페이스)", async () => {
  const host = fakeHost();
  const helm = fakeHelm(host);
  const install = helm.run;
  let policiesAtInstall: unknown[] = [];
  helm.run = async (args) => { if (args[0] === "upgrade") policiesAtInstall = host.networkPolicies.map((p) => ({ ...p })); return install(args); };
  const virtual = fakeVirtual({ readyAfter: 3 });
  const seen: Array<{ url: string; cert?: string; token?: string }> = [];
  const c = clock();
  const vc = await createVcluster({
    kube: asHostKube(host.kube), helm, chart: "/app/vendor/vcluster-0.37.6.tgz", workDir: mkdtempSync(join(tmpdir(), "vc-")), ...c,
    connect: (url, cr) => { seen.push({ url, cert: cr.cert, token: cr.token }); return virtual.kube; },
  }, spec());

  assert.equal(vc.name, "sbx-rehearsal-0f1e2d3c4b5a");
  const labels = host.namespaces.get(vc.name)!;
  assert.equal(labels["platform.svc/sandbox"], "true");
  assert.equal(labels["platform.svc/sandbox-purpose"], "rehearsal");
  assert.match(labels["platform.svc/expires-at"]!, /^\d{10}$/);
  assert.equal(Number(labels["platform.svc/expires-at"]), 1_800_000_000 + 1800);
  assert.equal(labels["pod-security.kubernetes.io/enforce"], "baseline");
  assert.equal(labels["platform.svc/tenant"], TENANT, "회사 라벨 (호스트 이미지 가드 VAP 가 본다)");
  // 규칙 없는 Egress = 모든 나가기 거부. 파드가 하나라도 뜨기 전(helm 전)에 있어야 한다
  assert.deepEqual(policiesAtInstall, [{ namespace: vc.name, body: { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
    metadata: { name: "sbx-default-deny" }, spec: { podSelector: {}, policyTypes: ["Egress"] } } }]);
  const rb = host.rolebindings[0]!;
  assert.deepEqual([rb.namespace, rb.body.roleRef.kind, rb.body.roleRef.name], [vc.name, "ClusterRole", "sbx-operator"]);
  assert.deepEqual(rb.body.subjects, [{ kind: "ServiceAccount", name: "agent-worker", namespace: "platform" }]);
  const upgrade = helm.calls[0]!;
  assert.deepEqual(upgrade.slice(0, 6), ["upgrade", "--install", vc.name, "/app/vendor/vcluster-0.37.6.tgz", "-n", vc.name]);
  assert.equal(existsSync(upgrade[upgrade.indexOf("-f") + 1]!), false, "값 파일은 설치 뒤 지운다");
  assert.deepEqual(helm.values[0].sync.toHost.pods.translateImage, { "reg.example/platform/t1/web@sha256:aa": "ecr.example/sandbox/t1/web@sha256:aa" });
  assert.deepEqual(seen[0], { url: `https://${vc.name}.${vc.name}.svc:443`, cert: "CERT", token: undefined });
  assert.equal(vc.k8sVersion, "v1.35.0");
  const agent = await vc.agent();
  assert.ok(agent);
  assert.deepEqual(seen[1], { url: `https://${vc.name}.${vc.name}.svc:443`, cert: undefined, token: "AGENT-TOKEN" });

  assert.deepEqual(await vc.dispose(), { deleted: true, detail: "" });
  assert.deepEqual(helm.calls.at(-1)!.slice(0, 4), ["uninstall", vc.name, "-n", vc.name]);
  assert.equal(host.namespaces.has(vc.name), false);
  await vc.dispose();
  assert.equal(helm.calls.filter((a) => a[0] === "uninstall").length, 1, "두 번 불러도 한 번만 지운다");
});

test("helm 실패·준비 시간 초과면 만든 네임스페이스를 지우고 코드로 실패한다", async () => {
  for (const [name, helmOpts, readyAfter, code] of [
    ["helm", { failInstall: "Error: deployments.apps is forbidden" }, 1, "SANDBOX_HELM"],
    ["ready", {}, 10_000, "SANDBOX_NOT_READY"],
  ] as const) {
    const host = fakeHost();
    const err = await createVcluster({
      kube: asHostKube(host.kube), helm: fakeHelm(host, helmOpts), chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vc-")), ...clock(),
      connect: () => fakeVirtual({ readyAfter }).kube,
    }, spec(), { readyTimeoutMs: 10_000 }).then(() => null, (e) => e);
    assert.ok(err instanceof KubeError, name);
    assert.equal(err.code, code, name);
    assert.equal(host.namespaces.size, 0, `${name}: 남은 네임스페이스 0`);
  }
});

test("회사 번호가 소문자 UUID 가 아니면 호스트에 아무것도 만들지 않는다", async () => {
  for (const tenantId of ["", "t1", TENANT.toUpperCase(), `${TENANT}x`]) {
    const host = fakeHost();
    const err = await createVcluster({ kube: asHostKube(host.kube), helm: fakeHelm(host), chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vc-")), ...clock(),
      connect: () => fakeVirtual().kube }, spec({ tenantId })).then(() => null, (e) => e);
    assert.equal(err?.code, "SANDBOX_CREATE", JSON.stringify(tenantId));
    assert.equal(host.requests.length, 0, `${JSON.stringify(tenantId)}: 호스트 요청 0`);
  }
});

test("클러스터 밖(port-forward): 길이 열릴 때까지 다시 열고, 관리자·조회 전용 모두 그 주소로, 지우기·실패에서 닫는다", async () => {
  const opened: string[] = [];
  let closed = 0;
  const reachOk = (fails: number) => async (name: string) => {
    opened.push(name);
    if (opened.length <= fails) throw new KubeError("SANDBOX_PORT_FORWARD", "unable to forward port because pod is not running");
    return { url: "https://127.0.0.1:40123", close: () => { closed++; } };
  };
  const seen: string[] = [];
  const host = fakeHost();
  const vc = await createVcluster({ kube: asHostKube(host.kube), helm: fakeHelm(host), chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vc-")), ...clock(),
    reach: reachOk(1), connect: (url) => { seen.push(url); return fakeVirtual().kube; } }, spec());
  await vc.agent();
  assert.deepEqual(seen, ["https://127.0.0.1:40123", "https://127.0.0.1:40123"]);
  assert.equal(opened.length, 2, "처음 실패한 뒤 한 번 더 열고, 열린 뒤에는 다시 안 연다");
  assert.equal(closed, 0);
  await vc.dispose();
  await vc.dispose();
  assert.equal(closed, 1, "지우기에서 한 번 닫는다");

  closed = 0; opened.length = 0;
  const h2 = fakeHost();
  const err = await createVcluster({ kube: asHostKube(h2.kube), helm: fakeHelm(h2), chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vc-")), ...clock(),
    reach: reachOk(0), connect: () => fakeVirtual({ readyAfter: 10_000 }).kube }, spec(), { readyTimeoutMs: 10_000 }).then(() => null, (e) => e);
  assert.equal(err?.code, "SANDBOX_NOT_READY");
  assert.equal(closed, 1, "준비 실패에서도 닫는다");
  assert.equal(h2.namespaces.size, 0);
});

test("kubectl port-forward: 정해진 env 만 받고, 127.0.0.1 빈 포트를 읽고, 닫으면 끝난다. 열기 전에 끝나면 SANDBOX_PORT_FORWARD", async () => {
  process.env.DATABASE_URL = "postgres://app:pw@db/app";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  const home = mkdtempSync(join(tmpdir(), "pf-"));
  const bin = join(home, "kubectl");
  writeFileSync(bin, `#!/bin/sh
env > "$HOME/env.txt"
echo "$@" > "$HOME/args.txt"
echo "Forwarding from 127.0.0.1:41234 -> 8443"
echo "Forwarding from [::1]:41234 -> 8443"
exec sleep 30
`);
  chmodSync(bin, 0o755);
  const ep = await kubectlPortForward({ bin, kubeconfig: join(home, "k"), home })("sbx-rehearsal-abc");
  assert.equal(ep.url, "https://127.0.0.1:41234");
  assert.deepEqual(readFileSync(join(home, "env.txt"), "utf8").trim().split("\n").map((l) => l.split("=")[0]).filter((k) => k !== "PWD" && k !== "SHLVL" && k !== "_").sort(), ["HOME", "KUBECONFIG"]);
  assert.equal(readFileSync(join(home, "args.txt"), "utf8").trim(), "port-forward -n sbx-rehearsal-abc svc/sbx-rehearsal-abc --address 127.0.0.1 :443");
  ep.close();
  ep.close();

  const bad = join(home, "kubectl-bad");
  writeFileSync(bad, `#!/bin/sh
echo 'error: unable to forward port because pod is not running. Current status=Pending' >&2
exit 1
`);
  chmodSync(bad, 0o755);
  const err = await kubectlPortForward({ bin: bad, kubeconfig: join(home, "k"), home })("sbx-x").then(() => null, (e) => e);
  assert.ok(err instanceof KubeError);
  assert.equal(err.code, "SANDBOX_PORT_FORWARD");
  assert.match(err.message, /not running/);
});

test("만료 청소: 지난 것만 지우고, 지우기 실패는 실행 번호·네임스페이스와 함께 돌려준다 (#177)", async () => {
  const nowSec = 1_800_000_000;
  const ns = (name: string, purpose: string, exp: number, run: string) =>
    ({ name, labels: { "platform.svc/sandbox": "true", "platform.svc/sandbox-purpose": purpose, "platform.svc/expires-at": String(exp), "platform.svc/sandbox-run": run } });
  const host = fakeHost([
    ns("sbx-rehearsal-old", "rehearsal", nowSec - 10, "run-old"),
    ns("sbx-remediation-old", "remediation", nowSec - 10, "run-rem"),
    ns("sbx-rehearsal-live", "rehearsal", nowSec + 600, "run-live"),
    ns("sbx-rehearsal-stuck", "rehearsal", nowSec - 10, "run-stuck"),
    { name: "plat", labels: {} },
  ]);
  host.failDelete.add("sbx-rehearsal-stuck");
  const r = await sweepSandboxes(asHostKube(host.kube), expiredSandbox(nowSec));
  assert.deepEqual(r.deleted.sort(), ["sbx-rehearsal-old", "sbx-remediation-old"]);
  assert.deepEqual(r.failed.map((f) => [f.namespace, f.runId]), [["sbx-rehearsal-stuck", "run-stuck"]]);
  assert.deepEqual([...host.namespaces.keys()].sort(), ["plat", "sbx-rehearsal-live", "sbx-rehearsal-stuck"]);
});

test("리허설 시작 전 청소: 지금 실행 말고 남은 리허설 네임스페이스만 지운다 (수정 고리는 그대로)", async () => {
  const l = (purpose: string) => ({ "platform.svc/sandbox": "true", "platform.svc/sandbox-purpose": purpose, "platform.svc/expires-at": "9999999999" });
  const host = fakeHost([{ name: "sbx-rehearsal-crashed", labels: l("rehearsal") }, { name: "sbx-rehearsal-me", labels: l("rehearsal") },
    { name: "sbx-remediation-other", labels: l("remediation") }]);
  const r = await sweepSandboxes(asHostKube(host.kube), leftoverRehearsal("sbx-rehearsal-me"));
  assert.deepEqual(r.deleted, ["sbx-rehearsal-crashed"]);
  assert.deepEqual([...host.namespaces.keys()].sort(), ["sbx-rehearsal-me", "sbx-remediation-other"]);
});

test("helm 자식 프로세스는 정해진 env 만 받는다 (agent-worker 비밀이 안 넘어간다)", async () => {
  process.env.DATABASE_URL = "postgres://app:pw@db/app";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  const home = mkdtempSync(join(tmpdir(), "helm-home-"));
  const r = await helmRunner({ bin: "/usr/bin/env", kubeconfig: join(home, "k"), home }).run([], 5000);
  const keys = r.out.trim().split("\n").map((l) => l.split("=")[0]).sort();
  assert.deepEqual(keys, ["HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME", "HOME", "KUBECONFIG"]);
});

test("차트 값: 도착 마이너에 맞는 제어판, RuntimeClass 는 격리 값을 따름, 제어판 저장 emptyDir, 노드 고정", () => {
  const v = vclusterValues(spec({ k8sMinor: "1.33" }), "sbx-x") as any;
  assert.match(v.controlPlane.distro.k8s.image.tag, /^v1\.33\.0@sha256:/);
  assert.match((vclusterValues(spec({ k8sMinor: "1.29" }), "sbx-x") as any).controlPlane.distro.k8s.image.tag, /^v1\.35\.0@/);
  assert.equal(v.controlPlane.statefulSet.persistence.volumeClaim.enabled, false);
  assert.deepEqual(v.controlPlane.statefulSet.scheduling.nodeSelector, { pool: "sandbox" });
  assert.deepEqual(v.sync.fromHost.nodes.selector.labels, { pool: "sandbox" });
  assert.equal(v.rbac.clusterRole.enabled, false);
  assert.equal(v.policies.networkPolicy.workload.publicEgress.enabled, false);
  assert.equal(v.sync.toHost.networkPolicies.enabled, false, "테넌트 NetworkPolicy 가 호스트로 내려와 sbx-default-deny 를 넓히지 못한다");
  assert.equal(v.policies.podSecurityStandard, "baseline");
  assert.equal("runtimeClassName" in v.sync.toHost.pods, false);
  assert.ok(v.controlPlane.proxy.extraSANs.includes("sbx-x.sbx-x.svc"));
  assert.equal(v.policies.resourceQuota.quota["services.loadbalancers"], 0);
  const rem = vclusterValues(spec({ kind: "remediation", isolation: { podSecurity: "restricted", runtimeClass: "gvisor" } }), "sbx-y") as any;
  assert.equal(rem.sync.toHost.pods.runtimeClassName, "gvisor");
  assert.equal(rem.policies.podSecurityStandard, "restricted");
  const reh = vclusterValues(spec({ isolation: { podSecurity: "baseline", runtimeClass: "gvisor" } }), "sbx-z") as any;
  assert.equal(reh.sync.toHost.pods.runtimeClassName, "gvisor", "gVisor 를 켜면 리허설 파드도");
  assert.equal(reh.policies.podSecurityStandard, "baseline");
});

test("자원 수량 읽기", () => {
  assert.deepEqual([cpuMilli("250m"), cpuMilli("1"), cpuMilli("0.5"), cpuMilli("x")], [250, 1000, 500, null]);
  assert.deepEqual([memoryMi("128Mi"), memoryMi("1Gi"), memoryMi("512M"), memoryMi("1048576"), memoryMi("")], [128, 1024, 489, 1, null]);
});

const doc = (yaml: string) => ({ path: "manifests/all.yaml", yaml });
const deploy = (name: string, replicas: number, resources: string, extra = "") => `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name} }
spec:
  replicas: ${replicas}
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata: { labels: { app: ${name} } }
    spec:
      containers:
        - { name: main, image: img, resources: ${resources} }${extra}
`;

test("리허설 자원 상한 = 적용 묶음 요청량 합 + 제어판·검사 파드 몫, 여유 20%, 노드 할당량으로 자름", () => {
  const apply = parseManifests([doc([
    deploy("web", 1, "{ requests: { cpu: 100m, memory: 128Mi }, limits: { memory: 256Mi } }"),
    // HPA minReplicas 2 → 파드 2개. 요청 없는 사이드카는 LimitRange 기본(100m/128Mi, 한도 512Mi)
    deploy("api", 1, "{ requests: { cpu: 250m, memory: 256Mi }, limits: { memory: 512Mi } }", "\n        - { name: log, image: busybox }"),
    "apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata: { name: api }\nspec: { scaleTargetRef: { name: api }, minReplicas: 2, maxReplicas: 4 }\n",
    "apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: { name: cache }\nspec: { resources: { requests: { storage: 2Gi } } }\n",
  ].join("---\n"))], "apply").manifests;
  const plan = sandboxQuotaPlan(apply, { cpuM: 1930, memoryMi: 3400 });
  // 요청: web 100 + api 2×(250+100) + 검사 10 + 제어판 220 = 1030m, 메모리 128 + 2×(256+128) + 16 + 320 = 1232Mi
  assert.deepEqual(plan.need, { cpuM: 1030, memoryMi: 1232 });
  assert.equal(plan.fits, true);
  assert.deepEqual(plan.quota.requests, { cpuM: Math.ceil(1030 * 1.2), memoryMi: Math.ceil(1232 * 1.2) });
  // 한도: 256 + 2×(512+512) + 64 + 1194 = 3562 → ×1.2 (노드로 자르지 않는다)
  assert.equal(plan.quota.limitsMemoryMi, Math.ceil(3562 * 1.2));
  assert.equal(plan.quota.pods, 3 + 1 + 2 + 2);
  assert.equal(plan.quota.storageMi, Math.ceil(2048 * 1.2));

  const small = sandboxQuotaPlan(apply, { cpuM: 1000, memoryMi: 3400 });
  assert.equal(small.fits, false);
  assert.equal(small.quota.requests.cpuM, 1000, "노드 할당량을 넘지 않는다");
});

test("원본 할당량 셈: 할당량이 세는 칸만, LimitRange 기본 없이. 빈 칸 컨테이너는 따로 (도착 API 서버가 거부)", () => {
  const orig = parseManifests([doc(deploy("api", 3, "{ limits: { cpu: 500m, memory: 512Mi } }", "\n        - { name: log, image: busybox }"))], "original").manifests;
  // limits: 적힌 한도만. log 사이드카는 한도가 없다
  assert.deepEqual(originalUsage(orig, "limits"), { cpuM: 1500, memoryMi: 1536, missing: { cpu: ["Deployment/api/log"], memory: ["Deployment/api/log"] } });
  // requests: 요청량이 비면 한도 (API 서버 기본값 규칙)
  assert.deepEqual(originalUsage(orig, "requests"), { cpuM: 1500, memoryMi: 1536, missing: { cpu: ["Deployment/api/log"], memory: ["Deployment/api/log"] } });

  // 초기화 컨테이너는 하나씩 돌아 큰 쪽, CNPG Cluster 는 instances 개 파드, cloudflared 같은 차트 객체도 센다
  const web = deploy("web", 2, "{ requests: { cpu: 100m, memory: 128Mi }, limits: { memory: 256Mi } }",
    "\n      initContainers:\n        - { name: migrate, image: img, resources: { requests: { cpu: 300m, memory: 64Mi } } }");
  const cnpg = "apiVersion: postgresql.cnpg.io/v1\nkind: Cluster\nmetadata: { name: db }\nspec: { instances: 2, resources: { requests: { cpu: 500m, memory: 1Gi }, limits: { memory: 1Gi } } }\n";
  const all = parseManifests([doc([web, cnpg].join("---\n"))], "original").manifests;
  assert.deepEqual(originalUsage(all, "requests"), { cpuM: 300 * 2 + 500 * 2, memoryMi: 128 * 2 + 1024 * 2, missing: { cpu: [], memory: [] } });
  assert.deepEqual(originalUsage(all, "limits").missing, { cpu: ["Deployment/web/main", "Deployment/web/migrate", "Cluster/db/postgres"], memory: ["Deployment/web/migrate"] });
});

test("종류 표 밖·dry-run 전용 종류가 적용 묶음에 있으면 problems", () => {
  const r = parseManifests([doc("apiVersion: v1\nkind: Pod\nmetadata: { name: p }\n---\napiVersion: postgresql.cnpg.io/v1\nkind: Cluster\nmetadata: { name: db }\n")], "apply");
  assert.equal(r.manifests.length, 0);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0]!, /v1\/Pod p \(지원 목록 밖\)/);
  assert.match(r.problems[1]!, /dry-run 전용/);
});

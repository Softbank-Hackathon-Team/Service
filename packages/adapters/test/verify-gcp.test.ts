// L7i: GCP 연결 확인 읽기 — 가짜 exec 만 (실제 gcloud 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGcpObserve, gcpEnvFor } from "../src/verify/gcp.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: Array<{ line: string; env: NodeJS.ProcessEnv }> = [];
  const exec: Exec = async (cmd, args, o) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push({ line, env: o.env });
    const hit = table.find(([re]) => re.test(line));
    const r = hit?.[1] ?? { code: 1, err: `no fake for: ${line}` };
    return { code: r.code ?? 0, stdout: typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const P = "cust-proj-123";
const denied: Reply = { code: 1, err: "ERROR: (gcloud) PERMISSION_DENIED: Permission denied on resource project" };
const table = (over: Array<[RegExp, Reply]> = []): Array<[RegExp, Reply]> => [...over,
  [/^gcloud projects describe/, { out: { projectId: P, projectNumber: "123456789012" } }],
  [/^gcloud container clusters list/, { out: [{ name: "shop", location: "asia-northeast3" }] }],
  [/^gcloud container clusters get-credentials shop --location asia-northeast3/, { out: "" }],
  [/^kubectl --kubeconfig \S+ auth can-i list deployments --all-namespaces/, { out: "yes\n" }],
  [/^gcloud sql instances list/, { out: [] }],
  [/^gcloud iam service-accounts describe svc-operate@/, { out: { email: `svc-operate@${P}.iam.gserviceaccount.com` } }],
];
const input = { projectId: P, token: "ya29.secret", clusterName: "shop" };

test("정상: 읽기 4번 + 쿠버네티스 can-i(get-credentials·kubectl) 모두 통과, 프로젝트 번호를 돌려주고 빌린 토큰만 쓴다", async () => {
  const f = fakeExec(table());
  const r = await verifyGcpObserve({ exec: f.exec, env: { PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/own.json", CLOUDSDK_CORE_ACCOUNT: "me" } }, input);
  assert.deepEqual(r, { ok: true, clusters: ["shop"], projectNumber: "123456789012" });
  assert.equal(f.calls.length, 6);
  for (const c of f.calls) {
    assert.equal(c.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "ya29.secret");
    assert.equal(c.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(c.env.CLOUDSDK_CORE_ACCOUNT, undefined);
    assert.ok(!c.line.includes("ya29"), "토큰은 인자에 안 들어간다");
  }
  assert.equal(gcpEnvFor("t", P, {}).CLOUDSDK_CORE_PROJECT, P);
});

test("거부: 프로젝트 번호가 처음과 다르면 ACCOUNT_MISMATCH (이후 읽기 안 함), 번호가 없던 첫 확인은 통과", async () => {
  const f = fakeExec(table());
  assert.deepEqual(await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, expectedProjectNumber: "999999999999" }), { ok: false, reason: "ACCOUNT_MISMATCH" });
  assert.equal(f.calls.length, 1);
  assert.equal((await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, expectedProjectNumber: "123456789012" })).ok, true);
  const other = fakeExec(table([[/^gcloud projects describe/, { out: { projectId: "someone-else", projectNumber: "1" + "0".repeat(11) } }]]));
  assert.equal((await verifyGcpObserve({ exec: other.exec, env: {} }, input) as { reason: string }).reason, "ACCOUNT_MISMATCH");
});

test("거부: 읽기 권한 없음 → PERMISSION_MISSING:<권한>, 클러스터 이름 없음 → K8S_ACCESS_MISSING, 실행 SA 없음 → ROLE_NOT_FOUND, 조직 정책 → ORG_POLICY_BLOCKED", async () => {
  const r = async (over: Array<[RegExp, Reply]>, i = input) => (await verifyGcpObserve({ exec: fakeExec(table(over)).exec, env: {} }, i) as { reason: string }).reason;
  assert.equal(await r([[/^gcloud sql instances list/, denied]]), "PERMISSION_MISSING:cloudsql.instances.list");
  assert.equal(await r([[/^gcloud container clusters list/, denied]]), "PERMISSION_MISSING:container.clusters.list");
  assert.equal(await r([], { ...input, clusterName: "nope" }), "K8S_ACCESS_MISSING");
  assert.equal(await r([[/^gcloud iam service-accounts describe/, { code: 1, err: "NOT_FOUND: Unknown service account" }]]), "ROLE_NOT_FOUND");
  assert.equal(await r([[/^gcloud sql instances list/, { code: 1, err: "constraints/gcp.resourceLocations violated by organization policy" }]]), "ORG_POLICY_BLOCKED");
  await assert.rejects(verifyGcpObserve({ exec: fakeExec(table([[/^gcloud sql instances list/, { code: 127 }]])).exec, env: {} }, input));
});

// ── OBSROLE3: 선택 권한 찔러 보기 (probeOptional) ──
import { OPTIONAL_PROBES } from "../src/verify/gcp.js";
import { GCP_COMMAND_PERMISSIONS } from "../src/common/observe-permissions.js";
const OPT: Array<[RegExp, Reply]> = [   // 선택 읽기는 전부 통과하는 기본
  [/^gcloud (projects get-iam-policy|services list|compute |artifacts |secrets list|storage buckets list|pubsub |redis )/, { out: [] }]];
const probeLines = (f: ReturnType<typeof fakeExec>) => f.calls.map((c) => c.line).filter((l) => !/^(gcloud (projects describe|container|sql|iam service-accounts)|kubectl )/.test(l));

test("선택 권한 찌르기 끄면(기본) 지금과 똑같이 4번만 부름, 켜면 11번 더 부르고 전부 통과하면 missingPermissions 없음", async () => {
  const off = fakeExec([...table(), ...OPT]);
  assert.deepEqual(await verifyGcpObserve({ exec: off.exec, env: {} }, input), { ok: true, clusters: ["shop"], projectNumber: "123456789012" });
  assert.equal(off.calls.length, 6);
  const on = fakeExec([...table(), ...OPT]);
  const r = await verifyGcpObserve({ exec: on.exec, env: {} }, { ...input, probeOptional: true });
  assert.deepEqual(r, { ok: true, clusters: ["shop"], projectNumber: "123456789012" });
  assert.equal(probeLines(on).length, OPTIONAL_PROBES.length);
  assert.equal(on.calls.length, 6 + OPTIONAL_PROBES.length);
  for (const l of probeLines(on)) assert.ok(/--limit=1|get-iam-policy/.test(l) && !/create|delete|update|set-iam|access-secret|versions/.test(l), `읽기 아님/전체 읽기: ${l}`);
});

test("선택 권한이 빠져도 연결은 ok: 빠진 권한 이름만 모아 돌려줌 (정렬·중복 없음), 전역 전달 규칙은 권한 둘", async () => {
  const f = fakeExec([[/^gcloud secrets list/, denied], [/^gcloud compute forwarding-rules list/, denied], [/^gcloud redis instances list/, denied], ...table(), ...OPT]);
  const r = await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, probeOptional: true });
  assert.deepEqual(r, { ok: true, clusters: ["shop"], projectNumber: "123456789012",
    missingPermissions: ["compute.forwardingRules.list", "compute.globalForwardingRules.list", "redis.instances.list", "secretmanager.secrets.list"] });
});

test("거부 아님: API 꺼짐·조직 정책·네트워크 오류는 권한 문제로 세지 않고, 명령 없음(127)도 연결 확인을 안 깨뜨림", async () => {
  const off = { code: 1, err: "ERROR: (gcloud) PERMISSION_DENIED: Cloud Memorystore for Redis API has not been used in project 1 before or it is disabled. SERVICE_DISABLED" };
  const f = fakeExec([[/^gcloud redis instances list/, off], [/^gcloud pubsub topics list/, { code: 1, err: "constraints/gcp.resourceLocations violated by organization policy" }],
    [/^gcloud storage buckets list/, { code: 1, err: "ERROR: Unable to reach the server: connection reset" }], [/^gcloud artifacts repositories list/, { code: 127 }], ...table(), ...OPT]);
  const r = await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, probeOptional: true });
  assert.deepEqual(r, { ok: true, clusters: ["shop"], projectNumber: "123456789012" });
});

test("필수 읽기가 실패하면 선택 찌르기는 부르지 않음 (이전 사유 그대로)", async () => {
  const f = fakeExec([[/^gcloud sql instances list/, denied], ...table(), ...OPT]);
  const r = await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, probeOptional: true });
  assert.deepEqual(r, { ok: false, reason: "PERMISSION_MISSING:cloudsql.instances.list" });
  assert.equal(probeLines(f).length, 0);
});

test("찌르기 목록은 권한 표와 맞음: 키가 표에 있고, 표의 클라우드 읽기 권한 중 못 찌르는 것은 이 7개뿐 (CRIMPORT: 이름·지역이 필요한 Cloud Run 읽기 4개 더함, DEPLOYNONK8S: 배포 확인용 run.services.get 1개)", () => {
  const probed = new Set<string>();
  for (const p of OPTIONAL_PROBES) {
    assert.ok(p.key in GCP_COMMAND_PERMISSIONS, p.key);
    for (const perm of GCP_COMMAND_PERMISSIONS[p.key] ?? []) probed.add(perm);
  }
  const required = new Set(["resourcemanager.projects.get", "container.clusters.list", "container.clusters.get", "cloudsql.instances.list", "cloudsql.instances.get", "iam.serviceAccounts.get"]);
  const notProbed = Object.values(GCP_COMMAND_PERMISSIONS).flatMap((v) => v ?? []).filter((p) => !probed.has(p) && !required.has(p));
  // N8: cloudsql.databases.list 는 인스턴스 이름이 있어야 불러서 못 찌름. E-1·E-2: 나가는 IP·사설 DNS 읽기 4개는 선택 찌르기에 아직 안 넣음 (못 읽어도 가져오기는 notes 로 계속)
  assert.deepEqual([...new Set(notProbed)].sort(), ["cloudscheduler.jobs.list", "cloudsql.databases.list", "compute.addresses.list", "compute.regions.get", "compute.routers.list", "dns.managedZones.list", "dns.resourceRecordSets.list",
    "run.domainmappings.list", "run.revisions.get", "run.services.get", "run.services.getIamPolicy", "storage.buckets.getIamPolicy"]);
});

test("GKE can-i: 쿠버네티스 읽기 권한이 없으면(can-i no) K8S_ACCESS_MISSING, 임시 KUBECONFIG 만 쓰고 빌린 토큰으로 부름", async () => {
  const f = fakeExec(table([[/^kubectl .* auth can-i/, { code: 1, out: "no\n" }]]));
  assert.deepEqual(await verifyGcpObserve({ exec: f.exec, env: {} }, input), { ok: false, reason: "K8S_ACCESS_MISSING" });
  const gc = f.calls.find((c) => c.line.includes("get-credentials"))!;
  assert.match(gc.env.KUBECONFIG ?? "", /svc-verify-gcp-.*kubeconfig$/);
  assert.equal(gc.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "ya29.secret");
});

test("GKE can-i 거부: get-credentials 가 권한 거절이면 PERMISSION_MISSING:container.clusters.get, 클러스터 위치를 모르면 K8S_ACCESS_MISSING", async () => {
  const f = fakeExec(table([[/get-credentials/, denied]]));
  assert.deepEqual(await verifyGcpObserve({ exec: f.exec, env: {} }, input), { ok: false, reason: "PERMISSION_MISSING:container.clusters.get" });
  const g = fakeExec(table([[/^gcloud container clusters list/, { out: [{ name: "shop" }] }]]));
  assert.deepEqual(await verifyGcpObserve({ exec: g.exec, env: {} }, input), { ok: false, reason: "K8S_ACCESS_MISSING" });
});

test("클러스터 이름이 없는 환경(Cloud Run·VM 만)은 can-i 를 안 부름", async () => {
  const f = fakeExec(table());
  assert.equal((await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, clusterName: null })).ok, true);
  assert.equal(f.calls.some((c) => /kubectl|get-credentials/.test(c.line)), false);
});

test("GKE can-i: 쿠버네티스 읽기 권한이 없으면(can-i no) K8S_ACCESS_MISSING, 임시 KUBECONFIG 만 쓰고 빌린 토큰으로 부름", async () => {
  const f = fakeExec(table([[/^kubectl .* auth can-i/, { code: 1, out: "no\n" }]]));
  assert.deepEqual(await verifyGcpObserve({ exec: f.exec, env: {} }, input), { ok: false, reason: "K8S_ACCESS_MISSING" });
  const gc = f.calls.find((c) => c.line.includes("get-credentials"))!;
  assert.match(gc.env.KUBECONFIG ?? "", /svc-verify-gcp-.*kubeconfig$/);
  assert.equal(gc.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "ya29.secret");
});

test("GKE can-i 거부: get-credentials 가 권한 거절이면 PERMISSION_MISSING:container.clusters.get, 클러스터 위치를 모르면 K8S_ACCESS_MISSING", async () => {
  const f = fakeExec(table([[/get-credentials/, denied]]));
  assert.deepEqual(await verifyGcpObserve({ exec: f.exec, env: {} }, input), { ok: false, reason: "PERMISSION_MISSING:container.clusters.get" });
  const g = fakeExec(table([[/^gcloud container clusters list/, { out: [{ name: "shop" }] }]]));
  assert.deepEqual(await verifyGcpObserve({ exec: g.exec, env: {} }, input), { ok: false, reason: "K8S_ACCESS_MISSING" });
});

test("클러스터 이름이 없는 환경(Cloud Run·VM 만)은 can-i 를 안 부름", async () => {
  const f = fakeExec(table());
  assert.equal((await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, clusterName: null })).ok, true);
  assert.equal(f.calls.some((c) => /kubectl|get-credentials/.test(c.line)), false);
});

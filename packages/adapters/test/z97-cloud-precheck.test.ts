import { test } from "node:test";
import assert from "node:assert/strict";
import { runCloudPrecheck, toPrecheckItems, cliProblem, type PrecheckDeps, type PrecheckInput } from "../src/precheck/cloud-precheck.js";

// Z97 사전 점검 실조회: 가짜 exec 로 aws/gcloud/kubectl 응답을 흉내 내 판정 규칙만 본다 (실제 명령은 맥에서)
type R = { code: number; stdout?: string; stderr?: string };
function fakeExec(table: Record<string, R>, seen: string[] = []): PrecheckDeps["exec"] {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    seen.push(key);
    const hit = Object.entries(table).find(([k]) => key.startsWith(k));
    const r = hit?.[1] ?? { code: 1, stderr: `unexpected ${key}` };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: 5 };
  };
}
const j = (v: unknown) => JSON.stringify(v);
const okTcp: PrecheckDeps["tcp"] = async () => ({ ok: true, ms: 3 });
const bigDisk = async () => 50 * 1024 ** 3;
const ENV = { AWS_REGION: "ap-northeast-2", ONPREM_KUBE_CONTEXT: "k3d-onprem" } as NodeJS.ProcessEnv;

const AWS_OK: Record<string, R> = {
  "aws sts get-caller-identity": { code: 0, stdout: j({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/x" }) },
  "aws ec2 describe-regions": { code: 0, stdout: j({ Regions: [{ RegionName: "ap-northeast-2", OptInStatus: "opt-in-not-required" }] }) },
  "aws service-quotas get-service-quota --service-code vpc": { code: 0, stdout: j({ Quota: { Value: 5 } }) },
  "aws service-quotas get-service-quota --service-code ec2": { code: 0, stdout: j({ Quota: { Value: 5 } }) },
  "aws service-quotas get-service-quota --service-code rds": { code: 0, stdout: j({ Quota: { Value: 40 } }) },
  "aws ec2 describe-vpcs": { code: 0, stdout: "1" },
  "aws ec2 describe-addresses": { code: 0, stdout: "0" },
  "aws rds describe-db-instances": { code: 0, stdout: "0" },
  "aws rds describe-db-engine-versions": { code: 0, stdout: j(["14.12", "15.7", "16.3", "16.4", "17.1"]) },
};
const KUBE_OK: Record<string, R> = {
  "kubectl --context k3d-onprem auth can-i": { code: 0, stdout: "yes\n" },
};
const onpremToAws: PrecheckInput = {
  source: { side: "source", provider: "onprem" }, target: { side: "target", provider: "aws", accountId: "123456789012" },
  sourcePgMajor: 16, sourceDbBytes: 50 * 1024 ** 2, endpoints: [{ name: "출발 DB", host: "127.0.0.1", port: 55434 }],
};
const byId = <T extends { id: string }>(cs: T[]) => new Map(cs.map((c) => [c.id, c] as const));

test("온프레→AWS 다 정상이면 FAIL 0, 항목마다 이유 문장", async () => {
  const cs = await runCloudPrecheck(onpremToAws, { exec: fakeExec({ ...AWS_OK, ...KUBE_OK }), env: ENV, tcp: okTcp, diskFree: bigDisk });
  assert.equal(cs.filter((c) => c.verdict === "FAIL").length, 0, j(cs.filter((c) => c.verdict === "FAIL")));
  const m = byId(cs);
  for (const id of ["PC-CRED-S", "PC-CRED-T", "PC-API", "PC-BILL", "PC-QUOTA-VPC", "PC-QUOTA-EIP", "PC-QUOTA-RDS", "PC-DBVER", "PC-NET-1", "PC-DISK"]) assert.ok(m.has(id), id);
  // Z104 03: 계정 번호는 끝 4자리만 (R8-46)
  assert.match(m.get("PC-CRED-T")!.reason, /••••9012/);
  for (const c of cs) assert.doesNotMatch(`${c.reason} ${c.fix ?? ""}`, /\d{12}/, c.id);
  assert.match(m.get("PC-QUOTA-VPC")!.reason, /한도 5 − 사용 1 = 남은 4/);
  assert.equal(m.get("PC-DBVER")!.verdict, "PASS");
  for (const c of cs) assert.ok(c.reason.length > 5, c.id);
});

test("자격 없음 → FAIL 이유 '자격 없음', 도착 클라우드 조회는 건너뜀 (가짜 PASS 없음)", async () => {
  const seen: string[] = [];
  const exec = fakeExec({ ...KUBE_OK, "aws sts get-caller-identity": { code: 255, stderr: "Unable to locate credentials. You can configure credentials by running \"aws configure\"." } }, seen);
  const cs = await runCloudPrecheck(onpremToAws, { exec, env: ENV, tcp: okTcp, diskFree: bigDisk });
  const t = byId(cs).get("PC-CRED-T")!;
  assert.equal(t.verdict, "FAIL"); assert.match(t.reason, /자격 없음/);
  assert.ok(!seen.some((s) => s.includes("service-quotas")), "자격 없으면 할당량을 묻지 않는다");
  assert.equal(byId(cs).get("PC-SKIP")!.verdict, "FAIL");
  assert.ok(toPrecheckItems(cs).some((i) => i.level === "block"));
});

test("aws 명령이 없으면 '자격 없음 — aws 명령이 없음'", async () => {
  const cs = await runCloudPrecheck(onpremToAws, { exec: fakeExec({ ...KUBE_OK, "aws": { code: 127, stderr: "spawn aws ENOENT" } }), env: ENV, tcp: okTcp, diskFree: bigDisk });
  assert.match(byId(cs).get("PC-CRED-T")!.reason, /자격 없음 — aws 명령이 없음/);
});

test("계정 번호가 환경 등록값과 다르면 FAIL", async () => {
  const i = { ...onpremToAws, target: { ...onpremToAws.target, accountId: "999999999999" } };
  const cs = await runCloudPrecheck(i, { exec: fakeExec({ ...AWS_OK, ...KUBE_OK }), env: ENV, tcp: okTcp, diskFree: bigDisk });
  assert.match(byId(cs).get("PC-CRED-T")!.reason, /••••9999/);
  assert.doesNotMatch(byId(cs).get("PC-CRED-T")!.reason, /\d{12}/);
  assert.equal(byId(cs).get("PC-CRED-T")!.verdict, "FAIL");
});

test("할당량: 남은 < 필요 FAIL, 남은 = 필요 WARN, 한도 못 읽음 WARN", async () => {
  const exec = fakeExec({ ...AWS_OK, ...KUBE_OK,
    "aws service-quotas get-service-quota --service-code vpc": { code: 0, stdout: j({ Quota: { Value: 5 } }) },
    "aws ec2 describe-vpcs": { code: 0, stdout: "5" },
    "aws ec2 describe-addresses": { code: 0, stdout: "4" },
    "aws service-quotas get-service-quota --service-code rds": { code: 254, stderr: "AccessDeniedException" } });
  const m = byId(await runCloudPrecheck(onpremToAws, { exec, env: ENV, tcp: okTcp, diskFree: bigDisk }));
  assert.equal(m.get("PC-QUOTA-VPC")!.verdict, "FAIL"); assert.ok(m.get("PC-QUOTA-VPC")!.fix);
  assert.equal(m.get("PC-QUOTA-EIP")!.verdict, "WARN");
  assert.equal(m.get("PC-QUOTA-RDS")!.verdict, "WARN"); assert.match(m.get("PC-QUOTA-RDS")!.reason, /한도 못 읽음/);
});

test("DB 버전: 출발 13 FAIL(복제 14+), 모름 WARN, 도착에 없는 버전이면 FAIL", async () => {
  const deps = { exec: fakeExec({ ...AWS_OK, ...KUBE_OK }), env: ENV, tcp: okTcp, diskFree: bigDisk };
  assert.equal(byId(await runCloudPrecheck({ ...onpremToAws, sourcePgMajor: 13 }, deps)).get("PC-DBVER")!.verdict, "FAIL");
  assert.equal(byId(await runCloudPrecheck({ ...onpremToAws, sourcePgMajor: null }, deps)).get("PC-DBVER")!.verdict, "WARN");
  assert.equal(byId(await runCloudPrecheck({ ...onpremToAws, sourcePgMajor: 18 }, deps)).get("PC-DBVER")!.verdict, "FAIL");
});

test("네트워크: TCP 실패 FAIL + 이유에 주소, 디스크 0.1GB FAIL", async () => {
  const tcp: PrecheckDeps["tcp"] = async (h) => h === "127.0.0.1" ? { ok: false, ms: 3000, error: "시간 초과 3000ms" } : { ok: true, ms: 4 };
  const m = byId(await runCloudPrecheck(onpremToAws, { exec: fakeExec({ ...AWS_OK, ...KUBE_OK }), env: ENV, tcp, diskFree: async () => 0.1 * 1024 ** 3 }));
  assert.equal(m.get("PC-NET-1")!.verdict, "FAIL"); assert.match(m.get("PC-NET-1")!.reason, /127\.0\.0\.1:55434/);
  assert.equal(m.get("PC-NET-2")!.verdict, "PASS"); assert.match(m.get("PC-NET-2")!.reason, /sts\.ap-northeast-2\.amazonaws\.com/);
  assert.equal(m.get("PC-DISK")!.verdict, "FAIL");
});

test("GCP 도착: tokeninfo·꺼진 API·결제 미연결·Cloud SQL 티어 규칙", async () => {
  const exec = fakeExec({ ...KUBE_OK,
    "gcloud auth print-access-token": { code: 0, stdout: "ya29.secret\n" },
    "gcloud services list": { code: 0, stdout: j([{ config: { name: "compute.googleapis.com" } }, { config: { name: "container.googleapis.com" } }]) },
    "gcloud billing projects describe finals-demo": { code: 0, stdout: j({ billingEnabled: false }) },
    "gcloud compute regions describe asia-northeast3": { code: 0, stdout: j({ quotas: [{ metric: "CPUS", limit: 24, usage: 2 }, { metric: "IN_USE_ADDRESSES", limit: 8, usage: 1 }, { metric: "STATIC_ADDRESSES", limit: 8, usage: 0 }] }) },
    "gcloud sql instances list": { code: 0, stdout: "[]" } });
  let body = "";
  const f = (async (_u: string, o: { body: string }) => { body = o.body; return new Response(j({ email: "sa@finals-demo.iam.gserviceaccount.com", expires_in: 3500 }), { status: 200 }); }) as unknown as typeof fetch;
  const cs = await runCloudPrecheck({ ...onpremToAws, target: { side: "target", provider: "gcp" } },
    { exec, env: { ...ENV, GCP_PROJECT: "finals-demo", CLOUDSQL_EDITION: "ENTERPRISE_PLUS" }, fetch: f, tcp: okTcp, diskFree: bigDisk });
  const m = byId(cs);
  assert.equal(m.get("PC-CRED-T")!.verdict, "PASS"); assert.match(m.get("PC-CRED-T")!.reason, /sa@finals-demo/);
  assert.match(body, /^access_token=/); assert.ok(!j(cs).includes("ya29"), "토큰이 결과에 안 남는다");
  assert.equal(m.get("PC-API")!.verdict, "FAIL"); assert.match(m.get("PC-API")!.reason, /sqladmin/);
  assert.equal(m.get("PC-BILL")!.verdict, "FAIL");
  assert.equal(m.get("PC-QUOTA-CPUS")!.verdict, "PASS");
  assert.equal(m.get("PC-QUOTA-SQL")!.verdict, "FAIL"); assert.match(m.get("PC-QUOTA-SQL")!.reason, /Invalid Tier/);
  assert.equal(m.get("PC-DBVER")!.verdict, "PASS");
});

test("MOCK_PRECHECK=1 이면 명령을 하나도 안 부르고 MOCK 이라고 밝힘", async () => {
  const seen: string[] = [];
  const cs = await runCloudPrecheck(onpremToAws, { exec: fakeExec({}, seen), env: { MOCK_PRECHECK: "1" }, tcp: okTcp, diskFree: bigDisk });
  assert.equal(seen.length, 0);
  assert.ok(cs.every((c) => /MOCK_PRECHECK=1/.test(c.reason)));
});

test("toPrecheckItems: FAIL→block WARN→warn PASS→info, message 에 판정·항목·이유", () => {
  const it = toPrecheckItems([{ id: "A", side: "target", item: "할당량 VPC", verdict: "FAIL", reason: "남은 0 < 필요 1", fix: "증설" },
    { id: "B", side: "both", item: "x", verdict: "WARN", reason: "y" }, { id: "C", side: "both", item: "x", verdict: "PASS", reason: "y" }]);
  assert.deepEqual(it.map((i) => i.level), ["block", "warn", "info"]);
  assert.equal(it[0]!.message, "FAIL 할당량 VPC — 남은 0 < 필요 1"); assert.equal(it[0]!.fix, "증설");
});

test("cliProblem 분류", () => {
  assert.equal(cliProblem("aws", { code: 127, stderr: "spawn aws ENOENT" }).kind, "missing");
  assert.equal(cliProblem("aws", { code: 255, stderr: "An error occurred (ExpiredToken)" }).kind, "nocred");
  assert.equal(cliProblem("gcloud", { code: 1, stderr: "PERMISSION_DENIED: x" }).kind, "denied");
});

test("Z104 03: 권한 오류 글(ARN)에 섞인 계정 번호도 가린다", async () => {
  const cs = await runCloudPrecheck(onpremToAws, { exec: fakeExec({ ...KUBE_OK, ...AWS_OK,
    "aws sts get-caller-identity": { code: 254, stderr: "An error occurred (AccessDenied): User: arn:aws:iam::123456789012:user/x is not authorized" } }),
    env: ENV, tcp: okTcp, diskFree: bigDisk });
  const r = byId(cs).get("PC-CRED-T")!.reason;
  assert.match(r, /••••9012/);
  assert.doesNotMatch(r, /123456789012/);
});

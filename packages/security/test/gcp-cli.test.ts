// L7i: GCP 발급기 — 가짜 gcloud 만. 다른 회사 → 다른 플랫폼 SA, 요청 값의 SA 는 무시, 거부 사유
import { test } from "node:test";
import assert from "node:assert/strict";
import { gcpCliIssuer, perEnvGcpIssuer, gcloudImpersonateArgs, GcpIssueError, GcloudCliError, mockIssuer, type GcloudRun, type IssueContext } from "../src/index.js";

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const SA: Record<string, string> = { [T1]: "t-" + "a".repeat(28), [T2]: "t-" + "b".repeat(28) };
const TOKEN = "ya29." + "x".repeat(40);

function ctx(tenantId: string, roleRef = "svc-observe@cust-proj-123.iam.gserviceaccount.com", extra: Record<string, unknown> = {}): IssueContext {
  return { req: { tenantId, envId: "33333333-3333-4333-8333-333333333333", provider: "gcp", purpose: "observe", actions: ["container.clusters.list"], ttlSec: 900, ...extra } as IssueContext["req"],
    now: new Date("2026-11-03T00:00:00Z"), roleRef, sessionName: "s" };
}
function fake(code = 0, stderr = "") {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: GcloudRun = async (args, env) => { calls.push({ args, env }); return { code, stdout: code === 0 ? `${TOKEN}\n` : "", stderr }; };
  return { run, calls };
}
const issuer = (run: GcloudRun) => gcpCliIssuer({ platformSa: async (t) => SA[t], platformProject: "svc-platform", run, env: { PATH: "/bin", CLOUDSDK_AUTH_ACCESS_TOKEN: "own" } });

test("회사마다 다른 플랫폼 SA 로 위임, 토큰은 bearer 로 돌려주고 자기 토큰 환경변수는 지운다", async () => {
  const f = fake();
  const i = issuer(f.run);
  const a = await i.issue(ctx(T1)), b = await i.issue(ctx(T2));
  assert.equal(a.material.kind, "bearer");
  assert.equal(a.ttlSec, 900);
  assert.deepEqual(f.calls[0]!.args, gcloudImpersonateArgs({ target: "svc-observe@cust-proj-123.iam.gserviceaccount.com",
    delegate: `${SA[T1]}@svc-platform.iam.gserviceaccount.com`, lifetimeSec: 900 }));
  assert.ok(f.calls[0]!.args.includes(`--impersonate-service-account=${SA[T1]}@svc-platform.iam.gserviceaccount.com,svc-observe@cust-proj-123.iam.gserviceaccount.com`));
  assert.ok(f.calls[1]!.args[2]!.startsWith(`--impersonate-service-account=${SA[T2]}@svc-platform.iam.gserviceaccount.com,`));
  assert.equal(f.calls[0]!.env.CLOUDSDK_AUTH_ACCESS_TOKEN, undefined);
  assert.ok(!JSON.stringify(b.detail).includes(TOKEN));
});

test("요청에 SA 를 넣어도 무시: DB 에 없는 회사는 거부, 이상한 고객 SA 이름도 거부", async () => {
  const f = fake();
  const i = issuer(f.run);
  // 요청 본문에 platformSa 를 끼워도(스키마 밖 칸) DB 값만 쓴다
  await i.issue(ctx(T1, undefined, { platformSa: "t-" + "c".repeat(28) }));
  assert.ok(f.calls[0]!.args.some((x) => x.includes(SA[T1]!)) && !f.calls[0]!.args.some((x) => x.includes("c".repeat(28))));
  await assert.rejects(i.issue(ctx("44444444-4444-4444-8444-444444444444")), (e) => e instanceof GcpIssueError && e.reason === "PLATFORM_SA_MISSING");
  await assert.rejects(i.issue(ctx(T1, "someone@gmail.com")), (e) => e instanceof GcpIssueError && e.reason === "ROLE_NOT_FOUND");
  assert.equal(f.calls.length, 1, "거부된 요청은 gcloud 를 부르지 않는다");
});

test("gcloud 실패: 권한 거부·없음은 사유, 명령 없음·알 수 없음은 던짐, 오류 글에 SA·토큰 없음", async () => {
  const denied = fake(1, "ERROR: PERMISSION_DENIED: Permission 'iam.serviceAccounts.getAccessToken' denied on svc-observe@cust-proj-123.iam.gserviceaccount.com");
  await assert.rejects(issuer(denied.run).issue(ctx(T1)), (e) => e instanceof GcpIssueError && e.reason === "ROLE_ASSUME_DENIED" && !e.message.includes("cust-proj"));
  const nf = fake(1, "NOT_FOUND: Unknown service account");
  await assert.rejects(issuer(nf.run).issue(ctx(T1)), (e) => e instanceof GcpIssueError && e.reason === "ROLE_NOT_FOUND");
  await assert.rejects(issuer(fake(127).run).issue(ctx(T1)), (e) => e instanceof GcloudCliError && e.missing);
  await assert.rejects(issuer(fake(1, "weird").run).issue(ctx(T1)), GcloudCliError);
});

test("시드(stub) 프로젝트는 mock 으로, 진짜 모양 SA 는 진짜로", async () => {
  const p = perEnvGcpIssuer(issuer(fake().run), mockIssuer("gcp"));
  assert.equal(p.mockFor?.({ roleRef: "svc-observe@stub.iam.gserviceaccount.com" }), true);
  assert.equal(p.mockFor?.({ roleRef: "svc-observe@cust-proj-123.iam.gserviceaccount.com" }), false);
  const f = fake();
  await perEnvGcpIssuer(issuer(f.run), mockIssuer("gcp")).issue(ctx(T1, "svc-observe@stub.iam.gserviceaccount.com"));
  assert.equal(f.calls.length, 0, "stub 프로젝트는 gcloud 를 안 부른다");
});

const OPR = "svc-operate@cust-proj-123.iam.gserviceaccount.com", PLAN = "svc-plan@cust-proj-123.iam.gserviceaccount.com";
const target = (args: string[]) => args.find((a) => a.startsWith("--impersonate-service-account="))!.split("=")[1]!.split(",").at(-1);

// 실측 11/4: gcloud auth print-access-token 에는 --delegates 가 없다 (Cloud SDK 558, unrecognized arguments). 쉼표 체인 하나로만
test("FM-GCP-13: print-access-token 인자에 --delegates 가 없고, 위임 SA,대상 SA 쉼표 체인(마지막이 대상)으로만 넘긴다", () => {
  const a = gcloudImpersonateArgs({ target: "svc-operate@c-prj.iam.gserviceaccount.com", delegate: "t-1@p-prj.iam.gserviceaccount.com", lifetimeSec: 900 });
  assert.deepEqual(a, ["auth", "print-access-token", "--impersonate-service-account=t-1@p-prj.iam.gserviceaccount.com,svc-operate@c-prj.iam.gserviceaccount.com", "--lifetime=900"]);
  assert.ok(!a.some((x) => x.startsWith("--delegates")));
  // print-access-token 이 받는 플래그만 (gcloud auth print-access-token --help: --lifetime, --impersonate-service-account, 전역 플래그)
  const ALLOWED = /^--(impersonate-service-account|lifetime)=/;
  assert.ok(a.slice(2).every((x) => ALLOWED.test(x)), a.join(" "));
});

test("ID-7: 실행 역할의 plan 단계는 svc-plan(읽기만)을 빌리고, apply·destroy 는 svc-operate 그대로", async () => {
  const f = fake();
  const i = issuer(f.run);
  const p = await i.issue(ctx(T1, OPR, { purpose: "operate", stage: "plan", migrationId: "44444444-4444-4444-8444-444444444444" }));
  await i.issue(ctx(T1, OPR, { purpose: "operate", stage: "apply", migrationId: "44444444-4444-4444-8444-444444444444" }));
  await i.issue(ctx(T1, OPR, { purpose: "operate", stage: "destroy", migrationId: "44444444-4444-4444-8444-444444444444" }));
  assert.deepEqual(f.calls.map((c) => target(c.args)), [PLAN, OPR, OPR]);
  assert.equal(p.detail.serviceAccount, PLAN);
  assert.equal(p.detail.planFallback, undefined);
});

test("ID-7 거부: 예전 스크립트 고객(svc-plan 없음)만 svc-operate 로 한 번 더 빌리고 표시를 남긴다, 거절(권한)은 넘기지 않고 실패", async () => {
  const calls: string[] = [];
  const run: GcloudRun = async (args) => {
    calls.push(target(args)!);
    return target(args) === PLAN ? { code: 1, stdout: "", stderr: "ERROR: NOT_FOUND: Service account svc-plan does not exist" } : { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
  };
  const out = await issuer(run).issue(ctx(T1, OPR, { purpose: "operate", stage: "plan", migrationId: "44444444-4444-4444-8444-444444444444" }));
  assert.deepEqual(calls, [PLAN, OPR]);
  assert.equal(out.detail.planFallback, true);
  const denied: GcloudRun = async () => ({ code: 1, stdout: "", stderr: "PERMISSION_DENIED: iam.serviceAccounts.getAccessToken" });
  await assert.rejects(issuer(denied).issue(ctx(T1, OPR, { purpose: "operate", stage: "plan", migrationId: "44444444-4444-4444-8444-444444444444" })),
    (e: unknown) => e instanceof GcpIssueError && e.reason === "ROLE_ASSUME_DENIED");
});

test("B-2: 환경 층(policy env_layer)은 svc-env 를 빌리고, svc-env 가 없으면 svc-operate 로 넘어가지 않고 ROLE_NOT_FOUND", async () => {
  const ENV = "svc-env@cust-proj-123.iam.gserviceaccount.com";
  const MID = "44444444-4444-4444-8444-444444444444";
  const f = fake();
  const ok = await issuer(f.run).issue(ctx(T1, OPR, { purpose: "operate", stage: "apply", policy: "env_layer", migrationId: MID }));
  assert.deepEqual(f.calls.map((c) => target(c.args)), [ENV]);
  assert.equal(ok.detail.serviceAccount, ENV);
  const calls: string[] = [];
  const missing: GcloudRun = async (args) => {
    calls.push(target(args)!);
    return target(args) === ENV ? { code: 1, stdout: "", stderr: "ERROR: NOT_FOUND: Service account svc-env does not exist" } : { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
  };
  await assert.rejects(issuer(missing).issue(ctx(T1, OPR, { purpose: "operate", stage: "apply", policy: "env_layer", migrationId: MID })),
    (e: unknown) => e instanceof GcpIssueError && e.reason === "ROLE_NOT_FOUND");
  assert.deepEqual(calls, [ENV], "svc-operate 로 다시 빌리지 않는다");
});

// FM-GCP-02: 네트워크·프록시 실패는 사유(끝)가 아니라 재시도 (null). 진짜 거부·없음은 그대로
test("FM-GCP-02: 연결·프록시·DNS·시간 초과 글은 null(재시도), 권한 거부·SA 없음은 그대로", async () => {
  const { gcloudFailure } = await import("../src/gcp-cli.js");
  for (const net of [
    "ERROR: (gcloud.auth.print-access-token) HTTPSConnectionPool(host='iamcredentials.googleapis.com', port=443): Max retries exceeded (Caused by ProxyError('Unable to connect to proxy', OSError('Tunnel connection failed: 403 Forbidden')))",
    "Failed to establish a new connection: [Errno 8] nodename nor servname provided, or not known",
    "TransportError: ('Connection aborted.', ConnectionResetError(54, 'Connection reset by peer'))",
    "ERROR: gcloud crashed (SSLError): [SSL: CERTIFICATE_VERIFY_FAILED]",
    "Read timed out. (read timeout=30)",
  ]) assert.equal(gcloudFailure(net), null, net.slice(0, 60));
  assert.equal(gcloudFailure("ERROR: (gcloud.auth.print-access-token) Failed to impersonate [svc-observe@p.iam.gserviceaccount.com]. Make sure the account that's trying to impersonate it has access"), "ROLE_ASSUME_DENIED");
  assert.equal(gcloudFailure("PERMISSION_DENIED: Permission 'iam.serviceAccounts.getAccessToken' denied"), "ROLE_ASSUME_DENIED");
  assert.equal(gcloudFailure("NOT_FOUND: Requested entity was not found."), "ROLE_NOT_FOUND");
});

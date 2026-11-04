// RV-27: GCP 도착 사전 점검이 워커 자기 gcloud 로그인이 아니라 빌린 관찰 토큰·도착(전용) 프로젝트로 도는가. 가짜 exec·fetch (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCloudPrecheck, GCP_APIS, type PrecheckDeps, type PrecheckInput } from "../src/precheck/cloud-precheck.js";
import { gcpEnvFor } from "../src/verify/gcp.js";

type Call = { key: string; env: NodeJS.ProcessEnv };
const j = (v: unknown) => JSON.stringify(v);
function fakeExec(calls: Call[]): PrecheckDeps["exec"] {
  return async (cmd, args, o) => {
    const key = `${cmd} ${args.join(" ")}`;
    calls.push({ key, env: o.env });
    const out = (stdout: string) => ({ code: 0, stdout, stderr: "", ms: 1 });
    if (key.startsWith("aws sts get-caller-identity")) return out(j({ Account: "111111111111" }));
    if (key.startsWith("aws")) return out("0");
    if (key.startsWith("gcloud auth print-access-token")) return out("tok-worker-own\n");
    if (key.startsWith("gcloud services list")) return out(j(GCP_APIS.map((n) => ({ config: { name: n } }))));
    if (key.startsWith("gcloud billing projects describe")) return out(j({ billingEnabled: true }));
    if (key.startsWith("gcloud compute regions describe")) return out(j({ quotas: [] }));
    if (key.startsWith("gcloud sql instances list")) return out("[]");
    return out("[]");
  };
}
const BASE = { PATH: "/bin", GCP_PROJECT: "finals-demo", GOOGLE_APPLICATION_CREDENTIALS: "/own/adc.json", CLOUDSDK_CORE_ACCOUNT: "worker@x" } as NodeJS.ProcessEnv;
const awsToGcp: PrecheckInput = {
  source: { side: "source", provider: "aws", accountId: "111111111111" }, target: { side: "target", provider: "gcp", accountId: "cust-mig" },
  sourcePgMajor: 16, sourceDbBytes: 1, endpoints: [],
};
function deps(calls: Call[], seen: string[], sideEnv?: PrecheckDeps["sideEnv"]): PrecheckDeps {
  return { exec: fakeExec(calls), env: BASE, tcp: async () => ({ ok: true, ms: 1 }), diskFree: async () => 50 * 1024 ** 3,
    fetch: (async (_u: string, init: { body: string }) => { seen.push(decodeURIComponent(init.body.split("=")[1]!));
      return { ok: true, json: async () => ({ email: "svc-observe@cust-proj.iam.gserviceaccount.com", expires_in: 3000 }) }; }) as unknown as typeof fetch,
    ...(sideEnv ? { sideEnv } : {}) };
}

test("RV-27 정상: 도착 GCP 조회는 빌린 토큰·전용 프로젝트로, 워커 자기 자격·GCP_PROJECT 는 안 씀, 이유 글에 '빌린 고객 관찰 자격'", async () => {
  const calls: Call[] = [], seen: string[] = [];
  const cs = await runCloudPrecheck(awsToGcp, deps(calls, seen, { target: gcpEnvFor("tok-borrowed", "cust-mig", BASE) }));
  const t = cs.find((c) => c.id === "PC-CRED-T")!;
  assert.equal(t.verdict, "PASS", t.reason);
  assert.match(t.reason, /빌린 고객 관찰 자격/);
  assert.match(t.reason, /프로젝트 cust-mig/);
  assert.deepEqual(seen, ["tok-borrowed"], "tokeninfo 에 다른 토큰을 보냄");
  const g = calls.filter((c) => c.key.startsWith("gcloud"));
  assert.ok(!g.some((c) => c.key.startsWith("gcloud auth print-access-token")), "워커 자기 토큰을 꺼냄");
  assert.ok(g.length >= 3);
  for (const c of g) {
    assert.equal(c.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "tok-borrowed", c.key);
    assert.equal(c.env.GOOGLE_APPLICATION_CREDENTIALS, undefined, c.key);
    assert.ok(!c.key.includes("finals-demo"), `워커 GCP_PROJECT 로 조회: ${c.key}`);
  }
  assert.ok(g.some((c) => c.key.includes("billing projects describe cust-mig")));
});

test("RV-27 거부: 빌린 토큰이 없으면 워커 자기 로그인으로 돌고 이유 글이 그렇다고 밝힘 (고객 자격 PASS 로 안 보이게)", async () => {
  const calls: Call[] = [], seen: string[] = [];
  const cs = await runCloudPrecheck(awsToGcp, deps(calls, seen));
  const t = cs.find((c) => c.id === "PC-CRED-T")!;
  assert.match(t.reason, /워커 자기 gcloud 로그인 \(빌린 자격 아님\)/);
  assert.ok(!/빌린 고객 관찰 자격/.test(t.reason));
  assert.deepEqual(seen, ["tok-worker-own"]);
  assert.ok(calls.some((c) => c.key.startsWith("gcloud auth print-access-token")));
});

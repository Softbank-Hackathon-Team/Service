// VL5c: L5c(사전 점검이 쪽마다 빌린 관찰 자격으로 조회) 검증 — 한쪽만 빌림·도착 자격 FAIL 때 조회 건너뜀·원본 env 불변. 가짜 exec 만
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCloudPrecheck, type PrecheckDeps, type PrecheckInput } from "../src/precheck/cloud-precheck.js";
import { envFor } from "../src/verify/aws.js";

const j = (v: unknown) => JSON.stringify(v);
type Call = { key: string; env: NodeJS.ProcessEnv };
function fakeExec(calls: Call[], accounts: { src: string; tgt: string; own: string }): PrecheckDeps["exec"] {
  return async (cmd, args, o) => {
    const key = `${cmd} ${args.join(" ")}`;
    calls.push({ key, env: o.env });
    const f = o.env.AWS_CONFIG_FILE ?? "";
    const acct = f.includes("src") ? accounts.src : f.includes("tgt") ? accounts.tgt : accounts.own;
    const out = (stdout: string) => ({ code: 0, stdout, stderr: "", ms: 1 });
    if (key.startsWith("aws sts get-caller-identity")) return out(j({ Account: acct }));
    if (key.startsWith("aws ec2 describe-regions")) return out(j({ Regions: [{ RegionName: "ap-northeast-2", OptInStatus: "opt-in-not-required" }] }));
    if (key.startsWith("aws service-quotas")) return out(j({ Quota: { Value: 5 } }));
    if (key.startsWith("aws rds describe-db-engine-versions")) return out(j(["16.3"]));
    if (key.startsWith("aws")) return out("0");
    return { code: 1, stdout: "", stderr: `unexpected ${key}`, ms: 1 };
  };
}
const BASE = { AWS_REGION: "ap-northeast-2", AWS_PROFILE: "finals", AWS_ACCESS_KEY_ID: "AKIAOWN", AWS_SESSION_TOKEN: "own-token", AWS_DEFAULT_PROFILE: "x", PATH: "/bin" } as NodeJS.ProcessEnv;
const IN: PrecheckInput = {
  source: { side: "source", provider: "aws", accountId: "111111111111" }, target: { side: "target", provider: "aws", accountId: "222222222222" },
  sourcePgMajor: 16, sourceDbBytes: 1, endpoints: [],
};
const mkDeps = (calls: Call[], accounts: { src: string; tgt: string; own: string }, sideEnv?: PrecheckDeps["sideEnv"]): PrecheckDeps => ({
  exec: fakeExec(calls, accounts), env: BASE, tcp: async () => ({ ok: true, ms: 1 }), diskFree: async () => 50 * 1024 ** 3, ...(sideEnv ? { sideEnv } : {}) });
const side = (name: "src" | "tgt") => envFor({ AWS_CONFIG_FILE: `/tmp/${name}/config`, AWS_REGION: "ap-northeast-2" }, BASE);
const A = { src: "111111111111", tgt: "222222222222", own: "999999999999" };

test("한쪽만 빌림(도착만): 도착 조회는 빌린 자격, 출발 확인은 프로세스 env 그대로", async () => {
  const calls: Call[] = [];
  const cs = await runCloudPrecheck(IN, mkDeps(calls, { ...A, own: "111111111111" }, { target: side("tgt") }));
  const by = new Map(cs.map((c) => [c.id, c]));
  assert.equal(by.get("PC-CRED-S")!.verdict, "PASS", by.get("PC-CRED-S")!.reason);
  assert.equal(by.get("PC-CRED-T")!.verdict, "PASS", by.get("PC-CRED-T")!.reason);
  const ident = calls.filter((c) => c.key.startsWith("aws sts get-caller-identity"));
  assert.equal(ident.filter((c) => c.env.AWS_PROFILE === "finals").length, 1, "출발 = 워커 프로필");
  assert.equal(ident.filter((c) => c.env.AWS_CONFIG_FILE === "/tmp/tgt/config").length, 1, "도착 = 빌린 자격");
});

test("거부: 도착 빌린 자격의 계정이 등록과 다르면 FAIL, 그 뒤 도착 API·결제·할당량 조회는 부르지 않는다", async () => {
  const calls: Call[] = [];
  const cs = await runCloudPrecheck(IN, mkDeps(calls, { ...A, tgt: "555555555555" }, { source: side("src"), target: side("tgt") }));
  const by = new Map(cs.map((c) => [c.id, c]));
  assert.equal(by.get("PC-CRED-T")!.verdict, "FAIL");
  assert.equal(by.get("PC-SKIP")!.verdict, "FAIL");
  assert.equal(calls.filter((c) => /service-quotas|describe-regions/.test(c.key)).length, 0, "건너뜀");
  assert.equal(by.get("PC-CRED-S")!.verdict, "PASS", "출발은 출발 자격으로 PASS");
});

test("불변: sideEnv 는 워커 env 를 고치지 않고, 워커 자기 자격(프로필·키·세션 토큰)이 빌린 env 에 안 섞인다", async () => {
  const snapshot = j(BASE);
  const s = side("src");
  assert.equal(j(BASE), snapshot);
  for (const k of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN"]) assert.equal(s[k], undefined, k);
  assert.equal(s.PATH, "/bin");
  const calls: Call[] = [];
  await runCloudPrecheck(IN, mkDeps(calls, A, { source: s, target: side("tgt") }));
  assert.equal(j(BASE), snapshot, "점검 뒤에도 워커 env 그대로");
  assert.ok(calls.every((c) => !JSON.stringify(c.env).includes("own-token") || !c.key.startsWith("aws")), "aws 호출 env 에 워커 세션 토큰 없음");
});

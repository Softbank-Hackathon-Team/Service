// 출발 RDS 관리 비밀(aws-sm:) 읽기: 빌린 출발 실행 자격으로만, 값은 메모리 Map 으로만, 오류 글자에 값 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Exec, ExecResult } from "@svc/adapters";
import { fetchManagedSecrets, managedSecretArns, readManagedSecret, ManagedSecretError } from "../src/relay/source-secret.js";

const ARN = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-0a1b2c3d-AbCdEf";
const PW = "s3cr3t-Value-from-RDS";
const T = "11111111-1111-4111-8111-111111111111", M = "22222222-2222-4222-8222-222222222222";
const mig = { id: M, status: "syncing" as const, sourceEnvId: "s", targetEnvId: "t" };

type Call = { cmd: string; args: string[]; env: NodeJS.ProcessEnv };
function fakeExec(res: Partial<ExecResult>) {
  const calls: Call[] = [];
  const exec = (async (cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: o.env ?? {} });
    return { code: 0, stdout: "", stderr: "", ...res } as ExecResult;
  }) as unknown as Exec;
  return { exec, calls };
}
const ok = () => fakeExec({ stdout: `${JSON.stringify({ username: "app", password: PW })}\n` });

test("ARN 고르기: 출발 줄의 aws-sm 만, 중복 없이 (도착 줄·env·derive·틀린 문법은 안 고름)", () => {
  assert.deepEqual(managedSecretArns([
    { side: "source", passwordRef: `aws-sm:${ARN}` }, { side: "source", passwordRef: `aws-sm:${ARN}` },
    { side: "target", passwordRef: `aws-sm:${ARN}x` }, { side: "source", passwordRef: "env:REPL_SECRET_SRC_X" },
    { side: "source", passwordRef: "derive:migrate" }, { side: "source", passwordRef: "aws-sm:not-an-arn" },
  ]), [ARN]);
});

test("읽기: 그 ARN 의 리전으로 get-secret-value 를 부르고 password 칸만 돌려준다", async () => {
  const f = ok();
  assert.equal(await readManagedSecret(ARN, { env: { A: "1" }, exec: f.exec }), PW);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.args, ["secretsmanager", "get-secret-value", "--secret-id", ARN, "--query", "SecretString", "--output", "text", "--region", "ap-northeast-2"]);
});

test("거부: 권한 없음은 연결 스택 안내, 모양이 틀린 비밀은 실패. 오류 글자에 값이 없다", async () => {
  const denied = fakeExec({ code: 254, stderr: "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: not authorized" });
  await assert.rejects(readManagedSecret(ARN, { env: {}, exec: denied.exec }), (e: unknown) => {
    assert.ok(e instanceof ManagedSecretError);
    assert.equal(e.awsCode, "AccessDeniedException");
    assert.match(e.message, /SourceDbInstanceId/);
    return true;
  });
  const bad = fakeExec({ stdout: JSON.stringify({ username: "app" }) });
  await assert.rejects(readManagedSecret(ARN, { env: {}, exec: bad.exec }), /password 칸 없음/);
  const notJson = fakeExec({ stdout: PW });
  await assert.rejects(readManagedSecret(ARN, { env: {}, exec: notJson.exec }), (e: unknown) => !(e as Error).message.includes(PW));
});

test("빌린 자격으로만: 출발 실행 자격 env 로 부르고 워커 자기 자격 키는 지운다, 결과는 Map", async () => {
  const f = ok();
  const got = await fetchManagedSecrets({ tenantId: T, migrationId: M }, mig, [ARN], {
    env: { AWS_ACCESS_KEY_ID: "worker-own", AWS_PROFILE: "worker", PATH: "/usr/bin" }, exec: f.exec, realSts: true,
    borrow: async (fn) => fn({ awsEnv: { source: { AWS_CONFIG_FILE: "/tmp/borrowed", AWS_PROFILE: "borrowed" } }, denied: [] }),
  });
  assert.equal(got.get(ARN), PW);
  const env = f.calls[0]!.env;
  assert.equal(env.AWS_CONFIG_FILE, "/tmp/borrowed");
  assert.equal(env.AWS_PROFILE, "borrowed");
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
});

test("거부: 역할을 못 빌렸거나, 진짜 발급기인데 자격이 없으면 고객 비밀을 읽지 않는다 (aws 안 부름)", async () => {
  const f = ok();
  await assert.rejects(fetchManagedSecrets({ tenantId: T, migrationId: M }, mig, [ARN], {
    exec: f.exec, realSts: true, borrow: async (fn) => fn({ denied: [{ side: "source", purpose: "operate", code: "ROLE_NO_CEILING" }] }) }), /ROLE_NO_CEILING/);
  await assert.rejects(fetchManagedSecrets({ tenantId: T, migrationId: M }, mig, [ARN], {
    exec: f.exec, realSts: true, borrow: async (fn) => fn({ denied: [] }) }), /자격이 없다/);
  assert.equal(f.calls.length, 0);
  // ARN 이 없으면 역할도 안 빌린다
  let borrowed = false;
  const none = await fetchManagedSecrets({ tenantId: T, migrationId: M }, mig, [], { borrow: async (fn) => { borrowed = true; return fn({ denied: [] }); } });
  assert.equal(none.size, 0);
  assert.equal(borrowed, false);
});

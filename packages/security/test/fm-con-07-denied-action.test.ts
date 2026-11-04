// FM-CON-07: AssumeRole 거부 원문에서 막힌 동작만 뽑는다 (계정·ARN 은 버림)
import { test } from "node:test";
import assert from "node:assert/strict";
import { awsCliSts, StsCliError } from "../src/index.js";

const stderr = (a: string) => `An error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:sts::111122223333:assumed-role/w/x is not authorized to perform: ${a} on resource: arn:aws:iam::444455556666:role/svc-observe`;

test("거부된 동작(TagSession·SetSourceIdentity·AssumeRole)을 StsCliError.deniedAction 에, 메시지에 계정 번호 없음", async () => {
  for (const a of ["sts:TagSession", "sts:SetSourceIdentity", "sts:AssumeRole"]) {
    const sts = awsCliSts({ run: async () => ({ code: 254, stdout: "", stderr: stderr(a) }), env: {} });
    const e = await sts.assumeRole({ RoleArn: "arn:aws:iam::444455556666:role/svc-observe", RoleSessionName: "s", DurationSeconds: 900 }).catch((x) => x);
    assert.ok(e instanceof StsCliError);
    assert.equal(e.awsCode, "AccessDenied"); assert.equal(e.deniedAction, a);
    assert.ok(!/\d{12}/.test(e.message), e.message);
  }
});

test("거부: 원문에 동작이 없으면 null (지어내지 않음)", async () => {
  const sts = awsCliSts({ run: async () => ({ code: 254, stdout: "", stderr: "An error occurred (ExpiredToken) when calling the AssumeRole operation: expired" }), env: {} });
  const e = await sts.assumeRole({ RoleArn: "r", RoleSessionName: "s", DurationSeconds: 900 }).catch((x) => x);
  assert.equal(e.deniedAction, null);
});

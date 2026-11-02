// OBSROLE: 가져오기가 관찰 역할을 빌릴 때 요청하는 동작 목록 — 깃발 off 는 지금 그대로, v2 는 데이터 읽기가 더해지고 최소 권한 검사를 통과한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AWS_DATA_READ_ACTIONS, ECS_OBSERVE_ACTIONS } from "@svc/adapters";
import { checkLeastPrivilege } from "@svc/security";
import { IMPORT_OBSERVE_ACTIONS, importObserveActions } from "../src/jobs/import.js";

const withFlag = <T>(v: string | undefined, f: () => T): T => {
  const old = process.env.IMPORT_IR;
  if (v === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = v;
  try { return f(); } finally { if (old === undefined) delete process.env.IMPORT_IR; else process.env.IMPORT_IR = old; }
};
const req = (actions: string[]) => ({ tenantId: "t", envId: "e", provider: "aws" as const, purpose: "observe" as const, actions, ttlSec: 3600 });

test("깃발 없음·v1·빈 값은 지금 목록 그대로 (S3·SQS·캐시 동작 0)", () => {
  for (const v of [undefined, "v1", "", "  "]) {
    const a = withFlag(v, importObserveActions);
    assert.deepEqual(a, IMPORT_OBSERVE_ACTIONS);
    assert.ok(!a.some((x) => /^(s3|sqs|elasticache|cloudwatch):/.test(x)));
  }
});

test("IMPORT_IR=v2(앞뒤 공백 허용) 이면 데이터 읽기 12개가 더해지고, 최소 권한 검사(와일드카드·쓰기 금지)를 통과", () => {
  for (const v of ["v2", " v2 "]) {
    const a = withFlag(v, importObserveActions);
    // I9: ECS 출발 읽기(목록·설명만)도 더해진다
    assert.deepEqual(a, [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS]);
    assert.equal(new Set(a).size, a.length);
    assert.doesNotThrow(() => checkLeastPrivilege(req(a)));
  }
});

test("거부: 데이터 쓰기·객체 읽기 동작을 섞으면 관찰 역할 요청이 거부됨", () => {
  assert.throws(() => checkLeastPrivilege(req([...AWS_DATA_READ_ACTIONS, "s3:PutObject"])), /ROLE_OBSERVE_WRITE|쓰기/);
  assert.throws(() => checkLeastPrivilege(req(["s3:*"])), /와일드카드/);
});

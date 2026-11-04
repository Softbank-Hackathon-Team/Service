// DRAFT(ai) 관찰 권한 넓힘 시험: 가져오기 갈래가 쓸 읽기 권한이 연결 템플릿·스크립트에 들어갔고, 읽기만이다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AWS_OBSERVE_PENDING } from "../src/common/observe-pending.js";

const tpl = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));

test("AWS 관찰 인라인에 DNS·데이터 읽기 권한이 있다, 전부 List·Get", () => {
  const acts: string[] = tpl.Resources.ObserveRole.Properties.Policies[0].PolicyDocument.Statement[0].Action;
  for (const a of AWS_OBSERVE_PENDING) assert.ok(acts.includes(a), a);
  for (const a of AWS_OBSERVE_PENDING) assert.match(a, /:(List|Get)/, a);
  // 거부: 실행 역할에는 들어가지 않는다 (관찰 전용)
  const op = JSON.stringify(tpl.Resources.OperatePolicy.Properties.PolicyDocument);
  for (const a of AWS_OBSERVE_PENDING) assert.ok(!op.includes(a), `실행 역할에 ${a}`);
});


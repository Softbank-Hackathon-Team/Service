// RV-13: 워커·API 로그 가리기(scrubString)가 감사 쪽에만 있던 모양도 가린다. 숫자·평범한 글은 그대로
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubString } from "../src/obs/log.js";

test("RV-13 로그: ya29·GitHub 토큰·PGPASSWORD=·DB_PASSWORD=·AWS_SESSION_TOKEN=·ARN 계정 번호를 가림", () => {
  const s = "gcp ya29.a0AfH6SMBexampleexample gh ghp_abcdefghijklmnopqrstuvwxyz0123 PGPASSWORD=hunter2xyz DB_PASSWORD=hunter2xyz AWS_SESSION_TOKEN=IQoJb3JpZ2lu User: arn:aws:sts::123456789012:assumed-role/svc-operate/s";
  const out = scrubString(s);
  assert.doesNotMatch(out, /ya29\.a0|ghp_abc|hunter2xyz|IQoJb3|123456789012/, out);
  assert.match(out, /arn:aws:sts::<account>:assumed-role\/svc-operate/);
});

test("RV-13 거부: 비밀 아닌 글(숫자 칸·포트·평범한 낱말)은 그대로", () => {
  for (const s of ["input_tokens=120 max_tokens=4096", "connect ECONNREFUSED 10.0.1.5:5432", "token bucket refilled", "secret:db-AbCdEf"]) assert.equal(scrubString(s), s);
});

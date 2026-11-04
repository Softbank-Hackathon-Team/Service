// RV-13: 실제 환경 변수 이름(밑줄 붙은 비밀 낱말)·JSON 꼴·camelCase 칸 이름도 감사 가리기에 걸린다. 비밀 아닌 칸은 그대로
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactAuditValue } from "../src/index.js";

test("RV-13 문구 속 키=값: 밑줄 뒤 비밀 낱말·JSON 꼴도 가림", () => {
  for (const s of ["DB_PASSWORD=hunter2xyz", "TF_VAR_db_password=hunter2xyz", "AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEXAMPLE", "CLOUDFLARE_API_TOKEN=abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "PGPASSWORD=hunter2xyz", '{"password":"hunter2xyz"}', "{'db_password': 'hunter2xyz'}"]) {
    const out = redactText(s);
    assert.doesNotMatch(out, /hunter2xyz|IQoJb3|abcdefabcdef|wJalrXUtn/, `${s} → ${out}`);
  }
});

test("RV-13 거부: ARN 자원 이름(secret:db)·tokenId 같은 칸 이름·숫자 칸 값은 안 가림", () => {
  assert.equal(redactText("arn:aws:secretsmanager:ap-northeast-2:<account>:secret:db-AbCdEf"), "arn:aws:secretsmanager:ap-northeast-2:<account>:secret:db-AbCdEf");
  const v = redactAuditValue({ input_tokens: 10, max_tokens: 20, token_count: 3, tokenId: "t1", passwordSet: true, hasPassword: false });
  assert.deepEqual(v, { input_tokens: 10, max_tokens: 20, token_count: 3, tokenId: "t1", passwordSet: true, hasPassword: false });
});

test("RV-13 칸 이름: AWS_SESSION_TOKEN·cloudflareApiToken·ExternalId·TF_VAR_db_password 값은 가림", () => {
  const v = redactAuditValue({ AWS_SESSION_TOKEN: "y1", cloudflareApiToken: "y2", ExternalId: "y3", externalId: "y4", TF_VAR_db_password: "y5", password: "y6", keep: "ok" }) as Record<string, unknown>;
  assert.ok(Object.entries(v).filter(([k]) => k !== "keep").every(([, x]) => !String(x).startsWith("y")), JSON.stringify(v));
  assert.equal(v.keep, "ok");
});

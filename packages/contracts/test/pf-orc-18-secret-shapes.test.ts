// PF FM-ORC-18: terraform·gcloud 오류 꼬리에 실리는 비밀 모양을 감사(redactText)·로그(scrubString) 가 둘 다 가린다
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactSecretShapes } from "../src/index.js";

const LEAK: [string, RegExp][] = [
  ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", /wJalrXUtnFEMI/],
  ["cloudflare token 1234567890abcdef1234567890abcdef12345678 rejected", /1234567890abcdef12345678/],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", /MIIE/],
  ['{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQ","client_email":"sa@p.iam.gserviceaccount.com"}', /MIIE/],
  ["TF_VAR_db_password=hunter2hunter2", /hunter2/],
  ['db_password = "hunter2hunter2"', /hunter2/],
  ["redis://:hunter2hunter2@cache:6379", /hunter2/],
  ['"client_secret": "abcDEF123456"', /abcDEF123456/],
];
for (const [s, secret] of LEAK) test(`PF FM-ORC-18 정상: 가림 — ${s.slice(0, 40).replace(/\n/g, " ")}`, () => {
  assert.doesNotMatch(redactText(s), secret, redactText(s));
  assert.doesNotMatch(redactSecretShapes(s), secret);
});

test("PF FM-ORC-18 거부(지나치게 안 가림): git 커밋 번호·평범한 글·토큰 수 칸은 그대로", () => {
  const sha = "commit 9915b31023db520e4fc56442a9a71ce25664745f pushed";
  assert.equal(redactText(sha), sha);
  assert.equal(redactText("input_tokens: 1234"), "input_tokens: 1234");
  assert.equal(redactText("plan ok, 3 resources"), "plan ok, 3 resources");
  const tgt = "token:0b6c1f8e-3a2d-4c5b-9e7f-1a2b3c4d5e6f";
  assert.equal(redactText(tgt), tgt);   // 감사 target (토큰 번호는 비밀 아님)
});

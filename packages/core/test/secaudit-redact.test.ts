// SECAUDIT: 감사 detail 가림막 (redact.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactAuditValue, redactText, AUDIT_REDACTED } from "../src/redact.js";

const ACCT = "123456789012";

test("정상: 주소·계정 ID·토큰·비밀번호를 가린다", () => {
  const cases: Array<[string, string]> = [
    [`arn:aws:iam::${ACCT}:role/observe`, "arn:aws:iam::<account>:role/observe"],
    [`arn:aws:sts::${ACCT}:assumed-role/x/s1`, "arn:aws:sts::<account>:assumed-role/x/s1"],
    [`arn:aws:secretsmanager:ap-northeast-2:${ACCT}:secret:db-AbC`, "arn:aws:secretsmanager:ap-northeast-2:<account>:secret:db-AbC"],
    [`https://sqs.ap-northeast-2.amazonaws.com/${ACCT}/jobs`, "https://sqs.ap-northeast-2.amazonaws.com/<account>/jobs"],
    ["connect to db1.c9abc.ap-northeast-2.rds.amazonaws.com:5432 refused", `connect to ${AUDIT_REDACTED}:5432 refused`],
    ["redis r1.abc.0001.apn2.cache.amazonaws.com", `redis ${AUDIT_REDACTED}`],
    ["postgres://app:S3cr3t!@db:5432/x", `postgres://app:${AUDIT_REDACTED}@db:5432/x`],
    ["Authorization: Bearer abcdefghij.klmn", `Authorization: Bearer ${AUDIT_REDACTED}`],
    ["key AKIAABCDEFGHIJKLMNOP used", `key ${AUDIT_REDACTED} used`],
    ["sk-ant-api03-abcdefghijk", AUDIT_REDACTED],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", AUDIT_REDACTED],
    ["PGPASSWORD=hunter22 psql", `PGPASSWORD=${AUDIT_REDACTED} psql`],
    ["host 10.0.3.12 timeout", "host <ip> timeout"],
  ];
  for (const [i, o] of cases) assert.equal(redactText(i), o, i);
});

test("정상: 키 이름이 비밀이면 값 통째로, 중첩·배열도", () => {
  const r = redactAuditValue({ a: { password: "x", token: "t", secretAccessKey: "k", ok: true },
    list: [{ dsn: "postgres://u:p@h/d" }], passwordSet: true, password2: "keep" });
  assert.deepEqual(r, { a: { password: AUDIT_REDACTED, token: AUDIT_REDACTED, secretAccessKey: AUDIT_REDACTED, ok: true },
    list: [{ dsn: AUDIT_REDACTED }], passwordSet: true, password2: "keep" });
});

test("거부(안 가림): id·코드·숫자·CIDR·상태·출력 이름은 그대로 (감사 읽는 쪽이 깨지지 않게)", () => {
  const d = { jobId: "8f0e6c1a-1111-4222-8333-444455556666", from: "terraform", to: "runner", reachedPct: 50,
    failureCode: "APPLY_FAILED", precheck: [{ id: "PC-NET-01", level: "warn", message: "CIDR 10.0.0.0/16 겹침" }],
    outputs: ["db_address", "db_password_secret_id"], removed: 3, version: "1.12.2", planHash: "a".repeat(64),
    seq: 123456789012345, token: null };
  assert.deepEqual(redactAuditValue(d), d);
});

test("IA-1: 명령 꼴 비밀(redis-cli -a, mysqladmin -p붙임, --password) 가림, 포트(-p 6379·-P 3306)는 남김", () => {
  assert.equal(redactText("redis-cli -h 10.0.0.0/8 -a s3cr3t ping"), `redis-cli -h 10.0.0.0/8 -a ${AUDIT_REDACTED} ping`);
  assert.equal(redactText("mysqladmin -uroot -ps3cr3t ping"), `mysqladmin -uroot -p${AUDIT_REDACTED} ping`);
  assert.equal(redactText("app --password s3cr3t"), `app --password ${AUDIT_REDACTED}`);
  assert.equal(redactText("redis-cli -p 6379 ping"), "redis-cli -p 6379 ping");
  assert.equal(redactText("mysqladmin ping -P 3306"), "mysqladmin ping -P 3306");
});

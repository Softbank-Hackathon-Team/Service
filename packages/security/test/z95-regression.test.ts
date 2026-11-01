// 보안 회귀 비교 (Z95): 순수 함수만. DB·클라우드 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareLiveReports, judgeChange } from "../src/regression.js";
import { check, type LiveCheck, type LiveSecurityReport } from "../src/live/types.js";

const rep = (side: "source" | "target", checks: LiveCheck[]): LiveSecurityReport => ({
  side, provider: side === "source" ? "aws" : "gcp", envId: side === "source" ? "s" : "t",
  checkedAt: "2026-11-07T03:00:00.000Z", durationMs: 10, origin: "live", credentials: "ok", reason: null,
  summary: { pass: 0, warn: 0, fail: 0, unavailable: 0, na: 0 }, checks,
});

test("judgeChange: pass > warn > fail, 못 읽음·해당 없음·없음은 unknown", () => {
  assert.equal(judgeChange("pass", "fail"), "worse");
  assert.equal(judgeChange("pass", "warn"), "worse");
  assert.equal(judgeChange("warn", "fail"), "worse");
  assert.equal(judgeChange("fail", "pass"), "better");
  assert.equal(judgeChange("warn", "pass"), "better");
  assert.equal(judgeChange("warn", "warn"), "same");
  assert.equal(judgeChange("pass", "unavailable"), "unknown");
  assert.equal(judgeChange("n_a", "pass"), "unknown");
  assert.equal(judgeChange(null, "pass"), "unknown");
  assert.equal(judgeChange("fail", null), "unknown");
});

test("같은 열쇠끼리 비교, 나빠짐 먼저 정렬, 근거 두 줄을 같이 싣는다, 회귀 1개면 regressed", () => {
  const r = compareLiveReports(
    rep("source", [
      check("public_ports.db", "pass", "rds/x", "PubliclyAccessible=false", "aws rds describe-db-instances"),
      check("tls.db", "fail", "rds/x", "rds.force_ssl=0", "aws rds describe-db-parameters"),
      check("iam.app_identity", "warn", "role/app", "s3:* 1개", "aws iam get-role-policy"),
      check("secrets.workload", "pass", "ns/app", "평문 0", "kubectl get cm"),
    ]),
    rep("target", [
      check("public_ports.db", "fail", "sql/x", "0.0.0.0/0 허용", "gcloud sql instances describe"),
      check("tls.db", "pass", "sql/x", "requireSsl=true", "gcloud sql instances describe"),
      check("iam.app_identity", "unavailable", "-", "자격 없음", "gcloud projects get-iam-policy"),
      check("secrets.workload", "pass", "ns/app", "평문 0", "kubectl get cm"),
      check("storage_encryption.db", "pass", "sql/x", "Google 관리 키", "gcloud sql instances describe"),
    ]));
  assert.deepEqual(r.items.map((i) => [i.key, i.change]), [
    ["public_ports.db", "worse"], ["tls.db", "better"],
    ["storage_encryption.db", "unknown"], ["iam.app_identity", "unknown"], ["secrets.workload", "same"]]);
  assert.deepEqual(r.summary, { worse: 1, better: 1, same: 1, unknown: 2 });
  assert.equal(r.verdict, "regressed");
  const db = r.items[0]!;
  assert.deepEqual([db.before, db.after, db.beforeEvidence, db.afterEvidence, db.category, db.title],
    ["pass", "fail", "PubliclyAccessible=false", "0.0.0.0/0 허용", "public_ports", "DB 가 인터넷에 열려 있나"]);
  const enc = r.items.find((i) => i.key === "storage_encryption.db")!;
  assert.deepEqual([enc.before, enc.beforeEvidence], [null, null]);
});

test("나빠진 줄이 없으면 no_regression, 비교한 줄 0이면 unavailable, 한쪽 보고서 없음도 unavailable", () => {
  const ok = compareLiveReports(rep("source", [check("tls.ingress", "warn", "-", "-", "-")]),
    rep("target", [check("tls.ingress", "pass", "-", "-", "-")]));
  assert.equal(ok.verdict, "no_regression");
  const none = compareLiveReports(rep("source", [check("tls.ingress", "unavailable", "-", "-", "-")]),
    rep("target", [check("tls.ingress", "pass", "-", "-", "-")]));
  assert.equal(none.verdict, "unavailable");
  const half = compareLiveReports(null, rep("target", [check("tls.ingress", "pass", "-", "-", "-")]));
  assert.deepEqual([half.verdict, half.summary.unknown, half.items[0]!.before], ["unavailable", 1, null]);
  assert.deepEqual(compareLiveReports(null, null), { verdict: "unavailable", summary: { worse: 0, better: 0, same: 0, unknown: 0 }, items: [] });
});

test("같은 보고서에 같은 열쇠가 둘이면 먼저 온 줄을 쓴다", () => {
  const r = compareLiveReports(
    rep("source", [check("tls.db", "pass", "a", "first", "-"), check("tls.db", "fail", "b", "second", "-")]),
    rep("target", [check("tls.db", "pass", "c", "x", "-")]));
  assert.deepEqual([r.items.length, r.items[0]!.change, r.items[0]!.beforeEvidence], [1, "same", "first"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../src/app/routes";
import { controlRows, securityHeadline, threatsFrom } from "../src/features/security/model";
import type { MatrixRow } from "../src/lib/security-types";

test("주소 해석: 모든 화면으로 간다", () => {
  assert.deepEqual(parseRoute(""), { page: "dashboard" });
  assert.deepEqual(parseRoute("#/"), { page: "dashboard" });
  assert.deepEqual(parseRoute("#/없는화면"), { page: "dashboard" });
  assert.deepEqual(parseRoute("#/environments"), { page: "environments", id: null });
  assert.deepEqual(parseRoute("#/environments/e1"), { page: "environments", id: "e1" });
  assert.deepEqual(parseRoute("#/security/m1"), { page: "security", id: "m1" });
  assert.deepEqual(parseRoute("#/audit"), { page: "audit", id: null });
  assert.deepEqual(parseRoute("#/agent/m1"), { page: "agent", id: "m1" });
  assert.deepEqual(parseRoute("#/settings"), { page: "settings" });
  assert.deepEqual(parseRoute("#/design-system"), { page: "designSystem" });
  assert.deepEqual(parseRoute("#/migrations"), { page: "migrations", view: "list" });
  assert.deepEqual(parseRoute("#/migrations/new"), { page: "migrations", view: "new" });
  assert.deepEqual(parseRoute("#/migrations/m1"), { page: "migrations", view: "detail", id: "m1" });
  assert.deepEqual(parseRoute("#/migrations/m1/cost"), { page: "migrations", view: "cost", id: "m1" });
});

const cell = (controlId: string, side: MatrixRow["side"], state: MatrixRow["state"]): MatrixRow =>
  ({ side, envKind: "aws", controlId, area: "a", title: controlId, state, topSeverity: null, basis: "static", reason: `${controlId}-${side}`, files: [] });

test("통제 표: 한 줄에 출발과 도착을 모으고, 없는 칸은 해당 없음이다", () => {
  const rows = controlRows([cell("C1", "source", "pass"), cell("C1", "target", "fail"), cell("C2", "source", "attested")]);
  assert.deepEqual(rows.map((r) => [r.id, r.source, r.target]), [["C1", "pass", "fail"], ["C2", "attested", "na"]]);
  assert.equal(rows[0]!.reason, "C1-target");
});

test("보안 머리말: 위반과 나빠짐은 경고, 위반 없으면 경고가 아니다", () => {
  const summary = (s: Partial<{ fail: number; warn: number; notImplemented: number }>) =>
    ({ summary: { ok: 1, warn: 0, fail: 0, notImplemented: 0, na: 0, ...s } });
  assert.equal(securityHeadline(null, null).stop, false);
  assert.equal(securityHeadline(summary({ fail: 2 }), null).stop, true);
  assert.equal(securityHeadline(summary({}), { verdict: "regressed", summary: { worse: 1, better: 0, same: 0, unknown: 0 } }).stop, true);
  assert.equal(securityHeadline(summary({ notImplemented: 3 }), null).stop, false);
  assert.match(securityHeadline(summary({}), null).title, /모두 지켜졌습니다/);
});

test("위협: 실패한 보안 보고만 모은다", () => {
  const threats = threatsFrom([null, { envId: "e", lastHeartbeatAt: null, stale: false, items: [
    { id: "1", kind: "security", receivedAt: "t", migrationId: null, report: { kind: "security", findings: [
      { status: "fail", severity: "high", resource: "db" }, { status: "pass", resource: "x" }] } },
    { id: "2", kind: "heartbeat", receivedAt: "t", migrationId: null, report: { kind: "heartbeat", k3sVersion: "1", cnpg: null } },
  ] }]);
  assert.deepEqual(threats.map((t) => [t.title, t.severity]), [["db", "high"]]);
});

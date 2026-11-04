import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../src/app/routes";
import { controlRows, ledgerOrder, ledgerSummary, securityCardSummary, securityHeadline, threatsFrom } from "../src/features/security/model";
import type { LedgerRow, MatrixRow } from "../src/lib/security-types";
import type { Finding } from "../src/lib/types";

test("주소 해석: 모든 화면으로 간다", () => {
  assert.deepEqual(parseRoute(""), { page: "dashboard" });
  assert.deepEqual(parseRoute("#/"), { page: "dashboard" });
  assert.deepEqual(parseRoute("#/없는화면"), { page: "dashboard" });
  assert.deepEqual(parseRoute("#/environments"), { page: "environments", id: null });
  assert.deepEqual(parseRoute("#/environments/e1"), { page: "environments", id: "e1" });
  // 보안 탭은 없어졌다. 예전 주소는 그 이전 화면(보안 카드가 있는 곳)으로 간다
  assert.deepEqual(parseRoute("#/security/m1"), { page: "migrations", view: "detail", id: "m1" });
  assert.deepEqual(parseRoute("#/security"), { page: "migrations", view: "list" });
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

const finding = (resource: string, status: Finding["status"], kind: Finding["kind"], severity: Finding["severity"] = "high"): Finding =>
  ({ tool: kind === "threat" ? "falco" : "kyverno", toolCheckId: `${resource}-check`, controlId: null, resource, status, severity, kind, observedAt: "t", evidence: `${resource} 근거` });

test("위협: 보안 보고 중 실패한 위협(kind: threat)만 모으고, 설정 위반은 뺀다", () => {
  const threats = threatsFrom([null, { envId: "e", lastHeartbeatAt: null, stale: false, items: [
    { id: "1", kind: "security", receivedAt: "t", migrationId: null, report: { kind: "security", findings: [
      finding("shell-in-pod", "fail", "threat"), finding("x", "pass", "threat"), finding("no-netpol", "fail", "posture", "medium")] } },
    { id: "2", kind: "heartbeat", receivedAt: "t", migrationId: null, report: { kind: "heartbeat", k3sVersion: "1", cnpg: null } },
  ] }]);
  assert.deepEqual(threats.map((t) => [t.title, t.severity, t.evidence]), [["shell-in-pod", "high", "shell-in-pod 근거"]]);
});

const ledger = (status: LedgerRow["status"], expiredButActive: boolean, issuedAt: string) => ({ status, expiredButActive, issuedAt });

test("임시 권한 장부: 만료됐는데 남은 것을 따로 세고 맨 위에 둔다", () => {
  const rows = [ledger("revoked", false, "1"), ledger("active", false, "2"), ledger("active", true, "0"), ledger("revoke_requested", false, "3"), ledger("expired", false, "4")];
  assert.deepEqual(ledgerSummary(rows), { total: 5, live: 2, closed: 2, stale: 1 });
  assert.deepEqual(ledgerOrder(rows).map((r) => r.issuedAt), ["0", "3", "2", "4", "1"]);
  assert.deepEqual(ledgerSummary([]), { total: 0, live: 0, closed: 0, stale: 0 });
});

test("이전 화면 보안 카드: 접힌 요약과 스스로 펼칠 때", () => {
  const view = (fail: number, warn: number, notImplemented = 0, ledger: { status: "active" | "revoked"; expiredButActive: boolean }[] | null = []) =>
    ({ summary: { ok: 10, warn, fail, notImplemented, na: 0 }, ledger: ledger as never });
  assert.deepEqual(securityCardSummary({ view: null, threats: 0, stoppedByRule: false, reading: true }), { summary: "읽는 중", open: false });
  assert.deepEqual(securityCardSummary({ view: view(2, 3), threats: 0, stoppedByRule: false, reading: false }), { summary: "위반 2 · 약점 3", open: false }, "위반·약점은 요약만");
  assert.deepEqual(securityCardSummary({ view: view(0, 0), threats: 0, stoppedByRule: false, reading: false }), { summary: "모두 지켜짐", open: false });
  assert.deepEqual(securityCardSummary({ view: view(0, 0, 4), threats: 0, stoppedByRule: false, reading: false }), { summary: "미구현 4", open: false });
  assert.deepEqual(securityCardSummary({ view: view(2, 3), threats: 1, stoppedByRule: true, reading: false }), { summary: "가드레일 멈춤 · 위협 1", open: true });
  const stale = view(0, 0, 0, [{ status: "active", expiredButActive: true }]);
  assert.deepEqual(securityCardSummary({ view: stale, threats: 0, stoppedByRule: false, reading: false }), { summary: "만료된 권한 1", open: true });
});

// 작업 Z18: GET /migrations/:id/security 응답 모양 (apps/api/src/security/schema.ts 와 같게 손으로 옮김)
// TODO(human): 화면 타입을 @svc/contracts 에서 가져올지 (types.ts 와 같은 문제)
export type SecState = "ok" | "warn" | "fail" | "not_implemented" | "n_a";
export type SecArea = "temp_credentials" | "least_privilege" | "audit" | "secrets" | "runtime" | "controls";
export interface SecRow {
  id: string; area: SecArea; item: string; scope: string; state: SecState;
  value: string; source: string; ref: string | null;
}
// 작업 Z39: 통제 12개 × 출발·도착 칸
export type CellState = "pass" | "fail" | "unknown" | "not_applicable" | "attested";
export interface MatrixRow {
  side: "source" | "target"; envKind: string; controlId: string; area: string; title: string;
  state: CellState; topSeverity: string | null; basis: "static" | "measured" | "none" | "n_a";
  reason: string; files: string[];
}
export interface SecurityView {
  viewVersion: 1;
  generatedAt: string;
  migration: { id: string; status: string };
  summary: { ok: number; warn: number; fail: number; notImplemented: number; na: number };
  rows: SecRow[];
  ledger: unknown[] | null;
  auditChain: { ok: boolean; checked: number; brokenAtSeq: number | null; reason: string | null; partial: boolean };
  tempRoleAudit: Record<string, number>;
  controlMatrix: MatrixRow[] | null;
  live?: LiveSecurityReport[] | null;   // Z91: 출발·도착 실제 점검. 없음/null = 서버가 끔
}
// 작업 Z91: 실제 점검 (packages/contracts/src/security.ts 와 같게 손으로 옮김)
export type LiveCheckState = "pass" | "warn" | "fail" | "unavailable" | "n_a";
export type LiveCheckCategory = "public_ports" | "storage_encryption" | "tls" | "iam" | "secrets";
export interface LiveCheck {
  key: string; category: LiveCheckCategory; title: string; resource: string;
  state: LiveCheckState; evidence: string; source: string;
}
export interface LiveSecurityReport {
  side: "source" | "target"; provider: string; envId: string; checkedAt: string; durationMs: number;
  origin: "live" | "snapshot"; credentials: "ok" | "unavailable" | "n_a"; reason: string | null;
  summary: { pass: number; warn: number; fail: number; unavailable: number; na: number };
  checks: LiveCheck[];
}
export interface LiveCheckResult { migrationId: string; source: LiveSecurityReport | null; target: LiveSecurityReport | null; recorded: boolean }

// 작업 Z95: GET /migrations/:id/security/regression 응답 모양 (packages/contracts/src/security.ts SecurityRegression 과 같게 손으로 옮김)
// 출발·도착 실점검(Z91)을 열쇠별로 비교. worse = 도착이 더 나쁨(회귀) / unknown = 한쪽이라도 못 읽음·해당 없음
export type RegressionChange = "worse" | "better" | "same" | "unknown";
export interface RegressionItem {
  key: string; category: string; title: string;
  before: LiveCheckState | null; after: LiveCheckState | null; change: RegressionChange;
  beforeEvidence: string | null; afterEvidence: string | null;
}
export interface SecurityRegressionReportHead {
  side: "source" | "target"; provider: string; envId: string; checkedAt: string; origin: "live" | "snapshot";
}
export interface SecurityRegression {
  regressionVersion: 1; migrationId: string; generatedAt: string;
  verdict: "regressed" | "no_regression" | "unavailable";
  summary: { worse: number; better: number; same: number; unknown: number };
  source: SecurityRegressionReportHead | null; target: SecurityRegressionReportHead | null;
  items: RegressionItem[]; recorded: boolean;
}

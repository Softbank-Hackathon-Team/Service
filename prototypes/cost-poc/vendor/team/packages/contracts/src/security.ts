import { z } from "zod";
import { Provider } from "./common.js";

// Z91: 보안 실제 점검 + 보안 회귀 계약.
//   GET  /api/v1/migrations/:id/security             → SecurityView.live (출발·도착 LiveSecurityReport)
//   POST /api/v1/migrations/:id/security/regression  → SecurityRegression (지금 점검 + 감사에 스냅숏 + 출발↔도착 비교)
// 원칙: 가짜 값 없음. 클라우드·k8s 를 실제로 읽지 못하면 state = "unavailable" 과 이유. 응답에 비밀값·계정 번호 없음.
// 점검 코드는 packages/security/src/live (이 파일의 타입과 같은 모양의 순수 TS 타입, 시험에서 서로 대입해 맞춘다)

// pass = 실제로 읽었고 지켜짐 / warn = 읽었고 알려진 약점 / fail = 읽었고 위반
// unavailable = 못 읽음(자격 없음·CLI 없음·자원 없음·STUB 자원) / n_a = 이 환경에는 해당 없음
export const LiveCheckState = z.enum(["pass", "warn", "fail", "unavailable", "n_a"]);
export type LiveCheckState = z.infer<typeof LiveCheckState>;

// 코디 지시 5영역: 공개 포트(보안그룹·방화벽·k8s Service) / 저장소 암호화 / TLS 종단 / IAM 과다 권한 / 시크릿 노출
export const LiveCheckCategory = z.enum(["public_ports", "storage_encryption", "tls", "iam", "secrets"]);
export type LiveCheckCategory = z.infer<typeof LiveCheckCategory>;

// 비교 열쇠. 클라우드가 달라도 "같은 질문"이면 같은 열쇠 (예: AWS RDS 와 Cloud SQL 은 둘 다 public_ports.db)
export const LiveCheckKey = z.enum([
  "public_ports.db", "public_ports.network", "public_ports.cluster_api", "public_ports.services",
  "storage_encryption.db", "storage_encryption.k8s_secrets",
  "tls.db", "tls.ingress",
  "iam.app_identity", "iam.k8s_rbac",
  "secrets.db_credential", "secrets.workload",
]);
export type LiveCheckKey = z.infer<typeof LiveCheckKey>;

export const LiveCheck = z.object({
  key: LiveCheckKey,
  category: LiveCheckCategory,
  title: z.string(),            // 사람이 읽는 항목 이름
  resource: z.string(),         // 무엇을 봤나 (RDS 주소·규칙 이름·네임스페이스). 계정 번호는 가린다
  state: LiveCheckState,
  evidence: z.string(),         // 근거 한 줄 (읽은 값 요약). 비밀값 없음
  source: z.string(),           // 어떤 읽기 API 를 불렀나 (예: "aws rds describe-db-instances")
}).strict();
export type LiveCheck = z.infer<typeof LiveCheck>;

export const LiveSecurityReport = z.object({
  side: z.enum(["source", "target"]),
  provider: Provider,
  envId: z.string(),
  checkedAt: z.string(),
  durationMs: z.number().int(),
  // live = 지금 읽음 / snapshot = 지금 못 읽어서 감사에 남은 마지막 점검을 씀 (출발 환경을 지운 뒤 등)
  origin: z.enum(["live", "snapshot"]),
  credentials: z.enum(["ok", "unavailable", "n_a"]),   // n_a = 클라우드 자격이 필요 없는 환경 (온프레 k8s 만)
  reason: z.string().nullable(),                        // 전체를 못 읽은 이유 (자격 없음 등)
  summary: z.object({ pass: z.number().int(), warn: z.number().int(), fail: z.number().int(),
    unavailable: z.number().int(), na: z.number().int() }).strict(),
  checks: z.array(LiveCheck),
}).strict();
export type LiveSecurityReport = z.infer<typeof LiveSecurityReport>;

// 출발 → 도착 비교 한 줄. worse = 도착이 더 나쁨(회귀) / better / same / unknown = 한쪽이라도 못 읽음·해당 없음
export const RegressionChange = z.enum(["worse", "better", "same", "unknown"]);
export type RegressionChange = z.infer<typeof RegressionChange>;

export const RegressionItem = z.object({
  key: LiveCheckKey,
  category: LiveCheckCategory,
  title: z.string(),
  before: LiveCheckState.nullable(),   // null = 출발 쪽에 이 점검이 없음
  after: LiveCheckState.nullable(),
  change: RegressionChange,
  beforeEvidence: z.string().nullable(),
  afterEvidence: z.string().nullable(),
}).strict();
export type RegressionItem = z.infer<typeof RegressionItem>;

export const SecurityRegression = z.object({
  regressionVersion: z.literal(1),
  migrationId: z.string(),
  generatedAt: z.string(),
  // regressed = 나빠진 줄 1개 이상 / no_regression = 비교한 줄 중 나빠진 것 없음 / unavailable = 비교한 줄 0
  verdict: z.enum(["regressed", "no_regression", "unavailable"]),
  summary: z.object({ worse: z.number().int(), better: z.number().int(), same: z.number().int(), unknown: z.number().int() }).strict(),
  source: LiveSecurityReport.nullable(),   // null = 출발 쪽 점검도 스냅숏도 없음
  target: LiveSecurityReport.nullable(),
  items: z.array(RegressionItem),
  recorded: z.boolean(),                   // 이번 점검을 감사(security.live_check)에 남겼나
}).strict();
export type SecurityRegression = z.infer<typeof SecurityRegression>;

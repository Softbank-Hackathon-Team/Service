import { z } from "zod";
import { LiveSecurityReport, MigrationStatus } from "@svc/contracts";
import { ChainCheck } from "../report/schema.js";

// 보안 시각화(데모 장면 "보안"): 이전 한 건에 대해 "지금 무엇이 지켜지고 있고, 무엇이 아직 안 되나"를 한 표로.
// 원칙: 가짜 값 없음. 확인할 재료가 없으면 state = not_implemented 로 적고 이유를 쓴다.
// DRAFT(ai): 경계 계약이라 원래 packages/contracts 에 둬야 한다. 공유 파일을 안 고치려고 report 처럼 api 안에 임시로 둔다

// ok = 확인했고 지켜짐 / warn = 확인했고 알려진 약점 / fail = 확인했고 위반
// not_implemented = 확인할 코드·표가 아직 없음 / n_a = 이 이전에는 해당 없음 (예: 온프레가 없는 이전의 k3d)
export const SecState = z.enum(["ok", "warn", "fail", "not_implemented", "n_a"]);
export type SecState = z.infer<typeof SecState>;

export const SecArea = z.enum(["temp_credentials", "least_privilege", "audit", "secrets", "runtime", "controls"]);
export type SecArea = z.infer<typeof SecArea>;

export const SecRow = z.object({
  id: z.string(),                 // 화면·시험에서 줄을 찾는 고정 이름 (예: TC-LEDGER)
  area: SecArea,
  item: z.string(),               // 사람이 읽는 항목 이름
  scope: z.string(),              // 어느 환경·파일에 대한 줄인가 (예: "도착 aws", "전체")
  state: SecState,
  value: z.string(),              // 한 줄 결과 (숫자 위주). 비밀값·계정 번호는 절대 안 넣는다
  source: z.string(),             // 어디서 읽었나 (표 이름, 파일 경로, 환경 변수 이름)
  ref: z.string().nullable(),     // 위협 모델·통제 번호 (T-ROLE-8, SEC-AUD-02 …)
}).strict();
export type SecRow = z.infer<typeof SecRow>;

// 임시 자격 장부 한 줄. 값(키·토큰)은 표에도 응답에도 없다
export const LedgerRow = z.object({
  credentialRef: z.string(),
  provider: z.string(),
  purpose: z.enum(["observe", "operate"]),
  stage: z.string().nullable(),
  status: z.enum(["active", "revoke_requested", "revoked", "expired"]),   // expired = 0013 (Z39)
  step: z.string().nullable(),    // 빌린 작업 단계 (0013). 0013 전 DB 면 null
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  ttlSec: z.number().int(),
  expiredButActive: z.boolean(),
}).strict();
export type LedgerRow = z.infer<typeof LedgerRow>;

// 통제 매트릭스 칸 하나 (Z39): 환경 × 통제. packages/security controlMatrix() 결과에서 파일 경로·근거 문구만 남긴다
export const MatrixRow = z.object({
  side: z.enum(["source", "target"]),
  envKind: z.string(),
  controlId: z.string(),
  area: z.string(),
  title: z.string(),
  state: z.enum(["pass", "fail", "unknown", "not_applicable", "attested"]),
  topSeverity: z.string().nullable(),
  basis: z.enum(["static", "measured", "none", "n_a"]),   // 정적(레포 파일) / 실측(감사 체인) / 근거 없음 / 해당 없음
  reason: z.string(),
  files: z.array(z.string()),
}).strict();
export type MatrixRow = z.infer<typeof MatrixRow>;

export const SecurityView = z.object({
  viewVersion: z.literal(1),
  generatedAt: z.string(),
  migration: z.object({ id: z.string(), status: MigrationStatus }).strict(),
  summary: z.object({
    ok: z.number().int(), warn: z.number().int(), fail: z.number().int(),
    notImplemented: z.number().int(), na: z.number().int(),
  }).strict(),
  rows: z.array(SecRow),
  ledger: z.array(LedgerRow).nullable(),          // null = 장부 표가 없음 (J2 통합 전)
  auditChain: ChainCheck,
  tempRoleAudit: z.record(z.string(), z.number().int()),  // temp_role.* 동작별 감사 줄 수 (이 이전 대상)
  controlMatrix: z.array(MatrixRow).nullable(),   // null = 증거 파일을 안 읽음 (Z39 전 재료)
  // Z91: 출발·도착 환경 실제 점검 (클라우드 읽기 API + k8s API). null = SEC_LIVE=0 으로 끔. 없음 = 예전 응답과 같은 모양(표 조립만)
  live: z.array(LiveSecurityReport).nullable().optional(),
}).strict();
export type SecurityView = z.infer<typeof SecurityView>;

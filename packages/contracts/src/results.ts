import { z } from "zod";

// GitOps 배포 결과
export const DeployResult = z.object({
  bundleHash: z.string(),
  status: z.enum(["synced_healthy", "applied", "failed"]),
  resources: z.array(z.string()),     // 예: Deployment/app/web
  reason: z.string().optional(),      // 실패 이유 그대로
}).strict();
export type DeployResult = z.infer<typeof DeployResult>;

// 트래픽 판정 한 번 (감사에 입력값 그대로 남긴다)
export const TrafficJudgement = z.object({
  migrationId: z.uuid(),
  stepPct: z.number().int(),
  samples: z.number().int(),
  target5xx: z.number().int(),
  targetErrorRatePct: z.number(),
  sourceErrorRatePct: z.number(),
  targetP95Ms: z.number(),
  sourceP95Ms: z.number(),
  latencyMeasured: z.boolean().optional(),   // false = 도착 응답 시간 지표가 없어 오류율로만 판정. 이때 p95 칸의 0 은 값이 아니다
  verdict: z.enum(["ok", "hold", "bad", "bad_shortcut"]),
  at: z.string(),
}).strict();
export type TrafficJudgement = z.infer<typeof TrafficJudgement>;

// 트래픽 전환 한 번의 판정 요약. 워커 shift 가 감사 detail.trafficSummary 로 남기고 증적 리포트 traffic 이 읽는다
// (판정 배열 전체는 100% 관찰만 수십 개라 감사 줄에 넣지 않는다). 판정이 없으면 최대값 두 칸은 null
export const TrafficSummary = z.object({
  judgements: z.number().int(),
  steps: z.array(z.number().int()),   // 지나간 가중치(%), 처음 나온 순서
  bad: z.number().int(),              // bad + bad_shortcut 판정 수
  maxTargetErrorRatePct: z.number().nullable(),
  maxTargetP95Ms: z.number().nullable(),
}).strict();
export type TrafficSummary = z.infer<typeof TrafficSummary>;

// z75-38: 트래픽 전환 진행 (GET /migrations/:id/traffic-shift). 화면 "목표 가중치 / 실측 비율" 두 칸
// 단위는 % 정수 0~100. 실측 = 지표 창의 도착 요청 수 / 전체. reached: 실측이 목표 ±tolerancePct 안 (null = 아직 실측 없음)
// available=false 면 이 이전에 shift 기록이 없다 (나머지 칸은 null·0)
export const TrafficShiftProgress = z.object({
  migrationId: z.uuid(),
  available: z.boolean(),
  targetWeightPct: z.number().int().min(0).max(100).nullable(),
  observedWeightPct: z.number().int().min(0).max(100).nullable(),
  reached: z.boolean().nullable(),
  tolerancePct: z.number().int(),
  reobserve: z.number().int().min(0),
  stepStartedAt: z.string().nullable(),
  observedAt: z.string().nullable(),
}).strict();
export type TrafficShiftProgress = z.infer<typeof TrafficShiftProgress>;

// 보안 도구 결과를 한 모양으로
export const Finding = z.object({
  tool: z.enum(["prowler", "kyverno", "trivy", "guardduty",
    "scc", "falco", "agent_script", "audit_verify"]),
  toolCheckId: z.string(),
  controlId: z.string().nullable(),   // 예: SEC-VIO-04, 없으면 null
  resource: z.string(),
  status: z.enum(["pass", "fail", "unknown"]),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  kind: z.enum(["posture", "threat"]),
  observedAt: z.string(),
  evidence: z.string().max(2000),
}).strict();
export type Finding = z.infer<typeof Finding>;

// 매트릭스 칸 하나 (환경 × 통제)
export const MatrixCell = z.object({
  envId: z.uuid(),
  controlId: z.string(),
  state: z.enum(["pass", "fail", "unknown", "not_applicable", "attested"]),
  reason: z.string(),
  topSeverity: z.string().nullable(),
  count: z.number().int(),
  lastObservedAt: z.string().nullable(),
}).strict();

// 가드레일 발동 한 건
export const GuardrailEvent = z.object({
  migrationId: z.uuid(),
  ruleId: z.string(),                 // 예: MG-2-07
  controlId: z.string().nullable(),
  action: z.enum(["warn", "pause_migration", "auto_revert"]),
  evidence: z.string(),
  at: z.string(),
}).strict();

// 에이전트 마무리 도구가 넘기는 것. PR은 플랫폼이 만든다
export const AgentFinish = z.object({
  outcome: z.enum(["proposed", "no_change", "gave_up"]),
  title: z.string().max(80),
  reason: z.string().max(2000),
  checked: z.array(z.string()).max(10),
  notDone: z.array(z.string()).max(10),
}).strict();
export type AgentFinish = z.infer<typeof AgentFinish>;

// 측정표 한 줄 (이름과 단위를 모두 맞춘다)
export const Measurement = z.object({
  migrationId: z.uuid(),
  name: z.string(),                   // 예: cutover_pause_ms
  value: z.number(),
  unit: z.enum(["ms", "s", "count", "pct", "rps"]),
  env: z.string(),
  at: z.string(),
}).strict();
export type Measurement = z.infer<typeof Measurement>;

// PA5a (계획 26 · A5a): AI 실행 종류 한 곳. agent_runs.kind CHECK(0025)와 같아야 한다
//   remediate = 샌드박스 점검·수정 제안, spec_draft = 명세 초안, failure_analysis = 실패 원인 분석(읽기 전용)
// agent-worker 의 손으로 쓴 AgentRunKind 타입을 이걸로 바꾸는 건 A5b (에이전트 워커 분기)
export const AgentRunKind = z.enum(["remediate", "spec_draft", "failure_analysis"]);
export type AgentRunKind = z.infer<typeof AgentRunKind>;

// 실패 원인 분석 결과 (agent_runs.result, kind = failure_analysis). AI 는 원인·고칠 것만 알려 주고 재시도는 사람이 누른다 (계획 26 3.2)
// DRAFT(ai): 칸 이름·길이 상한은 계획 26 A5a 안. confidence 는 0~1 (명세 칸 신뢰도 1/0.9/0.6 과 달리 연속값)
export const FailureAnalysis = z.object({
  cause: z.string().max(500),                    // 원인 한두 문장
  evidence: z.array(z.string().max(300)).max(10), // 근거 (감사 줄·실패 코드·작업 오류 요약에서)
  fix: z.array(z.string().max(300)).max(10),      // 사람이 할 일 (명세 수정·권한·쿼터 등)
  retryable: z.boolean(),                        // 고치지 않고 그냥 다시 해도 될 만한지
  confidence: z.number().min(0).max(1),
}).strict();
export type FailureAnalysis = z.infer<typeof FailureAnalysis>;

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
  verdict: z.enum(["ok", "hold", "bad", "bad_shortcut"]),
  at: z.string(),
}).strict();
export type TrafficJudgement = z.infer<typeof TrafficJudgement>;

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

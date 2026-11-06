import { z } from "zod";
import { ApiError, MigrationStatus, MigrationView, EnvironmentView, Provider } from "@svc/contracts";
import type { RunnerStatus } from "@svc/adapters";
import type { Timeline as CoreTimeline } from "@svc/core";

// 경로 응답 모양 (Z17). 경로의 schema.response에 달면 두 가지가 같이 된다
//   1) Fastify가 응답을 이 Zod 스키마로 검사·직렬화한다 (main.ts의 serializerCompiler, fastify-type-provider-zod)
//      → 모양이 어긋나면 조용히 새지 않고 500 INTERNAL로 드러난다 (strict라 모르는 칸도 500)
//   2) tools/openapi/gen-openapi.ts가 코드에서 바로 응답 문서를 뽑는다 (보충표 SUPPLEMENT 불필요)
// DRAFT(ai): 화면·CLI도 쓸 경계 계약이라 원래 packages/contracts에 둬야 한다.
// 공유 파일을 이 작업에서 안 고치려고 api 안에 둔다. 옮기는 안: proposals/contracts-responses.ts

// 202: 작업을 큐에 넣었고 번호만 돌려준다 (POST /migrations, /plan, /start)
export const Accepted = z.object({ id: z.uuid() }).strict();

// GET /migrations 목록 한 줄 = MigrationView 중 화면 목록에 필요한 칸
export const MigrationListItem = MigrationView.pick({
  id: true, status: true, version: true, sourceEnvId: true, targetEnvId: true, updatedAt: true,
});
export const MigrationList = z.object({ items: z.array(MigrationListItem) }).strict();

export const EnvironmentList = z.object({ items: z.array(EnvironmentView) }).strict();

// POST /plans/:id/approvals
export const ApprovalResult = z.object({
  migrationId: z.uuid(),
  planId: z.uuid(),
  status: z.enum(["approved", "rejected"]),
}).strict();

// 비상 버튼: from = 누르기 직전 상태
export const RollbackResult = z.object({ id: z.uuid(), from: MigrationStatus, status: z.literal("rolling_back") }).strict();
// 리소스 회수: 상태는 그대로이고 워커의 cleanup 작업이 옮긴다
export const ReclaimResult = z.object({ id: z.uuid(), status: z.literal("rollback_window"), windowEndsAt: z.string() });
export const CancelResult = z.object({ id: z.uuid(), from: MigrationStatus, status: z.literal("cancelled") }).strict();

// GET /environments/:id/status = adapters RunnerStatus (packages/adapters/src/common/runner.ts 인터페이스를 Zod로 옮겨 적음)
export const ResourceState = z.enum(["Creating", "Succeeded", "Deleting", "Deleted", "Failed"]);
export const RunnerResource = z.object({ type: z.string(), name: z.string(), id: z.string(), state: ResourceState }).strict();
export const EnvironmentStatus = z.object({
  provider: Provider,
  mock: z.boolean(),
  envId: z.string(),
  region: z.string(),
  health: z.enum(["healthy", "degraded", "unknown"]),
  checkedAt: z.string(),
  resources: z.array(RunnerResource),
}).strict();

// GET /migrations/:id/timeline = core Timeline (packages/core/src/timeline.ts 인터페이스를 Zod로 옮겨 적음)
// measurement는 인터페이스에 [k: string]: unknown이 있어 모르는 칸을 그대로 둔다 (looseObject)
export const TimelineMeasurement = z.looseObject({ name: z.string(), value: z.number(), unit: z.string() });
export const TimelineItem = z.object({
  seq: z.number().int(),
  at: z.string(),
  kind: z.enum(["transition", "event"]),
  actor: z.string(),
  action: z.string(),
  result: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  failureCode: z.string().nullable(),
  requestId: z.string().nullable(),
  measurements: z.array(TimelineMeasurement),
  detail: z.record(z.string(), z.unknown()),
}).strict();
export const StateDuration = z.object({ state: z.string(), ms: z.number().int(), entries: z.number().int() }).strict();
export const Timeline = z.object({
  migrationId: z.uuid(),
  status: z.string(),
  createdAt: z.string(),
  generatedAt: z.string(),
  running: z.boolean(),
  totalMs: z.number().int().nullable(),
  items: z.array(TimelineItem),
  stateDurations: z.array(StateDuration),
}).strict();

// 오류 응답은 전부 ApiError 한 모양 (plugins/errors.ts, plugins/auth.ts).
// ApiError는 strict가 아니라 직렬화 때 모르는 칸만 지운다 (지금 오류 본문엔 4칸뿐이라 바뀌는 것 없음)
// Z38 REVIEW-4 W-3: 403 TUNNEL_READ_ONLY(Z47, 터널로 온 쓰기)·429 RATE_LIMITED(Z52)도 실제로 나가므로 문서에 싣는다.
//   429 는 속도 제한이 모든 경로에 걸려(global, plugins/rate-limit.ts) 여기서 늘 붙인다. 403 은 쓰기 경로가 직접 적는다
type ErrCode = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;
export function errors<const C extends readonly ErrCode[]>(...codes: C) {
  return Object.fromEntries([...codes, 429].map((c) => [c, ApiError])) as { [K in C[number] | 429]: typeof ApiError };
}

// 이름을 붙여 문서(components/schemas)에 올릴 것. 생성기가 이 표를 읽는다
export const NAMED_RESPONSES = {
  Accepted, MigrationListItem, MigrationList, EnvironmentList, ApprovalResult, RollbackResult, ReclaimResult, CancelResult,
  EnvironmentStatus, RunnerResource, Timeline, TimelineItem, StateDuration,
} as const;

// 인터페이스와 Zod가 어긋나면 typecheck에서 걸리게 (양방향 대입 검사)
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _envStatusSame: Same<z.infer<typeof EnvironmentStatus>, RunnerStatus> = true;
const _timelineSame: Same<z.infer<typeof Timeline>, CoreTimeline> = true;
void _envStatusSame; void _timelineSame;

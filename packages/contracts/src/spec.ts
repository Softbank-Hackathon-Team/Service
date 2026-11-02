import { z } from "zod";

// 공통 명세(IR). 클라우드 이름 없이 앱을 적는다.
export const AppSpec = z.object({
  schemaVersion: z.literal("1"),
  app: z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  }).strict(),
  service: z.object({
    image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
    port: z.number().int().min(1).max(65535),
    healthPath: z.string().startsWith("/"),
    replicas: z.number().int().min(1).max(10),
    cpu: z.enum(["250m", "500m", "1"]),
    memory: z.enum(["512Mi", "1Gi", "2Gi"]),
    env: z.array(z.object({
      name: z.string(),
      value: z.string().max(256),
    }).strict()),
    secretRefs: z.array(z.object({
      name: z.string(),
      key: z.string(),
    }).strict()),
  }).strict(),
  database: z.object({
    engine: z.literal("postgres"),
    majorVersion: z.enum(["15", "16", "17"]),
    storageGb: z.number().int().max(100),
  }).strict().optional(),
  ingress: z.object({
    hostname: z.string(),
    entry: z.literal("cloudflare-lb"),
  }).strict(),
}).strict();
export type AppSpec = z.infer<typeof AppSpec>;

// 칸마다 "어디서 왔고 얼마나 믿나"
export const FieldMetaEntry = z.object({
  source: z.string(),            // 예: ecs.taskDefinition.portMappings[0], ai
  confidence: z.union([z.literal(1), z.literal(0.9), z.literal(0.6)]),
  needs_review: z.boolean(),
  rationale: z.string().optional(),
}).strict();
export const FieldMeta = z.record(z.string(), FieldMetaEntry);
export type FieldMeta = z.infer<typeof FieldMeta>;

// 가져오기 결과 한 벌 (명세 버전 표의 한 줄)
export const ImportResult = z.object({
  spec: AppSpec.partial(),
  fieldMeta: FieldMeta,
  unmapped: z.array(z.object({
    resource: z.string(), reason: z.string(),
  }).strict()),
}).strict();
export type ImportResult = z.infer<typeof ImportResult>;

// Z100 (Z101 요청): GET /api/v1/migrations/:id/spec — 이전 한 건의 최신 명세 한 판
//   source: accepted = 사람이 받아들인 판(계획·비용이 쓰는 판), ai_draft = 받아들인 판이 없고 AI 초안만 있을 때
//   complete: AppSpec 전체 모양이 맞는지(false 면 가져오기가 칸 일부만 채운 판 → 화면은 빈 칸을 "모름"으로)
//   needsReview: field_meta 에서 needs_review=true 인 칸 이름
export const MigrationSpecView = z.object({
  migrationId: z.uuid(),
  version: z.number().int(),
  createdAt: z.string(),
  source: z.enum(["accepted", "ai_draft"]),
  complete: z.boolean(),
  spec: AppSpec.partial(),
  needsReview: z.array(z.string()),
}).strict();
export type MigrationSpecView = z.infer<typeof MigrationSpecView>;

// PA2 (계획 26 · A2 v1): PATCH /api/v1/migrations/:id/spec — 사람이 명세를 고치거나 "봤다"고 확인한다. 새 판이 하나 생긴다
// DRAFT(ai): v1 설계 4.4 는 PATCH /specs/:id + If-Match. GET 이 /migrations/:id/spec 이고 화면이 판 번호(spec id)를 몰라
//   같은 경로 + 본문 baseVersion 으로 바꿈 (계획 26 3.3, 설계와 어긋남 → PR 설명에 적음)
//   baseVersion = 화면이 GET 으로 본 판 번호. 그사이 다른 판이 생겼으면 409 SPEC_VERSION_CONFLICT
//   changes     = 값 바꿈 → 그 칸 field_meta = {source:"human", confidence:1, needs_review:false}
//   confirm     = 값 그대로 "봤다" → needs_review:false (신뢰도·출처 그대로)
//   acceptDraft = AI 초안 판 번호. 그 판을 사람 판으로 옮겨 시작한다(_draft 뺌). AI 가 바꾼 칸은 아직 needs_review:true
// path 는 지금 명세(AppSpec v1)에 있는 칸 이름만 받는다 (field_meta 키와 같은 점 표기)
// TODO: v2 분기(I3 뒤, rebuildFromV2) — 기준 판에 spec_v2 가 있으면 v2 경로만 받게 넓힌다
export const SpecFieldPath = z.enum([
  "schemaVersion", "app.name", "service.image", "service.port", "service.healthPath", "service.replicas",
  "service.cpu", "service.memory", "service.env", "service.secretRefs", "database", "ingress.hostname", "ingress.entry",
]);
export type SpecFieldPath = z.infer<typeof SpecFieldPath>;
export const SpecPatchInput = z.object({
  baseVersion: z.number().int().min(1),
  // DRAFT(ai) VPA2b: 값 바꾸기 항목은 value 키가 꼭 있어야 한다. 빠지면 400 (예전엔 칸이 조용히 지워졌다).
  //   지우기는 명시적 null 로만 말하고, null 이 그 칸의 모양에 안 맞으면(지금은 nullable 칸 없음) 라우트의 모양 검사가 400 으로 막는다
  changes: z.array(z.object({ path: SpecFieldPath, value: z.unknown() }).strict()
    .refine((c) => "value" in c, { message: "value 가 있어야 한다 (지우려면 명시적 null)", path: ["value"] })).max(20).optional(),
  confirm: z.array(SpecFieldPath).max(20).optional(),
  acceptDraft: z.number().int().min(1).optional(),
}).strict().refine((b) => (b.changes?.length ?? 0) + (b.confirm?.length ?? 0) > 0 || b.acceptDraft !== undefined,
  { message: "changes, confirm, acceptDraft 중 하나는 있어야 한다" });
export type SpecPatchInput = z.infer<typeof SpecPatchInput>;

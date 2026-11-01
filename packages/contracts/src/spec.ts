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

import { z } from "zod";
import { AppSpecV2, FieldMetaV2, OutOfBoundaryV2 } from "./spec-v2.js";
import { ImportAccuracy } from "./import-accuracy.js";

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
// PA2v2: 기준 판에 spec_v2 가 있으면 v2 경로만 받는다(아래 SpecV2FieldPath·SpecV2ConfirmPath). 어느 쪽 경로인지는 라우트가 기준 판을 보고 고른다
//   (v2 판에 v1 키 → 400, v1 판에 v2 키 → 400. 두 명세를 따로 고쳐 어긋나지 않게 — 계획 26 A2 함정 표)
export const SpecFieldPath = z.enum([
  "schemaVersion", "app.name", "service.image", "service.port", "service.healthPath", "service.replicas",
  "service.cpu", "service.memory", "service.env", "service.secretRefs", "database", "ingress.hostname", "ingress.entry",
]);
export type SpecFieldPath = z.infer<typeof SpecFieldPath>;
// service.env.<이름> (환경변수 칸 하나). 이름 모양은 POSIX 환경변수 이름
export const SpecEnvFieldPath = z.string().regex(/^service\.env\.[A-Za-z_][A-Za-z0-9_]{0,127}$/);
// DRAFT(ai) PA2v2: v2 값 바꾸기 경로 = 리소스 props 의 맨 위 칸 하나(components.<id>.<칸>) 또는 links·entry·posture·security 통째.
//   더 깊은 칸(예: env 한 줄)은 그 칸 통째로 바꾼다 (v1 의 service.env 와 같은 방식). 모양 검사는 라우트가 AppSpecV2 + checkV2 로
export const SpecV2FieldPath = z.string().regex(/^(components\.[a-z][a-z0-9-]{0,39}\.[A-Za-z][A-Za-z0-9]{0,39}|links|entry|posture|security)$/);
// v2 확인 경로 = spec_v2.fieldMeta 키 그대로 (components.<id>.<칸>[.env.<이름>], links.<a>-><b>, entry.<host>.routes[i]…, check.reviews[i])
export const SpecV2ConfirmPath = z.string().regex(/^(components|links|entry|check)(\.|$)\S{0,300}$/);
export const SpecPatchInput = z.object({
  baseVersion: z.number().int().min(1),
  // DRAFT(ai) VPA2b: 값 바꾸기 항목은 value 키가 꼭 있어야 한다. 빠지면 400 (예전엔 칸이 조용히 지워졌다).
  //   지우기는 명시적 null 로만 말하고, null 이 그 칸의 모양에 안 맞으면(지금은 nullable 칸 없음) 라우트의 모양 검사가 400 으로 막는다
  changes: z.array(z.object({ path: z.union([SpecFieldPath, SpecV2FieldPath]), value: z.unknown() }).strict()
    .refine((c) => "value" in c, { message: "value 가 있어야 한다 (지우려면 명시적 null)", path: ["value"] })).max(20).optional(),
  // VPA3 버그 수정: 가져오기는 평문 비밀 환경변수를 칸 하나씩 service.env.<이름> 키로 검토 필요 표시한다(adapters normalize.ts).
  //   예전엔 confirm 이 그 키를 400 으로 막아 검토 칸이 영원히 남고 T04(POST /plan)가 409 로 막혔다 → 그 모양 키도 받는다
  confirm: z.array(z.union([SpecFieldPath, SpecEnvFieldPath, SpecV2ConfirmPath])).max(20).optional(),
  acceptDraft: z.number().int().min(1).optional(),
  /** BOUNDPULL: 경계 밖 목록(GET spec 의 outOfBoundary)의 resource 이름. 그 자원을 명세 안으로 끌어온다 (v2 판만, 데이터 자원만) */
  include: z.array(z.string().min(1).max(300)).max(50).optional(),
}).strict().refine((b) => (b.changes?.length ?? 0) + (b.confirm?.length ?? 0) + (b.include?.length ?? 0) > 0 || b.acceptDraft !== undefined,
  { message: "changes, confirm, include, acceptDraft 중 하나는 있어야 한다" });
export type SpecPatchInput = z.infer<typeof SpecPatchInput>;

// PA2v2: 명세 보기 + v2 검토 칸. 판에 spec_v2 가 있을 때만 needsReviewV2 가 붙는다 (v1 판 응답은 지금과 글자 그대로)
//   needsReviewV2 = spec_v2.fieldMeta 에서 needs_review=true 인 키. 화면은 이 키를 PATCH confirm 에 그대로 보낸다
// I8api: 판에 spec_v2 가 있으면 specV2(= spec_v2.spec, AppSpecV2)·fieldMetaV2(= spec_v2.fieldMeta)도 같이 돌려준다 (화면 v2 용). v1 판 응답엔 칸 자체가 없음
//   unmapped·ids·environment 는 안 내보낸다 (화면이 안 쓰고, 벤더 고유 키가 섞여 있음)
export const MigrationSpecViewV2 = MigrationSpecView.extend({
  needsReviewV2: z.array(z.string()).optional(),
  specV2: AppSpecV2.optional(),
  fieldMetaV2: FieldMetaV2.optional(),
  /** ACCVIEW: 가져오기 정확도 % (가져오기 감사 detail.accuracy). 가져오기 v2 판에만 있고 없으면 키 자체가 없음 */
  accuracy: ImportAccuracy.optional(),
  /** BOUNDVIEW: 앱 경계 밖이라 명세에 안 넣은 자원 (spec_v2.outOfBoundary 그대로: 이름·종류·이유만, 값 없음). v2 판에 그 칸이 있을 때만(빈 배열도 그대로), 옛 판·v1 판엔 키 없음 */
  outOfBoundary: z.array(OutOfBoundaryV2).optional(),
}).strict();
export type MigrationSpecViewV2 = z.infer<typeof MigrationSpecViewV2>;

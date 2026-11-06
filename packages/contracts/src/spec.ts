import { z } from "zod";
import { AppSpecV2, ApprovalRowV2, FieldMetaV2, OutOfBoundaryV2 } from "./spec-v2.js";
import { ImportAccuracy } from "./import-accuracy.js";

// 명세 보기·고치기 API 계약. 명세(IR)는 하나뿐이다 (spec-v2.ts). 예전 v1 명세(서비스 1개 + DB 1개)는 없앴다.

// PA2: PATCH /api/v1/migrations/:id/spec — 사람이 명세를 고치거나 "봤다"고 확인한다. 새 판이 하나 생긴다
// DRAFT(ai): 설계 4.4 는 PATCH /specs/:id + If-Match. GET 이 /migrations/:id/spec 이고 화면이 판 번호(spec id)를 몰라
//   같은 경로 + 본문 baseVersion 으로 바꿈 (계획 26 3.3, 설계와 어긋남 → PR 설명에 적음)
//   baseVersion = 화면이 GET 으로 본 판 번호. 그사이 다른 판이 생겼으면 409 SPEC_VERSION_CONFLICT
//   changes     = 값 바꿈 → 그 칸 fieldMeta = {source:"human", confidence:1, needs_review:false}
//   confirm     = 값 그대로 "봤다" → needs_review:false (신뢰도·출처 그대로)
//   acceptDraft = AI 초안 판 번호. 그 판을 사람 판으로 옮겨 시작한다(_draft 뺌). AI 가 바꾼 칸은 아직 needs_review:true
// DRAFT(ai) PA2v2: 값 바꾸기 경로 = 리소스 props 의 맨 위 칸 하나(components.<id>.<칸>) 또는 links·entry·posture·security 통째.
//   더 깊은 칸(예: env 한 줄)은 그 칸 통째로 바꾼다. 모양 검사는 라우트가 AppSpec + check 로
// G3b-5: app.name (앱 이름 = 도착 네임스페이스·자원 이름의 뿌리) 도 사람이 고친다. 통합: E10-1 의 "app" 통째 경로는 G3b-5 와 겹쳐 뺌 (TODO(human): 둘 중 하나로 확정)
// T1·SC-1: secrets 통째 (사람이 binary 를 켜거나 짝을 고침)
export const SpecFieldPath = z.string().regex(/^(components\.[a-z][a-z0-9-]{0,39}\.[A-Za-z][A-Za-z0-9]{0,39}|app\.name|links|entry|posture|security|secrets)$/);
// 확인 경로 = fieldMeta 키 그대로 (components.<id>.<칸>[.env.<이름>], links.<a>-><b>, entry.<host>.routes[i]…, check.<id>.<자리>…)
// G3c-4: posture·security 도 (다시 가져오기 합치기가 "posture"·"security" 키에 검토 표시를 붙인다)
//   T1·F-1: secrets.<이름>.keys.<키>.pairedWith(짝 확인) · unread.<종류>(못 읽은 종류를 봤음) 도 확인 대상
//   NS-1: namespaces.<ns> (가져오기가 네임스페이스 객체를 못 읽으면 검토 표시를 붙인다. 확인 길이 없으면 spec_review 에서 못 나감)
export const SpecConfirmPath = z.string().regex(/^(components|app|links|entry|posture|security|check|secrets|unread|namespaces)(\.|$)\S{0,300}$/);
export const SpecPatchInput = z.object({
  baseVersion: z.number().int().min(1),
  // DRAFT(ai) VPA2b: 값 바꾸기 항목은 value 키가 꼭 있어야 한다. 빠지면 400 (예전엔 칸이 조용히 지워졌다).
  //   지우기는 명시적 null 로만 말하고, null 이 그 칸의 모양에 안 맞으면(예외: security 는 null = 칸 지우기) 라우트의 모양 검사가 400 으로 막는다
  changes: z.array(z.object({ path: SpecFieldPath, value: z.unknown() }).strict()
    .refine((c) => "value" in c, { message: "value 가 있어야 한다 (지우려면 명시적 null)", path: ["value"] })).max(20).optional(),
  confirm: z.array(SpecConfirmPath).max(20).optional(),
  acceptDraft: z.number().int().min(1).optional(),
  /** BOUNDPULL: 경계 밖 목록(GET spec 의 outOfBoundary)의 resource 이름. 그 자원을 명세 안으로 끌어온다 (데이터 자원만) */
  include: z.array(z.string().min(1).max(300)).max(50).optional(),
}).strict().refine((b) => (b.changes?.length ?? 0) + (b.confirm?.length ?? 0) + (b.include?.length ?? 0) > 0 || b.acceptDraft !== undefined,
  { message: "changes, confirm, include, acceptDraft 중 하나는 있어야 한다" });
export type SpecPatchInput = z.infer<typeof SpecPatchInput>;

// Z100: GET /api/v1/migrations/:id/spec — 이전 한 건의 최신 명세 한 판
//   source: accepted = 사람이 받아들인 판(계획·비용이 쓰는 판), ai_draft = 받아들인 판이 없고 AI 초안만 있을 때
//   needsReview = fieldMeta 에서 needs_review=true 인 키. 화면은 이 키를 PATCH confirm 에 그대로 보낸다
//   unmapped·ids·environment 는 안 내보낸다 (화면이 안 쓰고, 벤더 고유 키가 섞여 있음)
export const MigrationSpecView = z.object({
  migrationId: z.uuid(),
  version: z.number().int(),
  createdAt: z.string(),
  source: z.enum(["accepted", "ai_draft"]),
  complete: z.boolean(),
  spec: AppSpecV2,
  fieldMeta: FieldMetaV2,
  needsReview: z.array(z.string()),
  /** 검토 키 → 사람이 읽는 이름표 (contracts reviewLabel). needsReview 키마다 하나. 화면은 보여 줄 때만 쓰고 confirm 에는 키를 보낸다 */
  reviewLabels: z.record(z.string(), z.string()).optional(),
  /** ACCVIEW: 가져오기 정확도 % (가져오기 감사 detail.accuracy). 없으면 키 자체가 없음 */
  accuracy: ImportAccuracy.optional(),
  /** BOUNDVIEW: 앱 경계 밖이라 명세에 안 넣은 자원 (이름·종류·이유만, 값 없음). 판에 그 칸이 있을 때만(빈 배열도 그대로) */
  outOfBoundary: z.array(OutOfBoundaryV2).optional(),
  /** 출발 관리형 상품이 도착에서 다른 상품이 되는 자원 (substitute 줄만, 계획 확인 항목과 같은 계산). 미리보기라 저장하지 않는다. 키가 없으면 옛 응답 */
  substitutions: z.array(ApprovalRowV2).optional(),
  // DRAFT(ai): 화면(apps/web)이 아직 예전 이름으로 읽는다. 값은 위 spec·fieldMeta·needsReview 와 같다. 화면이 새 이름으로 옮기면 지운다
  specV2: AppSpecV2,
  fieldMetaV2: FieldMetaV2,
  needsReviewV2: z.array(z.string()),
}).strict();
export type MigrationSpecView = z.infer<typeof MigrationSpecView>;

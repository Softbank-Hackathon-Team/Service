import { z } from "zod";
import { AppSpecV2, FieldMetaV2, Provider, UnmappedV2 } from "@svc/contracts";

// 명세 초안 에이전트의 입력·출력 모양.
// DRAFT(ai): 경계를 넘는 모양이라 원칙상 packages/contracts 에 있어야 한다. 통합 때 contracts/src/agent.ts 로 옮긴다 (CHANGES.md 요청 1)

// 에이전트가 받는 것: 가져오기 결과(규칙 기반 공통 명세) + discover 원본 + 도착 환경 정보 + (있으면) 계획서 요약
export const SpecDraftInput = z.object({
  migrationId: z.uuid(),
  source: z.object({ provider: Provider }).strict(),
  target: z.object({
    provider: Provider,
    region: z.string(),
    capabilities: z.array(z.string()),      // EnvironmentAdapter.capabilities() 결과
  }).strict(),
  inventory: z.object({                     // EnvironmentAdapter.discover() 결과 (RawInventory)
    provider: Provider,
    items: z.array(z.unknown()),
    coverage: z.record(z.string(), z.number()),
  }).strict(),
  baseline: z.object({                      // spec_versions 의 사람·규칙 최신 판 (spec_v2 칸: 보통 import 가 쓴 판)
    version: z.number().int().min(1),
    spec: AppSpecV2,
    fieldMeta: FieldMetaV2,
    unmapped: z.array(UnmappedV2).optional(),   // 가져오기가 옮기지 못한 출발 자원 (RISK-08)
  }).strict(),
  plan: z.object({                          // 계획서가 이미 있으면 설명에 쓴다. 없으면 null
    steps: z.array(z.object({ id: z.string(), owner: z.string(), estSec: z.number().optional() }).passthrough()),
    precheck: z.array(z.object({ id: z.string(), level: z.string(), message: z.string() }).passthrough()),
    rollbackCriteria: z.record(z.string(), z.number()),
  }).passthrough().nullable(),
}).strict();
export type SpecDraftInput = z.infer<typeof SpecDraftInput>;

// 이전 위험 한 줄. rule = 규칙이 찾은 것(에이전트가 지울 수 없음), ai = 에이전트가 덧붙인 것
export const MigrationRisk = z.object({
  id: z.string(),                           // RISK-01.. (규칙) / AI-01.. (에이전트)
  level: z.enum(["high", "medium", "low"]),
  title: z.string().max(80),
  detail: z.string().max(500),
  field: z.string().optional(),             // 관련 명세 칸 (예: components.db.storageGb)
  mitigation: z.string().max(300).optional(),
  source: z.enum(["rule", "ai"]),
}).strict();
export type MigrationRisk = z.infer<typeof MigrationRisk>;

// 에이전트가 넘기는 것. spec_versions 에 DRAFT(ai) 판으로 저장되고(field_meta 칸에 _draft 표시), 사람이 검토해야 쓰인다
//   fieldMeta 는 명세 칸 표시만 (초안 표시 _draft 는 저장소가 field_meta 칸에 따로 넣는다)
export const SpecDraftResult = z.object({
  spec: AppSpecV2,
  fieldMeta: FieldMetaV2,
  risks: z.array(MigrationRisk).max(20),
  planExplanation: z.string().max(3000),
  rejectedChanges: z.array(z.object({ field: z.string(), reason: z.string() }).strict()),
  model: z.string(),
  usage: z.object({ input: z.number().int(), output: z.number().int() }).strict(),
}).strict();
export type SpecDraftResult = z.infer<typeof SpecDraftResult>;

// spec_versions.field_meta 칸에 넣는 초안 표시 키. 이 키가 있으면 "AI 초안 판, 사람 검토 전" 이다
export const DRAFT_MARKER_KEY = "_draft";
/** 초안 표시 값 (field_meta._draft) */
export const draftMarker = (model: string) => ({ source: `ai:${model}`, confidence: 0.6, needs_review: true,
  rationale: "DRAFT(ai) 에이전트 초안 판. 사람이 검토·승인하기 전에는 계획에 쓰지 않는다" });

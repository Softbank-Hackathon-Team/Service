import { z } from "zod";
import { MigrationStatus } from "./migration.js";

// Postgres 알림(pg_notify) 내용. 8000바이트 제한, 비밀 금지
export const NotifyMigration = z.object({
  t: z.uuid(),          // tenantId
  id: z.uuid(),         // migrationId
  s: MigrationStatus,   // 새 상태
}).strict();

// 화면(SSE)으로 가는 신호. 신호는 "다시 읽어"라는 뜻이다
export const SseEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("migration.status_changed"),
    migrationId: z.uuid(), status: MigrationStatus }).strict(),
  z.object({ type: z.literal("weight_changed"),
    migrationId: z.uuid(), targetPct: z.number().int() }).strict(),
  z.object({ type: z.literal("rollback_started"),
    migrationId: z.uuid(), reason: z.string() }).strict(),
  z.object({ type: z.literal("rollback_done"),
    migrationId: z.uuid(), recoverSec: z.number() }).strict(),
  z.object({ type: z.literal("matrix_changed"),
    envId: z.uuid() }).strict(),
  z.object({ type: z.literal("agent.step"),
    agentRunId: z.uuid(), step: z.number().int() }).strict(),
  z.object({ type: z.literal("reload_all") }).strict(),
]);
export type SseEvent = z.infer<typeof SseEvent>;

// "도착 자원 준비됨". 자원 생성 → 배포로 넘어갈 때 같은 트랜잭션에서 넣는다
export const InfraReady = z.object({
  tenantId: z.uuid(),
  migrationId: z.uuid(),
  planId: z.uuid(),
  tfOutputs: z.record(z.string(), z.string()), // 비밀 제외
  helmValuesKey: z.string(),                    // Helm 값이 저장된 위치
}).strict();
export type InfraReady = z.infer<typeof InfraReady>;

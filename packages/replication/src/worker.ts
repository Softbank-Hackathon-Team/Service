import { endpointFromEnv } from "./endpoint.js";
import { Migration } from "./migration.js";
import type { StepMeasure } from "./switchover.js";
import { resolveTfRefs } from "./tf-facts.js";

// 워커 처리기용 얇은 도우미. REPL_SOURCE_URL이 없으면 null → 처리기는 STUB 그대로 간다 (DB 하나로 도는 smoke 유지)
// Z70: REPL_* 값의 {tf:키} 는 진짜 terraform 출력으로 채운다 (tf-facts.ts). 없으면 예전과 똑같다
export function replicationFromEnv(migrationId: string, env0: NodeJS.ProcessEnv = process.env): Migration | null {
  const env = resolveTfRefs(env0, migrationId);
  if (!env.REPL_SOURCE_URL || !env.REPL_TARGET_URL) return null;
  const tables = env.REPL_TABLES?.split(",").map((s) => s.trim()).filter(Boolean);
  return new Migration({
    key: migrationId,
    source: endpointFromEnv("REPL_SOURCE", env),
    target: endpointFromEnv("REPL_TARGET", env),
    tables: tables?.length ? tables : undefined,
    copySchema: env.REPL_COPY_SCHEMA === "1" || env.REPL_COPY_SCHEMA === "true",
    gate: {
      maxLagMs: Number(env.REPL_MAX_LAG_MS ?? 1000),
      consecutive: Number(env.REPL_GATE_SAMPLES ?? 3),
    },
  });
}

/** contracts의 Measurement 모양으로 (unit이 ms·count인 것만. bytes는 감사 detail에 따로 남긴다) */
export function toMeasurements(ms: StepMeasure[], migrationId: string, env: string) {
  const at = new Date().toISOString();
  return ms.filter((m) => m.unit === "ms" || m.unit === "count")
    .map((m) => ({ migrationId, name: m.name, value: m.value, unit: m.unit as "ms" | "count", env, at }));
}

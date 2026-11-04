import { endpointFromEnv, type Endpoint } from "./endpoint.js";
import { Migration } from "./migration.js";
import type { StepMeasure } from "./switchover.js";
import { hasTfRef, resolveTfRefs } from "./tf-facts.js";

/** PF-E22 (FM-APP-hunt-deploy-db-02): {tf:키} 를 못 채웠거나 빈 값으로 채워 주소가 깨짐 (terraform 출력 없음·빈 출력).
 *  재시도로 안 바뀐다 → 워커는 바로 paused REPL_TF_FACTS_MISSING (예전: 'Invalid URL' 로 재시도 4번 뒤 SYNC_FAILED) */
export class ReplConfigError extends Error {
  readonly code = "REPL_TF_FACTS_MISSING";
}
const URL_KEYS = ["REPL_SOURCE_URL", "REPL_SOURCE_PEER_URL", "REPL_TARGET_URL", "REPL_TARGET_PEER_URL"] as const;
function assertResolved(env: NodeJS.ProcessEnv) {
  const bad: string[] = [];
  for (const k of URL_KEYS) {
    const v = env[k];
    if (!v) continue;
    if (hasTfRef(v)) { bad.push(`${k}: 못 채운 ${(v.match(/\{tf:[a-z0-9_]+\}/gi) ?? []).join(" ")}`); continue; }
    if (!/^postgres(ql)?:\/\//.test(v)) continue;   // key=value 모양은 여기서 안 본다
    let u: URL | null = null;
    try { u = new URL(v); } catch { /* 아래 */ }
    if (!u || !u.hostname || (u.pathname.replace(/^\//, "") === "")) bad.push(`${k}: 호스트나 DB 이름이 비었다 (빈 terraform 출력?)`);
  }
  if (bad.length) throw new ReplConfigError(`복제 주소를 못 만듦 — ${bad.join("; ")}. terraform output(db_address·db_name 등)·REPL_FACTS_FILES 확인`);
}

// 워커 처리기용 얇은 도우미. REPL_SOURCE_URL이 없으면 null → 처리기는 STUB 그대로 간다 (DB 하나로 도는 smoke 유지)
// Z70: REPL_* 값의 {tf:키} 는 진짜 terraform 출력으로 채운다 (tf-facts.ts). 없으면 예전과 똑같다
export function replicationFromEnv(migrationId: string, env0: NodeJS.ProcessEnv = process.env): Migration | null {
  const env = resolveTfRefs(env0, migrationId);
  if (!env.REPL_SOURCE_URL || !env.REPL_TARGET_URL) return null;
  assertResolved(env);
  const tables = env.REPL_TABLES?.split(",").map((s) => s.trim()).filter(Boolean);
  return new Migration({
    key: migrationId,
    source: withLinkRole(endpointFromEnv("REPL_SOURCE", env), migrationId),
    target: endpointFromEnv("REPL_TARGET", env),
    tables: tables?.length ? tables : undefined,
    copySchema: env.REPL_COPY_SCHEMA === "1" || env.REPL_COPY_SCHEMA === "true",
    gate: {
      // PF-E13 (FM-APP-24): 빈 값("")은 없는 값과 같다. 예전 Number("") = 0 → 지연 한도 0ms 라 판정이 영원히 안 통과
      // PF-E14 (FM-APP-25): 상태 전이 T21(core guards, REPL_MAX_MARKER_RTT_MS 기본 500)보다 느슨하면 "준비됨"인데 전이가 GuardFailed →
      //   재시도 없이 paused JOB_FAILED_SYNC 였다. 판정 한도는 T21 한도를 넘지 않게 (기본도 T21 과 같은 500)
      maxLagMs: Math.min(num(env.REPL_MAX_LAG_MS, num(env.REPL_MAX_MARKER_RTT_MS, 500)), num(env.REPL_MAX_MARKER_RTT_MS, 500)),
      consecutive: num(env.REPL_GATE_SAMPLES, 3),
    },
  });
}

/** APP-22 (가) DECISION(team, 11/4 01:57Z): 컷오버 전까지 도착 앱이 출발 DB 에 붙는 전용 계정 이름 (source-db-link 와 같은 규칙: 이전 id 앞 8자).
 *  출발 울타리에 같이 넣는다 (계정이 없으면 울타리가 건너뜀) */
export const sourceLinkRoleOf = (migrationId: string) => `svc_link_${migrationId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
const withLinkRole = (e: Endpoint, migrationId: string): Endpoint =>
  ({ ...e, fenceRoles: [...new Set([...(e.fenceRoles ?? []), sourceLinkRoleOf(migrationId)])] });

const num = (v: string | undefined, d: number) => (v === undefined || v.trim() === "" ? d : Number(v));

/** contracts의 Measurement 모양으로 (unit이 ms·count인 것만. bytes는 감사 detail에 따로 남긴다) */
export function toMeasurements(ms: StepMeasure[], migrationId: string, env: string) {
  const at = new Date().toISOString();
  return ms.filter((m) => m.unit === "ms" || m.unit === "count")
    .map((m) => ({ migrationId, name: m.name, value: m.value, unit: m.unit as "ms" | "count", env, at }));
}

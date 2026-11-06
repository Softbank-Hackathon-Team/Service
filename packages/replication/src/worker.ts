import { endpointFromEnv, type Endpoint } from "./endpoint.js";
import { Migration, type MigrationConfig } from "./migration.js";
import { endpointFromRecord, type EndpointRecord } from "./record.js";
import type { ManagedSecrets } from "./secret-ref.js";
import type { StepMeasure } from "./switchover.js";
import { hasTfRef, resolveTfRefs } from "./tf-facts.js";

/** PF-E22 (FM-APP-hunt-deploy-db-02): {tf:키} 를 못 채웠거나 빈 값으로 채워 주소가 깨짐 (terraform 출력 없음·빈 출력).
 *  재시도로 안 바뀐다 → 워커는 바로 paused REPL_TF_FACTS_MISSING (예전: 'Invalid URL' 로 재시도 4번 뒤 SYNC_FAILED) */
// 이전마다 끝점(db 0050)의 설정 오류도 같은 꼴 (재시도로 안 바뀜 → paused):
//   REPL_ENDPOINT_INCOMPLETE = 줄이 한쪽만 있음 / REPL_SECRET_UNRESOLVED = password_ref 를 못 풂 (마스터 키 없음·env 없음·문법)
export type ReplConfigCode = "REPL_TF_FACTS_MISSING" | "REPL_ENDPOINT_INCOMPLETE" | "REPL_SECRET_UNRESOLVED";
export class ReplConfigError extends Error {
  constructor(message: string, readonly code: ReplConfigCode = "REPL_TF_FACTS_MISSING") { super(message); }
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
  return new Migration({
    key: migrationId,
    source: withLinkRole(endpointFromEnv("REPL_SOURCE", env), migrationId),
    target: endpointFromEnv("REPL_TARGET", env),
    ...tuningFromEnv(env),
  });
}

// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
/** replication_endpoints 줄로 Migration 만들기. 줄이 없으면 null (부르는 쪽이 예전 env 길로), 한쪽만 있으면 오류 (줄과 env 를 섞지 않는다).
 *  표 목록·지연 한도 같은 조절값(REPL_TABLES·REPL_MAX_LAG_MS …)은 끝점이 아니라서 예전처럼 env */
export function replicationFromRecords(migrationId: string, records: readonly EndpointRecord[], env: NodeJS.ProcessEnv = process.env,
  managed?: ManagedSecrets): Migration | null {
  const mine = records.filter((r) => r.migrationId === migrationId);
  if (mine.length !== records.length) throw new ReplConfigError(`복제 끝점 줄의 이전 번호가 ${migrationId} 와 다르다`, "REPL_ENDPOINT_INCOMPLETE");
  if (!mine.length) return null;
  const src = mine.filter((r) => r.side === "source"), dst = mine.filter((r) => r.side === "target");
  if (src.length !== 1 || dst.length !== 1)
    throw new ReplConfigError(`복제 끝점 줄이 한쪽만 있다 (source ${src.length}·target ${dst.length}). tools/repl-endpoint.ts set 으로 두 쪽을 다 등록한다`, "REPL_ENDPOINT_INCOMPLETE");
  if (src[0]!.tenantId !== dst[0]!.tenantId) throw new ReplConfigError("복제 끝점 두 줄의 회사가 다르다", "REPL_ENDPOINT_INCOMPLETE");
  const ep = (r: EndpointRecord) => {
    try { return endpointFromRecord(r, env, managed); }
    catch (e) { throw new ReplConfigError(`${r.side} 끝점(${r.label}): ${(e as Error).message}`, "REPL_SECRET_UNRESOLVED"); }
  };
  return new Migration({
    key: migrationId,
    source: withLinkRole(ep(src[0]!), migrationId),
    target: ep(dst[0]!),
    ...tuningFromEnv(env),
  });
}

/** 끝점이 아닌 조절값 (env). 두 길이 같은 규칙을 쓴다 */
function tuningFromEnv(env: NodeJS.ProcessEnv): Pick<MigrationConfig, "tables" | "copySchema" | "gate"> {
  const tables = env.REPL_TABLES?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    tables: tables?.length ? tables : undefined,
    copySchema: env.REPL_COPY_SCHEMA === "1" || env.REPL_COPY_SCHEMA === "true",
    gate: {
      // PF-E13 (FM-APP-24): 빈 값("")은 없는 값과 같다. 예전 Number("") = 0 → 지연 한도 0ms 라 판정이 영원히 안 통과
      // PF-E14 (FM-APP-25): 상태 전이 T21(core guards, REPL_MAX_MARKER_RTT_MS 기본 500)보다 느슨하면 "준비됨"인데 전이가 GuardFailed →
      //   재시도 없이 paused JOB_FAILED_SYNC 였다. 판정 한도는 T21 한도를 넘지 않게 (기본도 T21 과 같은 500)
      maxLagMs: Math.min(num(env.REPL_MAX_LAG_MS, num(env.REPL_MAX_MARKER_RTT_MS, 500)), num(env.REPL_MAX_MARKER_RTT_MS, 500)),
      consecutive: num(env.REPL_GATE_SAMPLES, 3),
    },
  };
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

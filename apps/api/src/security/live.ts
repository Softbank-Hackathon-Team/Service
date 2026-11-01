import { STUB_TF_OUTPUTS } from "@svc/adapters";
import { NotFound, writeAudit, type Tx } from "@svc/core";
import type { Provider } from "@svc/contracts";
import { LiveSecurityReport, envNumber } from "@svc/contracts";
import { liveEnabled, runLiveChecks, type ExecRunner, type LiveTarget } from "@svc/security";

// Z91: 보안 표 "실제 점검" 재료. DB 에서 출발·도착 환경과 그 환경에 마지막으로 만든 자원(infra.ready tfOutputs)을 읽고,
// 트랜잭션 밖에서 클라우드·k8s 읽기 명령을 돌린다 (CLI 몇 초를 DB 연결을 잡은 채 기다리지 않게)
// 감사 모양 (Z95 보안 회귀와 합의): action "security.live_check", target = 이전 id, detail = { report: LiveSecurityReport } 한 줄에 한 side

export const LIVE_CHECK_ACTION = "security.live_check";

const isStub = (tf: Record<string, string>) =>
  Object.entries(STUB_TF_OUTPUTS).some(([k, v]) => tf[k] === v);

// 그 환경을 도착으로 삼은 이전 중 마지막 infra.ready (이 이전이 아니어도 같은 회사 것. RLS 가 회사 벽)
async function lastTfOutputs(tx: Tx, envId: string): Promise<Record<string, string> | null> {
  const q = await tx.query(
    `SELECT a.detail->'infraReady'->'tfOutputs' AS tf FROM audit_events a JOIN migrations m ON a.target = m.id::text
      WHERE a.action = 'infra.ready' AND m.target_env_id = $1 ORDER BY a.seq DESC LIMIT 1`, [envId]);
  const tf = q.rows[0]?.tf;
  return tf && typeof tf === "object" ? (tf as Record<string, string>) : null;
}

export async function loadLiveTargets(tx: Tx, migrationId: string): Promise<LiveTarget[]> {
  const m = await tx.query(
    `SELECT s.id AS "sId", s.provider AS "sP", s.account_id AS "sA", t.id AS "tId", t.provider AS "tP", t.account_id AS "tA"
       FROM migrations m JOIN environments s ON s.id = m.source_env_id JOIN environments t ON t.id = m.target_env_id WHERE m.id = $1`, [migrationId]);
  const r = m.rows[0];
  if (!r) throw new NotFound("migration", migrationId);
  const out: LiveTarget[] = [];
  for (const [side, id, p, a] of [["source", r.sId, r.sP, r.sA], ["target", r.tId, r.tP, r.tA]] as const) {
    const tf = await lastTfOutputs(tx, id as string);
    out.push({ side, envId: id as string, provider: p as Provider, accountId: (a as string | null) ?? null, tfOutputs: tf, stubOutputs: tf ? isStub(tf) : false });
  }
  return out;
}

// 같은 이전을 화면이 몇 초마다 다시 읽어도 CLI 를 매번 부르지 않게 짧게 기억한다 (SEC_LIVE_CACHE_SEC, 기본 60초)
const cache = new Map<string, { at: number; v: LiveSecurityReport[] }>();
export const clearLiveCache = () => cache.clear();

export async function liveReports(targets: LiveTarget[], o: { run?: ExecRunner; env?: NodeJS.ProcessEnv; key?: string; fresh?: boolean } = {}): Promise<LiveSecurityReport[] | null> {
  const env = o.env ?? process.env;
  if (!liveEnabled(env)) return null;
  const ttl = envNumber(env.SEC_LIVE_CACHE_SEC, 60) * 1000;
  const hit = o.key ? cache.get(o.key) : undefined;
  if (hit && !o.fresh && Date.now() - hit.at < ttl) return hit.v;
  const v = (await Promise.all(targets.map((t) => runLiveChecks(t, { run: o.run, env })))).map((x) => LiveSecurityReport.parse(x));
  if (o.key) cache.set(o.key, { at: Date.now(), v });
  return v;
}

export async function recordLiveChecks(tx: Tx, tenantId: string, actor: string, migrationId: string, reports: LiveSecurityReport[]) {
  for (const report of reports) {
    const bad = report.summary.fail > 0;
    await writeAudit(tx, tenantId, { actor, action: LIVE_CHECK_ACTION, target: migrationId, result: bad ? "denied" : "ok", detail: { report } });
  }
}

// 마지막 스냅숏 (출발 환경을 지운 뒤 비교·표시용). Z95 회귀 GET 도 쓸 수 있다
export async function latestLiveSnapshot(tx: Tx, migrationId: string, side: "source" | "target"): Promise<LiveSecurityReport | null> {
  const q = await tx.query(
    `SELECT detail->'report' AS r FROM audit_events WHERE action = $1 AND target = $2 AND detail->'report'->>'side' = $3
      ORDER BY seq DESC LIMIT 1`, [LIVE_CHECK_ACTION, migrationId, side]);
  const raw = q.rows[0]?.r;
  if (!raw) return null;
  const p = LiveSecurityReport.safeParse(raw);
  return p.success ? { ...p.data, origin: "snapshot" } : null;
}

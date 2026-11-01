// 이전 N개(기본 50)를 동시에 처음부터 completed 까지 돌린다. 워커를 2~3개 띄워 놓고 실행한다
// 이전마다 다른 환경 쌍을 쓴다(SHARED_ENV=1 이면 전부 같은 쌍 = 잠금 경쟁 시험)
// 재는 것: 단계별 걸린 시간 p50/p95, 전체 시간, HTTP 5xx, 멈춘 상태, 남은 잠금, 실패 작업, 중복 전이, DB 연결 최대
// 실행: npx tsx --env-file=.env tools/load/flows.ts   (FLOWS=50, FLOW_TIMEOUT_MS=180000, POLL_MS=250)
import { call, owner, seedEnvPairs, sampleConnections, waitStatus, summary, printStatusCounts, SRC, DST } from "./lib.js";

const N = Number(process.env.FLOWS ?? 50);
const TIMEOUT = Number(process.env.FLOW_TIMEOUT_MS ?? 180000);
const POLL = Number(process.env.POLL_MS ?? 250);
const SHARED = process.env.SHARED_ENV === "1";

type Step = "create" | "import" | "plan" | "approve" | "run";
const lat: Record<Step, number[]> = { create: [], import: [], plan: [], approve: [], run: [] };
const total: number[] = [];
const ends: Record<string, number> = {};
const errors: string[] = [];

async function flow(i: number, src: string, dst: string): Promise<string | null> {
  const t0 = performance.now();
  let t = t0;
  const mark = (s: Step) => { const n = performance.now(); lat[s].push(n - t); t = n; };
  const c = await call("POST", "/migrations", { sourceEnvId: src, targetEnvId: dst });
  if (c.status !== 202) { errors.push(`#${i} create ${c.status} ${JSON.stringify(c.json)}`); return null; }
  const id = c.json.id as string; mark("create");
  const end = async (s: string) => { ends[s] = (ends[s] ?? 0) + 1; if (s !== "completed") errors.push(`#${i} ${id} ended ${s}`); return id; };
  let s = await waitStatus(id, ["spec_review"], TIMEOUT, POLL); if (s !== "spec_review") return end(s); mark("import");
  const p = await call("POST", `/migrations/${id}/plan`);
  if (p.status >= 300) { errors.push(`#${i} plan ${p.status} ${p.json?.code}`); return end("plan_rejected"); }
  s = await waitStatus(id, ["awaiting_approval"], TIMEOUT, POLL); if (s !== "awaiting_approval") return end(s); mark("plan");
  const plan = (await call("GET", `/migrations/${id}/plan`)).json;
  const a = await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash });
  if (a.status !== 200) { errors.push(`#${i} approve ${a.status} ${a.json?.code}`); return end(`approve_${a.json?.code ?? a.status}`); }
  const st = await call("POST", `/migrations/${id}/start`);
  if (st.status !== 202) { errors.push(`#${i} start ${st.status} ${st.json?.code}`); return end(`start_${st.json?.code ?? st.status}`); }
  mark("approve");
  s = await waitStatus(id, ["completed"], TIMEOUT, POLL); mark("run");
  total.push(performance.now() - t0);
  return end(s);
}

const pairs = SHARED ? Array.from({ length: N }, () => ({ src: SRC, dst: DST })) : await seedEnvPairs(N);
const before = (await owner.query("SELECT count(*)::int n FROM pgboss.job WHERE state='failed'")).rows[0].n;
const conn = sampleConnections(200);
const T0 = performance.now();
const ids = (await Promise.all(pairs.map((p, i) => flow(i, p.src, p.dst)))).filter((x): x is string => !!x);
const wall = performance.now() - T0;
const peak = conn.stop();

// 뒤처리 확인 (관리자 연결로 읽기만)
const stuck = (await owner.query(`SELECT status, count(*)::int n FROM migrations WHERE id = ANY($1) GROUP BY 1 ORDER BY 1`, [ids])).rows;
const locks = (await owner.query(`SELECT holder, count(*)::int n FROM env_locks WHERE migration_id = ANY($1) GROUP BY 1`, [ids])).rows;
const failedJobs = (await owner.query("SELECT name, count(*)::int n FROM pgboss.job WHERE state='failed' GROUP BY 1")).rows;
const rejected = (await owner.query(`SELECT count(*)::int n FROM audit_events WHERE target = ANY($1::uuid[]::text[]) AND action='job.rejected'`, [ids])).rows[0].n;
const dupes = (await owner.query(`
  SELECT action, count(*)::int n FROM (
    SELECT target, action, count(*) c FROM audit_events WHERE target = ANY($1::uuid[]::text[]) AND action NOT IN ('job.rejected')
     GROUP BY 1,2 HAVING count(*) > 1) d GROUP BY 1`, [ids])).rows;

console.log(`flows=${N} shared_env=${SHARED} wall=${Math.round(wall)} ms  ends=${JSON.stringify(ends)}`);
for (const k of Object.keys(lat) as Step[]) console.log(`  step ${k.padEnd(8)} ms`, JSON.stringify(summary(lat[k])));
console.log("  total ms", JSON.stringify(summary(total)));
console.log("final status:", JSON.stringify(stuck));
console.log("env_locks left:", JSON.stringify(locks));
console.log(`failed pg-boss jobs (all time, before=${before}):`, JSON.stringify(failedJobs));
console.log("job.rejected audits (duplicate/late job deliveries):", rejected);
console.log("audit actions repeated on same migration:", JSON.stringify(dupes));
console.log("DB conn peak (app_user):", JSON.stringify(peak));
printStatusCounts();
if (errors.length) console.log("errors:", errors.slice(0, 15).join("\n  "));
const has5xx = [...(await import("./lib.js")).statusCount.keys()].some((k) => k >= 500);
console.log(errors.length || has5xx ? "RESULT FAIL" : "RESULT OK");
await owner.end();

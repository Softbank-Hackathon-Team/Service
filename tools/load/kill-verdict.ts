// 워커 강제 종료 시험 판정 (작업 Z32, 6차). worker-kill.sh 가 kill-watch.ts 다음에 부른다 (api 는 아직 떠 있음)
// 기준 (흐름 50개, 워커 3 중 1개 kill -9):
//  ① JOB_NOT_PICKED·STEP_FAILED 등 WORKER_LOST 아닌 실패 0건
//  ② WORKER_LOST 는 전부 죽인 워커(KILLED_HOLDER, 기본 worker:kill-test-1)가 쥐고 있던 흐름 = kill 당시 진행 중이던 것만
//  ③ failed(WORKER_LOST) 는 다시 계획할 수 있는 단계(importing·prechecking·planning·provisioning)에서만 허용.
//     설계: 반쯤 돈 Terraform apply 는 자동으로 다시 돌리지 않는다(START_ONLY_RETRY) → failed, 사람이 재계획. 그 밖의 단계에서 failed 면 FAIL
//  ④ paused(WORKER_LOST) 는 이 판정이 재개(POST /resume)를 불러 RESUME_WAIT_MS(기본 300초) 안에 completed 가 돼야 PASS
// 마지막 줄: "KILL VERDICT PASS ..." 또는 "KILL VERDICT FAIL <이유>". flows.ts 의 RESULT 는 kill 흐름의 failed 를 그대로 세므로 이 줄로 판정한다
import { owner, call, sleep } from "./lib.js";

const RUN_START = new Date(Number(process.env.RUN_START));
const KILLED = process.env.KILLED_HOLDER ?? "worker:kill-test-1";
const WAIT = Number(process.env.RESUME_WAIT_MS ?? 300_000);
const REPLANNABLE = ["importing", "prechecking", "planning", "provisioning"];

const rows = (await owner.query(
  `SELECT m.id::text, m.status, m.failure_code, coalesce(m.paused_from, a.detail->>'from') AS from_state, a.detail->>'holder' AS holder
     FROM migrations m
     LEFT JOIN LATERAL (SELECT detail FROM audit_events e WHERE e.target = m.id::text AND e.detail->>'by' = 'lease-reaper'
                         AND e.action IN ('migration.failed', 'migration.paused') ORDER BY seq DESC LIMIT 1) a ON true
    WHERE m.created_at >= $1 AND m.status IN ('failed', 'paused')`, [RUN_START])).rows as
  { id: string; status: string; failure_code: string | null; from_state: string | null; holder: string | null }[];

const bad: string[] = [];
const other = rows.filter((r) => r.failure_code !== "WORKER_LOST");
if (other.length) bad.push(`WORKER_LOST 아닌 실패 ${other.length}건 (${[...new Set(other.map((r) => `${r.status}:${r.failure_code}`))].join(",")})`);
const lost = rows.filter((r) => r.failure_code === "WORKER_LOST");
const notKilled = lost.filter((r) => r.holder !== KILLED);
if (notKilled.length) bad.push(`죽이지 않은 워커의 WORKER_LOST ${notKilled.length}건 (${notKilled.map((r) => r.holder).join(",")})`);
const failed = lost.filter((r) => r.status === "failed");
const badFailed = failed.filter((r) => !REPLANNABLE.includes(r.from_state ?? ""));
if (badFailed.length) bad.push(`재계획 못 하는 단계에서 failed ${badFailed.length}건 (${badFailed.map((r) => r.from_state).join(",")})`);
for (const f of failed) console.log(`verdict: failed ${f.id} from=${f.from_state} holder=${f.holder} → 설계대로(반쯤 돈 단계 재실행 안 함, 재계획 가능)`);

const paused = lost.filter((r) => r.status === "paused");
const resumed: { id: string; from: string | null; ok: boolean; status: string; ms: number }[] = [];
for (const p of paused) {
  const t0 = Date.now();
  const r = await call("POST", `/migrations/${p.id}/resume`, { reason: "worker-kill verdict: worker restarted" }, { "idempotency-key": `kill-resume-${p.id}` });
  if (r.status !== 202) { bad.push(`재개 ${p.id} → ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`); continue; }
  let s = "";
  while (Date.now() - t0 < WAIT) {
    s = (await owner.query("SELECT status FROM migrations WHERE id=$1", [p.id])).rows[0].status;
    if (["completed", "failed", "paused", "rolled_back", "cancelled"].includes(s)) break;
    await sleep(1000);
  }
  resumed.push({ id: p.id, from: p.from_state, ok: s === "completed", status: s, ms: Date.now() - t0 });
  console.log(`verdict: paused ${p.id} from=${p.from_state} → resume → ${s} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (s !== "completed") bad.push(`재개 뒤 ${p.id} = ${s}`);
}
const fin = (await owner.query(`SELECT status, count(*)::int n FROM migrations WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [RUN_START])).rows;
console.log(`verdict: after resume ${JSON.stringify(Object.fromEntries(fin.map((r) => [r.status, r.n])))}`);
console.log(bad.length
  ? `KILL VERDICT FAIL ${bad.join(" / ")}`
  : `KILL VERDICT PASS worker_lost=${lost.length} (failed ${failed.length} 재계획 가능, paused ${paused.length} → 재개 completed ${resumed.filter((r) => r.ok).length})`);
await owner.end();
process.exit(bad.length ? 1 : 0);

// 워커 강제 종료 뒤 회복 관찰 (작업 Z32). worker-kill.sh 가 부른다. 관리자 연결로 읽기만 한다
// 하는 일: KILL_AT(epoch ms) 이후 만들어진 시험 이전들이 "끝 상태"(completed·failed·paused·rolled_back 등)에 닿을 때까지
//          WATCH_EVERY_MS 마다 상태 수·active 작업·잠금을 찍고, 마지막으로 회복 시간(죽인 시각 → 마지막 이전이 움직인 시각)을 낸다
// 실행: KILL_AT=<ms> RUN_START=<ms> npx tsx --env-file=.env tools/load/kill-watch.ts
import { owner, sleep } from "./lib.js";

const RUN_START = new Date(Number(process.env.RUN_START));
const KILL_AT = Number(process.env.KILL_AT);
const LIMIT_MS = Number(process.env.WATCH_LIMIT_MS ?? 20 * 60_000);
const EVERY = Number(process.env.WATCH_EVERY_MS ?? 5000);
const END = ["completed", "failed", "paused", "rolled_back", "cancelled", "stale", "rejected"];

const t = () => ((Date.now() - KILL_AT) / 1000).toFixed(0).padStart(4) + "s";
let lastMoving = -1;
while (Date.now() - KILL_AT < LIMIT_MS) {
  const st = (await owner.query(
    `SELECT status, count(*)::int n FROM migrations WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [RUN_START])).rows;
  const act = (await owner.query(
    `SELECT name, count(*)::int n, max(extract(epoch from now()-started_on))::int age
       FROM pgboss.job WHERE state='active' AND name NOT IN ('lease-reaper','idempotency-cleanup') GROUP BY 1 ORDER BY 1`)).rows;
  const locks = (await owner.query(
    `SELECT CASE WHEN holder LIKE 'worker:%' THEN 'worker' ELSE holder END h, count(*)::int n
       FROM env_locks l JOIN migrations m ON m.id=l.migration_id WHERE m.created_at >= $1 GROUP BY 1`, [RUN_START])).rows;
  const moving = st.filter((r) => !END.includes(r.status)).reduce((a, r) => a + r.n, 0);
  console.log(`${t()} moving=${moving} status=${JSON.stringify(Object.fromEntries(st.map((r) => [r.status, r.n])))} ` +
    `active=${JSON.stringify(act.map((r) => `${r.name}:${r.n}(${r.age}s)`))} locks=${JSON.stringify(locks.map((r) => `${r.h}:${r.n}`))}`);
  if (moving === 0 && act.length === 0) { lastMoving = Date.now(); break; }
  await sleep(EVERY);
}
// 회복 시간 = 죽인 시각부터 마지막 시험 이전이 마지막으로 상태를 바꾼 시각까지
const last = (await owner.query(
  `SELECT max(updated_at) t FROM migrations WHERE created_at >= $1`, [RUN_START])).rows[0].t as Date;
const fin = (await owner.query(
  `SELECT status, failure_code, count(*)::int n FROM migrations WHERE created_at >= $1 GROUP BY 1,2 ORDER BY 1`, [RUN_START])).rows;
const dead = (await owner.query(
  `SELECT action, count(*)::int n FROM audit_events a JOIN migrations m ON a.target = m.id::text
    WHERE m.created_at >= $1 AND (a.action LIKE '%.paused' OR a.action LIKE '%.failed' OR a.action LIKE '%retry%' OR a.detail->>'by' IN ('lease-reaper','dead-letter'))
    GROUP BY 1 ORDER BY 1`, [RUN_START])).rows;
console.log("final:", JSON.stringify(fin));
console.log("recovery audits:", JSON.stringify(dead));
console.log(`RECOVERY settled=${lastMoving > 0} last_change_after_kill_s=${((last.getTime() - KILL_AT) / 1000).toFixed(1)}`);
// Z32 (Z62 #37 ③): paused가 남았으면 그 이전들의 감사 마지막 10줄 + pgboss.job 행을 로그에 바로 덧붙인다 (맥에서 손으로 뽑을 필요 없게)
const paused = (await owner.query(
  `SELECT id::text, paused_from, failure_code FROM migrations WHERE created_at >= $1 AND status = 'paused' ORDER BY updated_at LIMIT 20`,
  [RUN_START])).rows as { id: string; paused_from: string | null; failure_code: string | null }[];
console.log(`paused: ${paused.length}`);
for (const p of paused) {
  console.log(`--- paused ${p.id} from=${p.paused_from} code=${p.failure_code}`);
  const au = (await owner.query(
    `SELECT to_char(at, 'HH24:MI:SS.MS') at, actor, action, result, left(detail::text, 200) detail
       FROM (SELECT * FROM audit_events WHERE target = $1 ORDER BY seq DESC LIMIT 10) a ORDER BY seq`, [p.id])).rows;
  for (const a of au) console.log(`  audit ${a.at} ${a.actor} ${a.action} ${a.result} ${a.detail}`);
  const jb = (await owner.query(
    `SELECT name, state, retry_count, retry_limit, to_char(created_on, 'HH24:MI:SS') c, to_char(started_on, 'HH24:MI:SS') s,
            to_char(completed_on, 'HH24:MI:SS') d, left(coalesce(output::text, ''), 160) out
       FROM pgboss.job WHERE data->>'migrationId' = $1 ORDER BY created_on`, [p.id])).rows;
  for (const j of jb) console.log(`  job ${j.name} ${j.state} retry=${j.retry_count}/${j.retry_limit} created=${j.c} started=${j.s ?? "-"} done=${j.d ?? "-"} ${j.out}`);
}
await owner.end();

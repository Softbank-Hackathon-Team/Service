// "가동 중 앱을 숫자로": 샘플 앱(M)에 쓰기 부하를 거는 동안 실제 복제(REPL_*)로 이전 한 번을 끝까지 돌린다.
// 재는 것: 단계별(이전 상태별) 요청 성공·실패·p95, 전체 실패 수, 받은 주문이 도착 DB 에 다 있는지(RPO)
// 전제: worker 가 REPL_* 로 출발=샘플 앱 DB, 도착=빈 대상 DB 를 보고 있다. 프록시(switch-proxy.mjs)가 :8090 에 떠 있다
// 실행: npx tsx --env-file=.env tools/load/live-app/live-migration.ts
//   환경 변수: SHOP_DIR(샘플 앱 폴더) WRITER_URL(http://localhost:8090) RATE(100) LEAD_SEC(3) TAIL_SEC(5)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { call, SRC, DST, sleep, pct, r1 } from "../lib.js";

const SHOP = process.env.SHOP_DIR!;
const URL_ = process.env.WRITER_URL ?? "http://localhost:8090";
const RATE = process.env.RATE ?? "100";
const LEAD = Number(process.env.LEAD_SEC ?? 3), TAIL = Number(process.env.TAIL_SEC ?? 5);

// 상태 타임라인 (성공 요청을 단계에 묶으려고 100ms 마다 본다)
const timeline: { t: number; s: string }[] = [];
const T0 = Date.now();
let id = "";
let done = false;
(async () => { let last = ""; while (!done) { if (id) { const s = (await call("GET", `/migrations/${id}`)).json.status; if (s !== last) { timeline.push({ t: Date.now(), s }); last = s; } } await sleep(100); } })();

// 부하기: 초당 줄(t=..s ok= fail=)을 받아 시간에 묶는다. 지연은 요청별로 없어서 p95 는 최종 요약 + 초당 max 로 본다
const perSec: { at: number; ok: number; fail: number; retry: number; max: number }[] = [];
let summaryLine = "";
const w = spawn("node", [`${SHOP}/load/writer.mjs`], { env: { ...process.env, TARGET_URL: URL_, RATE, CONCURRENCY: "8", DURATION_SEC: "0", OUT_DIR: "/tmp/live-app-out" } });
w.stdout.on("data", (d: Buffer) => {
  for (const line of d.toString().split("\n")) {
    const m = line.match(/t=\s*(\d+)s ok=(\d+) fail=(\d+) retry=(\d+) max=(\d+)ms/);
    if (m) perSec.push({ at: Date.now(), ok: +m[2]!, fail: +m[3]!, retry: +m[4]!, max: +m[5]! });
    if (line.startsWith("{\"runId\"")) summaryLine = line;
  }
});
await sleep(LEAD * 1000);

// 이전 한 번 (smoke 와 같은 순서)
const c = await call("POST", "/migrations", { sourceEnvId: SRC, targetEnvId: DST }); id = c.json.id;
await fetch(`${URL_}/__track/${id}`).catch(() => {});           // (Z6 HTTP 프록시일 때만) 이 이전을 보라고 알린다
const wait = async (s: string) => { for (;;) { const x = (await call("GET", `/migrations/${id}`)).json.status; if (x === s) return; if (x !== s && ["failed", "paused", "rolled_back"].includes(x) || Date.now() - T0 > Number(process.env.DEADLINE_MS ?? 180000)) throw new Error(`stopped at ${x}`); await sleep(100); } };
await wait("spec_review"); await call("POST", `/migrations/${id}/plan`); await wait("awaiting_approval");
const plan = (await call("GET", `/migrations/${id}/plan`)).json;
await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash });
try {
await call("POST", `/migrations/${id}/start`);
// Z31: ROLLBACK_AFTER_CUTOVER=1 이면 롤백 가능 창에서 되돌린다 (앱 연결도 도착 → 출발로 돌아와야 한다). ROLLBACK_WINDOW_SEC 를 길게 둔다
if (process.env.ROLLBACK_AFTER_CUTOVER === "1") {
  await wait("rollback_window"); await sleep(Number(process.env.ROLLBACK_DELAY_MS ?? 3000));
  await call("POST", `/migrations/${id}/rollback`, { reason: "z31 rehearsal" }, { "idempotency-key": `z31-rb-${id}` });
  await wait("rolled_back");
} else await wait("completed");
} catch (e) { console.log("STOPPED", (e as Error).message); }  // Z31: 멈춰도 부하기 요약은 찍는다
await sleep(TAIL * 1000);
done = true;
w.kill("SIGINT");
await new Promise((r) => w.on("close", r));

// 초당 줄을 상태에 묶기 (줄이 찍힌 시각 직전 1초가 그 상태)
const stateAt = (t: number) => { let s = "before"; for (const x of timeline) if (x.t <= t) s = x.s; return s; };
const by = new Map<string, { ok: number; fail: number; retry: number; max: number[]; secs: number }>();
for (const p of perSec) { const s = stateAt(p.at - 500); const b = by.get(s) ?? { ok: 0, fail: 0, retry: 0, max: [], secs: 0 }; b.ok += p.ok; b.fail += p.fail; b.retry += p.retry; b.max.push(p.max); b.secs++; by.set(s, b); }
console.log("\n| 이전 상태 | 초 | 성공 | 실패 | 재시도 | 초당 max 의 최대 ms |");
console.log("|---|---|---|---|---|---|");
for (const [s, b] of by) console.log(`| ${s} | ${b.secs} | ${b.ok} | ${b.fail} | ${b.retry} | ${Math.max(...b.max)} |`);
const durs = timeline.map((x, i) => `${x.s}=${i + 1 < timeline.length ? timeline[i + 1]!.t - x.t : 0}ms`).join(" ");
console.log("state durations:", durs);
const sum = JSON.parse(summaryLine || "{}");
console.log("writer summary:", JSON.stringify({ sent: sum.sent, ok: sum.ok, failed: sum.failed, retries: sum.retries, recoveredByRetry: sum.recoveredByRetry, latencyMs: sum.latencyMs, errors: sum.errors }));
console.log("ACK_FILE", sum.ackFile);
// Z31: 앱 안 재시도(db.mjs, 연결 오류 1회) 수 + DB 붙잡기 프록시 상태
const stats = await (await fetch(`${URL_}/api/v1/stats`)).json().catch(() => null) as { app?: { db?: unknown } } | null;
console.log("app db counters:", JSON.stringify(stats?.app?.db ?? null));
if (process.env.DBPROXY_CONTROL) console.log("dbproxy:", await (await fetch(`${process.env.DBPROXY_CONTROL}/status`)).text());
// (Z6 HTTP 프록시가 앞에 있을 때만) 요청 수 요약. 없으면 건너뜀
console.log("proxy:", await fetch(`${URL_}/__stats`).then((r) => r.text()).catch(() => "(HTTP 프록시 없음)"));
console.log("MIGRATION_ID", id);
console.log("perSec max p95 ms", r1(pct(perSec.map((p) => p.max), 95)));

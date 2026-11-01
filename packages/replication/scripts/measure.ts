// 반복 측정: 초기 복사(행 수별) 3회, 쓰기 부하 중 전환·롤백 5회. 먼저 npm run db:up
// 실행: npm run measure  (REPS=5 ROWS=100000 로 바꿀 수 있음)
import { Migration } from "../src/index.js";
import { Router, SOURCE, TABLES, TARGET, pct, resetAndSeed, sleep, startLoad } from "../test/harness.js";

const REPS = Number(process.env.REPS ?? 5);
const ROWS = Number(process.env.ROWS ?? 100_000);
const m = new Migration({ key: "measure", source: SOURCE, target: TARGET, tables: TABLES });
const stat = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return `min ${s[0]!.toFixed(0)} / median ${s[Math.floor(s.length / 2)]!.toFixed(0)} / max ${s.at(-1)!.toFixed(0)}`; };

const copy: number[] = [];
for (let i = 0; i < 3; i++) {
  await resetAndSeed(ROWS);
  const s = await m.sync();
  copy.push(s.measures.find((x) => x.name === "initial_copy_ms")!.value);
  await m.teardown();
}
console.log(`initial_copy_ms (${ROWS} orders, 3회): ${copy.join(", ")} → ${stat(copy)}`);

await resetAndSeed(ROWS);
const router = new Router(SOURCE);
const load = startLoad(router, 8, "measure");
const s = await m.sync();
console.log(`sync gate: ready=${s.gate.ready} lags=${s.gate.lastLags.join(",")}ms`);
const cut: number[] = [], back: number[] = [];
for (let i = 0; i < REPS; i++) {
  const a = await m.cutover({ hooks: router }); if (!a.ok) throw new Error(JSON.stringify(a));
  cut.push(a.pauseMs); await sleep(500);
  const b = await m.rollback({ hooks: router }); if (!b.result?.ok) throw new Error(JSON.stringify(b));
  back.push(b.result.pauseMs); await sleep(500);
}
await load.stop();
console.log(`cutover pause ms (${REPS}회, 부하 8 workers): ${cut.map((x) => x.toFixed(0)).join(", ")} → ${stat(cut)}`);
console.log(`rollback pause ms (${REPS}회): ${back.map((x) => x.toFixed(0)).join(", ")} → ${stat(back)}`);
console.log(`app writes ok=${load.ok} fail=${load.fail} p50=${pct(load.lat, 0.5).toFixed(1)}ms p99=${pct(load.lat, 0.99).toFixed(1)}ms max=${Math.max(...load.lat).toFixed(0)}ms errors=${JSON.stringify(load.errors)}`);
await m.teardown();
console.log(`leftovers: ${JSON.stringify(await m.leftovers())}`);

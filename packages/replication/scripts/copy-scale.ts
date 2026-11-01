// Z52 (모의 심사 Q15): "DB가 100GB면 초기 복사에 얼마나?" 에 답하려고 크기를 바꿔 가며 초기 복사 속도(MB/s)를 잰다.
// 같은 기계의 Postgres 두 대(루프백) 기준이라 리전 간 네트워크·관리형 DB 디스크 한도는 빠져 있다 → 결과는 "상한" 쪽 숫자.
// 실행: npm run db:up 뒤  SIZES_MB=100,300,1000 REPS=3 npx tsx scripts/copy-scale.ts
import { Migration } from "../src/index.js";
import { SOURCE, TABLES, TARGET, q, resetAndSeed } from "../test/harness.js";

const SIZES = (process.env.SIZES_MB ?? "100,300,1000").split(",").map(Number);
const REPS = Number(process.env.REPS ?? 3);
const m = new Migration({ key: "copyscale", source: SOURCE, target: TARGET, tables: TABLES });
const rows: Record<string, unknown>[] = [];

for (const mb of SIZES) {
  for (let r = 1; r <= REPS; r++) {
    await resetAndSeed(0);
    // orders 한 줄 ≈ 1KB (note 900자). 원하는 크기까지 채운다
    const n = Math.round((mb * 1024 * 1024) / 1050);
    await q(SOURCE, `INSERT INTO orders(customer_id, amount, note) SELECT 1 + g % 100, g, repeat(md5(g::text), 28) FROM generate_series(1, ${n}) g`);
    await q(SOURCE, `VACUUM ANALYZE orders`);
    const bytes = Number((await q(SOURCE, `SELECT sum(pg_table_size(c.oid)) b FROM pg_class c WHERE relname = ANY($1)`, [TABLES]))[0].b);
    const t0 = performance.now();
    const s = await m.sync({ waitCopyMs: 1_800_000 });
    const ms = performance.now() - t0;
    const copyMs = s.measures.find((x) => x.name === "initial_copy_ms")?.value ?? ms;
    const row = { sizeMB: Math.round(bytes / 1048576), rep: r, rows: n, copyMs: Math.round(copyMs), MBps: Math.round((bytes / 1048576) / (copyMs / 1000) * 10) / 10,
      gateReady: s.gate.ready, lagMs: s.gate.lastLags };
    console.log(JSON.stringify(row));
    rows.push(row);
    await m.teardown();
  }
}
const mbps = rows.map((r) => r.MBps as number).sort((a, b) => a - b);
const med = mbps[Math.floor(mbps.length / 2)]!;
console.log(`median ${med} MB/s → 100GB 추정 ${Math.round(102400 / med / 60)} 분 (루프백 상한, 【추정】)`);

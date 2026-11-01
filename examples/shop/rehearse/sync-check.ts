// DRAFT(ai): 샘플 앱 DB를 H 복제 모듈로 로컬 대상 DB(target)에 복제해 본다: precheck → sync → (쓰기 멈춤) → 행 수 비교 → teardown.
// 컷오버(앱 접속 바꾸기)는 하지 않는다. 그건 통합본 worker + 트래픽 훅 소관.
// Service 레포 루트에서: REPL_SOURCE_URL=... REPL_TARGET_URL=... npx tsx <이 파일>
import pg from "pg";
import { Migration } from "@svc/replication";

const src = process.env.REPL_SOURCE_URL!;
const tgt = process.env.REPL_TARGET_URL!;
const m = new Migration({
  key: process.env.REPL_KEY ?? "shopdemo",
  source: { label: "local-src", provider: "postgres", adminUrl: src, peerUrl: process.env.REPL_SOURCE_PEER_URL, appRole: "app", schema: "shop" },
  target: { label: "local-tgt", provider: "postgres", adminUrl: tgt, peerUrl: process.env.REPL_TARGET_PEER_URL, appRole: "app", schema: "shop" },
});

const mode = process.argv[2] ?? "all";
const t0 = performance.now();
if (mode === "precheck" || mode === "all") {
  const pc = await m.precheck();
  for (const c of pc.checks) console.log(`${c.ok ? "OK  " : "FAIL"} ${c.id.padEnd(6)} ${c.side.padEnd(6)} ${c.detail}${c.ok || !c.hint ? "" : "  → " + c.hint}`);
  console.log(`precheck ok=${pc.ok}`);
  if (!pc.ok) process.exit(1);
}
if (mode === "sync" || mode === "all") {
  const s0 = performance.now();
  const r = await m.sync({ waitCopyMs: 120000 });
  console.log(JSON.stringify({ phase: r.phase, created: r.created, copy: r.copy, gate: r.gate, syncMs: Math.round(performance.now() - s0) }));
}
if (mode === "compare" || mode === "all") {
  const q = async (url: string) => {
    const c = new pg.Client({ connectionString: url }); await c.connect();
    const r = await c.query(`SELECT 'customers' t, count(*)::int n FROM shop.customers UNION ALL SELECT 'products', count(*)::int FROM shop.products
      UNION ALL SELECT 'orders', count(*)::int FROM shop.orders UNION ALL SELECT 'order_items', count(*)::int FROM shop.order_items ORDER BY 1`);
    await c.end(); return Object.fromEntries(r.rows.map((x) => [x.t, x.n]));
  };
  const a = await q(src); const b = await q(tgt);
  console.log(JSON.stringify({ source: a, target: b, equal: JSON.stringify(a) === JSON.stringify(b) }));
}
if (mode === "teardown") {
  console.log(JSON.stringify(await m.teardown()));
  console.log(JSON.stringify({ leftovers: await m.leftovers() }));
}
console.log(`total ${Math.round(performance.now() - t0)}ms`);
process.exit(0);

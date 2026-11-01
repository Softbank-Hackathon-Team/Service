// 같은 Idempotency-Key 로 POST /migrations 를 동시에 N번 → 기대: 이전 1개, 나머지는 같은 응답 재생
// 실행: npx tsx --env-file=.env tools/load/idem-race.ts   (IDEM_N=20, IDEM_ROUNDS=5)
import { randomUUID } from "node:crypto";
import { call, owner, SRC, DST, summary, printStatusCounts } from "./lib.js";

const N = Number(process.env.IDEM_N ?? 20);
const ROUNDS = Number(process.env.IDEM_ROUNDS ?? 5);
const lat: number[] = [];
let bad = 0;
for (let round = 1; round <= ROUNDS; round++) {
  const key = `load-${randomUUID()}`;
  const body = { sourceEnvId: SRC, targetEnvId: DST };
  const rs = await Promise.all(Array.from({ length: N }, () =>
    call("POST", "/migrations", body, { "idempotency-key": key })));
  rs.forEach((r) => lat.push(r.ms));
  const ids = new Set(rs.filter((r) => r.status < 300).map((r) => r.json.id));
  const replayed = rs.filter((r) => r.headers.get("idempotent-replayed") === "true").length;
  const keyRows = (await owner.query("SELECT count(*)::int n FROM idempotency_keys WHERE key=$1", [key])).rows[0].n;
  const codes = rs.reduce<Record<number, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  const ok = ids.size === 1;
  if (!ok) bad++;
  console.log(`round ${round}: distinct migrations=${ids.size} (expect 1) replayed=${replayed} key rows=${keyRows} codes=${JSON.stringify(codes)} ${ok ? "OK" : "FAIL"}`);
}
console.log("latency ms", JSON.stringify(summary(lat)));
printStatusCounts();
console.log(bad ? `RESULT FAIL ${bad}/${ROUNDS} rounds created duplicates` : "RESULT OK");
await owner.end();

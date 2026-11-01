// 승인 경쟁 3가지
//  A. 같은 계획을 동시에 N번 승인 → 기대: 200 하나, 나머지 409
//  B. 같은 환경 쌍을 쓰는 이전 2개를 동시에 승인 → 기대: 하나 approved, 하나 409 ENV_BUSY
//  C. 승인된 이전에 start 를 동시에 N번 → 기대: 202 하나, 나머지 409, apply 작업 1개
// 실행: npx tsx --env-file=.env tools/load/approval-race.ts   (RACE_N=20, RACE_ROUNDS=5)
import { call, owner, seedEnvPairs, waitStatus, summary, printStatusCounts } from "./lib.js";

const N = Number(process.env.RACE_N ?? 20);
const ROUNDS = Number(process.env.RACE_ROUNDS ?? 5);
const codes = (rs: { status: number; json: any }[]) =>
  rs.reduce<Record<string, number>>((a, r) => { const k = `${r.status}${r.json?.code ? ":" + r.json.code : ""}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});

async function toAwaiting(src: string, dst: string) {
  const c = await call("POST", "/migrations", { sourceEnvId: src, targetEnvId: dst });
  const id = c.json.id as string;
  if ((await waitStatus(id, ["spec_review"], 30000, 100)) !== "spec_review") throw new Error("no spec_review " + id);
  const p = await call("POST", `/migrations/${id}/plan`);
  if (p.status >= 300) throw new Error(`plan ${p.status} ${JSON.stringify(p.json)}`);
  if ((await waitStatus(id, ["awaiting_approval"], 30000, 100)) !== "awaiting_approval") throw new Error("no awaiting " + id);
  const plan = (await call("GET", `/migrations/${id}/plan`)).json;
  return { id, planId: plan.planId as string, planHash: plan.planHash as string };
}

let fail = 0;
const latA: number[] = [], latC: number[] = [];
const pairs = await seedEnvPairs(ROUNDS * 2);
for (let round = 0; round < ROUNDS; round++) {
  // A
  const { src, dst } = pairs[round * 2]!;
  const m = await toAwaiting(src, dst);
  const rs = await Promise.all(Array.from({ length: N }, () =>
    call("POST", `/plans/${m.planId}/approvals`, { decision: "approve", planHash: m.planHash })));
  rs.forEach((r) => latA.push(r.ms));
  const ok200 = rs.filter((r) => r.status === 200).length;
  const appr = (await owner.query(`SELECT count(*)::int n FROM audit_events WHERE target=$1 AND action='plan.approved'`, [m.id])).rows[0].n;
  const locks = (await owner.query(`SELECT count(*)::int n FROM env_locks WHERE migration_id=$1`, [m.id])).rows[0].n;
  const a5 = rs.filter((r) => r.status >= 500).length;
  const okA = ok200 === 1 && appr === 1 && locks === 2 && a5 === 0;
  console.log(`A round ${round + 1}: 200=${ok200} audit plan.approved=${appr} env_locks=${locks} codes=${JSON.stringify(codes(rs))} ${okA ? "OK" : "FAIL"}`);
  if (!okA) fail++;

  // C (같은 이전 이어서)
  const ss = await Promise.all(Array.from({ length: N }, () => call("POST", `/migrations/${m.id}/start`)));
  ss.forEach((r) => latC.push(r.ms));
  const s202 = ss.filter((r) => r.status === 202).length;
  const jobs = (await owner.query(`SELECT count(*)::int n FROM pgboss.job WHERE name='apply' AND data->>'migrationId'=$1`, [m.id])).rows[0].n;
  const okC = s202 === 1 && jobs === 1 && ss.every((r) => r.status < 500);
  console.log(`C round ${round + 1}: 202=${s202} apply jobs=${jobs} codes=${JSON.stringify(codes(ss))} ${okC ? "OK" : "FAIL"}`);
  if (!okC) fail++;

  // B: 새 환경 쌍에 이전 2개
  const p2 = pairs[round * 2 + 1]!;
  const [x, y] = await Promise.all([toAwaiting(p2.src, p2.dst), toAwaiting(p2.src, p2.dst)].map((p) => p.catch((e) => e as Error)));
  if (x instanceof Error || y instanceof Error) {
    console.log(`B round ${round + 1}: could not reach awaiting_approval for both: ${(x as Error).message ?? ""} ${(y as Error).message ?? ""} FAIL`);
    fail++; continue;
  }
  const rb = await Promise.all([x!, y!].map((mm) => call("POST", `/plans/${mm.planId}/approvals`, { decision: "approve", planHash: mm.planHash })));
  const okB = rb.filter((r) => r.status === 200).length === 1 && rb.some((r) => r.json?.code === "ENV_BUSY");
  console.log(`B round ${round + 1}: codes=${JSON.stringify(codes(rb))} ${okB ? "OK" : "FAIL"}`);
  if (!okB) fail++;
}
console.log("A approvals latency ms", JSON.stringify(summary(latA)));
console.log("C start latency ms", JSON.stringify(summary(latC)));
printStatusCounts();
console.log(fail ? `RESULT FAIL ${fail} checks` : "RESULT OK");
await owner.end();

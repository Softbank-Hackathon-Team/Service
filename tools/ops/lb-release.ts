// 운영자 명령 (PF RV-20): 트래픽 LB 주인(db 0040 traffic_leases) 보기·회수.
//   주인 이전이 paused·failed 로 멈추면 LB 를 안 놓아(끝 상태에서만 놓음), 같은 LB 를 쓰는 다른 이전 shift 가 TRAFFIC_LB_BUSY 로 멈춘다.
// 실행 (Service 루트): npm run ops:lb-release -- <LB id>            ← 주인 이전·상태만 보여 줌 (기본)
//                     npm run ops:lb-release -- <LB id> --yes      ← 주인이 멈춘 이전(paused·failed·끝 상태)일 때만 지움
// 주인이 shifting·cutover·rolling_back 이면(가중치를 바꾸는 중) 지우지 않고 exit 1. 지우면 주인 회사 감사에 traffic_lease.released_by_operator
// DRAFT(ai): 가중치(LB)는 건드리지 않는다. 멈춘 주인 이전이 LB 를 반쯤 옮겨 두었으면 그 이전을 롤백·취소하는 것이 먼저다(출력에 안내)
import pg from "pg";
import { withTenant, writeAudit, pool } from "@svc/core";

const args = process.argv.slice(2);
const lb = args.find((a) => !a.startsWith("--"));
const yes = args.includes("--yes");
if (!lb) { console.error("사용법: npm run ops:lb-release -- <LB id> [--yes]"); process.exit(2); }
const MOVING = ["shifting", "cutover", "rolling_back"];

const owner = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL }); await owner.connect();
const h = (await owner.query(`SELECT l.migration_id::text m, l.tenant_id::text t, l.acquired_at, mg.status
    FROM traffic_leases l LEFT JOIN migrations mg ON mg.id = l.migration_id WHERE l.lb_id = $1`, [lb])).rows[0] as
  { m: string; t: string; acquired_at: Date; status: string | null } | undefined;
if (!h) { console.log(`LB ${lb}: 주인 없음`); await owner.end(); await pool.end(); process.exit(0); }
console.log(`LB ${lb}: 주인 이전 ${h.m} (상태 ${h.status ?? "없음"}, ${h.acquired_at.toISOString()} 부터)`);
if (h.status && MOVING.includes(h.status)) {
  console.error(`주인이 가중치를 바꾸는 중(${h.status}) → 안 지움. 그 이전이 끝나거나 멈추면 다시`);
  await owner.end(); await pool.end(); process.exit(1);
}
if (h.status === "paused" || h.status === "failed")
  console.log(`주의: 주인 이전이 ${h.status} — LB 가중치가 반쯤일 수 있다. 가능하면 그 이전을 먼저 롤백·취소(POST .../rollback·cancel)`);
if (!yes) { console.log("보기만 함. 지우려면 --yes"); await owner.end(); await pool.end(); process.exit(0); }
const del = await owner.query("DELETE FROM traffic_leases WHERE lb_id = $1 AND migration_id = $2", [lb, h.m]);
await owner.end();
if (del.rowCount === 1)
  await withTenant(h.t, (tx) => writeAudit(tx, h.t, { actor: `operator:${process.env.USER ?? "unknown"}`, action: "traffic_lease.released_by_operator",
    target: h.m, result: "ok", detail: { lbId: lb, holderStatus: h.status } }));
console.log(del.rowCount === 1 ? "지움. 기다리던 이전을 재개(POST .../resume)" : "그사이 주인이 바뀜 → 다시 보기");
await pool.end();

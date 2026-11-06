// ADR-031 R2: 역방향(온프레 CNPG → 클라우드 RDS 자리) 이전을 로컬 실험장(tools/reverse-lab)의 실제 길로 돌린다.
//   길: 클라우드 DB 가 중계:5432 → 온프레 터널(-R) → 온프레 DB 를 구독. 워커(이 시험)는 중계 입구로만 양쪽에 닿는다
//   롤백 창 역복제: 온프레 DB 가 터널(-L) → 중계 → 클라우드 DB 를 구독
//   권한: 온프레 쪽은 superuser 가 아닌 svc_migrate (CNPG managed role 모양), 클라우드 쪽은 superuser 가 아닌 관리자 (RDS 마스터 모양)
// 실험장이 없으면 건너뛴다: sh tools/reverse-lab/lab.sh up
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Migration, type Endpoint } from "../src/index.js";

const env = process.env;
// 실험장 전용 고정 비밀번호 (tools/reverse-lab/init/*.sql). 컨테이너 밖 실환경 값이 아니다
export const ONPREM: Endpoint = {
  label: "onprem-cnpg", provider: "cnpg", appRole: "shop_app", ephemeralPeerUser: true,
  adminUrl: env.LAB_ONPREM_URL ?? "postgres://svc_migrate:lab-svc-migrate@127.0.0.1:56432/shop",
  // 클라우드 DB 가 온프레를 구독할 때 = 중계의 역방향 끝 (실환경: 중계 사설 IP:5432)
  peerUrl: env.LAB_ONPREM_PEER_URL ?? "postgres://svc_migrate:lab-svc-migrate@relay:5432/shop",
};
export const CLOUD: Endpoint = {
  label: "cloud-rds", provider: "postgres", appRole: "shop_app", ephemeralPeerUser: true,
  adminUrl: env.LAB_CLOUD_URL ?? "postgres://app:lab-cloud-admin@127.0.0.1:56433/shop",
  // 롤백 창에 온프레가 클라우드를 구독할 때 = 온프레 터널 파드의 정방향 입구 (실환경: db-tunnel.<ns>.svc:5432)
  peerUrl: env.LAB_CLOUD_PEER_URL ?? "postgres://app:lab-cloud-admin@tunnel:5432/shop",
};
const TABLES = ["customers", "orders"];
const LAB = fileURLToPath(new URL("../../../tools/reverse-lab/lab.sh", import.meta.url));

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, sql: string, args: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 }); await c.connect();
  try { return (await c.query<T>(sql, args)).rows; } finally { await c.end(); }
}
const reachable = async (e: Endpoint) => { try { await q(e.adminUrl, "SELECT 1"); return true; } catch { return false; } };
const asApp = (e: Endpoint) => { const u = new URL(e.adminUrl); u.username = "shop_app"; u.password = "lab-shop-app"; return u.toString(); };

/** 앱 계정으로 실제 INSERT 를 해 본다 (권한 표가 아니라 진짜 쓰기). 울타리 안이면 false */
async function appInsert(e: Endpoint, item: string): Promise<boolean> {
  try { await q(asApp(e), `INSERT INTO orders(customer_id, item, amount) VALUES (1, $1, 1)`, [item]); return true; }
  catch { return false; }
}
/** 복제 객체 수 (양쪽 0 이어야 정리 끝) */
async function leftovers(e: Endpoint) {
  const [r] = await q<{ slots: string; pubs: string; subs: string; users: string }>(e.adminUrl, `SELECT
    (SELECT count(*) FROM pg_replication_slots) slots, (SELECT count(*) FROM pg_publication) pubs,
    (SELECT count(*) FROM pg_subscription) subs, (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'repl\\_%\\_u') users`);
  return { slots: Number(r!.slots), pubs: Number(r!.pubs), subs: Number(r!.subs), users: Number(r!.users) };
}
const ZERO = { slots: 0, pubs: 0, subs: 0, users: 0 };
const count = async (url: string, where = "true") => Number((await q<{ n: string }>(url, `SELECT count(*) n FROM orders WHERE ${where}`))[0]!.n);
const reset = () => execFileSync("sh", [LAB, "reset"], { stdio: "ignore" });

const up = (await reachable(ONPREM)) && (await reachable(CLOUD));
const skip = up ? false : "역방향 실험장 없음 (sh tools/reverse-lab/lab.sh up)";
let m: Migration | undefined;
before(() => { if (up) reset(); });
after(async () => { if (m) await m.teardown().catch(() => undefined); });

test("역방향 롤백: 온프레 → 클라우드 복제 → 컷오버(온프레 울타리) → 롤백 창 클라우드 쓰기가 온프레로 → 롤백 → 잔여물 0", { skip }, async () => {
  m = new Migration({ key: "revlab1", source: ONPREM, target: CLOUD, tables: TABLES, copySchema: true });
  await m.prepareTarget();
  const s = await m.sync();
  assert.equal(s.gate.ready, true, JSON.stringify(s.gate));
  assert.equal(await count(CLOUD.adminUrl), 500, "초기 복사");
  assert.equal(await appInsert(ONPREM, "before-cutover"), true, "컷오버 전 온프레 앱은 쓴다");

  const c = await m.cutover();
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(await m.phase(), "reverse");
  assert.equal(await count(CLOUD.adminUrl, "item = 'before-cutover'"), 1, "컷오버 전 쓰기가 클라우드에 왔다");
  // 울타리: 온프레 앱 계정(= DB 주인 shop_app)이 실제로 못 쓴다
  assert.equal(await appInsert(ONPREM, "after-cutover-old-side"), false, "온프레 앱이 컷오버 뒤에도 쓴다 (울타리 실패)");

  // 롤백 창: 클라우드에 쓴 행이 역복제로 온프레에 온다
  await q(CLOUD.adminUrl, `INSERT INTO orders(customer_id, item, amount) VALUES (1, 'rollback-window-probe', 1)`);
  let back = 0;
  for (let i = 0; i < 50 && back === 0; i++) { await new Promise((r) => setTimeout(r, 200)); back = await count(ONPREM.adminUrl, "item = 'rollback-window-probe'"); }
  assert.equal(back, 1, "롤백 창 시험 행이 온프레로 안 왔다");

  const r = await m.rollback();
  assert.equal(r.kind, "after_cutover", JSON.stringify(r));
  assert.equal(r.result?.ok, true, JSON.stringify(r.result));
  assert.equal(await appInsert(ONPREM, "after-rollback"), true, "롤백 뒤 온프레 앱이 다시 쓴다");
  await m.teardown();
  assert.deepEqual(await leftovers(ONPREM), ZERO, "온프레 잔여물");
  assert.deepEqual(await leftovers(CLOUD), ZERO, "클라우드 잔여물");
  // 역방향 적용용으로 관리자에게 직접 준 권한(fence.ts ensureApplyGrants)이 정리로 다 걷혔다 (남으면 CNPG 가 svc_migrate 를 못 지운다)
  const direct = await q<{ n: string }>(ONPREM.adminUrl, `SELECT count(*) n FROM pg_class cl
    CROSS JOIN LATERAL aclexplode(cl.relacl) a WHERE a.grantee = 'svc_migrate'::regrole AND cl.relnamespace = 'public'::regnamespace`);
  assert.equal(Number(direct[0]!.n), 0, "svc_migrate 직접 권한이 남았다");
});

test("역방향 완료: 컷오버 → 정리. 클라우드에 전체 데이터, 온프레는 울타리가 남는다(ADR-030), 잔여물 0", { skip }, async () => {
  reset();
  m = new Migration({ key: "revlab2", source: ONPREM, target: CLOUD, tables: TABLES, copySchema: true });
  await m.prepareTarget();
  assert.equal((await m.sync()).gate.ready, true);
  await q(asApp(ONPREM), `INSERT INTO orders(customer_id, item, amount) SELECT 1, 'live-' || g, g FROM generate_series(1, 100) g`);
  const c = await m.cutover();
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(await count(CLOUD.adminUrl), 600, "출발 500 + 복제 중 쓰기 100");
  // 클라우드 앱 계정의 로그인 비밀번호는 실환경에선 도착 인프라(Terraform·비밀 저장소)가 만든다. 여기선 관리자가 대신 정한다
  await q(CLOUD.adminUrl, `ALTER ROLE shop_app LOGIN PASSWORD 'lab-shop-app'`);
  await m.teardown();
  assert.deepEqual(await leftovers(ONPREM), ZERO);
  assert.deepEqual(await leftovers(CLOUD), ZERO);
  assert.equal(await appInsert(ONPREM, "after-complete"), false, "완료 뒤 옛 출발(온프레)은 울타리가 남아야 한다");
  assert.equal(await appInsert(CLOUD, "new-home"), true, "클라우드 앱 계정이 새 쓰기 담당");
});

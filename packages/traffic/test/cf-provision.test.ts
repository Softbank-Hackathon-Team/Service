// 이전마다 Cloudflare 트래픽 자원 만들기·지우기 (cf-provision). 가짜 Cloudflare 를 fetch 로 흉내 낸다 (네트워크·토큰 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { cfResourcePrefix, cloudflarePreflight, ensureMigrationCf, teardownMigrationCf, tunnelIngressConfig, type FetchLike } from "@svc/traffic";

const ACC = "a".repeat(32), ZONE = "z".repeat(32);
const MIG = "cdaece4c-b6f2-4679-b4bf-dab6871d28ce";
const HOST = "shop.example.test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any;
function fakeCf(seed: { lbs?: Obj[]; pools?: Obj[]; monitors?: Obj[]; tunnels?: Obj[] } = {}) {
  const db: Record<"lbs" | "pools" | "monitors" | "tunnels", Obj[]> = { lbs: [...(seed.lbs ?? [])], pools: [...(seed.pools ?? [])], monitors: [...(seed.monitors ?? [])], tunnels: [...(seed.tunnels ?? [])] };
  const calls: string[] = [];
  let n = 0;
  const nid = () => (++n).toString(16).padStart(32, "0");
  const ok = (result: unknown) => ({ status: 200, json: async () => ({ success: true, result }) });
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url); const p = u.pathname.replace(/^\/client\/v4/, ""); const m = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push(`${m} ${p}`);
    const coll = (seg: string) => seg === "load_balancers" && p.startsWith("/zones") ? db.lbs : seg === "pools" ? db.pools : seg === "monitors" ? db.monitors : null;
    let r: RegExpExecArray | null;
    if ((r = /^\/accounts\/[^/]+\/cfd_tunnel$/.exec(p))) {
      if (m === "GET") return ok(db.tunnels.filter((t) => t.name === u.searchParams.get("name") && !t.deleted_at));
      const t = { id: `${nid().slice(0, 8)}-0000-4000-8000-${nid().slice(0, 12)}`, ...body }; db.tunnels.push(t); return ok(t);
    }
    if ((r = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/configurations$/.exec(p))) { db.tunnels.find((t) => t.id === r![1])!.config = body.config; return ok({}); }
    if ((r = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/token$/.exec(p))) return ok(`tok-${r[1]}`);
    if ((r = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/connections$/.exec(p))) return ok({});
    if ((r = /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)$/.exec(p))) { db.tunnels.find((t) => t.id === r![1])!.deleted_at = "now"; return ok({}); }
    if ((r = /\/(load_balancers|pools|monitors)$/.exec(p))) {
      const c = coll(r[1]!)!;
      if (m === "GET") return ok(c);
      const o = { id: nid(), ...body }; c.push(o); return ok(o);
    }
    if ((r = /\/(load_balancers|pools|monitors)\/([^/]+)$/.exec(p))) {
      const c = coll(r[1]!)!; const i = c.findIndex((x) => x.id === r![2]);
      if (m === "DELETE") { c.splice(i, 1); return ok({ id: r[2] }); }
      Object.assign(c[i], body); return ok(c[i]);
    }
    return { status: 404, json: async () => ({ success: false, errors: [{ code: 7003, message: `no route ${m} ${p}` }], result: null }) };
  };
  return { db, calls, fetch };
}
const ctx = (f: FetchLike) => ({ token: async () => "fake", accountId: ACC, zoneId: ZONE, fetch: f, baseUrl: "https://cf.test/client/v4" });
const input = { migrationId: MIG, hostname: HOST, sourceOrigin: "src-tunnel.cfargotunnel.com", targetService: "http://shop-web.app-shop-api:80" };

test("이전 하나: 터널·모니터·pool 2·LB 를 만들고, LB 는 출발 100% 로 설계 조건을 지킨다. 다시 불러도 새로 안 만든다", async () => {
  const f = fakeCf();
  const r = await ensureMigrationCf(ctx(f.fetch), input);
  assert.equal(r.tunnelToken, `tok-${r.tunnelId}`);
  assert.equal(f.db.tunnels.length, 1);
  assert.equal(f.db.tunnels[0].name, `${cfResourcePrefix(MIG)}-tgt`);
  assert.deepEqual(f.db.tunnels[0].config.ingress, [{ hostname: HOST, service: input.targetService }, { service: "http_status:404" }]);
  const tgtPool = f.db.pools.find((p) => p.id === r.targetPoolId)!;
  assert.equal(tgtPool.origins[0].address, `${r.tunnelId}.cfargotunnel.com`);
  assert.deepEqual(tgtPool.origins[0].header, { Host: [HOST] });
  const lb = f.db.lbs[0]!;
  assert.equal(lb.name, HOST);
  assert.deepEqual(cloudflarePreflight(r, lb), []);
  assert.deepEqual(lb.random_steering.pool_weights, { [r.sourcePoolId]: 1, [r.targetPoolId]: 0 });
  const again = await ensureMigrationCf(ctx(f.fetch), input);
  assert.deepEqual({ ...again, tunnelToken: "" }, { ...r, tunnelToken: "" });
  assert.deepEqual([f.db.tunnels.length, f.db.monitors.length, f.db.pools.length, f.db.lbs.length], [1, 1, 2, 1]);
});

test("거부: 같은 호스트에 다른 LB(사람·다른 이전)가 있으면 LB 를 만들지 않고 409", async () => {
  const f = fakeCf({ lbs: [{ id: "x".repeat(32), name: HOST, description: "manual" }] });
  await assert.rejects(ensureMigrationCf(ctx(f.fetch), input), /다른 LB/);
  assert.equal(f.db.lbs.length, 1);
});

test("롤백 지우기: 이 이전 것만 LB → pool → 모니터 → 터널 순서로 지우고 남의 자원은 그대로", async () => {
  const other = { id: "o".repeat(32), name: "cf-check-src", description: "cf-check pool" };
  const f = fakeCf({ pools: [other] });
  await ensureMigrationCf(ctx(f.fetch), input);
  f.calls.length = 0;
  const t = await teardownMigrationCf(ctx(f.fetch), MIG);
  assert.deepEqual(t.errors, []);
  assert.deepEqual(t.removed, ["lb", "pool:src", "pool:tgt", "monitor", "tunnel:tgt"]);
  assert.deepEqual(f.db.pools, [other]);
  assert.deepEqual([f.db.lbs.length, f.db.monitors.length], [0, 0]);
  assert.ok(f.db.tunnels[0].deleted_at);
  const dels = f.calls.filter((c) => c.startsWith("DELETE"));
  assert.match(dels[0]!, /load_balancers\//); assert.match(dels.at(-1)!, /cfd_tunnel\/[^/]+$/);
  // 다시 불러도 안전 (지울 게 없음)
  assert.deepEqual((await teardownMigrationCf(ctx(f.fetch), MIG)).removed, []);
});

test("완료 정리(keepTarget): 앱 호스트가 도착을 계속 가리키게 LB·도착 pool·터널은 남기고 출발 pool 만 뺀다", async () => {
  const f = fakeCf();
  const r = await ensureMigrationCf(ctx(f.fetch), input);
  const t = await teardownMigrationCf(ctx(f.fetch), MIG, { keepTarget: true });
  assert.deepEqual(t.errors, []);
  assert.deepEqual(f.db.lbs[0]!.default_pools, [r.targetPoolId]);
  assert.equal(f.db.lbs[0]!.fallback_pool, r.targetPoolId);
  assert.deepEqual(f.db.pools.map((p) => p.id), [r.targetPoolId]);
  assert.ok(!f.db.tunnels[0]!.deleted_at);
});

test("거부: 연결 대상이 주소 모양이 아니면 터널 규칙을 안 만든다", () => {
  assert.throws(() => tunnelIngressConfig(HOST, "shop-web:80"), /http/);
});

// 이전마다 트래픽 입구 (traffic-entry.ts): 값에서 입구 찾기, 켜짐·꺼짐·건너뜀·멈춤·성공, 봉인 비밀 끼우기, 정리.
// 가짜 Cloudflare 를 fetch 로 흉내 낸다 (네트워크·토큰 0). 터널 토큰 평문은 단언에 쓰지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelmValues, TrafficTarget } from "@svc/contracts";
import type { CfProvisionCtx, FetchLike } from "@svc/traffic";
import { entryFailHint, entryOf, prepareTrafficEntry, teardownTrafficEntry, withTrafficEntry, TUNNEL_TOKEN_SECRET } from "../src/traffic-entry.js";

const MIG = "cdaece4c-b6f2-4679-b4bf-dab6871d28ce";
const TENANT = "00000000-0000-4000-8000-000000000001";
const HOST = "shop.example.test";
const ON = { TRAFFIC_AUTO_LB: "1" } as NodeJS.ProcessEnv;

const values: HelmValues = {
  namespace: "app-shop-api",
  ingress: { mode: "cloudflared", hosts: [{ hostnames: [HOST], paths: [{ path: "/", service: "shop-web", port: 80 }] }] },
  externalSecrets: { store: "vault", secrets: [{ name: TUNNEL_TOKEN_SECRET }, { name: "db-app" }] },
};

const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
function testCert(): string {
  const d = mkdtempSync(join(tmpdir(), "svc-te-test-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(d, "k.pem"), "-out", join(d, "c.pem"),
      "-days", "1", "-subj", "/CN=traffic-entry-test"], { stdio: "ignore" });
    return readFileSync(join(d, "c.pem"), "utf8");
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any;
function fakeCf(dns: Obj[]) {
  const db: Record<"lbs" | "pools" | "monitors" | "tunnels", Obj[]> = { lbs: [], pools: [], monitors: [], tunnels: [] };
  let n = 0;
  const nid = () => (++n).toString(16).padStart(32, "0");
  const ok = (result: unknown) => ({ status: 200, json: async () => ({ success: true, result }) });
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url); const p = u.pathname.replace(/^\/client\/v4/, ""); const m = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const coll = (seg: string) => seg === "load_balancers" ? db.lbs : seg === "pools" ? db.pools : db.monitors;
    let r: RegExpExecArray | null;
    if (/\/dns_records$/.test(p)) return ok(dns.filter((x) => x.name === u.searchParams.get("name")));
    if (/^\/accounts\/[^/]+\/cfd_tunnel$/.test(p)) {
      if (m === "GET") return ok(db.tunnels.filter((t) => t.name === u.searchParams.get("name") && !t.deleted_at));
      const t = { id: `${nid().slice(0, 8)}-0000-4000-8000-${nid().slice(0, 12)}`, ...body }; db.tunnels.push(t); return ok(t);
    }
    if (/\/cfd_tunnel\/[^/]+\/(configurations|connections)$/.test(p)) return ok({});
    if ((r = /\/cfd_tunnel\/([^/]+)\/token$/.exec(p))) return ok(`tok-${r[1]}`);
    if ((r = /\/cfd_tunnel\/([^/]+)$/.exec(p))) { db.tunnels.find((t) => t.id === r![1])!.deleted_at = "now"; return ok({}); }
    if ((r = /\/(load_balancers|pools|monitors)$/.exec(p))) {
      const c = coll(r[1]!);
      if (m === "GET") return ok(c);
      const o = { id: nid(), ...body }; c.push(o); return ok(o);
    }
    if ((r = /\/(load_balancers|pools|monitors)\/([^/]+)$/.exec(p))) {
      const c = coll(r[1]!); const i = c.findIndex((x) => x.id === r![2]);
      if (m === "DELETE") { c.splice(i, 1); return ok({ id: r[2] }); }
      Object.assign(c[i], body); return ok(c[i]);
    }
    return { status: 404, json: async () => ({ success: false, errors: [{ code: 7003, message: `no route ${m} ${p}` }], result: null }) };
  };
  return { db, fetch };
}
const ctxOf = (f: FetchLike): CfProvisionCtx => ({ token: async () => "fake", accountId: "a".repeat(32), zoneId: "z".repeat(32), fetch: f, baseUrl: "https://cf.test/client/v4" });

test("entryOf: cloudflared 입구의 첫 호스트와 도착 서비스 주소. 입구가 없으면 null", () => {
  assert.deepEqual(entryOf(values), { hostname: HOST, targetService: "http://shop-web.app-shop-api:80" });
  assert.equal(entryOf({ ...values, ingress: { mode: "none" } }), null);
  assert.equal(entryOf({ namespace: "x" }), null);
});

test("withTrafficEntry: 봉인 비밀을 넣고 같은 이름 ExternalSecret 줄만 뺀다", () => {
  const v = withTrafficEntry({ ...values, sealedSecrets: [{ name: TUNNEL_TOKEN_SECRET, encryptedData: { token: "old" } }] },
    { name: TUNNEL_TOKEN_SECRET, encryptedData: { token: "new" } });
  assert.deepEqual((v.externalSecrets as Obj).secrets, [{ name: "db-app" }]);
  assert.deepEqual(v.sealedSecrets, [{ name: TUNNEL_TOKEN_SECRET, encryptedData: { token: "new" } }]);
});

test("꺼짐·건너뜀: TRAFFIC_AUTO_LB 없으면 off, 입구 없거나 클라우드 도착이면 skipped (Cloudflare 호출 0)", async () => {
  const base = { tenantId: TENANT, migrationId: MIG, provider: "onprem", values, sealingCertPem: "x" };
  assert.deepEqual(await prepareTrafficEntry(base, {}), { kind: "off" });
  const never: FetchLike = async () => { throw new Error("호출되면 안 됨"); };
  assert.equal((await prepareTrafficEntry({ ...base, values: { namespace: "n" } }, ON, { ctx: ctxOf(never) })).kind, "skipped");
  assert.equal((await prepareTrafficEntry({ ...base, provider: "gcp" }, ON, { ctx: ctxOf(never) })).kind, "skipped");
});

test("거부: 켰는데 설정이 빠지면 TRAFFIC_ENTRY_NOT_CONFIGURED, 출발 DNS 줄이 없으면 TRAFFIC_SOURCE_ENTRY_MISSING (자원 안 만듦)", async () => {
  const base = { tenantId: TENANT, migrationId: MIG, provider: "onprem", values, sealingCertPem: "x" };
  const a = await prepareTrafficEntry(base, { ...ON, CLOUDFLARE_ACCOUNT_ID: "a" });
  assert.equal(a.kind === "stop" && a.code, "TRAFFIC_ENTRY_NOT_CONFIGURED");
  assert.match(a.kind === "stop" ? a.reason : "", /CLOUDFLARE_ZONE_ID/);
  const f = fakeCf([]);
  const b = await prepareTrafficEntry(base, ON, { ctx: ctxOf(f.fetch), register: async () => { throw new Error("등록되면 안 됨"); } });
  assert.equal(b.kind === "stop" && b.code, "TRAFFIC_SOURCE_ENTRY_MISSING");
  assert.deepEqual([f.db.tunnels.length, f.db.lbs.length], [0, 0]);
});

test("성공: 자원을 만들고 이 이전에 등록, 터널 토큰은 봉인 비밀로만 돌려준다. 롤백 정리는 모두 지운다", { skip: hasOpenssl ? false : "openssl 없음" }, async () => {
  const f = fakeCf([{ type: "CNAME", name: HOST, content: "11112222-3333-4444-5555-666677778888.cfargotunnel.com" }]);
  const reg: Array<[string, string, TrafficTarget]> = [];
  const r = await prepareTrafficEntry({ tenantId: TENANT, migrationId: MIG, provider: "onprem", values, sealingCertPem: testCert() }, ON,
    { ctx: ctxOf(f.fetch), register: async (t, m, tt) => { reg.push([t, m, tt]); } });
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.sealedSecret.name, TUNNEL_TOKEN_SECRET);
  assert.ok(r.sealedSecret.encryptedData.token && !r.sealedSecret.encryptedData.token.includes("tok-"));
  assert.equal(reg.length, 1);
  assert.deepEqual(reg[0]![2], { provider: "cloudflare", lbId: f.db.lbs[0].id, sourcePoolId: r.detail.sourcePoolId, targetPoolId: r.detail.targetPoolId, zoneId: "z".repeat(32) });
  assert.equal(f.db.pools.find((p) => p.id === r.detail.sourcePoolId).origins[0].address, "11112222-3333-4444-5555-666677778888.cfargotunnel.com");
  assert.ok(!JSON.stringify(r.detail).includes("5555-6666"), "출발 오리진은 가려서 남긴다");
  const t = await teardownTrafficEntry(MIG, { keepTarget: false }, ON, ctxOf(f.fetch));
  assert.ok("removed" in t && t.errors.length === 0);
  assert.deepEqual([f.db.lbs.length, f.db.pools.length, f.db.monitors.length], [0, 0, 0]);
});

test("정리: 꺼져 있으면 아무것도 안 한다", async () => {
  assert.deepEqual(await teardownTrafficEntry(MIG, { keepTarget: true }, {}), { skipped: "traffic_auto_lb_off" });
});

test("실패 안내: 요금제 오리진 한도면 토큰이 아니라 한도를 말한다, 그 밖은 토큰 권한", () => {
  assert.match(entryFailHint("Cloudflare POST /accounts/x/load_balancers/pools 실패: 1002 adding 1 origins to current total (2) would surpass the limit (2): validation failed"), /오리진 수 한도/);
  assert.match(entryFailHint("Cloudflare GET ... 9106 Authentication failed"), /토큰 권한/);
});

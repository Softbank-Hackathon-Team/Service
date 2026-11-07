// #373 B3 DB 시험 (상태: AI 초안): 같은 출발 환경을 TTL 안에 다시 가져오면 읽기 CLI 를 다시 부르지 않고, 감사 detail.cache(→ 타임라인)에 쓰임이 남는다.
//   kubectl 은 PATH 앞 가짜 스크립트 (온프레 push 출발 = --context 로 직접 읽는 길, MOCK_SEED 끔). IMPORT_CACHE_SEC=0 이면 캐시 없음
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let adapters: typeof import("@svc/adapters");
let owner: pg.Client;
const T = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "b3-bin-"));
const log = join(bin, "calls.log");
const saved = { PATH: process.env.PATH, MOCK_SEED: process.env.MOCK_SEED, ONPREM_FLOOR_VIA_GIT: process.env.ONPREM_FLOOR_VIA_GIT, IMPORT_CACHE_SEC: process.env.IMPORT_CACHE_SEC };
const DG = "sha256:" + "a".repeat(64);
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

before(async () => {
  if (skip) return;
  const dep = { metadata: { name: "shop-api", namespace: "shop" }, spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } },
    template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{ name: "api", image: `ghcr.io/demo/shop-api@${DG}`, ports: [{ containerPort: 8080 }] }] } } } };
  const svc = { metadata: { name: "shop-api", namespace: "shop" }, spec: { selector: { app: "shop-api" }, ports: [{ port: 80, targetPort: 8080 }] } };
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh
echo "kubectl $*" >> ${log}
[ "$1" = api-resources ] && exit 0
case "$2" in
  nodes) echo '${JSON.stringify({ items: [{ metadata: { name: "n1" }, status: { nodeInfo: { kubeletVersion: "v1.31.5+k3s1" } } }] })}' ;;
  deployments) echo '${JSON.stringify({ items: [dep] })}' ;;
  services) echo '${JSON.stringify({ items: [svc] })}' ;;
  namespace) echo '${JSON.stringify({ metadata: { name: "shop" } })}' ;;
  *) echo '{"items":[]}' ;;
esac
`);
  chmodSync(join(bin, "kubectl"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  delete process.env.MOCK_SEED;
  process.env.ONPREM_FLOOR_VIA_GIT = "0";   // kubectl --context 로 직접 읽는 길 (pull 이면 Agent 스냅숏 재생이라 캐시를 안 탐)
  delete process.env.IMPORT_CACHE_SEC;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-b3-cache')", [T]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = saved.PATH;
  for (const k of ["MOCK_SEED", "ONPREM_FLOOR_VIA_GIT", "IMPORT_CACHE_SEC"] as const) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  adapters.clearImportCache();
  await core.pool.end(); await owner.end(); rmSync(bin, { recursive: true, force: true });
});

async function sourceEnv() {
  const src = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,'onprem','s','connected')`, [src, T]);
  return src;
}
async function migration(src: string) {
  const id = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$2,'gcp','d','connected')`, [dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-b3-${id.slice(0, 8)}`, migrationId: id });
const reviewDetail = async (id: string) =>
  (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review'", [id])).rows[0]?.detail as Record<string, unknown> | undefined;

test("같은 출발 환경의 두 번째 가져오기: kubectl 0번, detail.cache.hits = 첫 번째의 misses, 타임라인 detail 에 보임", { skip }, async () => {
  adapters.clearImportCache();
  const src = await sourceEnv();
  writeFileSync(log, "");
  const a = await migration(src);
  assert.equal(await imp.handleImport(job(a)), "advanced");
  const first = calls().length;
  assert.ok(first >= 10, `첫 가져오기 kubectl ${first}번`);
  const c1 = (await reviewDetail(a))?.cache as { ttlSec: number; hits: number; misses: number; bypass: number } | undefined;
  assert.deepEqual(c1 && { ttlSec: c1.ttlSec, hits: c1.hits, bypass: c1.bypass }, { ttlSec: 300, hits: 0, bypass: 0 });
  assert.equal(c1!.misses, first);

  writeFileSync(log, "");
  const b = await migration(src);
  assert.equal(await imp.handleImport(job(b)), "advanced");
  assert.deepEqual(calls(), [], "TTL 안 = 기록 재생");
  const c2 = (await reviewDetail(b))?.cache as { hits: number; misses: number; maxAgeSec: number };
  assert.equal(c2.hits, first); assert.equal(c2.misses, 0);
  assert.ok(c2.maxAgeSec >= 0 && c2.maxAgeSec < 300);
  // 명세는 같다 (같은 원본)
  const spec = async (id: string) => (await owner.query("SELECT spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows[0].spec_v2.spec;
  assert.deepEqual(await spec(b), await spec(a));
  const tl = await core.withTenant(T, (tx) => core.loadTimeline(tx, b));
  const item = tl!.items.find((i) => i.action === "migration.spec_review")!;
  assert.deepEqual((item.detail.cache as { hits: number }).hits, first, "타임라인 detail.cache");
});

test("거부: 다른 출발 환경은 기록을 같이 쓰지 않고, IMPORT_CACHE_SEC=0 이면 매번 읽고 detail.cache 도 없음", { skip }, async () => {
  adapters.clearImportCache();
  const src1 = await sourceEnv(), src2 = await sourceEnv();
  writeFileSync(log, "");
  await imp.handleImport(job(await migration(src1)));
  const n = calls().length;
  writeFileSync(log, "");
  await imp.handleImport(job(await migration(src2)));
  assert.equal(calls().length, n, "환경이 다르면 다시 읽음");

  process.env.IMPORT_CACHE_SEC = "0";
  try {
    writeFileSync(log, "");
    const off = await migration(src1);
    assert.equal(await imp.handleImport(job(off)), "advanced");
    assert.equal(calls().length, n, "끔 = 다시 읽음");
    assert.equal((await reviewDetail(off))?.cache, undefined);
  } finally { delete process.env.IMPORT_CACHE_SEC; }
});

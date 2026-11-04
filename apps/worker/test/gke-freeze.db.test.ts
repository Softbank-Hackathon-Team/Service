// 이전 중 도착 GKE 업그레이드 멈춤 워커 훅: 전용 프로젝트·클러스터·위치를 환경 표에서 읽고 감사 한 줄. 클라우드 호출 0 (가짜 exec·토큰)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let job: typeof import("../src/jobs/gke-freeze.js");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  job = await import("../src/jobs/gke-freeze.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-gke-freeze')", [T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function seed(provider: string, cluster: string | null = "platform-target", region: string | null = "asia-northeast3-a") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES ($1,$2,'aws','s','connected','111122223333')`, [src, T]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, cluster_name, region, gcp_target_project)
    VALUES ($1,$2,$3,'g','connected',$4,$5,$6,$7)`,
    [dst, T, provider, provider === "gcp" ? "cust-proj" : "444455556666", cluster, region, provider === "gcp" ? "cust-mig" : null]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'provisioning')`, [id, T, src, dst]);
  return { m: { id, status: "provisioning" as const, sourceEnvId: src, targetEnvId: dst }, j: { tenantId: T, migrationId: id } };
}
function fakeCli(existing: () => string[]) {
  const calls: string[][] = [];
  const exec = async (_b: string, args: string[]) => {
    calls.push(args);
    if (args[2] === "describe") return { code: 0, stdout: JSON.stringify({ maintenancePolicy: { window: { maintenanceExclusions: Object.fromEntries(existing().map((n) => [n, {}])) } } }), stderr: "", ms: 1 };
    return { code: 0, stdout: "", stderr: "", ms: 1 };
  };
  return { calls, cli: { exec, env: { PATH: process.env.PATH } } };
}
const audits = async (id: string) => (await owner.query(`SELECT action, result, detail FROM audit_events WHERE target = $1 AND action LIKE 'gke_freeze.%' ORDER BY seq`, [id])).rows;

test("GKE 멈춤 훅 정상: 전용 프로젝트 클러스터에 걸고(감사 ok), 끝 상태 completed 에서 풂", { skip }, async () => {
  const { m, j } = await seed("gcp");
  let have: string[] = [];
  const f = fakeCli(() => have);
  const r = await job.freezeTargetGke(j, m, { cli: f.cli, token: "tok", now: () => new Date("2026-11-04T03:00:00Z") });
  assert.equal((r as { done: string }).done, "added");
  const upd = f.calls.find((a) => a[2] === "update")!;
  assert.ok(upd.includes("--project=cust-mig"), "원래 프로젝트에 걺");
  assert.ok(upd.includes("--location=asia-northeast3-a") && upd.includes("platform-target"));
  have = [(r as { name: string }).name];
  assert.equal(await job.releaseTargetGke(j, m, "migrating" as never, { cli: f.cli, token: "tok" }), null, "끝 상태가 아닌데 풂");
  const rel = await job.releaseTargetGke(j, m, "completed", { cli: f.cli, token: "tok" });
  assert.equal((rel as { done: string }).done, "removed");
  const a = await audits(m.id);
  assert.deepEqual(a.map((x) => [x.action, x.result]), [["gke_freeze.freeze", "ok"], ["gke_freeze.release", "ok"]]);
  assert.equal(a[1]!.detail.reason, "completed");
  assert.ok(!JSON.stringify(a).includes("tok"), "토큰이 감사에 남음");
});

test("GKE 멈춤 훅 거부: AWS 도착은 안 부름(감사 없음), 클러스터 없음·stub 토큰은 건너뜀, gcloud 실패는 이전을 안 멈추고 감사 error", { skip }, async () => {
  const f = fakeCli(() => []);
  let s = await seed("aws");
  assert.deepEqual(await job.freezeTargetGke(s.j, s.m, { cli: f.cli, token: "tok" }), { skipped: "not_gcp" });
  assert.equal((await audits(s.m.id)).length, 0);
  s = await seed("gcp", null);
  assert.deepEqual(await job.freezeTargetGke(s.j, s.m, { cli: f.cli, token: "tok" }), { skipped: "no_cluster" });
  s = await seed("gcp");
  assert.deepEqual(await job.freezeTargetGke(s.j, s.m, { cli: f.cli, token: "" }), { skipped: "stub" });
  // 진짜 길: 도착 실행 역할을 빌림 → 시험의 가짜 발급기(REAL_STS=0)는 stub 이라 클라우드를 안 부름
  assert.deepEqual(await job.freezeTargetGke(s.j, s.m, { cli: f.cli }), { skipped: "stub" });
  assert.equal(f.calls.length, 0, "건너뛰어야 할 때 gcloud 를 부름");
  const bad = { exec: async () => ({ code: 1, stdout: "", stderr: "PERMISSION_DENIED", ms: 1 }), env: {} };
  const r = await job.releaseTargetGke(s.j, s.m, "rolled_back", { cli: bad, token: "tok" });
  assert.ok(r && "error" in r, "실패를 던지지 말고 돌려줘야 함");
  const a = await audits(s.m.id);
  assert.deepEqual(a.map((x) => [x.action, x.result]), [["gke_freeze.freeze", "ok"], ["gke_freeze.freeze", "ok"], ["gke_freeze.release", "error"]]);
});

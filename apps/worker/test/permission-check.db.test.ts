// PERM-GATE DB 시험: ① permission-check 작업이 관찰 역할을 빌려 그 자격으로만 읽고 결과를 저장한다 ② 사전 점검 칸이 이 이전이 쓰는 묶음만 보고
//   빠졌으면 block 항목 + detail(missing·hint·permissionGaps). 가짜 gcloud·testIamPermissions (실제 GCP 호출 없음). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let job: typeof import("../src/jobs/permission-check.js");
let gate: typeof import("../src/permission-gate.js");
let owner: pg.Client;
const T = randomUUID();
const SP = "cust-prj", TP = "cust-mig";
const PLATFORM_SA_ID = "t-0123456789abcdef0123456789ab", PLATFORM_PRJ = "plat-prj";
const MEASURED = ["compute.globalAddresses.setLabels", "compute.addresses.setLabels", "compute.instanceGroupManagers.get"];
const yaml = (f: string) => readFileSync(new URL(`../../../infra/permissions/${f}`, import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
const bundles = JSON.parse(readFileSync(new URL("../../../infra/permissions/permission-bundles.json", import.meta.url), "utf8")).bundles as { id: string; permissions: string[]; apis: string[] }[];

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  job = await import("../src/jobs/permission-check.js");
  gate = await import("../src/permission-gate.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name, gcp_platform_sa) VALUES ($1, 'test-permission-check', $2)", [T, PLATFORM_SA_ID]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function seed(provider: string, o: { status?: string; target?: string | null } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, gcp_target_project) VALUES ($1,$2,$3,'e',$4,$5,$6)`,
    [id, T, provider, o.status ?? "connected", provider === "gcp" ? SP : "111122223333", o.target === undefined ? (provider === "gcp" ? TP : null) : o.target]);
  return id;
}
/** 11/06 실측 상태의 전용 프로젝트: platform_env 에 세 권한이 없음. 나머지는 다 있음 */
function gcpWorld(envPerms = yaml("gcp-env-custom-role.yaml").filter((p) => !MEASURED.includes(p))) {
  const calls: string[] = [];
  const role = (id: string) => `projects/${TP}/roles/${id}`, sa = (n: string, p = TP) => `serviceAccount:${n}@${p}.iam.gserviceaccount.com`;
  const defs: Record<string, string[]> = { platform_env: envPerms, platform_operate: yaml("gcp-operate-custom-role.yaml"),
    platform_plan: bundles.find((b) => b.id === "gcp.plan")!.permissions, platform_operate_iam: yaml("gcp-operate-iam-custom-role.yaml"),
    platform_operate_db_secret: ["secretmanager.versions.access"], platform_hub_access: ["container.clusters.get"], platform_observe: [] };
  const exec = (async (_b: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
    calls.push(args.join(" "));
    assert.equal(o.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "borrowed-token");
    const ok = (x: unknown) => ({ code: 0, stdout: JSON.stringify(x), stderr: "", ms: 1 });
    if (args[0] === "services") return ok(bundles.flatMap((b) => b.apis).map((a) => ({ config: { name: a } })));
    if (args[1] === "get-iam-policy") return ok({ bindings: [
      { role: role("platform_env"), members: [sa("svc-env")] }, { role: role("platform_operate"), members: [sa("svc-operate")] },
      { role: role("platform_plan"), members: [sa("svc-plan")] }, { role: role("platform_operate_iam"), members: [sa("svc-operate")], condition: { title: "c" } },
      { role: role("platform_operate_db_secret"), members: [sa("svc-operate")], condition: { title: "c" } },
      { role: role("platform_hub_access"), members: [`serviceAccount:${PLATFORM_SA_ID}@${PLATFORM_PRJ}.iam.gserviceaccount.com`] }] });
    if (args[1] === "roles") return ok({ includedPermissions: defs[args[3]!] ?? [], description: "x" });
    throw new Error(args.join(" "));
  }) as never;
  const fetch = (async (_u: string, init: { body: string }) => new Response(JSON.stringify({ permissions: JSON.parse(init.body).permissions }), { status: 200 })) as never;
  return { calls, gcp: { exec, fetch } };
}
const roles = (o: { stub?: boolean } = {}) => {
  const revoked: string[] = [], issued: { actions: string[]; purpose: string }[] = [];
  return { revoked, issued, broker: {
    issue: async (r: { actions: string[]; purpose: string }) => { issued.push(r); return { credentialRef: "ref", stub: !!o.stub, expiresAt: "2099-01-01T00:00:00Z" }; },
    use: () => ({ kind: "bearer", token: "borrowed-token" }),
    revoke: async (_r: string, _t: string, why: string) => { revoked.push(why); },
  } as never };
};
const stored = async (envId: string) => (await owner.query("SELECT result, checked_at FROM environment_permissions WHERE environment_id=$1", [envId])).rows[0];

test("permission-check: 빌린 관찰 토큰으로만 읽고 GCP 차이를 저장 (11/06 env 세 권한), 쓰기 명령 없음, 회수", { skip }, async () => {
  const id = await seed("gcp");
  const w = gcpWorld(), r = roles();
  assert.equal(await job.handlePermissionCheck({ tenantId: T, requestId: "r1", envId: id }, { roles: r.broker, realSts: true, gcp: w.gcp }), "saved");
  const row = await stored(id);
  assert.ok(row.checked_at);
  const env = row.result.gaps.find((g: { bundleId: string }) => g.bundleId === "gcp.env");
  assert.deepEqual([env.level, env.missing], ["block", [...MEASURED].sort()]);
  assert.equal(row.result.requiredVersion, 2);
  assert.ok(w.calls.every((c) => /^(services list|projects get-iam-policy|iam roles describe)/.test(c)), w.calls.join("\n"));
  assert.deepEqual(r.revoked, ["permission_check_done"]);
  assert.equal(r.issued[0]!.purpose, "observe");
  assert.ok(!JSON.stringify(row.result).includes("borrowed-token"));
  // GCP_PLATFORM_PROJECT 가 없으면 허브를 안 쓰므로 허브 묶음은 보지 않는다
  assert.ok(!row.result.gaps.some((g: { bundleId: string }) => g.bundleId === "gcp.hub"));
});

test("permission-check 허브 묶음: 플랫폼 SA 를 넘겨 바인딩으로 확인한다 (예전엔 늘 '플랫폼 SA 를 몰라 확인 못 함')", { skip }, async () => {
  const id = await seed("gcp");
  const w = gcpWorld(yaml("gcp-env-custom-role.yaml")), r = roles();
  await job.handlePermissionCheck({ tenantId: T, requestId: "r4", envId: id }, { roles: r.broker, realSts: true, gcp: w.gcp, env: { GCP_PLATFORM_PROJECT: PLATFORM_PRJ } });
  const row = await stored(id);
  assert.deepEqual(row.result.gaps, [], JSON.stringify(row.result.gaps));
  assert.equal(row.result.grantedVersion, row.result.requiredVersion, "빠진 것이 없으면 지금 판");
  // 플랫폼 SA 의 허브 역할 바인딩이 없으면 허브만 빠짐
  const id2 = await seed("gcp");
  const w2 = gcpWorld(yaml("gcp-env-custom-role.yaml"));
  const exec = w2.gcp.exec as unknown as (b: string, a: string[], o: { env: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string; ms: number }>;
  const noHub = (async (b: string, a: string[], o: { env: NodeJS.ProcessEnv }) => {
    const res = await exec(b, a, o);
    if (a[1] !== "get-iam-policy") return res;
    const p = JSON.parse(res.stdout);
    return { ...res, stdout: JSON.stringify({ bindings: p.bindings.filter((x: { role: string }) => !x.role.endsWith("platform_hub_access")) }) };
  }) as never;
  await job.handlePermissionCheck({ tenantId: T, requestId: "r5", envId: id2 }, { roles: roles().broker, realSts: true, gcp: { ...w2.gcp, exec: noHub }, env: { GCP_PLATFORM_PROJECT: PLATFORM_PRJ } });
  const g = (await stored(id2)).result.gaps;
  assert.deepEqual(g.map((x: { bundleId: string; level: string; missing: string[] }) => [x.bundleId, x.level, x.missing]), [["gcp.hub", "block", ["container.clusters.get"]]]);
});

test("permission-check 거부: 연결 안 된 환경은 빌리지 않고 이유만 저장, 흉내 자격이면 고객 권한을 봤다고 하지 않는다", { skip }, async () => {
  const a = await seed("gcp", { status: "awaiting_customer" });
  const r = roles();
  await job.handlePermissionCheck({ tenantId: T, requestId: "r2", envId: a }, { roles: r.broker, realSts: true, gcp: gcpWorld().gcp });
  assert.equal(r.issued.length, 0);
  assert.match((await stored(a)).result.error, /연결 상태가 아님/);
  const b = await seed("gcp"), s = roles({ stub: true }), w = gcpWorld();
  await job.handlePermissionCheck({ tenantId: T, requestId: "r3", envId: b }, { roles: s.broker, realSts: true, gcp: w.gcp });
  assert.match((await stored(b)).result.error, /MOCK_CREDENTIALS/);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(s.revoked, ["permission_check_done"]);
});

test("사전 점검 칸: 환경 층을 만드는 이전이면 gcp.env block + detail, 안 만들면 그 묶음은 안 본다, PERMISSION_GATE=warn·off", { skip }, async () => {
  const src = await seed("aws"), tgt = await seed("gcp");
  const m = { id: randomUUID(), sourceEnvId: src, targetEnvId: tgt };
  const run = (env: NodeJS.ProcessEnv) => gate.permissionPrecheck(T, m, { gcpToken: { target: "borrowed-token" } }, { gcp: gcpWorld().gcp, env: { ...env, MOCK_PRECHECK: "1" } });
  const on = await run({ ENV_LAYER_AUTO: "1" });
  const env = on.items.find((i) => i.id === "PC-PERM-gcp.env")!;
  assert.equal(env.level, "block");
  assert.match(env.message, /svc-env · platform_env/);
  for (const p of MEASURED) assert.ok(env.message.includes(p) || on.detail!.missing.some((x) => x.endsWith(p)), p);
  assert.ok(on.detail!.permissionGaps.some((g) => g.bundleId === "gcp.env"));
  assert.match(on.detail!.hint, /Cloud Shell/);
  // 주의·확인 못 함은 한 줄로 합친다 (승인 확인 항목 하나). 출발 AWS 는 빌린 자격이 없으니(흉내) 확인 못 함
  const warns = on.items.filter((i) => i.level === "warn");
  assert.deepEqual(warns.map((i) => i.id), ["PC-PERM-WARN"]);
  assert.match(warns[0]!.message, /aws\.observe\(확인 못 함\)/);
  assert.ok(on.detail!.permissionGaps.some((g) => g.bundleId.startsWith("aws.")), "묶음별 내용은 detail 에 그대로");
  const off = await run({ ENV_LAYER_AUTO: "0" });
  assert.ok(!off.items.some((i) => i.id === "PC-PERM-gcp.env"), "환경 층을 안 만들면 env 묶음은 안 본다");
  const warn = await run({ ENV_LAYER_AUTO: "1", PERMISSION_GATE: "warn" });
  assert.deepEqual(warn.items.map((i) => [i.id, i.level]), [["PC-PERM-WARN", "warn"]], "막지 않는 판은 막힘까지 한 줄로");
  assert.match(warn.items[0]!.message, /gcp\.env\(빠진 것 3\)/);
  assert.deepEqual((await run({ ENV_LAYER_AUTO: "1", PERMISSION_GATE: "off" })).items, []);
});

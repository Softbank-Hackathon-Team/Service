// #373 B2 DB 시험: 사전 점검이 environment_permissions 의 묶음별 결과를 다시 쓴다 (permission-cache.ts)
//   ① 실조회 뒤 되쓰기 → 다음 사전 점검은 클라우드를 안 부르고 같은 항목·detail ② 오래됨·판/정의 다름·막힘·끔이면 실조회
//   ③ 되쓰기는 그 묶음만 갈아 끼우고 나머지 묶음 결과·확인 때는 그대로. 가짜 aws·gcloud (실제 클라우드 호출 없음). DB 없으면 건너뛴다
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
const ACCOUNT = "111122223333";
const BORROWED = { AWS_ACCESS_KEY_ID: "ASIA-borrowed", AWS_SECRET_ACCESS_KEY: "borrowed-secret", AWS_SESSION_TOKEN: "borrowed-session" };
// AWS → 온프레 이전의 출발 묶음 (relay_aws_onprem). 도착 온프레는 묶음 없음
const REQ = ["aws.observe", "aws.permcheck", "aws.relay.source"];

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  job = await import("../src/jobs/permission-check.js");
  gate = await import("../src/permission-gate.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-permission-cache')", [T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function seedPair() {
  const src = randomUUID(), tgt = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES ($1,$2,'aws','src','connected',$3), ($4,$2,'onprem','tgt','connected',NULL)`,
    [src, T, ACCOUNT, tgt]);
  return { id: randomUUID(), sourceEnvId: src, targetEnvId: tgt };
}

/** 가짜 aws: get-role 은 판 태그 4, simulate 는 denied(11/07 실측: 관찰 역할에 iam:SimulatePrincipalPolicy 없음) 또는 deny 목록 말고 다 허용 */
function awsWorld(o: { denied?: boolean; deny?: string[] } = {}) {
  const calls: string[] = [];
  const exec = (async (bin: string, args: string[], x: { env: NodeJS.ProcessEnv }) => {
    assert.equal(bin, "aws");
    assert.equal(x.env.AWS_ACCESS_KEY_ID, BORROWED.AWS_ACCESS_KEY_ID, "빌린 관찰 자격으로만");
    calls.push(`${args[0]} ${args[1]}`);
    const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "", ms: 1 });
    if (args[1] === "get-role") return ok({ Role: { Tags: [{ Key: "platform-perms-version", Value: "4" }] } });
    if (args[1] === "simulate-principal-policy") {
      if (o.denied) return { code: 254, stdout: "", stderr: "An error occurred (AccessDenied): not authorized to perform: iam:SimulatePrincipalPolicy", ms: 1 };
      const from = args.indexOf("--action-names") + 1, to = args.findIndex((a, i) => i >= from && a.startsWith("--"));
      return ok({ EvaluationResults: args.slice(from, to).map((n) => ({ EvalActionName: n, EvalDecision: o.deny?.includes(n) ? "implicitDeny" : "allowed" })) });
    }
    throw new Error(args.join(" "));
  }) as never;
  return { calls, exec };
}
const run = (m: { id: string; sourceEnvId: string; targetEnvId: string }, w: { exec: never }, env: NodeJS.ProcessEnv = {}) =>
  gate.permissionPrecheck(T, m, { awsEnv: { source: BORROWED } }, { aws: { exec: w.exec }, env: { MOCK_PRECHECK: "1", ...env } });
const row = async (envId: string) => (await owner.query("SELECT result, checked_at FROM environment_permissions WHERE environment_id=$1", [envId])).rows[0];
/** 저장 줄의 checked 를 고친다 (나이·정의 지문 흉내) */
async function editChecked(envId: string, f: (c: { bundleId: string; at: string; def: string }) => object, result: (r: Record<string, unknown>) => object = (r) => r) {
  const r = (await row(envId)).result;
  await owner.query("UPDATE environment_permissions SET result=$2 WHERE environment_id=$1",
    [envId, JSON.stringify(result({ ...r, checked: r.checked.map(f) }))]);
}
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

test("재사용: 실조회 뒤 되쓰고, 10분 안 다음 사전 점검은 aws 를 안 부르고 같은 항목·detail (11/07 상태: 흉내 평가 거부 → 확인 못 함)", { skip }, async () => {
  const m = await seedPair();
  const w = awsWorld({ denied: true });
  const live = await run(m, w);
  assert.deepEqual(live.sources, [{ side: "source", source: "live", ageSec: 0 }]);
  assert.ok(w.calls.length >= REQ.length, w.calls.join("\n"));
  assert.deepEqual(live.items.map((i) => [i.id, i.level]), [["PC-PERM-WARN", "warn"]]);
  // 되쓰기: 이 이전이 쓴 묶음만 기록 (확인 때·정의 지문), both 묶음은 permission-check 와 같게 target 으로 저장
  const saved = await row(m.sourceEnvId);
  assert.ok(saved.checked_at);
  assert.deepEqual(saved.result.checked.map((c: { bundleId: string }) => c.bundleId), REQ);
  assert.equal(saved.result.requiredVersion, 4);
  assert.equal(saved.result.gaps.find((g: { bundleId: string }) => g.bundleId === "aws.observe").side, "target");
  assert.ok(!JSON.stringify(saved.result).includes("borrowed"), "자격은 안 남김");

  const n = w.calls.length;
  const hit = await run(m, w);
  assert.equal(w.calls.length, n, "저장 결과로 답함: aws 호출 0");
  assert.equal(hit.sources[0]!.source, "cache");
  assert.ok(hit.sources[0]!.ageSec >= 0 && hit.sources[0]!.ageSec < 60, String(hit.sources[0]!.ageSec));
  assert.deepEqual(hit.items, live.items, "항목 글자까지 같음");
  assert.deepEqual(hit.detail, live.detail, "detail(missing·hint·permissionGaps, side=source 포함) 같음");
  // 막지 않는 판(PERMISSION_GATE=warn)도 저장 결과에 같은 규칙
  const warnLive = await run(m, awsWorld({ denied: true }), { PERMISSION_CACHE_SEC: "0", PERMISSION_GATE: "warn" });
  const warnHit = await run(m, w, { PERMISSION_GATE: "warn" });
  assert.equal(warnHit.sources[0]!.source, "cache");
  assert.deepEqual(warnHit.items, warnLive.items);
});

test("오래됨: PERMISSION_CACHE_SEC 를 넘긴 묶음이 하나라도 있으면 실조회, PERMISSION_CACHE_SEC=0 이면 읽지도 쓰지도 않음", { skip }, async () => {
  const m = await seedPair();
  const w = awsWorld({ denied: true });
  const first = await run(m, w);
  await editChecked(m.sourceEnvId, (c) => (c.bundleId === "aws.relay.source" ? { ...c, at: ago(601) } : c));
  let n = w.calls.length;
  const stale = await run(m, w);
  assert.ok(w.calls.length > n, "오래된 묶음 → 실조회");
  assert.equal(stale.sources[0]!.source, "live");
  assert.deepEqual(stale.items, first.items);
  // 되쓰기로 다시 새것 → 짧은 TTL 이면 그 안에서만
  await editChecked(m.sourceEnvId, (c) => ({ ...c, at: ago(30) }));
  assert.equal((await run(m, w, { PERMISSION_CACHE_SEC: "60" })).sources[0]!.source, "cache");
  assert.equal((await run(m, w, { PERMISSION_CACHE_SEC: "20" })).sources[0]!.source, "live");
  // 끔: 저장 줄을 안 보고(실조회), 되쓰지도 않는다 (예전 동작 그대로)
  await editChecked(m.sourceEnvId, (c) => ({ ...c, at: ago(30) }));
  const before = await row(m.sourceEnvId);
  n = w.calls.length;
  const off = await run(m, w, { PERMISSION_CACHE_SEC: "0" });
  assert.ok(w.calls.length > n);
  assert.equal(off.sources[0]!.source, "live");
  assert.deepEqual(await row(m.sourceEnvId), before, "끔이면 저장 줄 안 건드림");
});

test("판·정의 다름: requiredVersion 이 지금 묶음 파일 판과 다르거나 묶음 정의 지문이 다르면 실조회, 확인 못 함(error) 줄도 안 씀", { skip }, async () => {
  const m = await seedPair();
  const w = awsWorld({ denied: true });
  await run(m, w);
  await editChecked(m.sourceEnvId, (c) => c, (r) => ({ ...r, requiredVersion: 3 }));
  let n = w.calls.length;
  assert.equal((await run(m, w)).sources[0]!.source, "live", "옛 판");
  assert.ok(w.calls.length > n);
  assert.equal((await row(m.sourceEnvId)).result.requiredVersion, 4, "되쓰기는 지금 판, 옛 판 묶음 결과는 버림");
  await editChecked(m.sourceEnvId, (c) => (c.bundleId === "aws.observe" ? { ...c, def: "0000000000000000" } : c));
  n = w.calls.length;
  assert.equal((await run(m, w)).sources[0]!.source, "live", "판은 같아도 묶음 정의가 바뀜");
  assert.ok(w.calls.length > n);
  await editChecked(m.sourceEnvId, (c) => c, (r) => ({ ...r, gaps: [], error: "확인 불가: 관찰 역할을 못 빌림 (AccessDenied)" }));
  assert.equal((await run(m, w)).sources[0]!.source, "live", "확인 못 한 줄");
  // 옛 줄(checked 없음, 이 PR 전 permission-check 가 쓴 것)도 안 씀
  await owner.query("UPDATE environment_permissions SET result = result - 'checked' WHERE environment_id=$1", [m.sourceEnvId]);
  assert.equal((await run(m, w)).sources[0]!.source, "live", "checked 없는 옛 줄");
});

test("막힘은 다시 읽는다: 저장된 block 묶음이 있으면 실조회 (고객이 고친 뒤 바로 다시 돌린 사전 점검이 옛 막힘에 안 걸림), 판정은 실조회와 같음", { skip }, async () => {
  const m = await seedPair();
  const relayPerm = "ec2:RunInstances";
  const w = awsWorld({ deny: [relayPerm] });
  const live = await run(m, w);
  const block = live.items.find((i) => i.id === "PC-PERM-aws.relay.source");
  assert.equal(block?.level, "block", JSON.stringify(live.items));
  let n = w.calls.length;
  const again = await run(m, w);
  assert.ok(w.calls.length > n, "block 이 있으면 저장 결과를 안 씀");
  assert.equal(again.sources[0]!.source, "live");
  assert.deepEqual(again.items, live.items, "같은 막힘");
  // 고객이 고침 → 다음 사전 점검이 바로 통과하고, 그 결과가 저장돼 그다음은 재사용
  const fixed = awsWorld();
  const ok = await run(m, fixed);
  assert.deepEqual(ok.items, []);
  assert.equal(ok.detail, null);
  n = fixed.calls.length;
  const hit = await run(m, fixed);
  assert.equal(hit.sources[0]!.source, "cache");
  assert.equal(fixed.calls.length, n);
  assert.deepEqual(hit.items, []);
  assert.equal(hit.detail, null, "빠진 것 없음도 그대로");
});

test("permission-check 결과 재사용 + 되쓰기 병합: 사전 점검은 쓰는 묶음만 보고, 실조회하면 그 묶음만 갈아 끼우고 나머지 묶음 결과·확인 때는 그대로", { skip }, async () => {
  const m = await seedPair();
  // 환경 화면 [다시 확인]: 환경 묶음 전부 (aws 7개). 운영 묶음 하나가 막힘(block) — 이 이전(AWS → 온프레 출발)은 그 묶음을 안 씀
  const opPerm = "ecr:CreateRepository";
  const full = awsWorld({ deny: [opPerm] });
  const roles = { issue: async () => ({ credentialRef: "ref", stub: false, expiresAt: "2099-01-01T00:00:00Z" }),
    use: () => ({ kind: "aws", accessKeyId: BORROWED.AWS_ACCESS_KEY_ID, secretAccessKey: BORROWED.AWS_SECRET_ACCESS_KEY, sessionToken: BORROWED.AWS_SESSION_TOKEN }),
    revoke: async () => undefined } as never;
  assert.equal(await job.handlePermissionCheck({ tenantId: T, requestId: "r1", envId: m.sourceEnvId }, { roles, realSts: true, aws: { exec: full.exec } }), "saved");
  const env = (await row(m.sourceEnvId)).result;
  const all = env.checked.map((c: { bundleId: string }) => c.bundleId);
  assert.ok(REQ.every((id) => all.includes(id)) && all.includes("aws.operate"), all.join(","));
  const opGap = env.gaps.find((g: { bundleId: string; missing: string[] }) => g.bundleId === "aws.operate" || g.missing.includes(opPerm));
  assert.equal(opGap?.level, "block");

  // 사전 점검: 쓰는 묶음은 다 새것 → 재사용 (쓰지 않는 묶음의 막힘은 상관없음), side 는 이 이전에서의 쪽(출발)
  const w = awsWorld({ deny: [opPerm] });
  const hit = await run(m, w);
  assert.equal(hit.sources[0]!.source, "cache");
  assert.equal(w.calls.length, 0);
  const liveCmp = await run(m, awsWorld({ deny: [opPerm] }), { PERMISSION_CACHE_SEC: "0" });
  assert.deepEqual(hit.items, liveCmp.items);
  assert.deepEqual(hit.detail, liveCmp.detail);

  // 쓰는 묶음 하나가 오래됨 → 실조회 → 그 묶음들만 갈아 끼움
  const oldAt = ago(300);
  await editChecked(m.sourceEnvId, (c) => (c.bundleId === "aws.observe" ? { ...c, at: ago(900) } : { ...c, at: oldAt }));
  const t0 = Date.now();
  assert.equal((await run(m, w)).sources[0]!.source, "live");
  const merged = (await row(m.sourceEnvId)).result;
  for (const c of merged.checked as { bundleId: string; at: string }[]) {
    if (REQ.includes(c.bundleId)) assert.ok(Date.parse(c.at) >= t0 - 1000, `${c.bundleId} 새로 확인`);
    else assert.equal(c.at, oldAt, `${c.bundleId} 확인 때 그대로 (새것처럼 안 보임)`);
  }
  assert.deepEqual(merged.checked.map((c: { bundleId: string }) => c.bundleId).sort(), [...all].sort(), "묶음 기록은 안 줄어듦");
  assert.deepEqual(merged.gaps.find((g: { bundleId: string }) => g.bundleId === opGap.bundleId), opGap, "쓰지 않은 묶음의 막힘은 환경 화면에 그대로");
  const order = env.gaps.map((g: { bundleId: string }) => g.bundleId);
  assert.deepEqual(merged.gaps.map((g: { bundleId: string }) => g.bundleId), order, "묶음 파일 순서 그대로");
});

test("GCP 도착도 같은 길: 두 번째 사전 점검은 gcloud·testIamPermissions 0번, 같은 항목. 빌린 자격 없는 쪽(접힌 '확인 못 함')은 저장도 재사용도 안 함", { skip }, async () => {
  const SP = "cust-prj", TP = "cust-mig";
  const src = randomUUID(), tgt = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, gcp_target_project) VALUES ($1,$2,'aws','s','connected',$3,NULL), ($4,$2,'gcp','t','connected',$5,$6)`,
    [src, T, ACCOUNT, tgt, SP, TP]);
  const m = { id: randomUUID(), sourceEnvId: src, targetEnvId: tgt };
  const file = JSON.parse(readFileSync(new URL("../../../infra/permissions/permission-bundles.json", import.meta.url), "utf8")) as { bundles: { role: string; principal: string; permissions: string[]; apis: string[] }[] };
  const calls: string[] = [];
  const sa = (n: string) => `serviceAccount:${n}@${TP}.iam.gserviceaccount.com`;
  const roleNames = [...new Set(file.bundles.filter((b) => b.principal !== "svc-observe" && b.principal !== "platform").map((b) => `${b.principal}|${b.role}`))];
  const exec = (async (_b: string, args: string[]) => {
    calls.push(args.slice(0, 2).join(" "));
    const ok = (x: unknown) => ({ code: 0, stdout: JSON.stringify(x), stderr: "", ms: 1 });
    if (args[0] === "services") return ok(file.bundles.flatMap((b) => b.apis).map((a) => ({ config: { name: a } })));
    if (args[1] === "get-iam-policy") return ok({ bindings: roleNames.map((x) => { const [p, r] = x.split("|"); return { role: `projects/${TP}/roles/${r}`, members: [sa(p!)], ...(/iam|db_secret/.test(r!) ? { condition: { title: "c" } } : {}) }; }) });
    // 역할 정의 = 그 역할을 쓰는 묶음 권한 전부 (빠진 것 없는 전용 프로젝트)
    if (args[1] === "roles") return ok({ includedPermissions: file.bundles.filter((b) => b.role === args[3]).flatMap((b) => b.permissions), description: "[perms v4]" });
    throw new Error(args.join(" "));
  }) as never;
  const fetch = (async (_u: string, init: { body: string }) => { calls.push("testIamPermissions"); return new Response(JSON.stringify({ permissions: JSON.parse(init.body).permissions }), { status: 200 }); }) as never;
  const go = (env: NodeJS.ProcessEnv = {}) => gate.permissionPrecheck(T, m, { gcpToken: { target: "borrowed-token" } }, { gcp: { exec, fetch }, env: { MOCK_PRECHECK: "1", ENV_LAYER_AUTO: "0", ...env } });
  const live = await go();
  assert.deepEqual(live.sources.map((s) => [s.side, s.source]), [["source", "live"], ["target", "live"]]);
  assert.match(live.items.find((i) => i.id === "PC-PERM-WARN")?.message ?? "", /aws\.observe\(확인 못 함\)/, "출발 AWS 는 빌린 자격 없음 → 접힌 한 줄");
  assert.equal(await row(src), undefined, "접힌 결과는 저장 안 함");
  const n = calls.length;
  assert.ok(n > 0);
  const hit = await go();
  assert.deepEqual(hit.sources.map((s) => [s.side, s.source]), [["source", "live"], ["target", "cache"]]);
  assert.equal(calls.length, n, "GCP 호출 0");
  assert.deepEqual(hit.items, live.items);
  assert.deepEqual(hit.detail, live.detail);
});

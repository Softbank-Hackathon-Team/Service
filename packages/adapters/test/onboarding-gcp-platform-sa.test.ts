// GCP 플랫폼 쪽 회사 전용 SA 스크립트 (infra/onboarding/gcp-platform-tenant-sa.sh). DRY_RUN·가짜 gcloud 만, 진짜 gcloud 안 부름
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../../../infra/onboarding/gcp-platform-tenant-sa.sh", import.meta.url).pathname;
const TENANT = "11111111-1111-4111-8111-111111111111";
const WORKER = "serviceAccount:svc-worker@svc-platform.iam.gserviceaccount.com";
function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gcloud-")), log = join(dir, "log");
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`); chmodSync(join(dir, "gcloud"), 0o755);
  const r = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, ...env } });
  return { ...r, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

test("정상: 회사 SA 이름 = t- + md5(회사 UUID) 앞 28자 (DB 0029 규칙과 같음), 워커에게 그 SA 의 tokenCreator 만 (DRY_RUN 은 gcloud 0번)", () => {
  const r = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  const id = "t-" + createHash("md5").update(TENANT).digest("hex").slice(0, 28);
  assert.match(r.stdout, new RegExp(`service-accounts create ${id} --project=svc-platform`));
  const tc = r.stdout.split("\n").filter((l) => l.includes("serviceAccountTokenCreator"));
  assert.equal(tc.length, 1);
  assert.ok(tc[0]!.includes(`add-iam-policy-binding ${id}@svc-platform.iam.gserviceaccount.com`) && tc[0]!.includes(`--member=${WORKER}`));
  assert.doesNotMatch(r.stdout, /projects add-iam-policy-binding|keys create/);
});

test("거부: allUsers·그룹·도메인·모양 틀린 주체, UUID 아닌 회사 번호, 틀린 프로젝트 ID 는 만들기 전에 종료", () => {
  for (const env of [{ WORKER_PRINCIPAL: "allUsers" }, { WORKER_PRINCIPAL: "allAuthenticatedUsers" }, { WORKER_PRINCIPAL: "group:ops@example.com" },
    { WORKER_PRINCIPAL: "domain:example.com" }, { WORKER_PRINCIPAL: "user:me@example.com,allUsers" }, { WORKER_PRINCIPAL: "user:me" },
    { TENANT_ID: "not-a-uuid" }, { PLATFORM_PROJECT: "Bad_Prj" }]) {
    const r = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, DRY_RUN: "1", ...env });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.doesNotMatch(r.stdout, /create|add-iam-policy-binding/);
  }
});

test("허브 주체: 있으면 이 회사 SA 에 workloadIdentityUser 만 주고, 허브 argocd 계정이 아니면 종료", () => {
  const hub = "principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/platform-hub/subject/system:serviceaccount:argocd:argocd-server";
  const base = { PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, DRY_RUN: "1" };
  const ok = run({ ...base, HUB_PRINCIPALS: hub });
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.split("\n").filter((l) => l.includes("workloadIdentityUser"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("service-accounts add-iam-policy-binding t-") && lines[0]!.includes(`--member=${hub}`));
  for (const bad of ["allUsers", hub.replace("argocd:argocd-server", "default:x"), `${hub},allUsers`]) {
    assert.notEqual(run({ ...base, HUB_PRINCIPALS: bad }).status, 0, bad);
  }
  assert.doesNotMatch(run(base).stdout, /workloadIdentityUser/);
});

// FM-CON-02: 맥 실검증 워커는 사람 gcloud 계정(user:)으로 돈다 → 그 계정에 회사 SA tokenCreator 를 준다
test("FM-CON-02: user:<이메일> 주체는 통과, tokenCreator 멤버가 그 계정, 경고 한 줄", () => {
  const r = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: "user:demo.op@example.com", DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  const tc = r.stdout.split("\n").filter((l) => l.includes("serviceAccountTokenCreator"));
  assert.equal(tc.length, 1);
  assert.ok(tc[0]!.includes("--member=user:demo.op@example.com"));
  assert.match(r.stderr, /사람 계정/);
  assert.doesNotMatch(r.stderr, /demo\.op/);   // 경고에 계정 이름은 앞 4자만 (2회차: 로그에 계정 노출 줄임)
  assert.match(r.stderr, /user:demo…@example\.com/);
  assert.doesNotMatch(r.stdout, /projects add-iam-policy-binding|keys create/);
});
test("FM-CON-02 거부: ALLOW_HUMAN_WORKER=0 이면 user: 를 만들기 전에 거부, serviceAccount: 는 그대로 통과", () => {
  const u = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: "user:demo.op@example.com", ALLOW_HUMAN_WORKER: "0", DRY_RUN: "1" });
  assert.notEqual(u.status, 0);
  assert.doesNotMatch(u.stdout, /create|add-iam-policy-binding/);
  const sa = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, ALLOW_HUMAN_WORKER: "0", DRY_RUN: "1" });
  assert.equal(sa.status, 0, sa.stderr);
});
test("FM-CON-02 거부: allUsers 는 ALLOW_HUMAN_WORKER=1 이어도 거부", () => {
  const r = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: "allUsers", ALLOW_HUMAN_WORKER: "1", DRY_RUN: "1" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /create|add-iam-policy-binding/);
});

// 맥과 같은 조건: md5sum 없음(또는 /sbin 에만), BSD md5 -q, LibreSSL openssl("MD5(stdin)= …", -r 없음), 고장 난 도구.
//   흉내 도구는 /usr/bin/md5sum 같은 리눅스 전용 경로에 기대지 않고 node 로 해시를 낸다 (맥에서도 같은 시험이 돈다)
const HASHER = join(mkdtempSync(join(tmpdir(), "hasher-")), "h.mjs");
writeFileSync(HASHER, `import { createHash } from "node:crypto";
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const h = createHash("md5").update(Buffer.concat(chunks)).digest("hex"); const [mode, ...args] = process.argv.slice(2);
if (mode === "gnu") process.stdout.write(h + "  -\\n");
else if (mode === "bsd") process.stdout.write(args.includes("-q") ? h + "\\n" : "MD5 (stdin) = " + h + "\\n");
else if (mode === "libressl") { if (args.includes("-r")) { process.stderr.write("unknown option -r\\n"); process.exit(1); } process.stdout.write("MD5(stdin)= " + h + "\\n"); }
else if (mode === "empty") process.exit(0);
else if (mode === "fail") process.exit(1);
`);
const tool = (mode: string) => `exec "${process.execPath}" "${HASHER}" ${mode} "$@"`;
function runPath(tools: Record<string, string>, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mac-path-"));
  for (const t of ["cut", "tr"]) {   // 스크립트가 쓰는 기본 도구만 (해시 도구는 빼고)
    const real = existsSync(`/usr/bin/${t}`) ? `/usr/bin/${t}` : `/bin/${t}`;
    writeFileSync(join(dir, t), `#!/bin/sh\nexec ${real} "$@"\n`); chmodSync(join(dir, t), 0o755);
  }
  for (const [n, body] of Object.entries(tools)) { writeFileSync(join(dir, n), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, n), 0o755); }
  const bash = existsSync("/bin/bash") ? "/bin/bash" : "bash";
  return spawnSync(bash, [script], { encoding: "utf8", env: { PATH: dir, HASH_EXTRA_PATH: "", ...env } });   // 맥의 진짜 /sbin/md5 를 안 보게
}
const BASE = { PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: WORKER, DRY_RUN: "1" };
const ID = "t-" + createHash("md5").update(TENANT).digest("hex").slice(0, 28);
const ok = (r: ReturnType<typeof runPath>, why: string) => {
  assert.equal(r.status, 0, `${why}: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`service-accounts create ${ID} --project=svc-platform`), why);
  assert.doesNotMatch(r.stdout, /create t- |t-@/, why);
};

test("맥 조건 여러 개: 어느 PATH 조합이든 같은 SA 이름 (빈 해시로 t- 가 되지 않음)", () => {
  const cases: [string, Record<string, string>][] = [
    ["리눅스 md5sum", { md5sum: tool("gnu") }],
    ["맥: BSD md5 만 (md5sum 없음)", { md5: tool("bsd") }],
    ["맥: LibreSSL openssl 만 (-r 없음)", { openssl: tool("libressl") }],
    ["맥: md5sum 이 빈 값을 줌 → md5 로", { md5sum: tool("empty"), md5: tool("bsd") }],
    ["md5sum 실패 + md5 실패 → openssl 로", { md5sum: tool("fail"), md5: tool("fail"), openssl: tool("libressl") }],
    ["md5sum 이 GNU 모양 + openssl 도 있음", { md5sum: tool("gnu"), openssl: tool("libressl") }],
    ["python3 만", { python3: tool("gnu") }],
  ];
  for (const [why, tools] of cases) ok(runPath(tools, BASE), why);
});

test("맥 조건 + FM-CON-02: md5sum 없음·BSD md5·LibreSSL 각각에서 user: 주체로도 같은 SA 이름, 멤버가 그 계정", () => {
  for (const tools of [{ md5: tool("bsd") }, { openssl: tool("libressl") }, { md5sum: tool("empty"), md5: tool("bsd") }] as Record<string, string>[]) {
    const r = runPath(tools, { ...BASE, WORKER_PRINCIPAL: "user:demo.op@example.com" });
    ok(r, JSON.stringify(Object.keys(tools)));
    assert.match(r.stdout, /--member=user:demo\.op@example\.com --role=roles\/iam\.serviceAccountTokenCreator/);
  }
});

test("거부: 해시 도구가 없거나 전부 빈 값·실패면 127 + 알림, SA 만들기 명령 안 나감", () => {
  for (const tools of [{}, { md5sum: tool("empty"), md5: tool("empty"), openssl: tool("fail") }] as Record<string, string>[]) {
    const r = runPath(tools, BASE);
    assert.equal(r.status, 127, JSON.stringify(Object.keys(tools)));
    assert.match(r.stderr, /md5 해시를 못 구함/);
    assert.doesNotMatch(r.stdout, /service-accounts create/);
  }
});

test("6회차 거부: WORKER_PRINCIPAL 에 user: 를 빼먹으면 만들기 전에 멈추고 붙이라고 알림", () => {
  const r = run({ PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, WORKER_PRINCIPAL: "demo.op@example.com", DRY_RUN: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /user:<이메일>/);
  assert.doesNotMatch(r.stdout, /create|add-iam-policy-binding/);
});

// 8회차(재실행·멱등): 가짜 gcloud(상태 파일)로 두 번 돌린다. 두 번째는 바꾸는 명령 0, 대소문자만 다른 주체도 같은 것으로 본다
function runFake(state: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "tsa-fake-"));
  writeFileSync(join(dir, "g.mjs"), `import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
const S = ${JSON.stringify(state)}; const st = existsSync(S) ? JSON.parse(readFileSync(S, "utf8")) : { sas: [], members: [] };
const a = process.argv.slice(2); const j = a.join(" "); const save = () => writeFileSync(S, JSON.stringify(st));
const sa = a[3];
if (j.startsWith("iam service-accounts describe")) process.exit(st.sas.includes(sa) ? 0 : 1);
if (j.startsWith("iam service-accounts create")) { appendFileSync(S + ".log", j + "\\n"); st.sas.push(a[3] + "@" + a.find((x) => x.startsWith("--project=")).slice(10) + ".iam.gserviceaccount.com"); save(); process.exit(0); }
if (j.startsWith("iam service-accounts get-iam-policy")) { for (const m of st.members) console.log(m); process.exit(0); }
if (j.startsWith("iam service-accounts add-iam-policy-binding")) { appendFileSync(S + ".log", j + "\\n"); st.members.push(a.find((x) => x.startsWith("--member=")).slice(9)); save(); process.exit(0); }
process.exit(2);
`);
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "g.mjs")}" "$@"\n`); chmodSync(join(dir, "gcloud"), 0o755);
  return spawnSync("bash", [script], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, PLATFORM_PROJECT: "svc-platform", TENANT_ID: TENANT, ...env } });
}
test("8회차 재실행: 처음 만들기 2번(SA·tokenCreator), 두 번째는 0번·전부 건너뜀, 대소문자만 다른 user: 도 같은 주체", () => {
  const state = join(mkdtempSync(join(tmpdir(), "tsa-st-")), "s.json");
  const log = () => (existsSync(state + ".log") ? readFileSync(state + ".log", "utf8").trim().split("\n").filter(Boolean) : []);
  const a = runFake(state, { WORKER_PRINCIPAL: "user:demo.op@example.com" });
  assert.equal(a.status, 0, a.stderr); assert.equal(log().length, 2);
  const b = runFake(state, { WORKER_PRINCIPAL: "user:Demo.Op@example.com" });
  assert.equal(b.status, 0, b.stderr); assert.equal(log().length, 2, "두 번째는 바꾸는 명령 0");
  assert.equal((b.stdout.match(/이미 있음, 건너뜀/g) ?? []).length, 2);
});
test("8회차 거부: 다른 주체(워커 SA)로 다시 돌리면 그 주체만 더한다(사람 계정 바인딩은 안 지움)", () => {
  const state = join(mkdtempSync(join(tmpdir(), "tsa-st-")), "s.json");
  runFake(state, { WORKER_PRINCIPAL: "user:demo.op@example.com" });
  const b = runFake(state, { WORKER_PRINCIPAL: WORKER });
  assert.equal(b.status, 0, b.stderr);
  const st = JSON.parse(readFileSync(state, "utf8"));
  assert.deepEqual(st.members, ["user:demo.op@example.com", WORKER]);
});

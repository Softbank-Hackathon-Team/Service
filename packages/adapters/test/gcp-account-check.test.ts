// tools/gcp-account-check.sh (FM-ENV-03·FM-OPS-09·FM-CLD-09) — 가짜 gcloud·curl 로 돌린다. 진짜 gcloud 는 안 부른다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../../../tools/gcp-account-check.sh", import.meta.url).pathname;
const SA = "t-0123456789abcdef0123456789ab@plat-prj.iam.gserviceaccount.com";

interface Fake { active?: string; adcEmail?: string; adcToken?: boolean; sas?: string[]; members?: string[]; listFails?: boolean; policyNotFound?: boolean }
function run(f: Fake, env: Record<string, string> = {}, macPath = false) {
  const dir = mkdtempSync(join(tmpdir(), "gacct-"));
  // 10회차(맥): 맥에는 GNU timeout 이 없다 → 기본 도구만 둔 PATH(timeout 빼고, perl alarm 길)로도 돌려 본다
  if (macPath) for (const t of ["sed", "tr", "cut", "grep", "head", "tail", "mktemp", "rm", "dirname", "perl", "cat"]) {
    const real = [`/usr/bin/${t}`, `/bin/${t}`].find((x) => existsSync(x));
    if (real) writeFileSync(join(dir, t), `#!/bin/sh\nexec ${real} "$@"\n`), chmodSync(join(dir, t), 0o755);
  }
  writeFileSync(join(dir, "fake.json"), JSON.stringify(f));
  const node = process.execPath;
  // gcloud 흉내: 읽기 명령만 안다. 만들기·바꾸기 명령이 오면 기록하고 실패 (시험이 그 기록을 본다)
  writeFileSync(join(dir, "g.mjs"), `import { readFileSync, appendFileSync } from "node:fs";
const f = JSON.parse(readFileSync(${JSON.stringify(join(dir, "fake.json"))}, "utf8")); const a = process.argv.slice(2).join(" ");
if (/ (create|add-iam-policy-binding|set-iam-policy|delete|remove-iam-policy-binding|set) /.test(" " + a + " ") && !a.startsWith("config get-value")) { appendFileSync(${JSON.stringify(join(dir, "mut.log"))}, a + "\\n"); process.exit(9); }
if (a === "config get-value account") { if (f.active) console.log(f.active); process.exit(0); }
if (a === "auth application-default print-access-token") { if (f.adcToken === false) process.exit(1); console.log("ya29.FAKE"); process.exit(0); }
if (a.startsWith("iam service-accounts list")) { if (f.listFails) { console.error("PERMISSION_DENIED"); process.exit(1); } for (const s of f.sas ?? []) console.log(s); process.exit(0); }
if (a.startsWith("iam service-accounts get-iam-policy")) { if (f.policyNotFound) { console.error("NOT_FOUND: Unknown service account"); process.exit(1); } for (const m of f.members ?? []) console.log(m); process.exit(0); }
process.exit(2);
`);
  writeFileSync(join(dir, "c.mjs"), `import { readFileSync } from "node:fs";
const f = JSON.parse(readFileSync(${JSON.stringify(join(dir, "fake.json"))}, "utf8")); const args = process.argv.slice(2);
const i = args.indexOf("--data"); const body = i >= 0 ? readFileSync(args[i + 1].replace(/^@/, ""), "utf8") : "";
if (!body.startsWith("access_token=")) process.exit(3);
process.stdout.write(f.adcEmail ? JSON.stringify({ email: f.adcEmail, scope: "x" }) : JSON.stringify({ scope: "x" }));
`);
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\nexec "${node}" "${join(dir, "g.mjs")}" "$@"\n`);
  writeFileSync(join(dir, "curl"), `#!/bin/sh\nexec "${node}" "${join(dir, "c.mjs")}" "$@"\n`);
  chmodSync(join(dir, "gcloud"), 0o755); chmodSync(join(dir, "curl"), 0o755);
  const bash = existsSync("/bin/bash") ? "/bin/bash" : "bash";
  const r = spawnSync(bash, [script], { encoding: "utf8", env: { PATH: macPath ? dir : `${dir}:/usr/bin:/bin`, TMPDIR: dir, GCP_EXPECTED_ACCOUNT: "", GCP_PLATFORM_PROJECT: "", REAL_STS: "0", ...env } });
  return { ...r, mutations: existsSync(join(dir, "mut.log")) ? "있음" : "" };
}
const line = (out: string, item: string) => out.split("\n").find((l) => l.split(/\s+/)[1] === item) ?? "";

test("정상: 활성 = 기대 = ADC, 회사 SA 고리 열림 → 전부 OK, 끝 코드 0, 이메일 전체·토큰 안 찍음", () => {
  const r = run({ active: "demo.op@example.com", adcEmail: "demo.op@example.com", sas: [SA], members: ["user:demo.op@example.com"] },
    { GCP_EXPECTED_ACCOUNT: "Demo.Op@example.com", GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const i of ["gcp-account", "gcp-adc-account", "gcp-tenant-sa"]) assert.match(line(r.stdout, i), /^OK /, i);
  assert.doesNotMatch(r.stdout, /demo\.op@|ya29/);
  assert.equal(r.mutations, "");
});

test("거부: 활성 계정이 기대와 다름(22:14Z 재발) → FAIL gcp-account", () => {
  const r = run({ active: "other.acct@example.com", adcEmail: "other.acct@example.com" }, { GCP_EXPECTED_ACCOUNT: "demo.op@example.com" });
  assert.match(line(r.stdout, "gcp-account"), /^FAIL .*gcloud config set account/);
  assert.notEqual(r.status, 0);
});

test("거부: ADC 계정 ≠ 활성 계정 → FAIL gcp-adc-account (terraform 과 워커가 다른 계정)", () => {
  const r = run({ active: "demo.op@example.com", adcEmail: "other.acct@example.com" }, { GCP_EXPECTED_ACCOUNT: "demo.op@example.com" });
  assert.match(line(r.stdout, "gcp-account"), /^OK /);
  assert.match(line(r.stdout, "gcp-adc-account"), /^FAIL /);
  assert.equal(r.status, 1);
});

test("거부: 회사 SA 는 있는데 활성 계정에 tokenCreator 없음 → FAIL, 다시 돌릴 명령 안내", () => {
  const r = run({ active: "demo.op@example.com", adcEmail: "demo.op@example.com", sas: [SA], members: ["serviceAccount:svc-worker@plat-prj.iam.gserviceaccount.com"] },
    { GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.match(line(r.stdout, "gcp-tenant-sa"), /^FAIL .*gcp-platform-tenant-sa\.sh/);
});

test("WARN 만: 기대 계정·플랫폼 프로젝트 없음, 회사 SA 없음(down 뒤) → FAIL 0", () => {
  const a = run({ active: "demo.op@example.com", adcEmail: "demo.op@example.com" });
  assert.equal(a.status, 0, a.stdout);
  assert.match(line(a.stdout, "gcp-account"), /^WARN /);
  assert.match(line(a.stdout, "gcp-tenant-sa"), /^WARN /);
  const b = run({ active: "demo.op@example.com", adcEmail: "demo.op@example.com", sas: [] }, { GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.match(line(b.stdout, "gcp-tenant-sa"), /^WARN .*down 뒤면 다시/);
  assert.equal(b.status, 0);
});

test("거부: 로그인·ADC 없음, SA 목록 권한 없음 → 각각 FAIL, 만들기 명령은 어느 경우에도 0", () => {
  const r = run({ adcToken: false, listFails: true }, { GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.match(line(r.stdout, "gcp-account"), /^FAIL /);
  assert.match(line(r.stdout, "gcp-adc-account"), /^FAIL /);
  assert.match(line(r.stdout, "gcp-tenant-sa"), /^FAIL /);
  assert.equal(r.status, 3);
  assert.equal(r.mutations, "");
});

// 6회차(운영자 실수): TENANT_ID 를 잘못 넣어 다른 회사 SA 를 만들었는지 — 연결 명령의 PLATFORM_SA 하나만 본다
test("6회차: GCP_TENANT_SA 를 주면 그 SA 만 본다 — 열림 OK, 없음(다른 회사 번호) FAIL, 다른 SA 만 열린 경우도 FAIL", () => {
  const base = { active: "demo.op@example.com", adcEmail: "demo.op@example.com" };
  const okR = run({ ...base, members: ["user:demo.op@example.com"] }, { GCP_TENANT_SA: SA });
  assert.match(line(okR.stdout, "gcp-tenant-sa"), /^OK /); assert.equal(okR.status, 0);
  const gone = run({ ...base, policyNotFound: true, sas: ["t-ffffffffffffffffffffffffffff@plat-prj.iam.gserviceaccount.com"] }, { GCP_TENANT_SA: SA, GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.match(line(gone.stdout, "gcp-tenant-sa"), /^FAIL .*다른 회사 번호/);
  const notMine = run({ ...base, members: ["user:someone.else@example.com"] }, { GCP_TENANT_SA: SA });
  assert.match(line(notMine.stdout, "gcp-tenant-sa"), /^FAIL /);
  assert.equal(gone.mutations + notMine.mutations, "");
});
test("6회차 거부: GCP_TENANT_SA 모양이 틀리면 gcloud 를 부르기 전에 FAIL", () => {
  const r = run({ active: "demo.op@example.com", adcEmail: "demo.op@example.com" }, { GCP_TENANT_SA: "svc-observe@x.iam.gserviceaccount.com" });
  assert.match(line(r.stdout, "gcp-tenant-sa"), /^FAIL .*모양이 아님/);
});

test("7회차: 플랫폼 프로젝트가 있는데 GCP_CONNECT_REPO_URL 이 없으면 WARN gcp-connect-link (FAIL 아님), 있으면 OK", () => {
  const f = { active: "demo.op@example.com", adcEmail: "demo.op@example.com", sas: [] };
  const a = run(f, { GCP_PLATFORM_PROJECT: "plat-prj", GCP_CONNECT_REPO_URL: "" });
  assert.match(line(a.stdout, "gcp-connect-link"), /^WARN /); assert.equal(a.status, 0);
  const b = run(f, { GCP_PLATFORM_PROJECT: "plat-prj", GCP_CONNECT_REPO_URL: "https://github.com/x/y.git" });
  assert.match(line(b.stdout, "gcp-connect-link"), /^OK /);
});

test("9회차 대용량: 회사 SA 가 많고 앞 10개에 고리가 없으면 FAIL 이 아니라 WARN, 80개 넘으면 한도 WARN, 고리 있으면 첫 것에서 멈춤", () => {
  const many = Array.from({ length: 85 }, (_, i) => `t-${i.toString(16).padStart(28, "0")}@plat-prj.iam.gserviceaccount.com`);
  const base = { active: "demo.op@example.com", adcEmail: "demo.op@example.com", sas: many };
  const w = run({ ...base, members: [] }, { GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.match(line(w.stdout, "gcp-tenant-sa"), /^WARN .*85개 중 앞 10개/);
  assert.match(line(w.stdout, "gcp-tenant-sa-quota"), /^WARN .*한도 100/);
  assert.equal(w.status, 0, w.stdout);
  const o = run({ ...base, members: ["user:demo.op@example.com"] }, { GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.match(line(o.stdout, "gcp-tenant-sa"), /^OK .*85개/);
});

test("10회차 맥: timeout 없는 PATH(perl alarm 길)에서도 같은 판정 — 정상 OK·ADC 다름 FAIL", { skip: existsSync("/usr/bin/perl") || existsSync("/bin/perl") ? false : "perl 없음" }, () => {
  const okR = run({ active: "demo.op@example.com", adcEmail: "demo.op@example.com", sas: [SA], members: ["user:demo.op@example.com"] },
    { GCP_EXPECTED_ACCOUNT: "demo.op@example.com", GCP_PLATFORM_PROJECT: "plat-prj", GCP_CONNECT_REPO_URL: "https://github.com/x/y.git" }, true);
  assert.equal(okR.status, 0, okR.stdout + okR.stderr);
  for (const i of ["gcp-account", "gcp-adc-account", "gcp-tenant-sa", "gcp-connect-link"]) assert.match(line(okR.stdout, i), /^OK /, i);
  const bad = run({ active: "demo.op@example.com", adcEmail: "other.acct@example.com" }, { GCP_EXPECTED_ACCOUNT: "demo.op@example.com" }, true);
  assert.match(line(bad.stdout, "gcp-adc-account"), /^FAIL /);
});

test("실측 01:15Z: 진짜 발급기인데 GCP_PLATFORM_PROJECT 가 없으면 FAIL gcp-platform-project, 있거나 REAL_STS=0 이면 FAIL 아님", () => {
  const f = { active: "demo.op@example.com", adcEmail: "demo.op@example.com", sas: [] };
  const bad = run(f, { REAL_STS: "" });
  assert.match(line(bad.stdout, "gcp-platform-project"), /^FAIL .*PLATFORM_SA_MISSING/); assert.notEqual(bad.status, 0);
  const real1 = run(f, { REAL_STS: "1", GCP_PLATFORM_PROJECT: "plat-prj" });
  assert.match(line(real1.stdout, "gcp-platform-project"), /^OK /);
  const off = run(f, { REAL_STS: "0" });
  assert.equal(line(off.stdout, "gcp-platform-project"), "");
  const optOut = run(f, { REAL_STS: "1", GCP_ACCOUNT_CHECK_GCP_OFF: "1" });
  assert.equal(line(optOut.stdout, "gcp-platform-project"), "");
});

// tools/platform-team-users.{ts,sh}: 팀원 계정 만들기 도구의 로컬 부분. DB·AWS·kubectl 은 가짜(PATH 앞 가짜 명령)로만 부른다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPassword } from "../src/auth/password.js";
import {
  assertProductionScrypt, collectUsers, InputError, parseLogins, parsePair, parseResults, planPasswords, reconcile,
} from "../../../tools/platform-team-users.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TENANT = "11111111-1111-4111-8111-111111111111";
const mode = (p: string) => statSync(p).mode & 0o777;

test("입력: email:이름 은 소문자 이메일·첫 콜론 뒤 전부가 이름, 파일은 빈 줄·# 줄을 건너뛴다", () => {
  assert.deepEqual(parsePair(" A@Example.COM : 팀원: 하나 "), { email: "a@example.com", displayName: "팀원: 하나" });
  assert.deepEqual(parsePair("b@example.com:"), { email: "b@example.com", displayName: "" });
  const files: Record<string, string> = { "team.txt": "# 팀\n\nc@example.com:C\r\nd@example.com:D\n" };
  const users = collectUsers(["team.txt", "e@example.com:E"], (p) => files[p] ?? null);
  assert.deepEqual(users.map((u) => u.email), ["c@example.com", "d@example.com", "e@example.com"]);
});

test("입력 거부: 콜론 없음·이메일 모양·이름의 탭/역슬래시·중복 이메일·빈 목록", () => {
  const none = () => null;
  assert.throws(() => parsePair("no-colon"), InputError);
  assert.throws(() => parsePair("not-an-email:x"), InputError);
  assert.throws(() => parsePair("a b@example.com:x"), InputError);
  assert.throws(() => parsePair("a@example.com:x\ty"), InputError);
  assert.throws(() => parsePair("a@example.com:x\\y"), InputError);
  assert.throws(() => collectUsers(["a@example.com:A", "A@example.com:B"], none), /두 번/);
  assert.throws(() => collectUsers([], none), InputError);
  assert.throws(() => parseLogins("a@example.com no-tab\n"), InputError);
});

test("비밀번호 계획: 파일에 있으면 그대로(kept), FORCE 면 새로, 새 비밀번호는 16자 이상·서로 다름", () => {
  const users = collectUsers(["a@example.com:A", "b@example.com:B"], () => null);
  const existing = new Map([["a@example.com", "old-password-aaaaaaaa"]]);
  const r = planPasswords(users, existing, false);
  assert.equal(r.logins.get("a@example.com"), "old-password-aaaaaaaa");
  assert.deepEqual(r.plan, [{ email: "a@example.com", source: "kept" }, { email: "b@example.com", source: "new" }]);
  assert.ok(r.logins.get("b@example.com")!.length >= 16);
  const f = planPasswords(users, existing, true);
  assert.notEqual(f.logins.get("a@example.com"), "old-password-aaaaaaaa");
  assert.notEqual(f.logins.get("a@example.com"), f.logins.get("b@example.com"));
  assert.ok(f.plan.every((p) => p.source === "new"));
});

test("결과 맞추기: 새로 만든 비밀번호인데 exists 면 파일에서 뺀다, 파일에 있던 것은 둔다. 찍는 줄에 비밀번호 없음", () => {
  const logins = new Map([["a@example.com", "pw-a-xxxxxxxxxxxxxxxx"], ["b@example.com", "pw-b-xxxxxxxxxxxxxxxx"],
    ["c@example.com", "pw-c-xxxxxxxxxxxxxxxx"], ["d@example.com", "pw-d-xxxxxxxxxxxxxxxx"]]);
  const plan = [{ email: "a@example.com", source: "new" }, { email: "b@example.com", source: "kept" },
    { email: "c@example.com", source: "new" }, { email: "d@example.com", source: "new" }] as const;
  const results = parseResults("noise\nRESULT\ta@example.com\tcreated\nRESULT\tb@example.com\texists\n"
    + "RESULT\tc@example.com\texists\nRESULT\td@example.com\texists-other-tenant\n");
  const r = reconcile(logins, [...plan], results);
  assert.deepEqual([...r.logins.keys()], ["a@example.com", "b@example.com"]);
  assert.equal(r.lines.at(-1), "합계 4명: created 1, exists 3");
  assert.match(r.lines[0]!, /^a@example\.com → created$/);
  assert.doesNotMatch(r.lines.join("\n"), /pw-/);
  assert.throws(() => parseResults("RESULT\ta@example.com\tweird\n"));
  assert.throws(() => reconcile(logins, [{ email: "z@example.com", source: "new" }], results), /no DB result/);
});

test("해시 세기: 셸에 남은 시험용 AUTH_SCRYPT_N(16384)이면 멈춘다, 비었거나 운영 이상이면 통과", () => {
  assert.throws(() => assertProductionScrypt({ AUTH_SCRYPT_N: "16384" }), /운영 기본/);
  assert.doesNotThrow(() => assertProductionScrypt({}));
  assert.doesNotThrow(() => assertProductionScrypt({ AUTH_SCRYPT_N: "" }));
  assert.doesNotThrow(() => assertProductionScrypt({ AUTH_SCRYPT_N: String(2 ** 18) }));
});

// 가짜 aws·kubectl: 인자는 args.log 에, kubectl exec 의 표준 입력은 stdin.txt 에. psql 대신 데이터 줄마다 결과를 돌려준다
function fakeBin(dir: string, status = "created") {
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const put = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  put("aws", `echo "aws $*" >> "${dir}/args.log"
case "$*" in *describe-db-instances*) printf 'db.example.internal\\tarn:aws:secretsmanager:fake\\n' ;; *) echo '{"username":"owner","password":"owner-secret-pw"}' ;; esac`);
  put("kubectl", `echo "kubectl $*" >> "${dir}/args.log"
case "$*" in *" exec "*) cat > "${dir}/stdin.txt"; awk -F'\\t' 'NF==3 && $3 ~ /^scrypt\\$/ {printf "RESULT\\t%s\\t${status}\\n", $1}' "${dir}/stdin.txt" ;; esac`);
  return bin;
}
function runTool(dir: string, args: string[], env: Record<string, string> = {}, status?: string) {
  const bin = fakeBin(dir, status);
  const base: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OUT_FILE: join(dir, "cfg", "team-logins.txt") };
  delete base.AUTH_SCRYPT_N;   // 운영과 같은 N=2^17 로 해시 (npm test 의 낮은 값이 남지 않게)
  return spawnSync("bash", ["tools/platform-team-users.sh", ...args], { cwd: ROOT, encoding: "utf8", env: { ...base, ...env }, timeout: 120_000 });
}

test("셸 전체(가짜 aws·kubectl): 파일 600·해시는 stdin 으로만·인자와 화면에 비밀값 없음·파드와 Secret 지움·다시 돌리면 같은 비밀번호", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-users-"));
  const r = runTool(dir, ["a@example.com:팀원 A", "B@example.com:팀원 B"], { TENANT_ID: TENANT });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = join(dir, "cfg", "team-logins.txt");
  assert.equal(mode(out), 0o600);
  const logins = parseLogins(readFileSync(out, "utf8"));
  assert.deepEqual([...logins.keys()], ["a@example.com", "b@example.com"]);
  const stdin = readFileSync(join(dir, "stdin.txt"), "utf8");
  const args = readFileSync(join(dir, "args.log"), "utf8");
  for (const pw of logins.values()) {
    assert.ok(pw.length >= 16);
    for (const [where, text] of [["stdout", r.stdout], ["stderr", r.stderr], ["args", args], ["stdin", stdin]]) {
      assert.ok(!text!.includes(pw), `password leaked into ${where}`);
    }
  }
  // 해시는 stdin 으로 가고, 앱의 verifyPassword 로 맞는다 (운영 N=2^17)
  const rows = stdin.split("\n").filter((l) => l.split("\t").length === 3 && l.includes("scrypt$"));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const [email, , hash] = row.split("\t");
    assert.match(hash!, /^scrypt\$131072\$8\$1\$/);
    assert.equal(await verifyPassword(logins.get(email!)!, hash), true);
    assert.ok(!args.includes(hash!) && !r.stdout.includes(hash!) && !r.stderr.includes(hash!), "hash leaked");
  }
  assert.ok(!args.includes("owner-secret-pw") && !r.stdout.includes("owner-secret-pw"), "db password leaked");
  assert.match(args, /kubectl --context eks-platform -n platform delete pod team-users-/);
  assert.match(args, /kubectl --context eks-platform -n platform delete secret team-users-/);
  assert.match(r.stdout, /^a@example\.com → created$/m);
  assert.match(r.stdout, /^합계 2명: created 2, exists 0$/m);

  const again = runTool(dir, ["a@example.com:팀원 A", "b@example.com:팀원 B"], { TENANT_ID: TENANT }, "exists");
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(parseLogins(readFileSync(out, "utf8")), logins, "FORCE 없이는 파일의 비밀번호를 안 바꾼다");
  assert.match(again.stdout, /^합계 2명: created 0, exists 2$/m);
});

test("셸: 새 사용자가 이미 다른 사람 계정(exists)이면 그 비밀번호는 파일에서 빠진다", () => {
  const dir = mkdtempSync(join(tmpdir(), "team-users-"));
  const r = runTool(dir, ["x@example.com:X"], { TENANT_ID: TENANT }, "exists");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /x@example\.com → exists \(이 도구가 만든 계정이 아님/);
  assert.equal(readFileSync(join(dir, "cfg", "team-logins.txt"), "utf8"), "");
});

test("셸 거부: TENANT_ID 없음·uuid 아님 → 2, aws·kubectl 안 부름. AUTH_SCRYPT_N 이 낮으면 파일도 안 씀", () => {
  for (const env of [{}, { TENANT_ID: "acme" }] as Record<string, string>[]) {
    const dir = mkdtempSync(join(tmpdir(), "team-users-"));
    const r = runTool(dir, ["a@example.com:A"], env);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(existsSync(join(dir, "args.log")), false);
  }
  const dir = mkdtempSync(join(tmpdir(), "team-users-"));
  const r = runTool(dir, ["a@example.com:A"], { TENANT_ID: TENANT, AUTH_SCRYPT_N: "16384" });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(join(dir, "cfg", "team-logins.txt")), false);
  assert.equal(existsSync(join(dir, "args.log")), false);
});

test("셸 DRY_RUN=1: 사용자 목록과 SQL 모양만, 비밀값·파일·aws·kubectl 없음", () => {
  const dir = mkdtempSync(join(tmpdir(), "team-users-"));
  const r = runTool(dir, ["a@example.com:팀원 A"], { TENANT_ID: TENANT, DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /a@example\.com → 팀원 A/);
  assert.match(r.stdout, /ON CONFLICT \(email\) DO NOTHING/);
  assert.match(r.stdout, /<scrypt\$131072\$8\$1\$소금\$해시>/);
  assert.doesNotMatch(r.stdout, /scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{16,}/);
  assert.equal(existsSync(join(dir, "cfg", "team-logins.txt")), false);
  assert.equal(existsSync(join(dir, "args.log")), false);
});

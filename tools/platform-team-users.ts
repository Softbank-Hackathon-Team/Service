// tools/platform-team-users.sh 의 로컬 쪽 (DRAFT(ai)). 비밀번호를 만들고·해시하고·파일에 쓰는 일은 전부 이 맥에서만 한다.
//   prepare  [--force] --out <로그인 파일> --hashes <해시 TSV> --plan <계획 TSV> -- <email:이름 | 파일> ...
//            사용자마다 비밀번호를 정하고(파일에 이미 있으면 그대로, FORCE 면 새로) 앱의 hashPassword 로 해시한다.
//            로그인 파일(email<TAB>password, 권한 600)에는 원문, 해시 TSV(email<TAB>이름<TAB>해시)에는 해시만. 화면에는 아무 값도 안 찍는다
//   finalize --out <로그인 파일> --plan <계획 TSV>      (표준 입력 = psql 결과 "RESULT<TAB>email<TAB>상태" 줄)
//            이번에 새로 만든 비밀번호인데 DB 에 안 들어간 사용자(exists)는 로그인 파일에서 뺀다 (안 맞는 비밀번호를 남기지 않는다)
//            화면에는 "email → 상태" 와 개수만
//   list     -- <email:이름 | 파일> ...                 DRY_RUN 용. 이메일·이름만 찍는다
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, SCRYPT_DEFAULT } from "../apps/api/src/auth/password.js";

export type TeamUser = { email: string; displayName: string };
export type PlanRow = { email: string; source: "new" | "kept" };
export type DbStatus = "created" | "exists" | "exists-other-tenant" | "reset";

// 0019 users_email_shape 와 같은 모양 + 한 줄 TSV(COPY text) 에 들어갈 수 없는 글자 금지
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const BAD_TSV = /[\t\n\r\\\u0000-\u001f\u007f]/;
export const DISPLAY_MAX = 100;   // DRAFT(ai): 화면 머리줄에 들어갈 길이. 표에는 길이 제한이 없다
export const GENERATED_LEN = 24;  // randomBytes(18) base64url = 24자 (144비트). 요구 최소 16

export class InputError extends Error {}

/** "email:이름" 한 줄. 이름은 첫 콜론 뒤 전부(콜론 포함 가능). 이름이 비면 null 대신 빈 문자열 → SQL 에서 NULL */
export function parsePair(raw: string, where = "인자"): TeamUser {
  const i = raw.indexOf(":");
  if (i < 0) throw new InputError(`${where}: "email:이름" 모양이 아님`);
  const email = raw.slice(0, i).trim().toLowerCase();
  const displayName = raw.slice(i + 1).trim();
  if (!EMAIL_RE.test(email) || email.length > 254 || BAD_TSV.test(email)) throw new InputError(`${where}: 이메일 모양이 아님 (${email || "빈 값"})`);
  if (BAD_TSV.test(displayName)) throw new InputError(`${where}: 이름에 탭·줄바꿈·역슬래시·제어 문자를 쓸 수 없음`);
  if (displayName.length > DISPLAY_MAX) throw new InputError(`${where}: 이름이 ${DISPLAY_MAX}자를 넘음`);
  return { email, displayName };
}

/** 파일 내용: 한 줄에 "email:이름". 빈 줄과 # 줄은 건너뛴다 */
export function parseUsersText(text: string, name = "파일"): TeamUser[] {
  const out: TeamUser[] = [];
  text.split(/\r?\n/).forEach((line, n) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    out.push(parsePair(t, `${name}:${n + 1}`));
  });
  return out;
}

/** 인자마다: 있는 파일이면 그 파일을 읽고, 아니면 "email:이름" 하나. 같은 이메일이 두 번 나오면 거부 */
export function collectUsers(args: string[], read: (p: string) => string | null = readIfFile): TeamUser[] {
  const all: TeamUser[] = [];
  for (const a of args) {
    const text = read(a);
    all.push(...(text === null ? [parsePair(a)] : parseUsersText(text, a)));
  }
  if (all.length === 0) throw new InputError("사용자가 없음 (email:이름 인자나 그 줄들이 든 파일을 준다)");
  const seen = new Set<string>();
  for (const u of all) {
    if (seen.has(u.email)) throw new InputError(`같은 이메일이 두 번: ${u.email}`);
    seen.add(u.email);
  }
  return all;
}

function readIfFile(p: string): string | null {
  try { return statSync(p).isFile() ? readFileSync(p, "utf8") : null; } catch { return null; }
}

/** 로그인 파일 "email<TAB>password" → Map. 모양이 틀린 줄이 있으면 멈춘다 (덮어써서 지우지 않게) */
export function parseLogins(text: string): Map<string, string> {
  const m = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, n) => {
    if (!line.trim() || line.startsWith("#")) return;
    const i = line.indexOf("\t");
    if (i <= 0) throw new InputError(`로그인 파일 ${n + 1}번째 줄 모양이 틀림 (email<TAB>password)`);
    m.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1));
  });
  return m;
}

export function formatLogins(m: Map<string, string>): string {
  return [...m].map(([e, p]) => `${e}\t${p}\n`).join("");
}

export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/** 사용자마다 쓸 비밀번호를 정한다. 파일에 이미 있으면 그대로(FORCE 가 아니면) → 다시 돌려도 같은 비밀번호 */
export function planPasswords(users: TeamUser[], existing: Map<string, string>, force: boolean, gen = generatePassword) {
  const logins = new Map(existing);
  const plan: PlanRow[] = [];
  for (const u of users) {
    const old = existing.get(u.email);
    if (old !== undefined && !force) { plan.push({ email: u.email, source: "kept" }); continue; }
    const pw = gen();
    if (pw.length < 16 || pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) throw new Error("generated password length out of range");
    logins.set(u.email, pw);
    plan.push({ email: u.email, source: "new" });
  }
  return { logins, plan };
}

/** 운영 api 는 AUTH_SCRYPT_N 을 비워 둔다(= 2^17). 이 맥 셸에 시험용 낮은 값이 남아 있으면 약한 해시가 운영에 들어가므로 멈춘다 */
export function assertProductionScrypt(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.AUTH_SCRYPT_N;
  if (raw === undefined || raw === "") return;
  const n = Number(raw);
  if (Number.isInteger(n) && n < SCRYPT_DEFAULT.N) {
    throw new InputError(`AUTH_SCRYPT_N=${raw} 는 운영 기본(${SCRYPT_DEFAULT.N})보다 낮다. 비우고 다시 돌린다`);
  }
}

/** 권한 600 으로 통째로 바꿔 쓴다 (임시 파일 → rename). 디렉터리는 700 으로 만든다 */
export function writePrivate(path: string, content: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** psql 출력에서 결과 줄만. 다른 줄(알림 등)은 버린다 */
export function parseResults(text: string): Map<string, DbStatus> {
  const m = new Map<string, DbStatus>();
  for (const line of text.split(/\r?\n/)) {
    const [tag, email, status] = line.split("\t");
    if (tag !== "RESULT" || !email) continue;
    if (status !== "created" && status !== "exists" && status !== "exists-other-tenant" && status !== "reset") {
      throw new Error(`unexpected status for ${email}`);
    }
    m.set(email, status);
  }
  return m;
}

/** DB 에 안 들어간 새 비밀번호를 로그인 파일에서 뺀다. 화면에 찍을 줄을 돌려준다 (비밀값 없음) */
export function reconcile(logins: Map<string, string>, plan: PlanRow[], results: Map<string, DbStatus>) {
  const next = new Map(logins);
  const lines: string[] = [];
  const count: Record<DbStatus, number> = { created: 0, exists: 0, "exists-other-tenant": 0, reset: 0 };
  for (const p of plan) {
    const s = results.get(p.email);
    if (!s) throw new Error(`no DB result for ${p.email}`);
    count[s]++;
    const dropped = (s === "exists" || s === "exists-other-tenant") && p.source === "new";
    if (dropped) next.delete(p.email);
    const note = s === "exists-other-tenant" ? " (다른 회사 계정, 손대지 않음)"
      : dropped ? " (이 도구가 만든 계정이 아님, 비밀번호는 그 사람에게)" : "";
    lines.push(`${p.email} → ${s}${note}`);
  }
  const parts = [`created ${count.created}`, `exists ${count.exists + count["exists-other-tenant"]}`];
  if (count.reset) parts.push(`reset ${count.reset}`);
  lines.push(`합계 ${plan.length}명: ${parts.join(", ")}`);
  return { logins: next, lines };
}

function opt(args: string[], name: string): string {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (!v) throw new InputError(`${name} 가 필요함`);
  return v;
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const dash = rest.indexOf("--");
  const flags = dash >= 0 ? rest.slice(0, dash) : rest;
  const positional = dash >= 0 ? rest.slice(dash + 1) : [];

  if (cmd === "list") {
    for (const u of collectUsers(positional)) console.log(`${u.email} → ${u.displayName || "(이름 없음)"}`);
    return;
  }
  if (cmd === "prepare") {
    assertProductionScrypt();
    const out = opt(flags, "--out"), hashesPath = opt(flags, "--hashes"), planPath = opt(flags, "--plan");
    const users = collectUsers(positional);
    const existing = existsSync(out) ? parseLogins(readFileSync(out, "utf8")) : new Map<string, string>();
    const { logins, plan } = planPasswords(users, existing, flags.includes("--force"));
    const rows: string[] = [];
    for (const u of users) rows.push(`${u.email}\t${u.displayName}\t${await hashPassword(logins.get(u.email)!)}\n`);
    // 순서: 로그인 파일 먼저. DB 가 중간에 실패해도 다음 실행이 같은 비밀번호를 다시 쓴다 (원문을 잃은 계정이 생기지 않게)
    writePrivate(out, formatLogins(logins));
    writePrivate(hashesPath, rows.join(""));
    writePrivate(planPath, plan.map((p) => `${p.email}\t${p.source}\n`).join(""));
    const kept = plan.filter((p) => p.source === "kept").length;
    console.error(`비밀번호 준비: 새로 ${plan.length - kept}명, 파일에 있던 것 그대로 ${kept}명 (값은 로그인 파일에만)`);
    return;
  }
  if (cmd === "finalize") {
    const out = opt(flags, "--out"), planPath = opt(flags, "--plan");
    const plan: PlanRow[] = readFileSync(planPath, "utf8").split("\n").filter(Boolean).map((l) => {
      const [email, source] = l.split("\t");
      return { email: email!, source: source === "kept" ? "kept" : "new" };
    });
    const results = parseResults(readFileSync(0, "utf8"));
    const { logins, lines } = reconcile(parseLogins(readFileSync(out, "utf8")), plan, results);
    writePrivate(out, formatLogins(logins));
    for (const l of lines) console.log(l);
    return;
  }
  throw new InputError("usage: prepare | finalize | list");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof InputError ? e.message : `실패: ${(e as Error).message}`);
    process.exit(2);
  });
}

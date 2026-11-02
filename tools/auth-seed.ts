// 데모 계정 비밀번호 넣기 (Z93). 0018 이 만든 데모 계정(비밀번호 없음 = 로그인 불가)에 비밀번호를 넣는다.
//   npm run auth:seed
// 값은 .env 에서만 읽는다 (화면·로그·채팅에 비밀번호를 찍지 않는다)
//   DEMO_USER_EMAIL     기본 demo@dev-company.test (0018 시드)
//   DEMO_USER_PASSWORD  8자 이상. 없으면 무작위로 만들어 .secrets/demo-login.txt (권한 600)에만 쓰고 그 경로만 알려 준다
// 표 주인 계정(OWNER_DATABASE_URL)으로 쓴다: 앱 계정(app_user)은 사용자 만들기 권한이 없다 (0018)
// 사용자 끄기 (L8): npm run auth:seed -- --disable [이메일]   (이메일 없으면 DEMO_USER_EMAIL)
//   users.disabled_at 을 채우고, 그 사용자의 살아 있는 로그인 세션을 전부 끊고, 같은 트랜잭션에서 session_events 알림을 보낸다.
//   인증 훅이 요청마다 disabled_at 을 보므로 이미 받은 접근 토큰도 다음 요청부터 401(USER_DISABLED)
// 이미 비밀번호가 있으면 바꾸지 않는다. 바꾸려면 AUTH_SEED_FORCE=1
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { hashPassword, PASSWORD_MIN } from "../apps/api/src/auth/password.js";

const DEV_TENANT = "11111111-1111-4111-8111-111111111111";
const argv = process.argv.slice(2);
const disableIdx = argv.indexOf("--disable");
// 검증 L8: `--disable --tenant <uuid>` 처럼 이메일을 생략하면 다음 옵션("--tenant")이 이메일로 읽히던 것을 막는다
const emailArg = disableIdx >= 0 && !argv[disableIdx + 1]?.startsWith("--") ? argv[disableIdx + 1] : undefined;
const email = (emailArg ?? process.env.DEMO_USER_EMAIL ?? "demo@dev-company.test").trim().toLowerCase();
const owner = process.env.OWNER_DATABASE_URL ?? "postgres://platform_owner:owner_pw@localhost:5432/platform";

if (disableIdx >= 0) {
  const c = new pg.Client({ connectionString: owner, application_name: "auth-seed" });
  await c.connect();
  try {
    await c.query("BEGIN");
    // 표 주인에게도 RLS(FORCE)가 걸리므로 회사 번호를 먼저 넣는다. 기본은 개발 회사, 다른 회사는 --tenant <uuid>
    const ti = argv.indexOf("--tenant");
    const tenantId = (ti >= 0 ? argv[ti + 1] : undefined) ?? DEV_TENANT;
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const found = await c.query("SELECT id, tenant_id FROM users WHERE email = $1", [email]);
    if (!found.rows[0]) { console.error(`사용자 없음: ${email}`); await c.query("ROLLBACK"); process.exit(1); }
    const userId = found.rows[0].id as string;
    // 검증 L8: 표 주인이 RLS 를 우회하는 환경(슈퍼유저)에서는 --tenant 가 틀려도 줄이 보인다 → 알림의 회사 번호는 줄에 적힌 진짜 회사로
    const realTenant = found.rows[0].tenant_id as string;
    await c.query("UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1", [userId]);
    const r = await c.query(
      "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'disabled' WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    // 모양은 contracts NotifySession {t,u,r} 과 같다 (도구는 apps 밖이라 contracts 를 거치지 않고 같은 글자로 보냄)
    await c.query("SELECT pg_notify('session_events', $1)", [JSON.stringify({ t: realTenant, u: userId, r: "disabled" })]);
    await c.query("COMMIT");
    console.log(`사용자 끔: ${email} (끊은 세션 ${r.rowCount}개)`);
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { await c.end(); }
  process.exit(0);
}

let pw = process.env.DEMO_USER_PASSWORD ?? "";
let wroteFile: string | null = null;
if (pw && pw.length < PASSWORD_MIN) { console.error(`DEMO_USER_PASSWORD 는 ${PASSWORD_MIN}자 이상이어야 한다`); process.exit(2); }

const c = new pg.Client({ connectionString: owner, application_name: "auth-seed" });
await c.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.tenant_id', $1, true)", [DEV_TENANT]);
  const cur = await c.query("SELECT id, password_hash IS NOT NULL AS has FROM users WHERE email = $1", [email]);
  if (cur.rows[0]?.has && process.env.AUTH_SEED_FORCE !== "1") {
    console.log(`이미 비밀번호 있음: ${email} (바꾸려면 AUTH_SEED_FORCE=1)`);
    await c.query("ROLLBACK");
    process.exit(0);
  }
  if (!pw) {
    pw = randomBytes(12).toString("base64url");
    const dir = resolve(".secrets");
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    wroteFile = resolve(dir, "demo-login.txt");
    writeFileSync(wroteFile, `email=${email}\npassword=${pw}\n`, { mode: 0o600 });
    chmodSync(wroteFile, 0o600);
  }
  const hash = await hashPassword(pw);
  await c.query(
    `INSERT INTO users (tenant_id, email, display_name, password_hash, password_changed_at) VALUES ($1, $2, '데모 사용자', $3, now())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now(), disabled_at = NULL`,
    [DEV_TENANT, email, hash]);
  await c.query("COMMIT");
  console.log(`비밀번호 넣음: ${email}${wroteFile ? ` (무작위 생성, 값은 ${wroteFile} 에만)` : " (.env DEMO_USER_PASSWORD)"}`);
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  throw e;
} finally { await c.end(); }

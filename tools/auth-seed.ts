// 데모 계정 비밀번호 넣기 (Z93). 0018 이 만든 데모 계정(비밀번호 없음 = 로그인 불가)에 비밀번호를 넣는다.
//   npm run auth:seed
// 값은 .env 에서만 읽는다 (화면·로그·채팅에 비밀번호를 찍지 않는다)
//   DEMO_USER_EMAIL     기본 demo@dev-company.test (0018 시드)
//   DEMO_USER_PASSWORD  8자 이상. 없으면 무작위로 만들어 .secrets/demo-login.txt (권한 600)에만 쓰고 그 경로만 알려 준다
// 표 주인 계정(OWNER_DATABASE_URL)으로 쓴다: 앱 계정(app_user)은 사용자 만들기 권한이 없다 (0018)
// 이미 비밀번호가 있으면 바꾸지 않는다. 바꾸려면 AUTH_SEED_FORCE=1
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { hashPassword, PASSWORD_MIN } from "../apps/api/src/auth/password.js";

const DEV_TENANT = "11111111-1111-4111-8111-111111111111";
const email = (process.env.DEMO_USER_EMAIL ?? "demo@dev-company.test").trim().toLowerCase();
const owner = process.env.OWNER_DATABASE_URL ?? "postgres://platform_owner:owner_pw@localhost:5432/platform";

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

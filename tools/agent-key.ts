// Z92: 온프레 Agent 키 발급·폐기 (사람이 맥에서 한 번). DB 에는 키 번호·회사·환경만, 비밀은 마스터로 다시 만든다
//   npm run agent:key -- issue --env 55555555-5555-4555-8555-555555555555 [--out .agent-key.env]
//   npm run agent:key -- revoke --key ak_xxxx --tenant <회사 번호>
// issue: 그 환경이 onprem 인지 확인 → agent_keys 한 줄 → 비밀을 --out 파일(권한 600)에만 쓴다. 화면에는 키 번호만
// 필요한 .env: DATABASE_URL, AGENT_REPORT_MASTER_KEY (서버와 같은 값)
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pool, withTenant } from "@svc/core";
import { deriveAgentSecret } from "@svc/contracts/agent-sig";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEV_TENANT = "11111111-1111-4111-8111-111111111111";

async function main() {
  const cmd = args[0];
  const tenant = opt("tenant") ?? DEV_TENANT;
  if (!UUID.test(tenant)) throw new Error("--tenant 는 uuid");
  if (cmd === "issue") {
    const master = process.env.AGENT_REPORT_MASTER_KEY ?? "";
    const env = opt("env");
    if (!env || !UUID.test(env)) throw new Error("--env <온프레 환경 uuid> 필요");
    const keyId = "ak_" + randomBytes(12).toString("hex");
    const secret = deriveAgentSecret(master, keyId);     // 마스터가 짧으면 여기서 멈춘다
    await withTenant(tenant, async (tx) => {
      const e = await tx.query(`SELECT provider FROM environments WHERE id = $1`, [env]);
      if (!e.rows[0]) throw new Error(`환경 ${env} 없음 (회사 ${tenant})`);
      if (e.rows[0].provider !== "onprem") throw new Error(`환경 ${env} 는 ${e.rows[0].provider} — Agent 키는 onprem 환경만`);
      await tx.query(`INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1, $2, $3)`, [keyId, tenant, env]);
    });
    const out = opt("out") ?? ".agent-key.env";
    writeFileSync(out, `AGENT_KEY_ID=${keyId}\nAGENT_KEY_SECRET=${secret}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, keyId, envId: env, secretFile: out }));
  } else if (cmd === "revoke") {
    const key = opt("key");
    if (!key) throw new Error("--key ak_... 필요");
    const n = await withTenant(tenant, async (tx) =>
      (await tx.query(`UPDATE agent_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [key])).rowCount ?? 0);
    console.log(JSON.stringify({ ok: n === 1, keyId: key, revoked: n }));
  } else {
    throw new Error("사용: agent-key.ts issue --env <uuid> [--tenant <uuid>] [--out 파일] | revoke --key <ak_…> [--tenant <uuid>]");
  }
}
main().then(() => pool.end(), async (e) => { console.error(JSON.stringify({ ok: false, error: (e as Error).message })); await pool.end(); process.exit(1); });

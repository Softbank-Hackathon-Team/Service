import type { FullConfig } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import { seedFor } from "./helpers";

// 시험 전에 API가 살아 있는지 본다. 없으면 30초 기다리지 말고 바로 이유를 알려 준다.
const api = process.env.E2E_API_URL ?? "http://localhost:3000";
// Z75-11: 일꾼이 여럿이면 1..n-1 번 일꾼의 회사와 seed 환경 3개(aws·gcp·azure_mock)를 0번 seed 를 본떠 만든다.
// 주인 계정으로 넣는다(회사 표는 앱 계정이 못 쓴다). 이미 있으면 그대로 둔다 → 몇 번을 돌려도 같다
// z75-25: 값이 없으면 레포 맨 위 .env 의 OWNER_DATABASE_URL 을 쓴다 (dev:api 가 읽는 것과 같은 DB).
//   예전엔 바로 기본 주소(platform)로 갔다 → .env 가 다른 DB(예: platform_c)를 가리키면 일꾼 회사를 엉뚱한 DB 에 만들고
//   1·2번 일꾼 시험이 "환경 없음"으로 전부 깨졌다. process.env 는 바꾸지 않는다 (parseEnv 로 읽기만)
function ownerUrl(config: FullConfig): string {
  if (process.env.OWNER_DATABASE_URL) return process.env.OWNER_DATABASE_URL;
  const file = resolve(dirname(config.configFile ?? resolve("playwright.config.ts")), "../../.env");
  const vars = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  if (vars.OWNER_DATABASE_URL) return vars.OWNER_DATABASE_URL;
  // OWNER 주소가 어디에도 없으면 기본 주인 계정 + API 가 쓰는 DB 이름 (Z38 R8-19)
  const def = new URL("postgres://platform_owner:owner_pw@localhost:5432/platform");
  const app = process.env.DATABASE_URL || vars.DATABASE_URL;
  if (app) { try { const u = new URL(app); def.host = u.host; def.pathname = u.pathname; } catch { /* 기본값 */ } }
  return def.toString();
}

async function seedWorkers(n: number, owner: string) {
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  try {
    const base = seedFor(0);
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [base.tenant]);
    const envs = (await c.query(
      "SELECT id, provider, name, connection_status, account_id FROM environments WHERE id = ANY($1::uuid[])",
      [[base.aws, base.gcp, base.azure]])).rows as Array<{ id: string; provider: string; name: string; connection_status: string; account_id: string | null }>;
    if (envs.length !== 3) throw new Error(`seed 환경이 ${envs.length}개다 (3개여야 함). db/migrations 0002·0008 을 넣었는지 확인`);
    for (let w = 1; w < n; w++) {
      const s = seedFor(w);
      const idOf: Record<string, string> = { [base.aws]: s.aws, [base.gcp]: s.gcp, [base.azure]: s.azure };
      await c.query("INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [s.tenant, `e2e-worker-${w}`]);
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [s.tenant]);
      for (const e of envs) {
        await c.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [idOf[e.id], s.tenant, e.provider, e.name, e.connection_status, e.account_id]);
      }
    }
  } finally { await c.end(); }
}

export default async function globalSetup(config: FullConfig) {
  try {
    const res = await fetch(`${api}/healthz`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw new Error(
      `API(${api}/healthz)가 응답하지 않아. 먼저 DB·워커·API를 띄워: ` +
        `npm run db:up, npm run dev:worker, npm run dev:api (원인: ${(e as Error).message})`,
    );
  }
  if (config.workers > 1) await seedWorkers(config.workers, ownerUrl(config));
}

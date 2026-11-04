// 멈춘 이전 닫기 (STUCKLOCK). 데모 회사의 안 끝난 이전을 정식 API 길로만 끝 상태로 보낸다 → advance() 가 환경 잠금을 푼다.
// 왜: 11/3 6차 이전이 syncing 에서 paused(SYNC_FAILED)로 남아 환경 잠금(reserved, 기한 지남)을 쥐었고,
//   7차 승인이 409 ENV_BUSY 로 막혔다. paused·failed 잠금은 청소 작업이 일부러 안 뺏는다(사람이 보라고). 그래서 사람이 닫는 길을 도구로 만든다.
//   DB 를 직접 고치지 않는다: 상태를 바꾸는 길은 advance() 하나 (CLAUDE.md 5-5).
//
// 상태별로 하는 일 (packages/contracts/src/migration.ts VALID 기준)
//   paused        → POST /rollback → 워커 rollback 작업 → rolled_back (실패하면 failed)
//   rolling_back  → 워커가 끝내기를 기다림
//   failed        → POST /cancel {manualCleanupConfirmed:true} → cancelled
//                   (클라우드 자원은 down·cloud-zero 가 0 을 확인한 뒤라는 전제. 그래서 down 끝에서 부른다)
//   그 밖에 VALID 에 cancelled 가 있는 상태(draft·spec_review·awaiting_approval·approved 등) → POST /cancel
//   돌고 있는 단계(provisioning·deploying·syncing·shifting·cutover·rollback_window·cleanup)와
//   cleanup 에서 멈춘 paused(롤백 창이 끝나 롤백 불가) → 건드리지 않고 "남음"으로 알린다
//
// 쓰는 법 (Service 폴더 맨 위, api·worker 가 떠 있어야 함)
//   npx tsx tools/close-stuck.ts             닫기
//   npx tsx tools/close-stuck.ts --dry-run   무엇을 할지 목록만
//   npx tsx tools/close-stuck.ts --only <이전 id>[,<id>…]   그 이전만
//   npx tsx tools/close-stuck.ts --check-db  사전 점검 ① DBINV: API 없이 플랫폼 DB 를 읽기만 한다 (up-preflight 가 부름)
//       데모 회사의 안 끝난 이전 0 · env_locks 0 · 시드 환경(smoke·실세션 기본 대상) 있음. OWNER_DATABASE_URL(없으면 로컬 기본)
// 환경 변수: API_PORT(기본 3000) CLOSE_WAIT_SEC(롤백 기다림, 기본 300) CLOSE_REASON
//            로그인 비밀번호는 smoke 와 같은 순서(DEMO_USER_PASSWORD → .env → .secrets/demo-login.txt). 값은 안 찍는다
// 끝 코드: 0 = 데모 회사에 안 끝난 이전 없음(잠금 풀림), 1 = 남은 것 있음, 2 = API·로그인 안 됨
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { VALID, type MigrationStatus } from "@svc/contracts";

const API = `http://localhost:${process.env.API_PORT ?? "3000"}/api/v1`;
const WAIT_SEC = Number(process.env.CLOSE_WAIT_SEC ?? 300);
const REASON = process.env.CLOSE_REASON?.trim() || "stuck migration closed after down (close-stuck)";
const DRY = process.argv.includes("--dry-run");
const oi = process.argv.indexOf("--only");
const ONLY = oi > 0 ? (process.argv[oi + 1] ?? "").split(",").filter(Boolean) : [];

export const TERMINAL: readonly MigrationStatus[] = ["completed", "rolled_back", "cancelled"];
export type Action = "rollback" | "cancel" | "cancel_confirmed" | "wait" | "leave";
// 이전 하나에 무엇을 할지 (순수 함수, 시험 대상)
export function actionFor(status: MigrationStatus, pausedFrom?: string | null): Action {
  if (status === "paused") return pausedFrom === "cleanup" ? "leave" : "rollback";
  if (status === "rolling_back") return "wait";
  if (status === "failed") return "cancel_confirmed";
  if (VALID[status].includes("cancelled")) return "cancel";
  return "leave";
}

function demoPassword(): string | undefined {
  const fromEnv = process.env.DEMO_USER_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  const tryRead = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
  const dot = tryRead(".env").split("\n").filter((l) => l.startsWith("DEMO_USER_PASSWORD=")).pop()?.slice(19).trim().replace(/^["']|["']$/g, "");
  if (dot) return dot;
  return tryRead(".secrets/demo-login.txt").match(/password\s*[:=]\s*(\S+)/i)?.[1];
}

const H: Record<string, string> = { "content-type": "application/json" };
async function login(): Promise<boolean> {
  const email = process.env.DEMO_USER_EMAIL?.trim() || "demo@dev-company.test";
  const res = await fetch(`${API}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ email, password: demoPassword() }) })
    .catch(() => null);
  if (!res?.ok) return false;
  H.authorization = `Bearer ${((await res.json()) as { accessToken: string }).accessToken}`;
  return true;
}
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const send = () => fetch(`${API}${path}`, { method, headers: { ...H, ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let res = await send();
  if (res.status === 401 && await login()) res = await send();
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

type Item = { id: string; status: MigrationStatus; sourceEnvId?: string; targetEnvId?: string };
async function list(): Promise<Item[]> {
  const r = await call("GET", "/migrations");
  if (r.status !== 200) throw new Error(`GET /migrations ${r.status}`);
  return (r.json.items as Item[]).filter((m) => !TERMINAL.includes(m.status) && (ONLY.length === 0 || ONLY.includes(m.id)));
}
async function detail(id: string): Promise<{ status: MigrationStatus; pausedFrom?: string | null; failureCode?: string | null }> {
  const r = await call("GET", `/migrations/${id}`);
  return r.json as { status: MigrationStatus; pausedFrom?: string | null; failureCode?: string | null };
}
async function waitOut(id: string, from: MigrationStatus): Promise<MigrationStatus> {
  const t0 = Date.now();
  let s = from;
  while (Date.now() - t0 < WAIT_SEC * 1000) {
    s = (await detail(id)).status;
    if (s !== from) return s;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return s;
}

async function main(): Promise<number> {
  const health = await fetch(`${API.replace(/\/api\/v1$/, "")}/healthz`).catch(() => null);
  if (!health?.ok) { console.log(`FAIL api ${API} 에 못 닿음 → api·worker 를 띄운 뒤 다시 (npm run dev:api · npm run dev:worker)`); return 2; }
  if (!await login()) { console.log("FAIL 로그인 실패 (npm run auth:seed 로 데모 계정 비밀번호를 넣었는지)"); return 2; }
  const items = await list();
  if (items.length === 0) { console.log("OK   안 끝난 이전 없음 (환경 잠금 없음)"); return 0; }
  for (const it of items) {
    const d = await detail(it.id);
    let s = d.status;
    let act = actionFor(s, d.pausedFrom);
    console.log(`이전 ${it.id} ${s}${d.pausedFrom ? `(from ${d.pausedFrom})` : ""}${d.failureCode ? ` ${d.failureCode}` : ""} → ${act}`);
    if (DRY) continue;
    if (act === "rollback") {
      const r = await call("POST", `/migrations/${it.id}/rollback`, { reason: REASON });
      if (r.status !== 202) { console.log(`  rollback 거부 ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); continue; }
      act = "wait"; s = "rolling_back";
    }
    if (act === "wait") {
      s = await waitOut(it.id, "rolling_back");
      console.log(`  롤백 결과 ${s}`);
      if (s === "failed") act = "cancel_confirmed";
    }
    if (act === "cancel" || act === "cancel_confirmed") {
      const r = await call("POST", `/migrations/${it.id}/cancel`,
        act === "cancel_confirmed" ? { reason: REASON, manualCleanupConfirmed: true } : { reason: REASON });
      console.log(r.status === 200 ? "  cancelled" : `  cancel 거부 ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    }
  }
  if (DRY) return 1;
  const left = await list();
  for (const m of left) console.log(`남음 ${m.id} ${m.status} (사람이 화면에서 확인)`);
  console.log(left.length === 0 ? "OK   안 끝난 이전 없음 → 환경 잠금 풀림" : `FAIL 안 끝난 이전 ${left.length}개 남음`);
  return left.length === 0 ? 0 : 1;
}

export const DEMO_TENANT = "11111111-1111-4111-8111-111111111111";
// smoke(SMOKE_SOURCE/TARGET 기본)·실세션(MI_TARGET_ENV 기본)이 쓰는 시드 환경
export const SEED_TARGETS = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "55555555-5555-4555-8555-555555555555"];
type Q = (sql: string, args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
// 읽기만. 회사 번호는 매개변수로. 줄 모양은 up-preflight 와 같음
export async function checkDb(q: Q, tenant = DEMO_TENANT): Promise<string[]> {
  const out: string[] = [];
  const open = (await q(`SELECT id, status, paused_from FROM migrations WHERE tenant_id = $1 AND status <> ALL($2::text[]) ORDER BY updated_at`,
    [tenant, TERMINAL])).rows;
  const locks = (await q(`SELECT env_id, migration_id, holder, (lease_expires_at < now()) AS expired FROM env_locks WHERE tenant_id = $1`, [tenant])).rows;
  const envs = (await q(`SELECT id::text FROM environments WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenant, SEED_TARGETS])).rows.map((r) => r.id);
  out.push(open.length === 0 ? "OK   db-open-migrations 데모 회사에 안 끝난 이전 없음"
    : `FAIL db-open-migrations 안 끝난 이전 ${open.length}개: ${open.slice(0, 5).map((r) => `${String(r.id).slice(0, 8)} ${r.status}${r.paused_from ? `(from ${r.paused_from})` : ""}`).join(", ")} → api·worker 띄우고 npx tsx tools/close-stuck.ts`);
  out.push(locks.length === 0 ? "OK   db-env-locks 환경 잠금 없음"
    : `FAIL db-env-locks 환경 잠금 ${locks.length}개: ${locks.slice(0, 5).map((r) => `env ${String(r.env_id).slice(0, 8)} ← ${String(r.migration_id).slice(0, 8)} ${r.holder}${r.expired ? " 기한 지남" : ""}`).join(", ")} → 승인이 409 ENV_BUSY. close-stuck 으로 이전을 닫으면 풀림`);
  const miss = SEED_TARGETS.filter((id) => !envs.includes(id));
  out.push(miss.length === 0 ? "OK   db-seed-envs smoke·실세션 기본 대상 환경 3개 있음"
    : `FAIL db-seed-envs 시드 환경 없음: ${miss.map((x) => x.slice(0, 8)).join(" ")} → bash tools/demo-reset.sh`);
  return out;
}

async function mainCheckDb(): Promise<number> {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL || "postgres://platform_owner:owner_pw@localhost:5432/platform",
    connectionTimeoutMillis: 5000 });
  try { await c.connect(); } catch { console.log("FAIL db-reach 플랫폼 DB 에 못 닿음 (docker compose up -d --wait db)"); return 1; }
  try {
    const lines = await checkDb((sql, args) => c.query(sql, args));
    for (const l of lines) console.log(l);
    return lines.some((l) => l.startsWith("FAIL")) ? 1 : 0;
  } finally { await c.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(process.argv.includes("--check-db") ? await mainCheckDb() : await main());

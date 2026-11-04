// 끝에서 끝까지 한 번: 이전 만들기 → 가져오기 → 계획 → (사람 승인 1번) → 시작 → completed
// 상태가 바뀔 때마다 한 줄씩 찍는다
import { readFileSync } from "node:fs";
import { smokeConfirmReview, smokeEnvs, smokePlanBodies } from "./smoke-env.js";

const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
// Z77 (Z62 주제 66): 실클라우드 회차는 SMOKE_TENANT_ID=66666666…(0018) 로 로컬 회차와 다른 회사·환경을 쓴다 (환경 잠금이 안 겹침)
const T0 = Date.now();
const LIMIT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60000);

// AUTHSMOKE: 인증. 데모 계정 비밀번호가 있으면 진짜 로그인(Bearer), 없으면 개발용 x-dev-tenant(API 가 DEV_AUTH=1 일 때만 통함).
//   근거: apps/api/src/auth/settings.ts 의 팀 결정(x-dev-tenant 는 시험 전용) → 실회차(demo-day API, DEV_AUTH 없음)는 로그인으로 간다. 찾는 순서는 env:connect·auth:seed 와 같다
//   (환경변수 → .env 의 DEMO_USER_PASSWORD → auth:seed 가 쓴 .secrets/demo-login.txt). 데모 계정은 개발 회사(11111111…)
function demoPassword(env: NodeJS.ProcessEnv = process.env, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  const fromEnv = env.DEMO_USER_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  const tryRead = (p: string) => { try { return read(p); } catch { return ""; } };
  const dot = tryRead(".env").split("\n").filter((l) => l.startsWith("DEMO_USER_PASSWORD=")).pop()?.slice(19).trim().replace(/^["']|["']$/g, "");
  if (dot) return dot;
  return tryRead(".secrets/demo-login.txt").match(/password\s*[:=]\s*(\S+)/i)?.[1];
}
const H: Record<string, string> = { "content-type": "application/json" };
const PASSWORD = demoPassword();
async function login(): Promise<boolean> {
  const email = process.env.DEMO_USER_EMAIL?.trim() || "demo@dev-company.test";
  const res = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }) });
  if (!res.ok) { console.log("로그인 실패", res.status, "(npm run auth:seed 로 데모 계정 비밀번호를 넣었는지)"); return false; }
  H.authorization = `Bearer ${((await res.json()) as { accessToken: string }).accessToken}`;
  return true;
}
const useDevHeader = () => { H["x-dev-tenant"] = process.env.SMOKE_TENANT_ID?.trim() || "11111111-1111-4111-8111-111111111111"; console.log("auth=x-dev-tenant (API DEV_AUTH=1 필요)"); };
// 로그인이 안 되면(로컬 시험에서 auth:seed 안 함) 예전 헤더로 — DEV_AUTH 없는 API 면 첫 요청이 401 로 멈춘다
const LOGGED_IN = PASSWORD ? await login() : false;
if (!LOGGED_IN) useDevHeader();
else {
  console.log("auth=login (demo user)");
  const t = process.env.SMOKE_TENANT_ID?.trim();
  if (t && t !== "11111111-1111-4111-8111-111111111111") console.log(`주의: SMOKE_TENANT_ID=${t} 는 로그인 회사(개발 회사)와 다르다 → 환경이 안 보이면 404`);
}

async function call(method: string, path: string, body?: unknown) {
  const send = () => fetch(`${API}${path}`, { method, headers: H,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  let res = await send();
  // 접근 토큰은 15분(AUTH_ACCESS_TTL_SEC). 실회차 smoke 는 20분까지 돌므로 401 이면 한 번 다시 로그인
  if (res.status === 401 && LOGGED_IN && await login()) res = await send();
  const json = await res.json() as Record<string, unknown>;
  if (res.status >= 400) { console.log(method, path, res.status, json); process.exit(1); }
  return json;
}

let last = "";
async function waitFor(target: string) {
  for (;;) {
    const m = await call("GET", `/migrations/${id}`) as { status: string };
    if (m.status !== last) { console.log(`+${String(Date.now() - T0).padStart(6)} ms  status=${m.status}`); last = m.status; }
    if (m.status === target) return;
    if (["failed", "cancelled", "rolled_back"].includes(m.status) || Date.now() - T0 > LIMIT_MS) {
      console.log("stopped at", m.status); process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const envs = smokeEnvs();
console.log(`envs source=${envs.sourceEnvId} target=${envs.targetEnvId}`);
const { id } = await call("POST", "/migrations", envs) as { id: string };
console.log("POST /migrations", id, "target", envs.targetEnvId);
await waitFor("spec_review");
// VSMOKE: 사람 확인 칸이 있으면 화면처럼 confirm (없으면 요청 0)
const reviewed = await smokeConfirmReview(call, id);
if (reviewed) console.log(`PATCH /migrations/:id/spec confirm ${reviewed}칸`);

await call("POST", `/migrations/${id}/plan`);
await waitFor("awaiting_approval");

const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string; acknowledgements?: { id: string }[] };
console.log("GET /migrations/:id/plan", plan.planId, "planHash", plan.planHash.slice(0, 12));
const bodies = smokePlanBodies(plan);
await call("POST", `/plans/${plan.planId}/approvals`, bodies.approve);
await waitFor("approved");

await call("POST", `/migrations/${id}/start`, bodies.start);
await waitFor("completed");
console.log(`completed after ${Date.now() - T0} ms`);

// smoke 변형: 깃발 켠 서버용 (E2E). PLAN_ACKS=1 이면 승인 본문에 acks, 시작 본문에 planHash 를 보낸다
// 거부 경로도 한 번씩 본다: acks 빠진 승인 → 409, planHash 빠진 시작 → 409 (깃발 PLAN_ACKS=1 일 때만)
// DRAFT(ai): E2E 묶음용 개발 스크립트. 실클라우드 호출 없음 (MOCK_* 서버 기준)
import { smokeEnvs } from "./smoke-env.js";

const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
const H = { "content-type": "application/json", "x-dev-tenant": process.env.SMOKE_TENANT_ID?.trim() || "11111111-1111-4111-8111-111111111111" };
const T0 = Date.now();
const LIMIT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60000);
const ACKS = process.env.PLAN_ACKS?.trim() === "1";

async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: H,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}
async function call(method: string, path: string, body?: unknown) {
  const r = await raw(method, path, body);
  if (r.status >= 400) { console.log(method, path, r.status, r.json); process.exit(1); }
  return r.json;
}
async function expectStatus(want: number, method: string, path: string, body?: unknown) {
  const r = await raw(method, path, body);
  console.log(`  거부 확인 ${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} → ${r.status} ${r.json.code ?? ""}`);
  if (r.status !== want) { console.log("기대", want, r.json); process.exit(1); }
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
const { id } = await call("POST", "/migrations", envs) as { id: string };
console.log("POST /migrations", id);
await waitFor("spec_review");
await call("POST", `/migrations/${id}/plan`);
await waitFor("awaiting_approval");

const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string; acknowledgements?: { id: string }[] };
const acks = (plan.acknowledgements ?? []).map((a) => a.id);
console.log("확인 항목", acks.length, acks.slice(0, 5).join(","));
if (ACKS && acks.length) await expectStatus(409, "POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash });
await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash, ...(ACKS ? { acks } : {}) });
await waitFor("approved");
if (ACKS) await expectStatus(409, "POST", `/migrations/${id}/start`, {});
await call("POST", `/migrations/${id}/start`, ACKS ? { planHash: plan.planHash } : {});
await waitFor("completed");
console.log(`completed after ${Date.now() - T0} ms`);

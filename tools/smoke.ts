// 끝에서 끝까지 한 번: 이전 만들기 → 가져오기 → 계획 → (사람 승인 1번) → 시작 → completed
// 상태가 바뀔 때마다 한 줄씩 찍는다
import { smokeEnvs, smokePlanBodies } from "./smoke-env.js";

const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
// Z77 (Z62 주제 66): 실클라우드 회차는 SMOKE_TENANT_ID=66666666…(0018) 로 로컬 회차와 다른 회사·환경을 쓴다 (환경 잠금이 안 겹침)
const H = { "content-type": "application/json", "x-dev-tenant": process.env.SMOKE_TENANT_ID?.trim() || "11111111-1111-4111-8111-111111111111" };
const T0 = Date.now();
const LIMIT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60000);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: H,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
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

await call("POST", `/migrations/${id}/plan`);
await waitFor("awaiting_approval");

const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string; acknowledgements?: { id: string }[] };
console.log("GET /migrations/:id/plan", plan.planId, "planHash", plan.planHash.slice(0, 12));
// MACDRY: 화면이 하듯 확인 항목을 전부 체크하고(acks), 시작 때 본 지문을 다시 보낸다 → PLAN_ACKS=1 깃발 on 에서도 끝까지 간다.
//   깃발 off 면 둘 다 선택 칸이라 지금과 같은 결과
await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash,
  ...(plan.acknowledgements?.length ? { acks: plan.acknowledgements.map((a) => a.id) } : {}) });
await waitFor("approved");

await call("POST", `/migrations/${id}/start`, { planHash: plan.planHash });
const bodies = smokePlanBodies(plan);
await call("POST", `/plans/${plan.planId}/approvals`, bodies.approve);
await waitFor("approved");

await call("POST", `/migrations/${id}/start`, bodies.start);
await waitFor("completed");
console.log(`completed after ${Date.now() - T0} ms`);

// 작업 Z65: 장애 점검(remediate) 시작 API 를 부르고 결과가 나올 때까지 기다리는 얇은 껍데기 (데모 준비·검증용)
//   POST /api/v1/migrations/:id/agent-review/run  →  GET /api/v1/migrations/:id/agent-review (runId 가 같고 끝날 때까지)
// 쓰는 법: npx tsx --env-file=.env tools/agent-remediate.ts <이전번호> ["점검 요청 문장"]
//   DEV_TENANT 로 회사를 바꾼다 (기본 dev 회사). AGENT_WAIT_SEC 로 기다릴 시간 (기본 30초, 0 이면 시작만)
//   API 는 먼저 떠 있어야 한다 (npm run dev -w @svc/api). DB 에 직접 붙지 않는다
import { randomUUID } from "node:crypto";

const [migrationId, task] = process.argv.slice(2);
if (!migrationId) { console.error("쓰는 법: tools/agent-remediate.ts <이전번호> [점검 요청 문장]"); process.exit(2); }
const API = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
const H = { "content-type": "application/json", "x-dev-tenant": process.env.DEV_TENANT ?? "11111111-1111-4111-8111-111111111111" };
const waitSec = Number(process.env.AGENT_WAIT_SEC ?? 30);

const t0 = Date.now();
const res = await fetch(`${API}/migrations/${migrationId}/agent-review/run`, {
  method: "POST", headers: { ...H, "idempotency-key": `agent-remediate-${randomUUID()}` },
  body: JSON.stringify(task ? { task } : {}),
});
const started = await res.json() as { runId?: string; code?: string; message?: string };
console.log(JSON.stringify({ http: res.status, ...started }));
if (res.status !== 202 || !started.runId) process.exit(1);

let status = "queued";
while (waitSec > 0 && Date.now() - t0 < waitSec * 1000) {
  const v = await (await fetch(`${API}/migrations/${migrationId}/agent-review`, { headers: H })).json() as
    { remediate?: { runId: string | null; status: string; outcome: string | null; title: string } | null };
  const rm = v.remediate;
  if (rm?.runId === started.runId) {
    status = rm.status;
    if (status === "finished" || status === "failed") {
      console.log(JSON.stringify({ runId: rm.runId, status, outcome: rm.outcome, title: rm.title, waited_ms: Date.now() - t0 }));
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (status !== "finished" && status !== "failed") console.log(JSON.stringify({ runId: started.runId, status, waited_ms: Date.now() - t0 }));
process.exit(status === "failed" ? 1 : 0);

import { AgentReport } from "@svc/contracts";
import { AGENT_HEADERS, AGENT_REPORTS_PATH, signReport } from "@svc/contracts/agent-sig";

// Z92: 온프레 Agent 의 보내기 쪽. k3s 안(또는 k3d 옆 맥)에서 플랫폼 API 로 서명한 보고를 POST 한다.
// 헤더 이름·경로는 contracts agent-sig.ts 한 곳 (받는 쪽 apps/api/src/routes/agent-reports.ts 와 같이 쓴다)

export interface SendOptions {
  baseUrl: string;            // 예: http://localhost:3000 (끝 / 없이)
  keyId: string;
  secret: string;             // tools/agent-key.ts 가 만든 키 비밀 (.env 의 AGENT_KEY_SECRET)
  fetch?: typeof fetch;       // 시험에서 바꿔 끼운다
  now?: () => Date;
  timeoutMs?: number;         // 기본 10초
}
export interface SendResult { ok: boolean; status: number; body: unknown }

// 보내기 전에 모양을 확인한다 (받는 쪽 400 을 먼저 여기서 잡는다). 서명은 보낸 글자 그대로에 건다
export async function sendAgentReport(report: AgentReport, o: SendOptions): Promise<SendResult> {
  const parsed = AgentReport.parse(report);
  const body = JSON.stringify(parsed);
  const ts = Math.floor((o.now?.() ?? new Date()).getTime() / 1000);
  const f = o.fetch ?? fetch;
  const res = await f(o.baseUrl.replace(/\/+$/, "") + AGENT_REPORTS_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [AGENT_HEADERS.keyId]: o.keyId,
      [AGENT_HEADERS.timestamp]: String(ts),
      [AGENT_HEADERS.signature]: signReport(o.secret, ts, body),
    },
    body,
    signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* 본문이 JSON 이 아니면 글자 그대로 */ }
  return { ok: res.ok, status: res.status, body: json };
}

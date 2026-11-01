import { createHmac, timingSafeEqual } from "node:crypto";
import { AgentReport } from "./agent.js";

// Z92: 온프레 Agent 보고 서명·검증 (예전 packages/agent/src/onprem/report.ts). api(받기)와 agent(보내기)가 같이 쓴다.
// node:crypto 를 쓰므로 index 에 넣지 않고 하위 경로 "@svc/contracts/agent-sig" 로만 내보낸다 (화면 번들에 안 들어가게).
// api 가 @svc/agent(AI SDK 포함)에 기대지 않게 여기 둔다 → package-lock 변경 없음

export const AGENT_HEADERS = { keyId: "x-agent-key-id", signature: "x-agent-signature", timestamp: "x-agent-timestamp" } as const;
export const AGENT_REPORTS_PATH = "/api/v1/agent/reports";

export interface AgentKey { tenantId: string; envId: string; secret: string; revoked?: boolean }
export interface AgentKeyRegistry { lookup(keyId: string): Promise<AgentKey | null> }

export class AgentReportRejected extends Error {
  constructor(readonly status: 400 | 401, readonly code: string, message: string) { super(message); }
}

// DRAFT(ai): 서명 = HMAC-SHA256(secret, "<timestamp>.<본문>"), 시계 차이 허용 5분. 재전송 막기용
export const MAX_SKEW_SEC = 300;
export const signReport = (secret: string, timestamp: number, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

export interface AgentHeaders { keyId?: string; signature?: string; timestamp?: string }

// 받은 보고 검사. 키 확인 → 서명 확인 → 시각 확인 → 모양 확인. 통과하면 회사·환경을 키에서 붙여 돌려준다
export async function acceptAgentReport(
  h: AgentHeaders, rawBody: string, keys: AgentKeyRegistry, now: Date,
): Promise<{ tenantId: string; envId: string; report: AgentReport }> {
  if (!h.keyId || !h.signature || !h.timestamp) throw new AgentReportRejected(401, "AGENT_AUTH_MISSING", "Agent 키·서명·시각 헤더가 필요하다");
  const key = await keys.lookup(h.keyId);
  if (!key || key.revoked) throw new AgentReportRejected(401, "AGENT_KEY_UNKNOWN", "모르는 Agent 키");
  const ts = Number(h.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now.getTime() / 1000 - ts) > MAX_SKEW_SEC)
    throw new AgentReportRejected(401, "AGENT_TS_SKEW", "보고 시각이 5분 넘게 어긋남");
  // Z38b 리뷰: Buffer.from(x,"hex") 는 대문자·뒤 쓰레기·홀수 길이를 조용히 받아 들인다 → 같은 서명의 다른 글자로
  //   (key_id, signature) 재전송 색인을 비켜 갈 수 있었다. 소문자 hex 64자만 받는다 (= signReport 출력 모양 하나)
  if (!/^[0-9a-f]{64}$/.test(h.signature)) throw new AgentReportRejected(401, "AGENT_BAD_SIGNATURE", "서명 모양이 틀림 (소문자 hex 64자)");
  const want = Buffer.from(signReport(key.secret, ts, rawBody), "hex");
  const got = Buffer.from(h.signature, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got))
    throw new AgentReportRejected(401, "AGENT_BAD_SIGNATURE", "서명이 맞지 않음");
  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { throw new AgentReportRejected(400, "AGENT_BAD_JSON", "본문이 JSON이 아님"); }
  const r = AgentReport.safeParse(json);
  if (!r.success) throw new AgentReportRejected(400, "AGENT_BAD_SHAPE", r.error.issues[0]?.message ?? "모양 오류");
  return { tenantId: key.tenantId, envId: key.envId, report: r.data };
}

// Z92: 키 비밀은 DB 에 두지 않는다. 서버는 .env 의 AGENT_REPORT_MASTER_KEY 하나로 키 번호마다 비밀을 다시 만든다.
//   키 비밀 = HMAC-SHA256(마스터, "agent-key:<키 번호>") hex. DB(agent_keys)에는 키 번호·회사·환경·폐기만 있다
// 【사실】 HMAC 을 키 유도 함수로 쓰는 방식 = RFC 5869 HKDF 의 Extract/Expand 바탕 (여기서는 한 단계만, 출력 32바이트)
export const MIN_MASTER_KEY_LEN = 32;
export function deriveAgentSecret(masterKey: string, keyId: string): string {
  if (masterKey.length < MIN_MASTER_KEY_LEN) throw new Error(`AGENT_REPORT_MASTER_KEY 는 ${MIN_MASTER_KEY_LEN}자 이상`);
  return createHmac("sha256", masterKey).update(`agent-key:${keyId}`).digest("hex");
}

// 시험·도구용 메모리 키 목록 (서버는 apps/api/src/routes/agent-reports.ts 의 DB 키 목록을 쓴다)
export function memoryKeyRegistry(entries: Record<string, AgentKey>): AgentKeyRegistry {
  return { lookup: async (id) => entries[id] ?? null };
}

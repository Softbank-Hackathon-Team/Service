import type { FastifyReply, FastifyRequest } from "fastify";
import { authSettings, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from "./settings.js";

// 쿠키 읽기·쓰기 (routes/auth.ts 에서 옮김. GitHub 콜백도 같은 리프레시 쿠키를 쓴다)
export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}
export function isHttps(req: FastifyRequest) {
  return authSettings().cookieSecure || req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}
// set-cookie 는 여러 번 부르면 Fastify 가 이어 붙인다 (덮어쓰지 않음)
export function setRefreshCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAgeSec: number) {
  const attrs = [`${REFRESH_COOKIE}=${encodeURIComponent(value)}`, `Path=${REFRESH_COOKIE_PATH}`, "HttpOnly", "SameSite=Strict", `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`];
  // DRAFT(ai) Z93: 데모는 http(localhost·터널 뒤)라 Secure 를 늘 켜면 쿠키가 안 저장된다 → https 로 들어왔을 때만
  if (isHttps(req)) attrs.push("Secure");
  reply.header("set-cookie", attrs.join("; "));
}
export const clearRefreshCookie = (req: FastifyRequest, reply: FastifyReply) => setRefreshCookie(req, reply, "", 0);

// 로그인 점검(입력층): 로그인 실패 제한의 "접속 IP". API 앞에 Cloudflare 터널·nginx 가 있으면 req.ip 는 늘 그 프록시 주소라
//   IP 하나 15분 50번 칸을 모든 사용자가 같이 쓴다 → 아무나 50번 틀리면 모두의 로그인이 15분 막힌다(데모 화면 잠김).
// AUTH_CLIENT_IP_HEADER(예: cf-connecting-ip) 를 켜면 그 헤더의 IP 를 쓴다. 헤더는 앞단 프록시가 덮어써 줄 때만 믿을 수 있으므로
//   API 가 프록시 없이 바로 열려 있으면 켜지 말 것 (아무나 헤더로 IP 를 바꿔 제한을 피함)
// DRAFT(ai): 기본은 꺼짐(예전과 같음). 값이 IP 모양이 아니거나 여러 개(쉼표)면 req.ip
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})$/i;
export function clientIp(req: FastifyRequest, env: NodeJS.ProcessEnv = process.env): string {
  const h = env.AUTH_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (!h) return req.ip;
  const v = req.headers[h];
  return typeof v === "string" && IP_RE.test(v.trim()) ? v.trim() : req.ip;
}

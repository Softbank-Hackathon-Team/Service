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

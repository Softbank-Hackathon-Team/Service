import type { ApiError } from "./types";

// 화면의 HTTP 요청은 전부 여기 한 곳을 지난다 (작업 Z46).
//   - 로그인 토큰(Authorization: Bearer)
//   - POST·PATCH 마다 Idempotency-Key 하나 (버튼 한 번 = 키 하나. 서버 req.idempotent 는 메서드를 안 가린다)
//   - 응답 본문 읽기 + 오류를 HttpError 하나로
//   - GET 만 짧게 다시 시도 (아래 RETRY)
// Vite(import.meta.env)를 안 쓰는 순수 모듈이라 node:test 로 바로 시험한다 (test/http.test.ts)

export class HttpError extends Error {
  constructor(public status: number, public body: Partial<ApiError> | null) {
    super(body?.code ? `${body.code}: ${body.message ?? ""}` : `HTTP ${status}`);
  }
}

// DRAFT(ai): 다시 시도 규칙. GET 만, 네트워크 오류(TypeError)나 게이트웨이 오류(502·503·504)일 때 한 번 더.
//   POST 는 다시 보내지 않는다 (서버가 같은 키를 첫 결과로 돌려주긴 하지만, 사람이 결과를 보고 다시 누르는 쪽이 안전).
//   예외 하나: 409 RETRY 는 같은 키로 한 번 더 (아래 W-2)
//   4xx·500 은 다시 해도 같으니 바로 오류. 폴링(0.7초)보다 짧게 쉬어서 화면 새로고침 간격이 밀리지 않게 한다
//   끄려면 getAttempts: 1
export const RETRY = { getAttempts: 2, delayMs: 200, statuses: [502, 503, 504] as readonly number[] };
export type RetryPolicy = typeof RETRY;

export interface ClientOptions {
  base: string;                 // 예: "/api"
  fetch?: typeof fetch;         // 시험용
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  newKey?: () => string;        // 시험용 Idempotency-Key 생성기
  // 로그인 토큰. 회사는 토큰이 정한다
  token?: () => Promise<string | null>;
  // Z96: 401 을 맞으면 한 번 부른다(refresh). true 면 같은 요청(같은 멱등 키)을 한 번 더 보낸다
  //   code = 서버 오류 코드 (USER_DISABLED 면 refresh 하지 않고 바로 로그인 화면으로)
  onUnauthorized?: (code?: string) => Promise<boolean>;
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

// Z38 REVIEW-4 W-4: crypto.randomUUID 는 보안 문맥(https·localhost)에서만 있다.
//   심사 기기가 http://<맥 IP>:5173 로 붙으면 없어서 모든 POST(승인·롤백 포함)가 TypeError 로 죽는다.
//   getRandomValues 는 보안 문맥이 아니어도 있으므로 그걸로 UUIDv4 를 만든다 (RFC 9562 4·5.4절 비트)
export function newIdempotencyKey(c: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createClient(o: ClientOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const retry = o.retry ?? RETRY;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newKey = o.newKey ?? (() => newIdempotencyKey());

  async function once<T>(method: Method, path: string, body: unknown, key: string | null): Promise<T> {
    const bearer = o.token ? await o.token() : null;
    const headers: Record<string, string> = bearer ? { authorization: `Bearer ${bearer}` } : {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers["idempotency-key"] = key;
    const res = await doFetch(`${o.base}${path}`, {
      method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* JSON 아님 */ }
    if (!res.ok) throw new HttpError(res.status, json as Partial<ApiError> | null);
    return json as T;
  }

  const retryable = (e: unknown) =>
    e instanceof TypeError || (e instanceof HttpError && retry.statuses.includes(e.status));
  // Z38 REVIEW-4 W-2: 서버가 409 RETRY(교착·직렬화 실패, Z38-7)를 주면 POST 도 "같은 키로" 한 번 더 보낸다.
  //   같은 키라 서버가 두 번 처리하지 않는다(멱등 키). 예전엔 이 경우 사람에게 오류만 보였다
  const retryablePost = (e: unknown) => e instanceof HttpError && e.status === 409 && e.body?.code === "RETRY";

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const key = method === "GET" ? null : newKey();
    const attempts = Math.max(1, retry.getAttempts);
    let reauthed = false;
    for (let i = 1; ; i++) {
      try { return await once<T>(method, path, body, key); }
      catch (e) {
        // Z96: 401 → refresh 한 번 → 같은 요청 한 번 더. 두 번째 401 이면 그대로 던진다(화면은 로그인으로)
        if (e instanceof HttpError && e.status === 401 && o.onUnauthorized && !reauthed) {
          reauthed = true; i--;
          if (await o.onUnauthorized(e.body?.code ?? undefined)) continue;
          throw e;
        }
        const again = method === "GET" ? retryable(e) : retryablePost(e);
        if (i >= attempts || !again) throw e;
        await sleep(method === "GET" ? retry.delayMs : Math.max(retry.delayMs, 1000)); // retry-after: 1
      }
    }
  }

  // Z96: fetch 를 직접 써야 하는 곳(리포트 HTML)용 머리말
  async function headersFor(): Promise<Record<string, string>> {
    const bearer = o.token ? await o.token() : null;
    return bearer ? { authorization: `Bearer ${bearer}` } : {};
  }

  return {
    headers: headersFor,
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
    // 명세 고치기(PATCH /migrations/:id/spec). 다시 보내기 규칙은 POST 와 같다 (409 RETRY 만 같은 키로 한 번 더)
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
    // 해제처럼 지우는 요청 (DELETE). 다시 보내기 규칙은 POST 와 같다
    del: <T>(path: string) => request<T>("DELETE", path),
  };
}

// 404 를 "아직 없음"(null)으로 바꾼다. 다른 오류는 그대로 던진다.
// 서버에 경로가 아직 없을 수 있는 칸(계획서·비용·보안 표)에서 쓴다
export async function or404<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; }
  catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; }
}

export const is404 = (e: unknown) => e instanceof HttpError && e.status === 404;
// Z83: "API 자체에 못 닿음"(네트워크 오류·게이트웨이 502/503/504). 맨 위 띠 하나가 말하므로 보조 카드는 빨간 상자를 반복하지 않는다
export const isApiDown = (e: unknown) => e instanceof TypeError || (e instanceof HttpError && RETRY.statuses.includes(e.status));

// 목록 응답이 배열이든 { items } 든 배열로
export function unwrap<T>(r: T[] | { items: T[] }): T[] {
  return Array.isArray(r) ? r : r.items;
}

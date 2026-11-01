// 제공자 HTTP 호출 공통. fetch 는 주입한다 (시험에서 네트워크 없이 요청 모양을 본다)
// Z14: signal(시간 제한) 추가, 응답 헤더 retry-after 를 읽을 수 있게 headers 를 선택으로 받는다
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal })
  => Promise<{ status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }>;
// 토큰은 부를 때마다 받아 온다 (임시 토큰이 만료되면 보안 패키지가 새로 발급). 값을 들고 있지 않는다
export type TokenSource = () => Promise<string>;

// DRAFT(ai): 요청 하나 10초. 넘기면 끊고 ProviderError(status 0, 재시도 가능)로 올린다
// 이유: 시간 제한이 없으면 제공자가 응답을 안 줄 때 shift·rollback 작업이 영원히 멈춘다 (Z14-03)
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export class HttpTimeout extends Error {
  readonly code = "HTTP_TIMEOUT";
}

export async function jsonRequest(f: FetchLike | undefined, method: string, url: string, token: string, body?: unknown,
  o: { timeoutMs?: number } = {}) {
  const doFetch = f ?? (globalThis.fetch as unknown as FetchLike);
  const ms = o.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await doFetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctl.signal,
    });
    // 본문 읽기도 시간 제한 안에서 (헤더만 오고 본문이 안 오는 경우)
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    if (ctl.signal.aborted) throw new HttpTimeout(`${method} ${redactUrl(url)} ${ms}ms 안에 본문 없음`);
    return { status: res.status, body: parsed, retryAfter: res.headers?.get("retry-after") ?? null };
  } catch (e) {
    if (e instanceof HttpTimeout) throw e;
    if (ctl.signal.aborted) throw new HttpTimeout(`${method} ${redactUrl(url)} ${ms}ms 안에 응답 없음`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 오류 메시지에 경로의 ID(zone·계정)를 그대로 남기지 않는다. 32자리 hex 는 앞 4자리만
export const redactUrl = (u: string) => u.replace(/[0-9a-f]{32}/gi, (m) => `${m.slice(0, 4)}…`);

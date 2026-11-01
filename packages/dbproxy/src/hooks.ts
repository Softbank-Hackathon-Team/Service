// Z31 DRAFT(ai): 워커 쪽 훅. @svc/replication 의 TrafficHooks(pause/resume) 모양을 그대로 맞춘다 (의존성은 안 건다).
// 붙잡기 프록시가 여러 개일 수 있다 (클러스터마다 하나: 출발 쪽 앱, 도착 쪽 앱). 전부 붙잡고 전부 푼다.
//   pause  : 하나라도 실패하면 이미 붙잡은 것을 지금 대상 그대로 풀고 예외 → C2 펜스 전에 멈추므로 아무것도 안 바뀐다
//   resume : 대상마다 재시도 (기본 3번, 100/300/900ms). 끝내 실패해도 예외를 던지지 않는다.
//            C6 은 DB 쪽이 이미 바뀐 뒤라 여기서 던지면 "반쯤 컷오버"(C5 뒤 예외)가 된다.
//            대신 report().resumeFailed 를 남기고, 프록시는 holdMax 뒤 스스로 풀며, GitOps 값(activeWriter)이 재시작 뒤 대상을 고정한다
export interface WriterRef { label: string; adminUrl: string }
export interface AppLinkConfig {
  /** 프록시 제어 주소들. 예: http://localhost:6480 */
  urls: string[];
  token?: string;
  /** 한 번 부를 때 제한 시간 */
  timeoutMs: number;
  /** resume 재시도 횟수 (첫 시도 제외) */
  retries: number;
  drainTimeoutMs?: number;
}
export interface AppLinkReport {
  urls: number;
  pause: { ok: boolean; ms: number; closedIdle: number; drainedBusy: number; leftBusy: number } | null;
  resume: { upstream: string; ok: boolean; ms: number; released: number; maxWaitMs: number; attempts: number } | null;
  resumeFailed: boolean;
  errors: string[];
}
export interface HoldHooks {
  pause(): Promise<void>;
  resume(writer: WriterRef): Promise<void>;
  report(): AppLinkReport;
}

/** APP_LINK_URLS 가 없으면 null → 훅 없음(지금까지와 같음: 앱은 그대로, 펜스 뒤 쓰기 실패) */
export function appLinkFromEnv(env: NodeJS.ProcessEnv = process.env): AppLinkConfig | null {
  const urls = (env.APP_LINK_URLS ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!urls.length) return null;
  return {
    urls,
    token: env.APP_LINK_TOKEN || undefined,
    timeoutMs: Number(env.APP_LINK_TIMEOUT_MS ?? 3000),
    retries: Number(env.APP_LINK_RETRIES ?? 3),
    drainTimeoutMs: env.APP_LINK_DRAIN_MS ? Number(env.APP_LINK_DRAIN_MS) : undefined,
  };
}

type FetchLike = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** nameOf: 쓰기 대상(Endpoint) → 프록시의 upstream 이름 ("source" | "target") */
export function holdHooks(cfg: AppLinkConfig, nameOf: (w: WriterRef) => string, f: FetchLike = fetch): HoldHooks {
  const rep: AppLinkReport = { urls: cfg.urls.length, pause: null, resume: null, resumeFailed: false, errors: [] };
  const headers: Record<string, string> = { "content-type": "application/json", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) };
  // 지금 대상 이름 (pause 실패 시 그대로 풀어 줄 때 쓴다). 첫 status 에서 알아낸다
  let activeBefore: string | null = null;

  async function call(url: string, path: string, body?: object) {
    const r = await f(`${url}${path}`, {
      method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${path} ${r.status} ${String(j.error ?? "")}`.trim());
    return j;
  }

  return {
    async pause() {
      const t0 = performance.now();
      try { activeBefore = String((await call(cfg.urls[0]!, "/status")).active ?? "source"); }
      catch (e) { rep.errors.push(`status: ${(e as Error).message}`); rep.pause = { ok: false, ms: round(performance.now() - t0), closedIdle: 0, drainedBusy: 0, leftBusy: 0 };
                  throw new Error(`APP_LINK_PAUSE_FAILED: status ${(e as Error).message}`); }
      const rs = await Promise.allSettled(cfg.urls.map((u) => call(u, "/pause", cfg.drainTimeoutMs ? { drainTimeoutMs: cfg.drainTimeoutMs } : {})));
      const bad = rs.flatMap((r, k) => (r.status === "rejected" ? [`pause ${k}: ${(r.reason as Error).message}`] : []));
      const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const sum = (k: string) => ok.reduce((a, v) => a + Number(v[k] ?? 0), 0);
      rep.pause = { ok: bad.length === 0, ms: round(performance.now() - t0), closedIdle: sum("closedIdle"), drainedBusy: sum("drainedBusy"), leftBusy: sum("leftBusy") };
      if (bad.length) {
        rep.errors.push(...bad);
        // 붙잡은 쪽만 그대로 풀어 준다 (대상 안 바뀜)
        await Promise.allSettled(cfg.urls.map((u, k) => (rs[k]!.status === "fulfilled" ? call(u, "/resume", { upstream: activeBefore }) : Promise.resolve())));
        throw new Error(`APP_LINK_PAUSE_FAILED: ${bad.join("; ")}`);
      }
    },
    async resume(writer) {
      const t0 = performance.now();
      const upstream = nameOf(writer);
      let attempts = 0, released = 0, maxWaitMs = 0;
      const left = new Set(cfg.urls);
      const delays = [100, 300, 900, 2700];
      for (let k = 0; k <= cfg.retries && left.size; k++) {
        if (k > 0) await sleep(delays[k - 1] ?? 2700);
        attempts++;
        await Promise.all([...left].map(async (u) => {
          try {
            const j = await call(u, "/resume", { upstream });
            released += Number(j.released ?? 0); maxWaitMs = Math.max(maxWaitMs, Number(j.maxWaitMs ?? 0));
            left.delete(u);
          } catch (e) { rep.errors.push(`resume try ${k + 1}: ${(e as Error).message}`); }
        }));
      }
      rep.resumeFailed = left.size > 0;
      rep.resume = { upstream, ok: left.size === 0, ms: round(performance.now() - t0), released, maxWaitMs, attempts };
    },
    report: () => rep,
  };
}

const round = (x: number) => Math.round(x * 10) / 10;

// PF FM-ORC-13: 기다리면 풀리는 트래픽 제공자 오류 (Cloudflare 429·연결 끊김(0)·5xx, 또는 제공자가 retryable 로 표시). 이유 글자를 돌려준다
export function transientTrafficError(e: unknown): string | null {
  for (let x = e as { code?: string; status?: number; retryable?: boolean; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (x.code !== "TRAFFIC_PROVIDER_ERROR") continue;
    if (x.status === 429) return "rate_limited";
    if (x.status === 0) return "network";
    if ((x.status ?? 0) >= 500) return `http_${x.status}`;
  }
  return null;
}
// DRAFT(ai): 1·2·5·5·5·5 분 (합 23분, Cloudflare 5분 차단을 몇 번 넘김). 한 번은 반납 잠금 기한(600초)보다 짧아야 리퍼가 안 끼어든다.
//   ROLLBACK_TRANSIENT_RETRY_SEC="…" 로 바꿈, "" 이면 끔
export function rollbackTransientDelaysSec(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.ROLLBACK_TRANSIENT_RETRY_SEC ?? "60,120,300,300,300,300";
  return raw.split(",").map((x) => Number(x.trim())).filter((n) => raw.trim() !== "" && Number.isFinite(n) && n >= 0).map((n) => Math.min(n, 540));
}

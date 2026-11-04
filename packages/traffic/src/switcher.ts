// 트래픽 가중치를 바꾸는 쪽. 기본은 Cloudflare Load Balancer의 pool 가중치, 같은 클라우드 안이면 ALB·GCLB도 된다.
// 컨트롤러는 항상 "출발/도착 비율(0~1, 합 1)"로만 말한다. 제공자별 숫자 단위는 각 어댑터가 바꾼다.
export interface Weights { source: number; target: number }   // 합 1, 0.1 단위
export interface TrafficSwitcher {
  readonly provider?: TrafficProvider;
  get(lbId: string): Promise<Weights>;
  set(lbId: string, w: Weights): Promise<void>;
  // Z14: 전환 전 설정 점검. 문제 코드 목록(빈 배열 = 통과). 제공자가 없으면 생략 (mock·GCLB·ALB)
  preflight?(lbId: string): Promise<string[]>;
  // pf-d FM-TRF-13: 무게 있는 쪽이 다 죽었을 때 갈 곳(fallback). 컷오버 뒤 = 도착(출발은 울타리), 롤백 = 출발. 없으면 그 제공자는 모름(mock 은 기억만)
  setFallback?(lbId: string, side: "source" | "target"): Promise<void>;
  getFallback?(lbId: string): Promise<"source" | "target" | "other" | null>;
}

export type TrafficProvider = "cloudflare" | "aws_alb" | "gcp_gclb" | "mock";

export class InvalidWeights extends Error {
  readonly code = "INVALID_WEIGHTS";
}
// 가중치를 바꿨는데 다시 읽으니 다르다 / 제공자 API가 계속 실패한다
export class SwitchFailed extends Error {
  readonly code = "TRAFFIC_SWITCH_FAILED";
  constructor(message: string, readonly attempts: number) { super(message); }
}
// 제공자 API 응답이 실패(HTTP 4xx/5xx, success=false)
// Z14: retryable 추가. 다시 해도 같은 결과인 오류(인증 401/403, 없음 404, 본문 400, 속도 제한 429)는 바로 멈춘다
//   429 를 재시도 안 하는 이유: 【사실】 Cloudflare 는 한도(5분 1,200건)를 넘으면 "다음 5분 동안" 모든 호출을 막는다
//   (developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-429) → 0.5~2초 재시도는 소용없다
export class ProviderError extends Error {
  readonly code = "TRAFFIC_PROVIDER_ERROR";
  readonly retryable: boolean;
  readonly providerCodes: number[];   // Cloudflare errors[].code 등
  constructor(readonly provider: TrafficProvider, readonly status: number, message: string,
    o: { retryable?: boolean; providerCodes?: number[] } = {}) {
    super(message);
    // 기본 true: GCLB 412(fingerprint 경합)처럼 4xx 라도 다시 하면 되는 제공자가 있어 예전 동작(항상 재시도)을 지킨다
    this.retryable = o.retryable ?? true;
    this.providerCodes = o.providerCodes ?? [];
  }
}

// 【사실】 Cloudflare random_steering pool_weights 는 0~1, 0.1 단위 (트래픽 전환 설계 v1에서 문서 확인)
// 컨트롤러 단계(10/50/100%)가 전부 0.1 단위라 공통 검사로 쓴다
export function checkWeights(w: Weights): void {
  const ok = (x: number) => x >= 0 && x <= 1 && Math.abs(x * 10 - Math.round(x * 10)) < 1e-9;
  if (!ok(w.source) || !ok(w.target) || Math.abs(w.source + w.target - 1) > 1e-9)
    throw new InvalidWeights(`가중치는 0~1, 0.1 단위, 합 1이어야 한다: ${JSON.stringify(w)}`);
}

export const pctWeights = (targetPct: number): Weights =>
  ({ source: Math.round(100 - targetPct) / 100, target: Math.round(targetPct) / 100 });
export const sameWeights = (a: Weights, b: Weights) =>
  Math.abs(a.source - b.source) < 1e-6 && Math.abs(a.target - b.target) < 1e-6;

// 바꾸고 → 다시 읽어 확인. 다르거나 실패하면 다시 시도한다.
// DRAFT(ai): 3번, 대기 0.5→1→2초. Cloudflare PATCH 는 보통 1초 안에 반영된다는 PoC 관찰 기준 (【추정】 실제 API에선 미측정)
// pf-d RV-11: guard 를 주면 PATCH(set) 한 번만 그 안에서 한다. 읽어 확인(get)·재시도 대기는 guard 밖.
//   예전엔 shift 가 setAndVerify 전체(시도 3번 × 요청 10초 + 대기)를 이전 행 FOR SHARE 안에서 돌려 그동안 API 롤백·멈춤이 최대 ~61초 막혔다.
//   guard 가 던진 오류(MigrationMoved·플랫폼 DB 오류)는 재시도로 삼키지 않고 그대로 밖으로 보낸다
export async function setAndVerify(sw: TrafficSwitcher, lbId: string, w: Weights,
  o: { attempts?: number; sleep?: (ms: number) => Promise<void>; baseDelayMs?: number;
       guard?: (set: () => Promise<void>) => Promise<void> } = {}): Promise<{ attempts: number }> {
  checkWeights(w);
  const attempts = o.attempts ?? 3;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    let setErr: unknown = null;
    const set = async () => { try { await sw.set(lbId, w); } catch (e) { setErr = e; } };
    if (o.guard) await o.guard(set); else await set();
    try {
      if (setErr) throw setErr;
      const got = await sw.get(lbId);
      if (sameWeights(got, w)) return { attempts: i };
      last = `읽은 값 ${JSON.stringify(got)} ≠ 원하는 값 ${JSON.stringify(w)}`;
    } catch (e) {
      if (e instanceof InvalidWeights) throw e;
      last = (e as Error).message;
      // Z14: 다시 해도 안 되는 오류면 남은 시도를 쓰지 않는다 (롤백 작업이 나중에 다시 부른다)
      if (e instanceof ProviderError && !e.retryable) throw new SwitchFailed(`가중치 전환 실패 (재시도 불가 ${e.status}): ${last}`, i);
    }
    if (i < attempts) await sleep((o.baseDelayMs ?? 500) * 2 ** (i - 1));
  }
  throw new SwitchFailed(`가중치 전환 실패 (${attempts}번): ${last}`, attempts);
}

// 하위 호환: D 단계 STUB 이름. 새 코드는 providers/mock.ts 의 mockLb 를 쓴다
export { mockLb as stubCloudflareLb } from "./providers/mock.js";

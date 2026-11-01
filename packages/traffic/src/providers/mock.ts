import { checkWeights, ProviderError, type TrafficProvider, type TrafficSwitcher, type Weights } from "../switcher.js";

// STUB: 클라우드를 부르지 않는 메모리 LB. 시험·데모·로컬 smoke 용.
// 실패 주입으로 "PATCH 가 실패" / "읽으면 옛 값"(전파 지연) 상황을 만든다.
export interface MockLbOpts {
  provider?: TrafficProvider;   // 어느 제공자 흉내인지 (기록용)
  failSets?: number;            // 처음 n번 set 은 실패
  staleGets?: number;           // 처음 n번 get 은 옛 값을 돌려준다
  failAllSets?: boolean;        // set 이 계속 실패 (롤백 실패 시험)
}
export type MockCall = { op: "get" | "set"; lbId: string; w?: Weights; failed?: boolean };

export function mockLb(initial: Weights = { source: 1, target: 0 }, o: MockLbOpts = {}) {
  const state = new Map<string, Weights>();
  const prev = new Map<string, Weights>();
  const calls: MockCall[] = [];
  let failSets = o.failSets ?? 0, staleGets = o.staleGets ?? 0;
  const provider = o.provider ?? "mock";
  const sw: TrafficSwitcher & { calls: MockCall[]; provider: TrafficProvider } = {
    provider, calls,
    async get(lbId) {
      calls.push({ op: "get", lbId });
      if (staleGets > 0) { staleGets--; return { ...(prev.get(lbId) ?? initial) }; }
      return { ...(state.get(lbId) ?? initial) };
    },
    async set(lbId, w) {
      checkWeights(w);
      if (o.failAllSets || failSets > 0) {
        if (failSets > 0) failSets--;
        calls.push({ op: "set", lbId, w: { ...w }, failed: true });
        throw new ProviderError(provider, 503, "mock: 제공자 API 일시 실패");
      }
      calls.push({ op: "set", lbId, w: { ...w } });
      prev.set(lbId, state.get(lbId) ?? initial);
      state.set(lbId, { ...w });
    },
  };
  return sw;
}

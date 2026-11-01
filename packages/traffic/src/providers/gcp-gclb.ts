import { checkWeights, ProviderError, type TrafficSwitcher, type Weights } from "../switcher.js";
import { jsonRequest, type FetchLike, type TokenSource } from "./http.js";

// GCP 전역 외부 Application LB(URL map) 가중치 전환.
// DRAFT(ai): Cloudflare 를 못 쓸 때의 대안. 도착이 GCP 이고, 출발(AWS·온프레)을 인터넷 NEG 백엔드로 붙이면 클라우드를 넘어서도 나눌 수 있다.
// 【추정】 defaultRouteAction.weightedBackendServices 는 EXTERNAL_MANAGED(새 전역 외부 ALB)에서만 된다. 옛 classic LB 는 안 된다
// 【추정】 weight 는 0~1000 정수. 우리는 퍼센트(0~100)를 그대로 넣는다 (비율만 의미가 있다)
// 【미확인】 PATCH 에 defaultService 가 같이 있으면 거부되는지 → 실제 URL map 으로 확인 필요
// 필요한 권한: compute.urlMaps.get, compute.urlMaps.update, compute.globalOperations.get (최소 권한 파일에 추가 요청)
export interface GclbConfig {
  project: string;
  urlMap: string;                 // lbId 대신 이 이름을 쓴다. lbId 를 넘기면 그걸 URL map 이름으로 본다
  sourceBackend: string;          // 백엔드 서비스 self link
  targetBackend: string;
  token: TokenSource;             // 보안 패키지의 GCP 단기 토큰 (generateAccessToken)
  fetch?: FetchLike;
  baseUrl?: string;
  pollMs?: number; maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UrlMap {
  name: string; fingerprint: string;
  defaultService?: string;
  defaultRouteAction?: { weightedBackendServices?: Array<{ backendService: string; weight: number }> };
}

export function gclbPatchBody(c: Pick<GclbConfig, "sourceBackend" | "targetBackend">, fingerprint: string, w: Weights) {
  checkWeights(w);
  return {
    fingerprint,   // 낙관적 잠금. 그 사이 누가 바꿨으면 412 로 실패 → setAndVerify 가 다시 시도
    defaultRouteAction: {
      weightedBackendServices: [
        { backendService: c.sourceBackend, weight: Math.round(w.source * 100) },
        { backendService: c.targetBackend, weight: Math.round(w.target * 100) },
      ],
    },
  };
}

export function gclbWeightsOf(c: Pick<GclbConfig, "sourceBackend" | "targetBackend">, m: UrlMap): Weights {
  const ws = m.defaultRouteAction?.weightedBackendServices;
  if (!ws?.length) return m.defaultService === c.targetBackend ? { source: 0, target: 1 } : { source: 1, target: 0 };
  const s = ws.find((x) => x.backendService === c.sourceBackend)?.weight ?? 0;
  const t = ws.find((x) => x.backendService === c.targetBackend)?.weight ?? 0;
  const sum = s + t;
  if (sum <= 0) return { source: 0, target: 0 };
  return { source: Math.round((s / sum) * 10) / 10, target: Math.round((t / sum) * 10) / 10 };
}

export function gcpGclb(c: GclbConfig): TrafficSwitcher {
  const base = c.baseUrl ?? "https://compute.googleapis.com/compute/v1";
  const mapUrl = (name: string) => `${base}/projects/${encodeURIComponent(c.project)}/global/urlMaps/${encodeURIComponent(name)}`;
  const sleep = c.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const name = (lbId: string) => lbId || c.urlMap;
  async function req(method: string, url: string, body?: unknown) {
    const res = await jsonRequest(c.fetch, method, url, await c.token(), body);
    if (res.status >= 400) {
      const msg = (res.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new ProviderError("gcp_gclb", res.status, `GCLB ${method} 실패: ${msg}`);
    }
    return res.body as Record<string, unknown>;
  }
  return {
    provider: "gcp_gclb",
    async get(lbId) { return gclbWeightsOf(c, (await req("GET", mapUrl(name(lbId)))) as unknown as UrlMap); },
    async set(lbId, w) {
      const cur = (await req("GET", mapUrl(name(lbId)))) as unknown as UrlMap;
      const op = await req("PATCH", mapUrl(name(lbId)), gclbPatchBody(c, cur.fingerprint, w));
      // 전역 작업(Operation)이 DONE 이 될 때까지 기다린다
      const opName = op.name as string | undefined;
      if (!opName) return;
      for (let i = 0; i < (c.maxPolls ?? 30); i++) {
        const o = await req("GET", `${base}/projects/${encodeURIComponent(c.project)}/global/operations/${encodeURIComponent(opName)}`);
        if (o.status === "DONE") {
          if (o.error) throw new ProviderError("gcp_gclb", 500, `GCLB 작업 실패: ${JSON.stringify(o.error)}`);
          return;
        }
        await sleep(c.pollMs ?? 1000);
      }
      throw new ProviderError("gcp_gclb", 504, `GCLB 작업이 시간 안에 안 끝남: ${opName}`);
    },
  };
}

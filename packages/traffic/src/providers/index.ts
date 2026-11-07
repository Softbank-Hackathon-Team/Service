import type { TrafficProvider, TrafficSwitcher } from "../switcher.js";
import { cloudflareLb } from "./cloudflare.js";
import { gcpGclb } from "./gcp-gclb.js";
import { awsAlb, type AlbApi } from "./aws-alb.js";
import { mockLb } from "./mock.js";
import type { FetchLike, TokenSource } from "./http.js";

export * from "./cloudflare.js";
export * from "./gcp-gclb.js";
export * from "./aws-alb.js";
export * from "./mock.js";
export type { FetchLike, TokenSource } from "./http.js";

// 환경변수 → 어느 전환기를 쓸지. 비밀값(토큰)은 환경변수 "이름"만 받고 값은 tokens 함수가 꺼낸다
// DRAFT(ai): 기본은 mock. 진짜 Cloudflare 는 TRAFFIC_PROVIDER=cloudflare 와 아래 ID 세 개가 있어야 켜진다
//   ID 는 비밀이 아니라 .env.example 에 자리만 둔다 (CHANGES.md 요청)
export interface SwitcherDeps {
  tokens?: (provider: TrafficProvider) => TokenSource;   // 비밀 저장소 / 보안 패키지의 단기 토큰
  fetch?: FetchLike;
  albApi?: AlbApi;
}
export function switcherFromEnv(env: Record<string, string | undefined>, deps: SwitcherDeps = {}): TrafficSwitcher {
  const p = (env.TRAFFIC_PROVIDER || "mock") as TrafficProvider;   // Z14: 빈 값("")도 mock
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`TRAFFIC_PROVIDER=${p} 인데 ${k} 가 비어 있다`);
    return v;
  };
  const tok = (pp: TrafficProvider) => {
    if (!deps.tokens) throw new Error(`TRAFFIC_PROVIDER=${pp} 는 토큰 공급자가 필요하다`);
    return deps.tokens(pp);
  };
  switch (p) {
    case "cloudflare": {
      // Z14-05: .env 에는 CLOUDFLARE_ZONE_NAME 이 있다 (계정 세팅). CF_ZONE_ID 가 있으면 그걸 먼저 쓴다
      // M9 DRAFT(ai): 이름은 CLOUDFLARE_* 하나로 맞춘다 (계정 세팅 .env 와 같게). 예전 이름 CF_* 도 그대로 받는다
      const cf = (k: string) => env[`CLOUDFLARE_${k}`] || env[`CF_${k}`];
      const needCf = (k: string) => {
        const v = cf(k);
        if (!v) throw new Error(`TRAFFIC_PROVIDER=${p} 인데 CLOUDFLARE_${k} (옛 이름 CF_${k}) 가 비어 있다`);
        return v;
      };
      const zoneId = cf("ZONE_ID"), zoneName = env.CLOUDFLARE_ZONE_NAME;
      if (!zoneId && !zoneName) throw new Error(`TRAFFIC_PROVIDER=${p} 인데 CLOUDFLARE_ZONE_ID(옛 이름 CF_ZONE_ID) 와 CLOUDFLARE_ZONE_NAME 이 둘 다 비어 있다`);
      // Z14-04: 워커는 TRAFFIC_LB_ID 가 없으면 이전 번호를 LB 번호로 쓴다(mock 전용). 진짜 Cloudflare 에선 404 → 롤백도 실패하므로 시작 때 막는다
      need("TRAFFIC_LB_ID");
      return cloudflareLb({ ...(zoneId ? { zoneId } : { zoneName: zoneName! }), sourcePoolId: needCf("SOURCE_POOL_ID"),
        targetPoolId: needCf("TARGET_POOL_ID"), token: tok(p), fetch: deps.fetch });
    }
    case "gcp_gclb":
      return gcpGclb({ project: need("GCLB_PROJECT"), urlMap: need("GCLB_URL_MAP"),
        sourceBackend: need("GCLB_SOURCE_BACKEND"), targetBackend: need("GCLB_TARGET_BACKEND"), token: tok(p), fetch: deps.fetch });
    case "aws_alb":
      if (!deps.albApi) throw new Error("TRAFFIC_PROVIDER=aws_alb 는 AlbApi(SDK 연결)가 필요하다 (STUB)");
      return awsAlb({ sourceTargetGroupArn: need("ALB_SOURCE_TG_ARN"), targetTargetGroupArn: need("ALB_TARGET_TG_ARN"), api: deps.albApi });
    case "mock":
      return mockLb();
    default:
      throw new Error(`모르는 TRAFFIC_PROVIDER: ${p as string}`);
  }
}
export * from "./cf-provision.js";

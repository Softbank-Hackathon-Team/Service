import { checkWeights, ProviderError, type TrafficSwitcher, type Weights } from "../switcher.js";

// AWS ALB 가중치 대상 그룹 전환 (리스너 기본 동작 forward + ForwardConfig.TargetGroups[].Weight)
// DRAFT(ai): 같은 VPC 안에서만 의미가 있다 (대상 그룹은 같은 VPC 의 인스턴스·IP). 클라우드를 넘는 전환은 Cloudflare 가 기본
//   쓰임새: 도착이 AWS 일 때 EKS 안 새 버전/옛 버전 나누기, 또는 온프레를 Direct Connect IP 대상으로 붙인 경우
// 【추정】 Weight 는 0~999 정수. 우리는 퍼센트(0~100)를 그대로 넣는다
// 필요한 권한: elasticloadbalancing:DescribeListeners, elasticloadbalancing:ModifyListener (리스너 ARN 으로 자원 제한)
//
// 아래 AlbApi 는 AWS SDK v3 ElasticLoadBalancingV2Client 의 DescribeListeners / ModifyListener 입력·출력 모양과 같게 잡았다.
// STUB: SDK 연결. 새 의존성(@aws-sdk/client-elastic-load-balancing-v2)은 통합 쪽에 요청 (CHANGES.md). 지금은 주입만 받는다
export interface AlbTargetGroupTuple { TargetGroupArn: string; Weight: number }
export interface AlbAction { Type: "forward"; ForwardConfig: { TargetGroups: AlbTargetGroupTuple[]; TargetGroupStickinessConfig?: { Enabled: boolean } } }
export interface AlbApi {
  describeListeners(input: { ListenerArns: string[] }): Promise<{ Listeners?: Array<{ ListenerArn: string; DefaultActions?: AlbAction[] }> }>;
  modifyListener(input: { ListenerArn: string; DefaultActions: AlbAction[] }): Promise<unknown>;
}
export interface AlbConfig { sourceTargetGroupArn: string; targetTargetGroupArn: string; api: AlbApi }

export function albModifyInput(c: Omit<AlbConfig, "api">, listenerArn: string, w: Weights) {
  checkWeights(w);
  return {
    ListenerArn: listenerArn,
    DefaultActions: [{
      Type: "forward" as const,
      ForwardConfig: {
        TargetGroups: [
          { TargetGroupArn: c.sourceTargetGroupArn, Weight: Math.round(w.source * 100) },
          { TargetGroupArn: c.targetTargetGroupArn, Weight: Math.round(w.target * 100) },
        ],
        // 고정 세션 끔: 켜 두면 롤백해도 도착에 묶인 사용자가 남는다 (Cloudflare session_affinity none 과 같은 이유)
        TargetGroupStickinessConfig: { Enabled: false },
      },
    }],
  };
}

export function albWeightsOf(c: Omit<AlbConfig, "api">, actions: AlbAction[] | undefined): Weights {
  const tgs = actions?.find((a) => a.Type === "forward")?.ForwardConfig?.TargetGroups ?? [];
  const s = tgs.find((t) => t.TargetGroupArn === c.sourceTargetGroupArn)?.Weight ?? 0;
  const t = tgs.find((x) => x.TargetGroupArn === c.targetTargetGroupArn)?.Weight ?? 0;
  const sum = s + t;
  if (sum <= 0) return { source: 0, target: 0 };
  return { source: Math.round((s / sum) * 10) / 10, target: Math.round((t / sum) * 10) / 10 };
}

// lbId = 리스너 ARN
export function awsAlb(c: AlbConfig): TrafficSwitcher {
  return {
    provider: "aws_alb",
    async get(listenerArn) {
      const r = await c.api.describeListeners({ ListenerArns: [listenerArn] });
      const l = r.Listeners?.[0];
      if (!l) throw new ProviderError("aws_alb", 404, `리스너 없음: ${listenerArn}`);
      return albWeightsOf(c, l.DefaultActions);
    },
    async set(listenerArn, w) {
      try { await c.api.modifyListener(albModifyInput(c, listenerArn, w)); }
      catch (e) { throw new ProviderError("aws_alb", 502, `ModifyListener 실패: ${(e as Error).message}`); }
    },
  };
}

// STUB: AWS 를 부르지 않는 메모리 ALB. 요청 모양은 진짜와 같아서, SDK 를 붙여도 위 awsAlb 는 안 바뀐다
export function mockAlbApi(initial: Record<string, AlbAction[]> = {}) {
  const listeners = new Map(Object.entries(initial));
  const calls: Array<{ op: string; input: unknown }> = [];
  const api: AlbApi & { calls: typeof calls } = {
    calls,
    async describeListeners(input) {
      calls.push({ op: "DescribeListeners", input });
      return { Listeners: input.ListenerArns.filter((a) => listeners.has(a)).map((a) => ({ ListenerArn: a, DefaultActions: listeners.get(a) })) };
    },
    async modifyListener(input) {
      calls.push({ op: "ModifyListener", input });
      if (!listeners.has(input.ListenerArn)) throw new Error("ListenerNotFound");
      listeners.set(input.ListenerArn, input.DefaultActions);
      return {};
    },
  };
  return api;
}

import { arr, get, runJson, str, type CliDeps } from "../common/cli.js";

// #245: 전환 직전 출발 ALB 의 초당 요청 수 (CloudWatch RequestCount). 출발 응답 수 지표가 없을 때 단계별 몫 확인의 기준값으로 쓴다.
// DRAFT(ai): 지표가 늦게 들어오니 최근 2분은 빼고 그 앞 5분을 본다. 부하가 도중에 시작했어도 낮게 잡히지 않게 데이터가 있는 분만 나눈다
export const ALB_RATE_AWS_COMMANDS = ["elbv2 describe-load-balancers", "cloudwatch get-metric-statistics"] as const;
export const ALB_RATE_WINDOW_SEC = 300;
export const ALB_RATE_LAG_SEC = 120;
const PERIOD_SEC = 60;

export type AlbRate = { rps: number; lb: string; from: string; to: string };
export type AlbRateResult = AlbRate | { error: string };

const normalizeHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "").replace(/^dualstack\./, "");

/** origins = Cloudflare 출발 풀의 원본 주소. 그중 하나와 DNS 이름이 같은 ALB 를 찾아 읽는다. CLI 실패는 CliError 로 던진다 */
export async function readAlbRequestRate(o: { origins: string[]; region: string; cliEnv: Record<string, string>; now: Date }, d: CliDeps = {}): Promise<AlbRateResult> {
  const r = ["--region", o.region, "--output", "json"];
  const wanted = new Set(o.origins.map(normalizeHost));
  const lbs = arr(get(await runJson(d, "aws", ["elbv2", "describe-load-balancers", ...r], o.cliEnv), "LoadBalancers"));
  const lb = lbs.find((l) => str(l.Type) === "application" && wanted.has(normalizeHost(str(l.DNSName) ?? "")));
  // LoadBalancer 차원 값 = ARN 의 loadbalancer/ 뒤 (app/<이름>/<id>)
  const dimension = str(lb?.LoadBalancerArn)?.split(":loadbalancer/")[1];
  if (!dimension) return { error: "출발 풀의 원본 주소와 같은 ALB 를 못 찾음" };
  const endMs = Math.floor(o.now.getTime() / (PERIOD_SEC * 1000)) * PERIOD_SEC * 1000 - ALB_RATE_LAG_SEC * 1000;
  const from = new Date(endMs - ALB_RATE_WINDOW_SEC * 1000).toISOString(), to = new Date(endMs).toISOString();
  const points = arr(get(await runJson(d, "aws", ["cloudwatch", "get-metric-statistics", "--namespace", "AWS/ApplicationELB", "--metric-name", "RequestCount",
    "--dimensions", `Name=LoadBalancer,Value=${dimension}`, "--start-time", from, "--end-time", to, "--period", String(PERIOD_SEC), "--statistics", "Sum", ...r], o.cliEnv), "Datapoints"));
  const total = points.reduce((sum, p) => sum + (Number(p.Sum) || 0), 0);
  if (total <= 0) return { error: `ALB ${dimension} 의 요청 수가 ${from}~${to} 에 없음 (전환 전 몇 분 동안 부하가 있어야 한다)` };
  return { rps: Math.round((total / (points.length * PERIOD_SEC)) * 100) / 100, lb: dimension, from, to };
}

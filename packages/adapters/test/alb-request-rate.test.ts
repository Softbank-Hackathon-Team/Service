// #245: 출발 풀 원본 주소로 ALB 를 찾아 CloudWatch 요청 수로 초당 요청 수를 낸다 (가짜 CLI)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAlbRequestRate } from "../src/aws/alb-request-rate.js";
import { AWS_COMMAND_ACTIONS } from "../src/common/observe-permissions.js";

const LBS = { LoadBalancers: [
  { Type: "network", DNSName: "shop.example.com", LoadBalancerArn: "arn:aws:elasticloadbalancing:r:1:loadbalancer/net/n/1" },
  { Type: "application", DNSName: "other.elb.amazonaws.com", LoadBalancerArn: "arn:aws:elasticloadbalancing:r:1:loadbalancer/app/other/2" },
  { Type: "application", DNSName: "shop.elb.amazonaws.com", LoadBalancerArn: "arn:aws:elasticloadbalancing:r:1:loadbalancer/app/shop/3" },
] };
function fakeCli(datapoints: unknown[]) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec = (async (_bin: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: o.env });
    return { code: 0, stderr: "", ms: 1, stdout: JSON.stringify(args[0] === "elbv2" ? LBS : { Datapoints: datapoints }) };
  }) as never;
  return { calls, exec };
}
const input = (origins: string[]) => ({ origins, region: "ap-northeast-2", cliEnv: { AWS_SESSION_TOKEN: "x" }, now: new Date("2026-11-07T01:00:30Z") });

test("원본 주소와 같은 ALB 의 요청 수로 초당 요청 수를 낸다. 지표가 늦는 최근 2분은 뺀다", async () => {
  const f = fakeCli([{ Sum: 3000 }, { Sum: 3000 }, { Sum: 6000 }]);
  const r = await readAlbRequestRate(input(["dualstack.SHOP.elb.amazonaws.com."]), { exec: f.exec });
  assert.deepEqual(r, { rps: 66.67, lb: "app/shop/3", from: "2026-11-07T00:53:00.000Z", to: "2026-11-07T00:58:00.000Z" });
  const cw = f.calls[1]!;
  assert.ok(cw.args.includes("Name=LoadBalancer,Value=app/shop/3"));
  assert.equal(cw.env.AWS_SESSION_TOKEN, "x");
});

test("거부: 같은 ALB 가 없거나(NLB 는 안 친다) 요청 수가 없으면 이유를 돌려준다", async () => {
  const nlb = await readAlbRequestRate(input(["shop.example.com"]), { exec: fakeCli([]).exec });
  assert.ok("error" in nlb && /ALB/.test(nlb.error), JSON.stringify(nlb));
  const empty = await readAlbRequestRate(input(["shop.elb.amazonaws.com"]), { exec: fakeCli([]).exec });
  assert.ok("error" in empty && /요청 수/.test(empty.error), JSON.stringify(empty));
});

test("부르는 명령은 전부 관찰 권한 표에 있다", () => {
  for (const k of ["elbv2 describe-load-balancers", "cloudwatch get-metric-statistics"]) assert.ok(AWS_COMMAND_ACTIONS[k], k);
});

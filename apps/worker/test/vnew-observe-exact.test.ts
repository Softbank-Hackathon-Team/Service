// VNEW (상태: AI 초안): 가져오기 관찰 요청 목록(importObserveActions) = discover 가 실제로 부르는 명령의 권한 (모자람 0·남음 0·중복 0).
//   VMIMPORT·CRIMPORT·I9·I6 목록이 base 에서 손으로 합쳐져서, 모든 갈래를 켠 가짜 실행으로 부른 명령을 모아 권한 표로 바꿔 대조한다 (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionsOfCommands, AWS_COMMAND_ACTIONS, discoverAws, discoverGcp, GCP_COMMAND_PERMISSIONS } from "@svc/adapters";
import { importObserveActions } from "../src/jobs/import.js";

const DG = "sha256:" + "e5".repeat(32);
const j = (x: unknown) => ({ code: 0, stdout: JSON.stringify(x), stderr: "", ms: 1 });
const dep = { metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } }, spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } },
  template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{ name: "api", image: `r/a@${DG}`, ports: [{ containerPort: 8080 }] }] } } } };
function keyOf(table: Record<string, unknown>, args: string[]): string {
  const words = args.filter((w) => !w.startsWith("-"));
  const k = [4, 3, 2].map((n) => words.slice(0, n).join(" ")).find((x) => x in table);
  assert.ok(k, `권한 표에 없는 명령: ${args.join(" ")}`);
  return k;
}
function withEnv<T>(env: Record<string, string | undefined>, f: () => T): T {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env); for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { return f(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const dups = (a: string[]) => a.filter((x, i) => a.indexOf(x) !== i);

test("gcp v2: 관찰 요청 = GKE 앱 + VM(IMPORT_VM=1) + Cloud Run 서비스·잡 + 데이터 읽기가 부르는 권한 (정확히 같음, 중복 0)", async () => {
  const keys = new Set<string>();
  const exec = async (bin: string, args: string[]) => {
    if (bin === "gcloud") keys.add(keyOf(GCP_COMMAND_PERMISSIONS, args));
    const s = args.join(" ");
    if (bin === "kubectl") return j({ items: args[1] === "deployments" ? [dep] : [] });
    if (/container clusters list/.test(s)) return j([{ name: "gke-1", location: "r" }]);
    if (/compute instances list/.test(s)) return j([{ name: "vm-1", status: "RUNNING", machineType: "m/e2-small", networkInterfaces: [] }]);
    if (/^run services list/.test(s)) return j([{ metadata: { name: "s", labels: { "cloud.googleapis.com/location": "r" } }, spec: { template: { spec: { containers: [{ image: "i:1" }] } } }, status: { latestReadyRevisionName: "s-1" } }]);
    if (/^run revisions describe/.test(s)) return j({ status: { imageDigest: DG } });
    if (/^run services get-iam-policy/.test(s)) return j({ bindings: [] });
    if (/^run jobs list/.test(s)) return j([{ metadata: { name: "jb", labels: { "cloud.googleapis.com/location": "r" } }, spec: { template: { spec: { template: { spec: { containers: [{ image: `i@${DG}` }] } } } } } }]);
    if (/^storage buckets list/.test(s)) return j([{ name: "b1" }]);
    return j([]);
  };
  await discoverGcp({ exec: exec as never, env: { GCP_PROJECT: "p", IMPORT_VM: "1" } }, { ir: "v2" });
  const used = actionsOfCommands("gcp", [...keys]);
  const listed = withEnv({ IMPORT_IR: "v2" }, () => importObserveActions("gcp"));
  assert.deepEqual(dups(listed), []);
  assert.deepEqual(used.filter((a) => !listed.includes(a)), [], "부르는데 요청 안 함 (실계정에서 권한 거부)");
  assert.deepEqual(listed.filter((a) => !used.includes(a)), [], "요청하는데 안 부름 (최소 권한 아님)");
});

test("aws v2: 관찰 요청 = EKS 앱 + ECS + VM(IMPORT_VM=1) + 데이터 읽기가 부르는 동작 (정확히 같음, 중복 0, 무권한 명령 제외)", async () => {
  const keys = new Set<string>();
  const arn = "arn:aws:ecs:ap-northeast-2:000000000000";
  const exec = async (bin: string, args: string[]) => {
    if (bin === "aws") keys.add(keyOf(AWS_COMMAND_ACTIONS, args));
    const s = args.join(" ");
    if (bin === "kubectl") return j({ items: args[1] === "deployments" ? [dep] : [] });
    if (/^sts get-caller-identity/.test(s)) return j({ Account: "000000000000" });
    if (/^eks list-clusters/.test(s)) return j({ clusters: ["eks-1"] });
    if (/^eks describe-cluster/.test(s)) return j({ cluster: { name: "eks-1", resourcesVpcConfig: { vpcId: "vpc-1" } } });
    if (/^eks update-kubeconfig/.test(s)) return { code: 0, stdout: "", stderr: "", ms: 1 };
    if (/^ecs list-clusters/.test(s)) return j({ clusterArns: [`${arn}:cluster/c1`] });
    if (/^ecs list-services/.test(s)) return j({ serviceArns: [`${arn}:service/c1/shop`] });
    if (/^ecs describe-services/.test(s)) return j({ services: [{ serviceName: "shop", serviceArn: `${arn}:service/c1/shop`, clusterArn: `${arn}:cluster/c1`,
      taskDefinition: `${arn}:task-definition/shop:1`, desiredCount: 1, launchType: "FARGATE",
      loadBalancers: [{ targetGroupArn: "arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:targetgroup/tg/1", containerName: "shop", containerPort: 80 }] }] });
    if (/^ecs describe-task-definition/.test(s)) return j({ taskDefinition: { family: "shop", cpu: "256", memory: "512", containerDefinitions: [{ name: "shop", image: `r/shop@${DG}`, essential: true, portMappings: [{ containerPort: 80 }] }] } });
    if (/^ecs list-tasks/.test(s)) return j({ taskArns: [`${arn}:task/c1/t1`] });
    if (/^ecs describe-tasks/.test(s)) return j({ tasks: [{ containers: [{ name: "shop", imageDigest: DG }] }] });
    if (/^elbv2 describe-target-groups/.test(s)) return j({ TargetGroups: [{ TargetGroupArn: "arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:targetgroup/tg/1", LoadBalancerArns: ["arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/lb/1"], HealthCheckPath: "/" }] });
    if (/^elbv2 describe-listeners/.test(s)) return j({ Listeners: [{ ListenerArn: "arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:listener/app/lb/1/l1", Port: 80, Protocol: "HTTP" }] });
    if (/^elbv2 describe-load-balancers/.test(s)) return j({ LoadBalancers: [{ LoadBalancerArn: "arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/lb/1", LoadBalancerName: "lb", VpcId: "vpc-1" }] });
    if (/^ec2 describe-instances/.test(s)) return j({ Reservations: [{ Instances: [{ InstanceId: "i-1", State: { Name: "running" }, InstanceType: "t3.small", Tags: [{ Key: "Name", Value: "legacy-1" }], SecurityGroups: [{ GroupId: "sg-1" }] }] }] });
    if (/^application-autoscaling describe-scalable-targets/.test(s)) return j({ ScalableTargets: [{ MinCapacity: 1, MaxCapacity: 3 }] });
    if (/^s3api list-buckets/.test(s)) return j({ Buckets: [{ Name: "b1" }] });
    if (/^sqs list-queues/.test(s)) return j({ QueueUrls: ["https://sqs.ap-northeast-2.amazonaws.com/000000000000/q1"] });
    if (/^elasticache describe-replication-groups/.test(s)) return j({ ReplicationGroups: [{ ReplicationGroupId: "rg1", MemberClusters: ["rg1-001"] }] });
    return j({});
  };
  await discoverAws({ exec: exec as never, env: { AWS_REGION: "ap-northeast-2", IMPORT_VM: "1" } }, { ir: "v2" });
  const used = actionsOfCommands("aws", [...keys]);
  const listed = withEnv({ IMPORT_IR: "v2", IMPORT_AWS_IAM: undefined }, () => importObserveActions("aws"));
  assert.deepEqual(dups(listed), []);
  assert.deepEqual(used.filter((a) => !listed.includes(a)), [], "부르는데 요청 안 함");
  // sts:GetCallerIdentity 는 권한이 필요 없는 명령(표 null)이지만 예전 장부 목록에 있던 것이라 남겨 둔다
  assert.deepEqual(listed.filter((a) => !used.includes(a) && a !== "sts:GetCallerIdentity"), [], "요청하는데 안 부름");
});

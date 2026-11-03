// I9: ECS 출발 갈래 (Reader aws-ecs · 매퍼 ecs-service · aws v2 데모 · Builder capability · HCL 대조). 클라우드 CLI 는 가짜 exec
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppSpecV2, checkV2, ImportResultV2, ServiceTfVars } from "@svc/contracts";
import {
  adapterFor, AdapterError, DEMO_INVENTORY, DEMO_INVENTORY_V2, discoverAws, inventoryForAudit, normalizeV2, projectV1, readEcs,
  roleNameOf, secretRefOf, targetBuilderFor, UNSUPPORTED_V2, v2PrecheckItems,
} from "../src/index.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "ab".repeat(32);
const T = { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp" as const, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" };

test("aws v2 데모(ECS 3티어) → normalizeV2: 관리형 컨테이너 서비스 3개 + DB, 연결·라우팅·비밀, 같은 입력 = 같은 결과", () => {
  const a = normalizeV2(DEMO_INVENTORY_V2.aws!), b = normalizeV2(DEMO_INVENTORY_V2.aws!);
  assert.equal(JSON.stringify(a.result), JSON.stringify(b.result));
  const r = ImportResultV2.parse(a.result);
  assert.deepEqual(checkV2(r.spec).errors, []);
  assert.deepEqual(r.unmapped, []);
  const svc = r.spec.components.filter((c) => c.kind === "service");
  assert.deepEqual(svc.map((c) => c.id), ["shop-api", "shop-web", "shop-worker"]);
  for (const c of svc) {
    assert.equal(c.kind === "service" && c.props.runtime, "managedContainer");
    assert.deepEqual(c.kind === "service" && c.props.origin, { runtime: "managedContainer", product: "ecs" });
  }
  const api = svc.find((c) => c.id === "shop-api")!;
  assert.ok(api.kind === "service");
  assert.deepEqual(api.props.replicas, { min: 2, max: 6 });
  assert.deepEqual(api.props.scale, { targetCpuPct: 70 });
  assert.equal(api.props.serviceAccount, "shop-api-task");
  assert.deepEqual(api.props.resources, { request: { cpuMilli: 500, memMiB: 1024 } });
  assert.deepEqual(api.props.env.find((e) => e.name === "DB_HOST"), { name: "DB_HOST", fromLink: { to: "shop-db", output: "host" } });
  assert.deepEqual(api.props.env.find((e) => e.name === "DATABASE_PASSWORD"), { name: "DATABASE_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } });
  // Service Connect 이름(shop-api.shop.local)으로 web → api 연결, 주소는 template 으로
  assert.deepEqual(r.spec.links.map((l) => `${l.from}->${l.to}:${l.intent}`), ["shop-api->shop-db:connect", "shop-web->shop-api:call", "shop-worker->shop-db:connect"]);
  const web = svc.find((c) => c.id === "shop-web")!;
  assert.ok(web.kind === "service");
  assert.deepEqual(web.props.env, [{ name: "API_URL", template: "http://${shop-api.host}:8080" }]);
  // ALB 규칙 → 라우팅 (/api/* → PathPrefix /api 먼저, /* → /)
  assert.deepEqual(r.spec.entry?.hosts[0]?.routes.map((x) => [x.matches[0]!.path.value, x.backends[0]!.to]), [["/api", "shop-api"], ["/", "shop-web"]]);
  assert.deepEqual(r.environment, ["ecs.cluster"]);
  // checkV2 는 runtime 이 출발과 같아 실행 방식 바뀜 승인 줄이 없다
  assert.deepEqual(checkV2(r.spec).approvals, []);
});

test("v1 투영: v1 ECS 데모 원본을 v2 로 읽어 투영 = 지금 v1 명세 (값 같음)", () => {
  const n = normalizeV2(DEMO_INVENTORY.aws);
  const p = projectV1(n.result, n.projectionEnv);
  assert.deepEqual(p.spec, adapterFor("aws").normalize(DEMO_INVENTORY.aws).spec);
  // v1 데모의 hostname 은 "/" 한 줄 라우팅 + 검토 표시
  assert.equal(n.result.spec.entry?.hosts[0]?.hostnames[0], "shop.example.com");
  assert.equal(n.result.fieldMeta["entry.shop.example.com.routes[0]"]?.needs_review, true);
  // v2 데모 주 서비스(shop-api)도 같은 칸 (DB_HOST 만 더 있음)
  const m = normalizeV2(DEMO_INVENTORY_V2.aws!);
  const q = projectV1(m.result, m.projectionEnv).spec;
  assert.equal(q.app?.name, "shop-api");
  assert.equal(q.ingress?.hostname, "shop.example.com");
  assert.deepEqual(q.service?.secretRefs, [{ name: "DATABASE_PASSWORD", key: "password" }]);
});

test("거부: digest 못 읽은 ECS 서비스 → unmapped B, 깨진 원본 → C (리소스 안 됨)", () => {
  const inv = { provider: "aws" as const, coverage: {}, items: [
    { kind: "ecs.service", serviceName: "tagonly", desiredCount: 1, imageDigest: null, taskDefinition: { containerDefinitions: [{ image: "r/x:1.0" }] } },
    { kind: "ecs.service", serviceName: "broken" },
  ] };
  const r = normalizeV2(inv).result;
  assert.deepEqual(r.spec.components, []);
  assert.deepEqual(r.unmapped.map((u) => [u.resource, u.grade]), [["ecs.service:broken", "C"], ["ecs.service:tagonly", "B"]]);
});

test("secrets ARN → 비밀 이름·키, 작업 역할 ARN → 이름", () => {
  assert.deepEqual(secretRefOf("DB_PASS", "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:shop-db:password::"), { secret: "shop-db", key: "password" });
  assert.deepEqual(secretRefOf("DB_PASS", "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:shop-db-AbCdEf"), { secret: "shop-db-AbCdEf", key: "DB_PASS" });
  assert.deepEqual(secretRefOf("TOKEN", "arn:aws:ssm:ap-northeast-2:000000000000:parameter/app/prod/token"), { secret: "token", key: "TOKEN" });
  assert.equal(roleNameOf("arn:aws:iam::000000000000:role/path/shop-task"), "shop-task");
  assert.equal(roleNameOf(null), null);
});

// TA13: aws·gcp 는 ECS·Cloud Run 으로 그림 (ta13-managed-target.test.ts). 온프레·azure 는 계속 capability 로 막힘
test("Builder: managedContainer 는 온프레에서 capability 로 막힘 (UNSUPPORTED_V2, 서비스·푸는 길 적음), runtime 을 k8s 로 바꾸면 그려진다", () => {
  const spec = normalizeV2(DEMO_INVENTORY_V2.aws!).result.spec;
  for (const p of ["onprem"] as const) {
    assert.throws(() => targetBuilderFor(p).toTerraformV2(spec, { ...T, provider: p }), (e: unknown) =>
      e instanceof AdapterError && e.code === UNSUPPORTED_V2 && /runtime\.managedContainer/.test(e.message) && /shop-api,shop-web,shop-worker/.test(e.message), p);
  }
  const items = v2PrecheckItems("onprem", { spec: null, specV2: spec, hadV2Before: false });
  assert.ok(items.some((i) => i.level === "block" && /runtime\.managedContainer/.test(i.message)));
  // 사람이 runtime 을 k8s 로 바꾼 판 = 실행 방식 바뀜 승인 줄 + GKE 로 그려짐
  const k8s = AppSpecV2.parse({ ...spec, components: spec.components.map((c) => (c.kind === "service" ? { ...c, props: { ...c.props, runtime: "k8s" } } : c)) });
  assert.equal(checkV2(k8s).approvals.filter((a) => a.kind === "runtime_change").length, 3);
  const tf = targetBuilderFor("gcp").toTerraformV2(k8s, T);
  assert.ok(tf.instances.some((i) => i.kind === "postgres" && i.id === "shop-db"));
  const v = targetBuilderFor("gcp").toWorkloadValues(k8s, {}, T);
  assert.equal((v.workloads as unknown[]).length, 3);
});

// ── Reader (가짜 aws CLI) ─────────────────────────────
type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    return { code: hit[1].code ?? 0, stdout: JSON.stringify(hit[1].out ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const TG = "arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:targetgroup/api/1";
const LB = "arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/shop/1";
const ECS_TABLE: Array<[RegExp, Reply]> = [
  [/^aws ecs list-clusters/, { out: { clusterArns: ["arn:aws:ecs:ap-northeast-2:000000000000:cluster/shop"] } }],
  [/^aws ecs list-services --cluster shop/, { out: { serviceArns: ["arn:aws:ecs:ap-northeast-2:000000000000:service/shop/shop-api"] } }],
  [/^aws ecs describe-services --cluster shop --services/, { out: { services: [{ serviceName: "shop-api", serviceArn: "arn:aws:ecs:ap-northeast-2:000000000000:service/shop/shop-api",
    status: "ACTIVE", desiredCount: 2, launchType: "FARGATE", taskDefinition: "arn:aws:ecs:ap-northeast-2:000000000000:task-definition/shop-api:7",
    loadBalancers: [{ targetGroupArn: TG, containerName: "api", containerPort: 8080 }],
    deployments: [{ serviceConnectConfiguration: { enabled: true, namespace: "shop.local", services: [{ portName: "http", discoveryName: "shop-api", clientAliases: [{ port: 8080, dnsName: "shop-api.shop.local" }] }] } }] }] } }],
  [/^aws ecs describe-task-definition/, { out: { taskDefinition: { family: "shop-api", cpu: "512", memory: "1024", taskRoleArn: "arn:aws:iam::000000000000:role/shop-api-task",
    containerDefinitions: [{ name: "api", image: "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/shop-api:1.4.2", essential: true,
      portMappings: [{ containerPort: 8080, protocol: "tcp" }], environment: [{ name: "LOG_LEVEL", value: "info" }, { name: "API_KEY", value: "sk-ant-aaaaaaaaaaaaaaaaaaaa" }],
      secrets: [{ name: "DATABASE_PASSWORD", valueFrom: "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:shop-db:password::" }],
      logConfiguration: { logDriver: "awslogs" }, healthCheck: { command: ["CMD-SHELL", "curl -f http://localhost:8080/healthz"], interval: 30 } }] } } }],
  [/^aws ecs list-tasks/, { out: { taskArns: ["arn:aws:ecs:ap-northeast-2:000000000000:task/shop/abc"] } }],
  [/^aws ecs describe-tasks/, { out: { tasks: [{ taskDefinitionArn: "arn:aws:ecs:ap-northeast-2:000000000000:task-definition/shop-api:7", containers: [{ name: "api", imageDigest: D }] }] } }],   // VI9: 진짜 응답처럼 판 ARN 포함 (reader 가 서비스 판 작업만 봄)
  [/^aws elbv2 describe-target-groups/, { out: { TargetGroups: [{ TargetGroupArn: TG, HealthCheckPath: "/healthz", LoadBalancerArns: [LB] }] } }],
  [/^aws elbv2 describe-listeners/, { out: { Listeners: [{ ListenerArn: "arn:l1" }] } }],
  [/^aws elbv2 describe-rules/, { out: { Rules: [
    { Priority: "10", Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: ["shop.example.com"] } }, { Field: "path-pattern", PathPatternConfig: { Values: ["/api/*"] } }],
      Actions: [{ Type: "forward", TargetGroupArn: TG }] },
    { Priority: "default", Conditions: [], Actions: [{ Type: "forward", TargetGroupArn: TG }] },
  ] } }],
  [/^aws application-autoscaling describe-scalable-targets/, { out: { ScalableTargets: [{ MinCapacity: 2, MaxCapacity: 6 }] } }],
  [/^aws application-autoscaling describe-scaling-policies/, { out: { ScalingPolicies: [{ PolicyType: "TargetTrackingScaling",
    TargetTrackingScalingPolicyConfiguration: { TargetValue: 70.0, PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" } } }] } }],
];

test("Reader aws-ecs: 서비스·작업 정의·digest·ALB 규칙·Auto Scaling → ecs.service 원본 → 매퍼까지. 쓰기 명령 없음", async () => {
  const { exec, calls } = fakeExec(ECS_TABLE);
  const r = await readEcs({ exec, env: {} }, "ap-northeast-2", {});
  assert.deepEqual(r.counts, { "ecs.service": 1 });
  assert.ok(r.notes.some((n) => /호스트 조건 없음/.test(n)));
  const it = r.items[0] as Record<string, any>;
  assert.equal(it.imageDigest, D);
  assert.deepEqual(it.routes, [{ host: "shop.example.com", path: "/api/*", priority: 10 }]);
  assert.deepEqual(it.autoscaling, { min: 2, max: 6, targetCpuPct: 70 });
  assert.equal("logConfiguration" in it.taskDefinition.containerDefinitions[0], false, "허용 목록 밖 칸은 안 넣음");
  assert.ok(calls.every((c) => / (list|describe)-/.test(c)), "읽기 명령만");
  const n = normalizeV2({ provider: "aws", coverage: {}, items: r.items as never }).result;
  const api = n.spec.components.find((c) => c.id === "shop-api")!;
  assert.ok(api.kind === "service");
  assert.deepEqual(api.props.probes?.liveness, { type: "exec", command: ["sh", "-c", "curl -f http://localhost:8080/healthz"], periodSec: 30 });
  assert.deepEqual(api.props.probes?.readiness, { type: "http", path: "/healthz", port: 8080 });
  // 평문 비밀 env(API_KEY)는 명세에서 빠진다 (k8s 와 같은 규칙)
  assert.equal(api.props.env.some((e) => e.name === "API_KEY"), false);
  assert.ok(n.unmapped.some((u) => u.resource === "env:shop-api.API_KEY"));
});

test("discoverAws: v2 는 EKS 없어도 ECS 로 읽고, v1 은 지금처럼 EKS 필수(SOURCE_INCOMPLETE). 감사 판은 ECS env 값을 지운다", async () => {
  const base: Array<[RegExp, Reply]> = [
    [/^aws sts get-caller-identity/, { out: { Account: "000000000000" } }],
    [/^aws eks list-clusters/, { out: { clusters: [] } }],
    [/^aws rds describe-db-instances/, { out: { DBInstances: [] } }],
    [/^aws (ec2|elbv2 describe-load-balancers|ecr|secretsmanager)/, { out: {} }],
  ];
  const { exec } = fakeExec([...base, ...ECS_TABLE]);
  const inv = await discoverAws({ exec, env: {} }, { ir: "v2" });
  assert.equal(inv.coverage["ecs.service"], 1);
  assert.ok(inv.items.some((i) => (i as { kind: string }).kind === "ecs.cluster"));
  assert.equal(inv.items.some((i) => (i as { kind: string }).kind === "eks.cluster"), false);
  await assert.rejects(discoverAws({ exec, env: {} }, {}), (e: unknown) => e instanceof AdapterError && e.code === "SOURCE_INCOMPLETE");
  const audit = inventoryForAudit(inv);
  const s = JSON.stringify(audit.items.find((i) => (i as { kind: string }).kind === "ecs.service"));
  assert.equal(s.includes("sk-ant-"), false);
  assert.equal(s.includes("info"), false);
  assert.ok(s.includes("LOG_LEVEL"));
});

test("HCL 대조: service-ecs·service-cloudrun 의 cfg 칸 = ServiceTfVars 칸 (양방향)", () => {
  const infra = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/modules");
  const fields = Object.keys(ServiceTfVars.shape).sort();
  for (const m of ["aws/kinds/service-ecs", "gcp/kinds/service-cloudrun"]) {
    const src = readFileSync(join(infra, m, "main.tf"), "utf8");
    const body = src.match(/variable "cfg" \{\s*type = object\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
    assert.deepEqual([...body.matchAll(/^\s*([a-z_]+)\s*=/gm)].map((x) => x[1]!).sort(), fields, m);
    for (const f of new Set([...src.matchAll(/\bcfg\.([a-z_]+)/g)].map((x) => x[1]!))) assert.ok(fields.includes(f), `${m}: cfg.${f}`);
  }
});

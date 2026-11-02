// VI9: I9 ECS 가져오기 경계 시험 — 서비스 0개·작업 정의 여러 판(롤링 중)·사이드카·오토스케일 없음·비밀 env(값 안 남음)·결정성
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, ImportResultV2 } from "@svc/contracts";
import { AdapterError, discoverAws, inventoryForAudit, normalizeV2, readEcs } from "../src/index.js";
import { ecsServiceMapper } from "../src/import/mappers/ecs-service.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D_OLD = "sha256:" + "0a".repeat(32), D_NEW = "sha256:" + "0b".repeat(32), D_SIDE = "sha256:" + "0c".repeat(32);
const A = "000000000000";
const TD = (rev: number) => `arn:aws:ecs:ap-northeast-2:${A}:task-definition/shop-api:${rev}`;
const PLANT_PW = "Plant-pw-9f8e7d", PLANT_URL = `postgres://app:${PLANT_PW}@db.internal:5432/app`;

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply | ((line: string) => Reply)]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const r = typeof hit[1] === "function" ? hit[1](line) : hit[1];
    return { code: r.code ?? 0, stdout: JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const svc = (name: string, o: Record<string, unknown> = {}) => ({ serviceName: name, serviceArn: `arn:aws:ecs:ap-northeast-2:${A}:service/shop/${name}`,
  status: "ACTIVE", desiredCount: 2, launchType: "FARGATE", taskDefinition: TD(7), loadBalancers: [], deployments: [], ...o });
const tdef = (o: Record<string, unknown> = {}) => ({ taskDefinition: { family: "shop-api", cpu: "256", memory: "512",
  containerDefinitions: [{ name: "api", image: `${A}.dkr.ecr.ap-northeast-2.amazonaws.com/shop-api:latest`, essential: true,
    portMappings: [{ containerPort: 8080 }], environment: [{ name: "LOG_LEVEL", value: "info" }] }], ...o } });
const common = (services: unknown[], extra: Array<[RegExp, Reply | ((l: string) => Reply)]> = []): Array<[RegExp, Reply | ((l: string) => Reply)]> => [
  ...extra,
  [/^aws ecs list-clusters/, { out: { clusterArns: [`arn:aws:ecs:ap-northeast-2:${A}:cluster/shop`] } }],
  [/^aws ecs list-services/, { out: { serviceArns: (services as Array<{ serviceArn: string }>).map((s) => s.serviceArn) } }],
  [/^aws ecs describe-services/, (l) => ({ out: { services: (services as Array<{ serviceName: string }>).filter((s) => l.includes(`/${s.serviceName}`)) } })],
  [/^aws ecs describe-task-definition/, { out: tdef() }],
  [/^aws ecs list-tasks/, { out: { taskArns: [] } }],
  [/^aws application-autoscaling describe-scalable-targets/, { out: { ScalableTargets: [] } }],
];

test("서비스 0개: 클러스터는 있는데 서비스 없음 → items = 클러스터 한 줄, ecs.service 0. v2 discover 는 EKS 도 없으면 SOURCE_INCOMPLETE", async () => {
  const { exec } = fakeExec(common([]));
  const r = await readEcs({ exec, env: {} }, "ap-northeast-2", {});
  assert.deepEqual(r.items, [{ kind: "ecs.cluster", name: "shop" }]);
  assert.deepEqual(r.counts, { "ecs.service": 0 });
  const { exec: e2 } = fakeExec([[/^aws sts get-caller-identity/, { out: { Account: A } }], [/^aws eks list-clusters/, { out: { clusters: [] } }],
    [/^aws rds describe-db-instances/, { out: { DBInstances: [] } }], [/^aws (ec2|elbv2 describe-load-balancers|ecr|secretsmanager)/, { out: {} }], ...common([])]);
  await assert.rejects(discoverAws({ exec: e2, env: {} }, { ir: "v2" }),
    (e: unknown) => e instanceof AdapterError && e.code === "SOURCE_INCOMPLETE" && /ECS 서비스도 없음/.test(e.message));
});

test("서비스 0개 + INACTIVE 만: 지운 서비스(INACTIVE)는 서비스로 안 센다", async () => {
  const { exec } = fakeExec(common([svc("old", { status: "INACTIVE" })]));
  const r = await readEcs({ exec, env: {} }, "ap-northeast-2", {});
  assert.deepEqual(r.counts, { "ecs.service": 0 });
});

// 롤링 배포 중: 서비스의 작업 정의는 :7 인데 실행 중 작업 첫 줄은 옛 판(:6) → digest 는 :7 작업 것이어야 한다
function rolling(order: "oldFirst" | "newFirst", newDigests: string[] = [D_NEW]) {
  const tasks = [{ arn: "t-old", td: TD(6), d: D_OLD }, ...newDigests.map((d, i) => ({ arn: `t-new${i}`, td: TD(7), d }))];
  const list = order === "oldFirst" ? tasks : [...tasks].reverse();
  return common([svc("shop-api", { deployments: [{ status: "PRIMARY", taskDefinition: TD(7) }, { status: "ACTIVE", taskDefinition: TD(6) }] })], [
    [/^aws ecs list-tasks/, { out: { taskArns: list.map((t) => t.arn) } }],
    [/^aws ecs describe-tasks/, (l) => ({ out: { tasks: list.filter((t) => l.split(" ").includes(t.arn))
      .map((t) => ({ taskArn: t.arn, taskDefinitionArn: t.td, containers: [{ name: "api", imageDigest: t.d }] })) } })],
  ]);
}

test("작업 정의 여러 판(롤링 중): digest 는 서비스가 가리키는 판의 작업에서, 작업 목록 순서와 무관", async () => {
  for (const order of ["oldFirst", "newFirst"] as const) {
    const { exec } = fakeExec(rolling(order));
    const r = await readEcs({ exec, env: {} }, "ap-northeast-2", {});
    assert.equal((r.items[0] as { imageDigest: string }).imageDigest, D_NEW, order);
  }
});

test("거부: 같은 판 작업들이 digest 가 둘 이상(태그 다시 올림) → digest 를 고르지 않고 notes, 매퍼는 unmapped B", async () => {
  const { exec } = fakeExec(rolling("oldFirst", [D_NEW, "sha256:" + "0d".repeat(32)]));
  const r = await readEcs({ exec, env: {} }, "ap-northeast-2", {});
  assert.equal((r.items[0] as { imageDigest: string | null }).imageDigest, null);
  assert.ok(r.notes.some((n) => /digest 가 2개/.test(n)), r.notes.join("|"));
  const n = normalizeV2({ provider: "aws", coverage: {}, items: r.items as never }).result;
  assert.ok(n.unmapped.some((u) => u.grade === "B" && /digest/.test(u.reason)));
});

const sideRaw = (o: Record<string, unknown> = {}) => ({
  kind: "ecs.service", serviceName: "shop-api", clusterName: "shop", desiredCount: 3, imageDigest: D_NEW,
  taskDefinition: { cpu: "512", memory: "1024", containerDefinitions: [
    // 첫 컨테이너가 보조(essential false) → 주 컨테이너는 essential 인 api
    { name: "log-router", image: `public.ecr.aws/aws-observability/aws-for-fluent-bit@${D_SIDE}`, essential: false,
      environment: [{ name: "FLB_PASSWORD", value: PLANT_PW }, { name: "OUT", value: "cloudwatch" }],
      secrets: [{ name: "FLB_TOKEN", valueFrom: `arn:aws:ssm:ap-northeast-2:${A}:parameter/shop/flb/token` }] },
    { name: "api", image: `${A}.dkr.ecr.ap-northeast-2.amazonaws.com/shop-api:1.0`, essential: true, portMappings: [{ containerPort: 8080 }],
      environment: [{ name: "DATABASE_URL", value: PLANT_URL }, { name: "LOG_LEVEL", value: "info" }],
      secrets: [{ name: "DB_PASSWORD", valueFrom: `arn:aws:secretsmanager:ap-northeast-2:${A}:secret:shop-db:password::` }] },
    { name: "xray", image: "amazon/aws-xray-daemon:3", essential: false },
  ] }, ...o });

test("사이드카: 주 컨테이너 = 첫 essential, digest 있는 보조는 sidecars, 태그만 있는 보조는 빠지고 검토 표시", () => {
  const n = normalizeV2({ provider: "aws", coverage: {}, items: [sideRaw()] as never }).result;
  const api = n.spec.components.find((c) => c.id === "shop-api")!;
  assert.ok(api.kind === "service");
  assert.equal(api.props.image.digest, D_NEW);
  assert.deepEqual(api.props.sidecars?.map((s) => s.name), ["log-router"]);
  assert.equal(api.props.sidecars?.[0]?.image.digest, D_SIDE);
  assert.equal(n.fieldMeta["components.shop-api.sidecars"]?.confidence, 0.6);
});

test("비밀 env: 주·보조 컨테이너 평문 비밀(이름·값 둘 다 기준) 값이 명세·fieldMeta·unmapped 어디에도 없다, secrets 는 참조만", () => {
  const n = normalizeV2({ provider: "aws", coverage: {}, items: [sideRaw()] as never }).result;
  const all = JSON.stringify(n);
  assert.equal(all.includes(PLANT_PW), false, "평문 비밀 값이 결과에 남음");
  assert.equal(/arn:aws:(secretsmanager|ssm)/.test(all), false, "secrets ARN 이 명세에 남음");
  const api = n.spec.components.find((c) => c.id === "shop-api")!;
  assert.ok(api.kind === "service");
  assert.deepEqual(api.props.env.find((e) => e.name === "DB_PASSWORD"), { name: "DB_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } });
  assert.equal(api.props.env.some((e) => e.name === "DATABASE_URL"), false);
  assert.equal(api.props.sidecars?.[0]?.env.some((e) => e.name === "FLB_PASSWORD"), false);
  assert.deepEqual(api.props.sidecars?.[0]?.env, [{ name: "OUT", value: "cloudwatch" }, { name: "FLB_TOKEN", fromSecret: { secret: "token", key: "FLB_TOKEN" } }]);
  assert.ok(n.unmapped.some((u) => u.resource === "env:shop-api.DATABASE_URL"));
  assert.ok(n.unmapped.some((u) => u.resource === "env:shop-api.log-router.FLB_PASSWORD"));
  // 감사 판: 모든 컨테이너 env 값 지움
  const audit = JSON.stringify(inventoryForAudit({ provider: "aws", coverage: {}, items: [sideRaw()] as never }));
  assert.equal(audit.includes(PLANT_PW), false);
});

test("오토스케일 없음: replicas = desiredCount 고정, scale 없음. desiredCount 0(멈춘 서비스)도 명세가 통과", () => {
  for (const dc of [3, 0]) {
    const n = normalizeV2({ provider: "aws", coverage: {}, items: [sideRaw({ desiredCount: dc, autoscaling: null })] as never }).result;
    const api = n.spec.components.find((c) => c.id === "shop-api")!;
    assert.ok(api.kind === "service");
    assert.deepEqual(api.props.replicas, { min: dc, max: dc });
    assert.equal(api.props.scale, undefined);
    assert.equal(n.fieldMeta["components.shop-api.replicas"]?.source.endsWith(".desiredCount"), true);
    assert.equal(ImportResultV2.safeParse(n).success, true, `desiredCount ${dc}`);
    assert.deepEqual(checkV2(n.spec).errors, [], `desiredCount ${dc}`);
  }
});

test("결정성: 서비스·작업 목록 순서가 달라도 원본·명세가 글자 하나까지 같다", async () => {
  const s3 = [svc("b-svc"), svc("a-svc"), svc("c-svc")];
  const run = async (order: unknown[], tasksRev: boolean) => {
    const { exec } = fakeExec(common(order, [
      [/^aws ecs list-tasks/, { out: { taskArns: tasksRev ? ["t2", "t1"] : ["t1", "t2"] } }],
      [/^aws ecs describe-tasks/, (l) => ({ out: { tasks: ["t1", "t2"].filter((t) => l.split(" ").includes(t))
        .map((t) => ({ taskArn: t, taskDefinitionArn: TD(7), containers: [{ name: "api", imageDigest: D_NEW }] })) } })],
    ]));
    const r = await readEcs({ exec, env: {} }, "ap-northeast-2", {});
    return { raw: JSON.stringify(r), spec: JSON.stringify(normalizeV2({ provider: "aws", coverage: {}, items: r.items as never }).result) };
  };
  const a = await run(s3, false), b = await run([...s3].reverse(), true);
  assert.equal(a.raw, b.raw);
  assert.equal(a.spec, b.spec);
});

test("매퍼 거부: 컨테이너 0개·서비스 이름 없음 → C, 순수 함수(입력 안 바꿈)", () => {
  assert.deepEqual(ecsServiceMapper.map({ kind: "ecs.service", serviceName: "x", desiredCount: 1, taskDefinition: { containerDefinitions: [] } } as never),
    { skip: "컨테이너 없음", grade: "C" });
  assert.equal((ecsServiceMapper.map({ kind: "ecs.service", desiredCount: 1, taskDefinition: { containerDefinitions: [] } } as never) as { grade: string }).grade, "C");
  const raw = sideRaw(); const before = JSON.stringify(raw);
  ecsServiceMapper.map(raw as never);
  assert.equal(JSON.stringify(raw), before);
});

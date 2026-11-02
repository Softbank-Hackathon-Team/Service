// JOBBUILD: 관리형 앱(ECS·Cloud Run 도착)의 예약 잡 → root job_json (JobTfVars). k8s 도착은 지금처럼 Helm CronJob. 순수 함수, terraform 안 돌림
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, JobTfVars } from "@svc/contracts";
import {
  AdapterError, DEMO_INVENTORY_V2, identitiesOf, managedBlockers, managedJobVars, normalizeV2, requirementsV2, resourceTypesV2For, targetBuilderFor, UNSUPPORTED_V2, v2PrecheckItems,
} from "../src/index.js";

const T = { envId: "33333333-3333-4333-8333-333333333333", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" };
const at = (p: "aws" | "gcp" | "onprem") => ({ ...T, provider: p }) as never;
const D = "sha256:" + "c3".repeat(32);
const throwsUnsupported = (f: () => unknown, re: RegExp) =>
  assert.throws(f, (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2 && re.test(e.message));

type Comp = { id: string; kind: string; props: Record<string, unknown> };
const nightly = (over: Record<string, unknown> = {}): Comp => ({ id: "nightly", kind: "job", props: {
  image: { source: "registry", repository: "registry.example.com/shop/batch", digest: D },
  resources: { limit: { cpuMilli: 1000, memMiB: 1024 } },
  env: [{ name: "MODE", value: "nightly" }, { name: "DB_HOST", fromLink: { to: "shop-db", output: "host" } }, { name: "DB_URL", template: "${shop-db.url}" }],
  serviceAccount: "shop-api-task", schedule: "0 3 * * *", timeZone: "Asia/Seoul", backoffLimit: 2, activeDeadlineSec: 600, concurrencyPolicy: "Forbid",
  command: ["/bin/batch"], args: ["--all"], ...over } });
/** ECS 3티어 데모 + 잡. product 를 바꾸면 Cloud Run 출발 모양 (도착 Builder 는 origin.product 를 안 봄) */
function app(product: "ecs" | "cloudRun", job: Comp | null = nightly(), mutate?: (s: { components: Comp[] }) => void): AppSpecV2 {
  const s = structuredClone(normalizeV2(DEMO_INVENTORY_V2.aws!).result.spec) as unknown as { components: Comp[] };
  for (const c of s.components) if (c.kind === "service") c.props.origin = { runtime: "managedContainer", product };
  if (job) s.components.push(job);
  mutate?.(s);
  return AppSpecV2.parse(s);
}
const jobs = (vars: Record<string, unknown>) => (JSON.parse(vars.job_json as string) as unknown[]).map((x) => JobTfVars.parse(x));

test("정상: ECS 도착 잡 → aws job_json (JobTfVars 모양), kinds/job 인스턴스·모듈, env 의존성은 한 덩어리 자리표시, 결정적", () => {
  const spec = app("ecs");
  assert.deepEqual(managedBlockers(spec), []);
  assert.ok(requirementsV2(spec).includes("runtime.managedContainer") && !requirementsV2(spec).includes("runtime.k8s"), "관리형 앱의 잡 = 관리형 capability");
  const a = targetBuilderFor("aws").toTerraformV2(spec, at("aws")), b = targetBuilderFor("aws").toTerraformV2(spec, at("aws"));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.instances.some((i) => i.module === "aws/kinds/job" && i.id === "nightly"));
  assert.ok(a.modules.some((m) => m.path === "infra/modules/aws/kinds/job"));
  const [j, ...rest] = jobs(a.vars);
  assert.equal(rest.length, 0);
  assert.ok(j!.name.startsWith("app-") && j!.name.length <= 58, j!.name);
  assert.deepEqual({ ...j, name: "<n>", image: "<i>" }, {
    id: "nightly", name: "<n>", schedule: "0 3 * * *", time_zone: "Asia/Seoul", concurrency_policy: "Forbid", suspend: null,
    backoff_limit: 2, active_deadline_sec: 600, restart_policy: null, image: "<i>",
    command_json: JSON.stringify(["/bin/batch"]), args_json: JSON.stringify(["--all"]), cpu_milli: 1000, mem_mib: 1024,
    env_json: JSON.stringify([{ name: "MODE", value: "nightly" }, { name: "DB_HOST", value: "<tf-output:link.shop-db.host>" }, { name: "DB_URL", value: "<tf-output:link.shop-db.url>" }]),
    identity: "nightly",
  });
  assert.match(j!.image, /\.dkr\.ecr\.ap-northeast-2\.amazonaws\.com\/.*@sha256:[0-9a-f]{64}$/);
  // 신원: 같은 SA(shop-api-task)를 쓰던 서비스 shop-api 와 한 묶음, 묶음 id = 그 중 id 가 가장 앞선 것(nightly)
  assert.deepEqual(identitiesOf(spec).find((i) => i.id === "nightly")?.workloads, ["nightly", "shop-api"]);
  for (const r of ["aws_scheduler_schedule", "aws_ecs_task_definition", "aws_cloudwatch_log_group"]) assert.ok(resourceTypesV2For("aws", spec).includes(r), r);
  // 관리형 화면 값에 잡도 보임
  const v = targetBuilderFor("aws").toWorkloadValues(spec, {} as never, at("aws")) as { managedJobs?: unknown[] };
  assert.deepEqual(v.managedJobs, [{ id: "nightly", runtime: "ecs-scheduled", schedule: "0 3 * * *" }]);
});

test("정상: Cloud Run 도착 잡 → gcp job_json, 이름 49자 소문자 규칙, kinds/job, 잡 없으면 job_json 키 자체가 없음(기존 지문)", () => {
  const spec = app("cloudRun");
  const a = targetBuilderFor("gcp").toTerraformV2(spec, at("gcp"));
  const j = jobs(a.vars)[0]!;
  assert.match(j.name, /^app-[a-z0-9-]*[a-z0-9]$/);
  assert.ok(j.name.length <= 49);
  assert.equal(j.schedule, "0 3 * * *");
  assert.equal(JSON.parse(j.env_json)[1].value, "<tf-output:link.shop-db.host>");
  assert.ok(a.instances.some((i) => i.module === "gcp/kinds/job" && i.id === "nightly"));
  for (const r of ["google_cloud_run_v2_job", "google_cloud_scheduler_job"]) assert.ok(resourceTypesV2For("gcp", spec).includes(r), r);
  const none = targetBuilderFor("gcp").toTerraformV2(app("cloudRun", null), at("gcp"));
  assert.equal("job_json" in none.vars, false);
  assert.ok(!resourceTypesV2For("gcp", app("cloudRun", null)).includes("google_cloud_scheduler_job"));
});

test("k8s 도착은 그대로: 관리형 서비스가 없는 앱의 잡은 Helm CronJob (job_json 없음, runtime.k8s)", () => {
  const spec = app("ecs", nightly(), (s) => { for (const c of s.components) if (c.kind === "service") { c.props.runtime = "k8s"; c.props.origin = { runtime: "k8s", product: "eks" }; } });
  assert.ok(requirementsV2(spec).includes("runtime.k8s"));
  const a = targetBuilderFor("aws").toTerraformV2(spec, at("aws"));
  assert.equal("job_json" in a.vars, false);
  assert.ok(!a.instances.some((i) => i.module.endsWith("kinds/job")));
});

test("거부: schedule 이 옮길 수 없는 cron(6필드·요일 간격·날짜+요일)·비밀 env·조각 template → precheck block + Builder UNSUPPORTED_V2", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ schedule: "0 0 3 * * *" }, /cron 5필드/],
    [{ schedule: "0 3 * * 1/2" }, /요일 칸의 간격/],
    [{ schedule: "0 3 1 * 1" }, /날짜 칸과 요일 칸/],
    [{ env: [{ name: "PW", fromSecret: { secret: "shop-db", key: "password" } }] }, /fromSecret/],
    [{ env: [{ name: "URL", template: "postgres://${shop-db.host}:${shop-db.port}/x" }] }, /template/],
  ];
  for (const [over, re] of cases) {
    const spec = app("ecs", nightly(over));
    assert.ok(managedBlockers(spec).some((m) => /nightly 관리형 예약 잡/.test(m) && re.test(m)), `${JSON.stringify(over)} → ${managedBlockers(spec).join(" | ")}`);
    for (const p of ["aws", "gcp"] as const) throwsUnsupported(() => targetBuilderFor(p).toTerraformV2(spec, at(p)), /nightly 관리형 예약 잡/);
    assert.ok(v2PrecheckItems("aws", { spec: null, specV2: spec, hadV2Before: false }).some((i) => i.level === "block" && /nightly/.test(i.message)));
  }
  // 온프레(관리형 capability 없음)는 관리형 앱 전체가 막힘 (잡만 따로 새지 않음)
  throwsUnsupported(() => targetBuilderFor("onprem").toTerraformV2(app("ecs"), at("onprem")), /./);
});

test("거부: schedule 없음 → 계약이 막음 / IR id 겹침 → Builder 가 job_json 을 안 만듦", () => {
  assert.equal(AppSpecV2.safeParse({ ...(app("ecs", null) as object), components: [...app("ecs", null).components, { ...nightly(), props: { ...nightly().props, schedule: undefined } }] }).success, false);
  const spec = app("ecs");
  const dup = { ...spec, components: [...spec.components, { ...structuredClone(spec.components.find((c) => c.id === "nightly")!) }] } as AppSpecV2;
  throwsUnsupported(() => managedJobVars("aws", dup, at("aws"), (s) => s), /nightly 가 겹침/);
  const dup2 = { ...spec, components: spec.components.map((c) => (c.id === "nightly" ? { ...c, id: "shop-db" } : c)) } as AppSpecV2;
  throwsUnsupported(() => managedJobVars("gcp", dup2, at("gcp"), (s) => s), /shop-db 가 겹침/);
});

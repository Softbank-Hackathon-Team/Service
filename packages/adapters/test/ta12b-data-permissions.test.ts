// TA12b: 데이터 자원 — 실행 역할 정책(최소 권한·접두어 범위)·세션 정책 크기/부분집합·GCP 천장, 가짜 tf 출력 → deploy 값 연결
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppSpecV2, LINK_OUTPUTS, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor } from "../src/index.js";
import { stubTfOutputsV2 } from "../src/target/plan-v2.js";

const dir = new URL("../../../infra/permissions/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
type Stmt = { Sid?: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string>> };
const arr = (x: string | string[]) => (Array.isArray(x) ? x : [x]);
const st = (f: string) => (JSON.parse(read(f)) as { Statement: Stmt[] }).Statement;
const acts = (f: string) => new Set(st(f).flatMap((s) => arr(s.Action)));

const NEW_AWS = ["elasticache:CreateReplicationGroup", "elasticache:DeleteReplicationGroup", "s3:CreateBucket", "s3:DeleteBucket", "sqs:CreateQueue", "sqs:DeleteQueue", "sns:CreateTopic", "sns:DeleteTopic"];

test("AWS 실행 역할: 데이터 자원 동작이 들어 있고 와일드카드 action 0, 쓰기는 app-* 이름 자원에만", () => {
  const all = acts("aws-operate-role-policy.json");
  for (const a of NEW_AWS) assert.ok(all.has(a), a);
  for (const s of st("aws-operate-role-policy.json")) for (const a of arr(s.Action)) assert.ok(!a.includes("*"), a);
  const scoped = st("aws-operate-role-policy.json").find((s) => s.Sid === "DataScoped")!;
  assert.ok(arr(scoped.Resource).every((r) => r !== "*"));
  for (const r of arr(scoped.Resource).filter((x) => !x.includes("parametergroup"))) assert.match(r, /app-\*(\/\*)?$/, r);
  assert.equal(scoped.Condition?.StringEquals?.["aws:RequestedRegion"], "ap-northeast-2");
  // Resource "*" 인 데이터 문장은 읽기(Describe)만
  const d = st("aws-operate-role-policy.json").find((s) => s.Sid === "DataDescribe")!;
  assert.equal(d.Resource, "*");
  assert.ok(arr(d.Action).every((a) => /^elasticache:Describe/.test(a)));
});

test("AWS 세션 정책: 단계별로 맞는 동작만 (plan 은 읽기뿐, destroy 는 삭제, apply 는 생성), 2,048자 이내, 역할 정책의 부분집합", () => {
  const role = new Set([...acts("aws-operate-role-policy.json"), ...acts("aws-operate-db-kms-policy.json")]);   // 실행 역할 = 관리형 정책 + 인라인 db-kms (KMS 는 관리형 정책 한도 때문에 인라인, export-permissions)
  for (const p of ["plan", "apply", "destroy"]) {
    const f = `aws-session-policy-${p}.json`;
    // 보내는 판(security compactSessionPolicy)이 2,048자 - 여유 300 이내인지는 security z39-evidence 시험이 본다. 파일(하나하나 적은 판)은 6,144자 상한
    assert.ok(JSON.stringify(JSON.parse(read(f))).length <= 6144, `${p} 길이`);
    assert.deepEqual([...acts(f)].filter((a) => !role.has(a)), [], `${p} 부분집합`);
  }
  const plan = acts("aws-session-policy-plan.json"), apply = acts("aws-session-policy-apply.json"), destroy = acts("aws-session-policy-destroy.json");
  assert.ok([...plan].every((a) => /:(Describe|Get|List)/.test(a)));
  assert.ok(apply.has("s3:CreateBucket") && !plan.has("s3:CreateBucket") && !apply.has("s3:DeleteBucket"));
  assert.ok(destroy.has("s3:DeleteBucket") && destroy.has("sqs:DeleteQueue") && !destroy.has("sqs:CreateQueue"));
});

test("어댑터 권한표 ↔ 정책 파일: v2 데이터 명세의 apply/destroy 동작이 전부 실행 역할 정책(천장) 안에 있음 (AWS)", () => {
  const role = new Set([...acts("aws-operate-role-policy.json"), ...acts("aws-operate-db-kms-policy.json")]);   // 실행 역할 = 관리형 정책 + 인라인 db-kms (KMS 는 관리형 정책 한도 때문에 인라인, export-permissions)
  const spec = dataSpec();
  for (const purpose of ["plan", "apply", "destroy"] as const) {
    const missing = targetBuilderFor("aws").operateActionsV2(spec, purpose).filter((a) => !role.has(a));
    // iam·ec2 등 기존 동작은 v1 과 같은 천장에 이미 있음 → 데이터 자원 동작이 빠지면 여기서 걸림
    assert.deepEqual(missing, [], purpose);
  }
});

test("GCP 천장: 데이터 자원 권한이 들어 있고 와일드카드·금지 권한 없음, 어댑터 권한표와 일치", () => {
  const role = new Set(read("gcp-operate-custom-role.yaml").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()));
  for (const a of ["redis.instances.create", "storage.buckets.create", "pubsub.topics.create", "pubsub.topics.attachSubscription", "pubsub.subscriptions.delete"]) assert.ok(role.has(a), a);
  for (const a of role) assert.ok(!a.includes("*") && !/setIamPolicy|secretmanager\.versions\.access/.test(a), a);
  for (const purpose of ["plan", "apply", "destroy"] as const)
    assert.deepEqual(targetBuilderFor("gcp").operateActionsV2(dataSpec(), purpose).filter((a) => !role.has(a) && !a.endsWith(".setIamPolicy")), [], purpose);   // setIamPolicy 는 별도 조건부 역할
});

// ── 가짜 tf 출력 ──
// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
function dataSpec(): AppSpecV2 {
  const s: any = structuredClone(BASE);
  const svc = s.components.find((c: any) => c.kind === "service");
  svc.props.env.push({ name: "REDIS_URL", template: "${shop-cache.url}" }, { name: "BUCKET", fromLink: { to: "shop-assets", output: "name" } },
    { name: "QUEUE_URL", fromLink: { to: "orders", output: "url" } }, { name: "REDIS_HOST", fromLink: { to: "shop-cache", output: "host" } });
  s.components.push(
    { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 512, tls: true, auth: true } },
    { id: "shop-assets", kind: "objectStore", props: { versioning: false, public: false, sizeGb: 1 } },
    { id: "orders", kind: "queue", props: { model: "queue" } });
  for (const to of ["shop-cache", "shop-assets", "orders"]) s.links.push({ from: svc.id, to, intent: "connect" });
  return AppSpecV2.parse(s);
}

test("stubTfOutputsV2: 데이터 자원마다 LINK_OUTPUTS 표의 출력 전부 (이름 모양·결정적), 없는 출력은 안 만듦", () => {
  const spec = dataSpec(), out = stubTfOutputsV2(spec);
  for (const c of spec.components.filter((x) => x.kind === "cache" || x.kind === "objectStore" || x.kind === "queue"))
    for (const o of (LINK_OUTPUTS as Record<string, readonly string[]>)[c.kind]!) assert.ok(out[`link.${c.id}.${o}`], `${c.id}.${o}`);
  assert.match(out["link.shop-cache.url"]!, /^rediss:\/\/stub-shop-cache\.cache\.target\.internal:6379$/);
  assert.equal(out["link.shop-cache.port"], "6379");
  assert.equal(out["link.shop-cache.user"], undefined);
  assert.deepEqual(out, stubTfOutputsV2(dataSpec()));
  // tls=false 면 redis://
  const s2: any = structuredClone(spec); s2.components.find((c: any) => c.id === "shop-cache").props.tls = false;
  assert.match(stubTfOutputsV2(AppSpecV2.parse(s2))["link.shop-cache.url"]!, /^redis:\/\//);
});

for (const p of ["aws", "gcp"] as const) {
  test(`${p}: stub 출력 → 앱 env 에 꽂힘 (template·fromLink 모두 실제 값으로, 자리표시 안 남음)`, () => {
    const spec = dataSpec(), out = stubTfOutputsV2(spec);
    const v: any = targetBuilderFor(p).toWorkloadValues(spec, out, T(p));
    const env = v.workloads.find((w: any) => w.name === spec.components.find((c) => c.kind === "service")!.id).env as Array<{ name: string; value?: string }>;
    const val = (n: string) => env.find((e) => e.name === n)?.value;
    assert.equal(val("REDIS_URL"), out["link.shop-cache.url"]);
    assert.equal(val("REDIS_HOST"), out["link.shop-cache.host"]);
    assert.equal(val("BUCKET"), out["link.shop-assets.name"]);
    assert.equal(val("QUEUE_URL"), out["link.orders.url"]);
    assert.ok(!JSON.stringify(v).includes("<tf-output:link."), "데이터 link 자리표시가 남음");   // (db_master_secret_arn 같은 다른 출력은 이 stub 범위 밖)
  });

  test(`${p} 거부: stub 출력이 없으면 데이터 link env 는 지어낸 값이 아니라 <tf-output:link.…> 자리표시 그대로 (deploy 가 못 풀면 알 수 있음)`, () => {
    const v: any = targetBuilderFor(p).toWorkloadValues(dataSpec(), {}, T(p));
    const env = v.workloads.find((w: any) => w.env.some((e: any) => e.name === "REDIS_URL")).env as Array<{ name: string; value?: string }>;
    assert.equal(env.find((e) => e.name === "REDIS_URL")?.value, "<tf-output:link.shop-cache.url>");
    assert.equal(env.find((e) => e.name === "BUCKET")?.value, "<tf-output:link.shop-assets.name>");
  });
}

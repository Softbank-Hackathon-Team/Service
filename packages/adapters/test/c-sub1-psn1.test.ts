// SUB-1: 구독 목록(topic 모델)의 구독 이름을 적은 env → fromLink.subscription → 도착 구독 이름 출력.
// PSN-1: Pub/Sub 짧은 이름을 적은 env 는 url 이 아니라 name 출력으로 (SQS 큐 URL 은 그대로 url)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppSpecV2, ImportResultV2, checkV2, type RawInventory, type TargetEnv } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor } from "../src/index.js";
import { k8sEnv } from "../src/target/shared.js";

type Raw = Record<string, any>;
const D = "sha256:" + "a".repeat(64);
const inv = (provider: "aws" | "gcp", items: Raw[]): RawInventory => ({ provider, coverage: {}, items } as unknown as RawInventory);
const dep = (name: string, env: Raw[]): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const sub = (n: string): Raw => ({ name: `projects/p/subscriptions/${n}`, ackDeadlineSeconds: 30, expirationPolicy: {} });
const topic = (n: string, subs: Raw[]): Raw => ({ kind: "pubsub.topic", name: `projects/p/topics/${n}`, subscriptions: subs });
const T = { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp", region: "default", migrationId: "44444444-4444-4444-8444-444444444444" } as TargetEnv;
const envOf = (spec: AppSpecV2, id: string, name: string) =>
  ((spec.components.find((c) => c.id === id)!.props as { env: Raw[] }).env).find((e) => e.name === name)!;

test("SUB-1: 구독 둘인 토픽 — 구독 이름 env 는 fromLink.subscription, 토픽 이름 env 는 name → 도착은 모듈 출력 sub.<출발 구독> 을 읽음", () => {
  const { result } = normalizeV2(inv("gcp", [
    topic("orders", [sub("orders-billing"), sub("orders-mail")]),
    dep("worker", [{ name: "SUB", value: "orders-billing" }, { name: "TOPIC", value: "orders" }]),
  ]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.deepEqual(envOf(result.spec, "worker", "SUB"), { name: "SUB", fromLink: { to: "orders", output: "name", subscription: "orders-billing" } });
  assert.deepEqual(envOf(result.spec, "worker", "TOPIC"), { name: "TOPIC", fromLink: { to: "orders", output: "name" } }, "PSN-1: 짧은 이름 → name");
  assert.ok(result.spec.links.some((l) => l.from === "worker" && l.to === "orders"));
  // 도착: env 값 = 루트 출력 link.orders.sub.orders-billing 자리표시, 구독 목록 변수엔 출발 이름(source)
  const e = k8sEnv(result.spec, envOf(result.spec, "worker", "SUB") as never, { namespace: "shop", out: {} });
  assert.equal(e.value, "<tf-output:link.orders.sub.orders-billing>");
  assert.equal(k8sEnv(result.spec, envOf(result.spec, "worker", "SUB") as never, { namespace: "shop", out: { "link.orders.sub.orders-billing": "app-orders-1a2b3c" } }).value, "app-orders-1a2b3c");
  const q = (JSON.parse(String(targetBuilderFor("gcp").toTerraformV2(result.spec, T).vars.queue_json)) as Raw[])[0]!;
  assert.deepEqual((JSON.parse(q.subscriptions_json) as Raw[]).map((s) => s.source), ["orders-billing", "orders-mail"]);
  const mod = readFileSync(new URL("../../../infra/modules/gcp/kinds/queue/main.tf", import.meta.url), "utf8");
  assert.match(mod, /"sub\.\$\{s\.source\}" => google_pubsub_subscription\.extra\[s\.name\]\.name/);
});

test("PSN-1: SQS 큐 URL 을 적은 env 는 그대로 url, Pub/Sub 구독 하나(model=queue) 의 구독 이름은 name", () => {
  const url = "https://sqs.ap-northeast-2.amazonaws.com/000000000000/jobs";
  const a = normalizeV2(inv("aws", [{ kind: "sqs.queue", QueueUrl: url, Attributes: { QueueArn: "arn:aws:sqs:ap-northeast-2:000000000000:jobs" } },
    dep("worker", [{ name: "QUEUE_URL", value: url }])])).result;
  assert.deepEqual(envOf(a.spec, "worker", "QUEUE_URL"), { name: "QUEUE_URL", fromLink: { to: "jobs", output: "url" } });
  const g = normalizeV2(inv("gcp", [topic("jobs", [sub("jobs-worker")]), dep("worker", [{ name: "SUB", value: "jobs-worker" }])])).result;
  assert.deepEqual(envOf(g.spec, "worker", "SUB"), { name: "SUB", fromLink: { to: "jobs", output: "name" } }, "구독 하나 = 도착 구독 이름 = 토픽 이름(name)");
});

test("거부: 구독 목록에 없는 이름·url 출력·queue 아닌 대상의 subscription 은 checkV2 오류, 구독 이름이 값 일부면 자리 못 정함 검토", () => {
  const { result } = normalizeV2(inv("gcp", [
    topic("orders", [sub("orders-billing"), sub("orders-mail")]),
    dep("worker", [{ name: "SUB", value: "orders-billing" }, { name: "SUB_PATH", value: "orders-billing,orders-mail" }]),
  ]));
  const spec = structuredClone(result.spec) as unknown as Raw;
  const w = spec.components.find((c: Raw) => c.id === "worker");
  w.props.env = w.props.env.map((e: Raw) => e.name === "SUB" ? { name: "SUB", fromLink: { to: "orders", output: "name", subscription: "nope" } } : e);
  assert.ok(checkV2(AppSpecV2.parse(spec)).errors.some((x) => /구독 nope/.test(x)));
  w.props.env = w.props.env.map((e: Raw) => e.name === "SUB" ? { name: "SUB", fromLink: { to: "orders", output: "url", subscription: "orders-billing" } } : e);
  assert.ok(checkV2(AppSpecV2.parse(spec)).errors.some((x) => /구독 orders-billing/.test(x)));
  // 값 일부(템플릿) 자리는 구독 이름을 못 적음 → 값 그대로 + 검토
  const p = envOf(result.spec, "worker", "SUB_PATH");
  if ("value" in p) assert.equal(result.fieldMeta["components.worker.env.SUB_PATH"]?.needs_review, true);
  else assert.fail(`템플릿으로 바뀌면 안 됨: ${JSON.stringify(p)}`);
});

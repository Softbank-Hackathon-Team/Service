// G3c-3: env 한 줄 신뢰도는 그 줄이 맞은 근거만 (링크 신뢰도로 안 올림). 큐는 이름으로 맞았으면 name, url 로 맞았으면 url
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";

const D = "sha256:" + "ab".repeat(32);
const NS = "shop";
type Raw = Record<string, any>;
const dep = (name: string, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const svc = (name: string): Raw => ({ kind: "k8s.service", metadata: { name, namespace: NS }, spec: { selector: { app: name }, ports: [{ port: 8080, targetPort: 8080 }] } });
const inv = (provider: RawInventory["provider"], items: Raw[]): RawInventory => ({ provider, coverage: {}, items: items as RawInventory["items"] });
const envOf = (spec: { components: Array<{ id: string; props: unknown }> }, id: string) =>
  Object.fromEntries(((spec.components.find((c) => c.id === id)!.props as { env: Raw[] }).env).map((e) => [e.name, e]));

test("거부: 같은 링크에 확실한 근거가 있어도 맨 이름(ROLE=worker) 줄은 0.9 검토 표시가 남는다", () => {
  const { result } = normalizeV2(inv("onprem", [
    dep("api", [{ name: "UPSTREAM", value: "http://worker.shop.svc:8080" }, { name: "ROLE", value: "worker" }]), dep("worker"), svc("worker"), svc("api")]));
  assert.equal(result.fieldMeta["links.api->worker"]?.confidence, 1, "준비: 링크는 확실");
  assert.equal(result.fieldMeta["components.api.env.UPSTREAM"]?.needs_review, false);
  const role = result.fieldMeta["components.api.env.ROLE"];
  assert.equal(role?.confidence, 0.9);
  assert.equal(role?.needs_review, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
});

test("정상: Pub/Sub 토픽 이름으로 맞은 env 는 출력 name (url 아님), SQS url 은 url", () => {
  const ps = normalizeV2(inv("gcp", [dep("api", [{ name: "TOPIC", value: "orders" }]),
    { kind: "pubsub.topic", name: "projects/p/topics/orders", messageRetentionDuration: "86400s" }]));
  assert.deepEqual(envOf(ps.result.spec, "api").TOPIC.fromLink, { to: "orders", output: "name" });
  assert.deepEqual(checkV2(ps.result.spec).errors, []);
  const url = "https://sqs.ap-northeast-2.amazonaws.com/000000000000/jobs";
  const sq = normalizeV2(inv("aws", [dep("api", [{ name: "QUEUE_URL", value: url }]),
    { kind: "sqs.queue", QueueUrl: url, Attributes: { QueueArn: "arn:aws:sqs:ap-northeast-2:000000000000:jobs" } }]));
  assert.deepEqual(envOf(sq.result.spec, "api").QUEUE_URL.fromLink, { to: "jobs", output: "url" });
});

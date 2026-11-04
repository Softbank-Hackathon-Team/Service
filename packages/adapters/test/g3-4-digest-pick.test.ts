// G3-4: 이미지 digest 를 "라벨이 맞는 아무 파드"가 아니라 지금 판(가장 큰 revision 의 ReplicaSet) 파드·가장 최근 Job 파드에서 고른다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { DIGEST, fakeExec, type Reply } from "./fake-cli.js";

const OLD = DIGEST("1"), NEW = DIGEST("2"), CANARY = DIGEST("3");
const dep = { metadata: { name: "api", namespace: "shop" }, spec: { replicas: 2, selector: { matchLabels: { app: "api" } },
  template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: "ghcr.io/demo/api:latest" }] } } } };
const pod = (name: string, rs: string, d: string, extra: Record<string, string> = {}) => ({
  metadata: { name, namespace: "shop", labels: { app: "api", ...extra }, ownerReferences: [{ kind: "ReplicaSet", name: rs }] },
  status: { containerStatuses: [{ name: "api", imageID: `ghcr.io/demo/api@${d}` }] } });
const rs = (name: string, owner: string, rev: string) => ({ metadata: { name, namespace: "shop", annotations: { "deployment.kubernetes.io/revision": rev },
  ownerReferences: [{ kind: "Deployment", name: owner }] } });
const table = (pods: unknown[], rss: Reply, crons: unknown[] = []): Array<[RegExp, Reply]> => [
  [/^kubectl get deployments/, { out: { items: [dep] } }],
  [/^kubectl get pods/, { out: { items: pods } }],
  [/^kubectl get replicasets/, rss],
  [/^kubectl get cronjobs/, { out: { items: crons } }],
];
const digestOf = async (t: Array<[RegExp, Reply]>) => {
  const { exec } = fakeExec(t);
  const r = await readK8sNamespace({ exec, env: {} }, []);
  return r.items.find((i) => i.kind === "k8s.deployment") as unknown as { imageDigest: string | null; digestReview?: string };
};

test("G3-4: 롤링 중(옛 판 파드가 이름순 앞) → 가장 큰 revision 의 ReplicaSet 파드 digest, 검토 없음", async () => {
  const d = await digestOf(table([pod("api-a-1", "api-a", OLD), pod("api-b-1", "api-b", NEW)],
    { out: { items: [rs("api-a", "api", "3"), rs("api-b", "api", "4"), rs("canary-x", "api-canary", "9")] } }));
  assert.equal(d.imageDigest, NEW);
  assert.equal(d.digestReview, undefined);
});

test("G3-4: 라벨이 같은 카나리 Deployment 파드는 섞이지 않는다", async () => {
  const d = await digestOf(table([pod("api-canary-1", "canary-x", CANARY, { track: "canary" }), pod("api-b-1", "api-b", NEW)],
    { out: { items: [rs("api-b", "api", "4"), rs("canary-x", "api-canary", "9")] } }));
  assert.equal(d.imageDigest, NEW);
});

test("G3-4: ReplicaSet 을 못 읽고 파드끼리 digest 가 다르면 → 지어내지 않고 신뢰도 0.6 검토", async () => {
  const t = table([pod("api-a-1", "api-a", OLD), pod("api-b-1", "api-b", NEW), pod("api-b-2", "api-b", NEW)], { code: 1, err: "Error from server (Forbidden): replicasets is forbidden" });
  const d = await digestOf(t);
  assert.equal(d.imageDigest, NEW, "가장 많은 것");
  assert.match(d.digestReview ?? "", /2가지/);
  const { exec } = fakeExec(t);
  const inv = await readK8sNamespace({ exec, env: {} }, []);
  const r = normalizeV2({ provider: "onprem", items: inv.items, coverage: {} }).result;
  const meta = Object.entries(r.fieldMeta).find(([k]) => k.endsWith(".image"))?.[1];
  assert.equal(meta?.confidence, 0.6);
  assert.equal(meta?.needs_review, true);
});

test("G3-4: CronJob 은 가장 최근 Job 파드의 digest (남은 옛 Job 파드가 목록 앞이어도)", async () => {
  const cron = { metadata: { name: "nightly", namespace: "shop" }, spec: { schedule: "0 3 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "c", image: "ghcr.io/demo/c:latest" }] } } } } } };
  const jp = (job: string, d: string) => ({ metadata: { name: `${job}-x`, namespace: "shop", labels: { "job-name": job } }, status: { containerStatuses: [{ name: "c", imageID: `ghcr.io/demo/c@${d}` }] } });
  const { exec } = fakeExec(table([jp("nightly-28000000", OLD), jp("nightly-28001440", NEW)], { out: { items: [] } }, [cron]));
  const r = await readK8sNamespace({ exec, env: {} }, []);
  const c = r.items.find((i) => i.kind === "k8s.cronjob") as unknown as { imageDigest: string | null };
  assert.equal(c.imageDigest, NEW);
});

test("G3-4: 컨테이너 이름이 안 맞는 파드의 첫 컨테이너(사이드카) digest 를 쓰지 않는다", async () => {
  const side = { metadata: { name: "api-b-1", namespace: "shop", labels: { app: "api" }, ownerReferences: [{ kind: "ReplicaSet", name: "api-b" }] },
    status: { containerStatuses: [{ name: "envoy", imageID: `envoy@${CANARY}` }] } };
  const d = await digestOf(table([side], { out: { items: [rs("api-b", "api", "1")] } }));
  assert.equal(d.imageDigest, null);
});

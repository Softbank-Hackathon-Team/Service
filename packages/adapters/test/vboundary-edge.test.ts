// VBOUNDARY: BOUNDARY(5b 앱 경계) + PARTOF(3b 앱 묶음)의 빈틈 시험 — 경계값·불변식·순서 무관·여러 앱이 같이 쓰는 자원. 순수 함수
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/index.js";

type Raw = Record<string, any>;
const NS = "shop";
const D = "sha256:" + "ab".repeat(32);
const ACC = "000000000000";
const inv = (items: Raw[]): RawInventory => ({ provider: "aws", coverage: {}, items });
const P = "app.kubernetes.io/part-of", N = "app.kubernetes.io/name";
const dep = (name: string, labels: Record<string, string> = {}, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name, ...labels } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const cron = (name: string, labels: Record<string, string>, env: Raw[] = []): Raw => ({ kind: "k8s.cronjob", imageDigest: D, metadata: { name, namespace: NS, labels },
  spec: { schedule: "0 3 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, env }] } } } } } });
const bucket = (name: string): Raw => ({ kind: "s3.bucket", Name: name, Arn: `arn:aws:s3:::${name}` });
const queue = (name: string, dlq?: string): Raw => ({ kind: "sqs.queue", QueueUrl: `https://sqs.ap-northeast-2.amazonaws.com/${ACC}/${name}`,
  Attributes: { QueueArn: `arn:aws:sqs:ap-northeast-2:${ACC}:${name}`, ...(dlq ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:ap-northeast-2:${ACC}:${dlq}`, maxReceiveCount: 3 }) } : {}) } });
const rds = (id: string): Raw => ({ kind: "rds.dbInstance", DBInstanceIdentifier: id, Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20,
  Endpoint: { Address: `${id}.abc.ap-northeast-2.rds.amazonaws.com` }, DBInstanceArn: `arn:aws:rds:ap-northeast-2:${ACC}:db:${id}` });
const ids = (r: ImportResultV2) => r.spec.components.map((c) => c.id).sort();
const outs = (r: ImportResultV2) => (r.outOfBoundary ?? []).map((o) => o.resource);
const bucketEnv = (b: string) => [{ name: "BUCKET", value: `s3://${b}` }];

/** 불변식: 결과의 fieldMeta 키는 전부 살아 있는 components·links 를 가리키고, 계약·검사를 통과한다 */
function invariants(r: ImportResultV2, label: string) {
  const comp = new Set(r.spec.components.map((c) => c.id));
  const links = new Set(r.spec.links.map((l) => `${l.from}->${typeof l.to === "string" ? l.to : ""}`));
  for (const k of Object.keys(r.fieldMeta)) {
    const m = /^components\.([^.]+)(\.|$)/.exec(k);
    if (m) assert.ok(comp.has(m[1]!), `${label}: 없는 구성요소를 가리키는 fieldMeta 키 ${k}`);
    if (k.startsWith("links.")) assert.ok(links.has(k.slice(6)) || [...links].some((l) => k === `links.${l}`), `${label}: 없는 링크를 가리키는 fieldMeta 키 ${k}`);
  }
  for (const l of r.spec.links) {
    assert.ok(comp.has(l.from), `${label}: 링크 from ${l.from} 없음`);
    if (typeof l.to === "string") assert.ok(comp.has(l.to), `${label}: 링크 to ${l.to} 없음`);
  }
  for (const o of r.outOfBoundary ?? []) assert.ok(![...comp].some((c) => o.resource.endsWith(`:${c}`) && r.spec.components.find((x) => x.id === c)), `${label}: 경계 밖인데 명세에도 있음 ${o.resource}`);
  assert.deepEqual(checkV2(r.spec).errors, [], label);
  assert.ok(ImportResultV2.safeParse(r).success, label);
}

test("불변식: 여러 모양(섞인 앱·DLQ·점 든 버킷 이름·DB 예외·입력 partOf) 어디서도 fieldMeta 에 없는 구성요소·링크가 안 남는다", () => {
  const mixed = (): Raw[] => [
    dep("shop-api", { [P]: "shop" }, [...bucketEnv("shop.assets.v2"), { name: "JOBS", value: `https://sqs.ap-northeast-2.amazonaws.com/${ACC}/shop-jobs` }, { name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }]),
    dep("blog-api", { [P]: "blog" }, bucketEnv("blog-media")), dep("shop-web", { [P]: "shop" }),
    bucket("shop.assets.v2"), bucket("blog-media"), bucket("acme-terraform-state"), queue("shop-jobs", "shop-jobs-dlq"), queue("shop-jobs-dlq"), queue("blog-q"), rds("shop-db"), rds("blog-db")];
  for (const [label, opts] of [["입력 없음", undefined], ["partOf=shop", { partOf: "shop" }], ["partOf=blog", { partOf: "blog" }], ["partOf=없는앱", { partOf: "nope" }]] as const)
    invariants(normalizeV2(inv(mixed()), opts as never).result, label);
});

test("순서 무관: 원본 항목 순서를 뒤집거나 섞어도 구성요소·링크·경계 밖 목록·fieldMeta 가 같다 (묶음 선택·경계 둘 다)", () => {
  const items = (): Raw[] => [
    dep("shop-api", { [P]: "shop" }, bucketEnv("shop-assets")), dep("shop-web", { [P]: "shop" }), cron("shop-cleanup", { [P]: "shop" }),
    dep("blog-api", { [P]: "blog" }, bucketEnv("blog-media")), dep("docs", { [P]: "docs" }),
    bucket("shop-assets"), bucket("blog-media"), bucket("tfstate"), queue("q1", "q2"), queue("q2")];
  const base = JSON.stringify(normalizeV2(inv(items())).result);
  const rev = JSON.stringify(normalizeV2(inv(items().reverse())).result);
  const rot = JSON.stringify(normalizeV2(inv([...items().slice(4), ...items().slice(0, 4)])).result);
  assert.equal(rev, base);
  assert.equal(rot, base);
});

test("같이 쓰는 자원: shop 과 blog 가 같은 버킷을 쓰면 어느 앱을 골라도 그 버킷은 경계 안 (근거는 고른 앱의 워크로드)", () => {
  const items = (): Raw[] => [dep("shop-api", { [P]: "shop" }, bucketEnv("shared-assets")), dep("shop-web", { [P]: "shop" }),
    dep("blog-api", { [P]: "blog" }, bucketEnv("shared-assets")), bucket("shared-assets")];
  const shop = normalizeV2(inv(items()), { partOf: "shop" }).result, blog = normalizeV2(inv(items()), { partOf: "blog" }).result;
  assert.deepEqual(ids(shop), ["shared-assets", "shop-api", "shop-web"]);
  assert.deepEqual(ids(blog), ["blog-api", "shared-assets"]);
  assert.equal(shop.fieldMeta["components.shared-assets.boundary"]?.source, "boundary:shop-api:env:BUCKET");
  assert.equal(blog.fieldMeta["components.shared-assets.boundary"]?.source, "boundary:blog-api:env:BUCKET");
  invariants(shop, "shop"); invariants(blog, "blog");
});

test("DLQ: 서로를 가리키는 큐(q1↔q2)에서도 끝나고 둘 다 경계 안 / 경계 밖 큐의 DLQ 대상은 따라 들어오지 않는다", () => {
  const cyc = normalizeV2(inv([dep("shop-api", {}, [{ name: "Q", value: `https://sqs.ap-northeast-2.amazonaws.com/${ACC}/q1` }]), queue("q1", "q2"), queue("q2", "q1")])).result;
  assert.deepEqual(ids(cyc), ["q1", "q2", "shop-api"]);
  const outq = normalizeV2(inv([dep("shop-api"), queue("lonely", "lonely-dlq"), queue("lonely-dlq")])).result;
  assert.deepEqual(ids(outq), ["shop-api"]);
  assert.deepEqual(outs(outq), ["sqs.queue:lonely", "sqs.queue:lonely-dlq"]);
  invariants(outq, "outq");
});

test("점이 든 버킷 이름(shop.assets.v2)이 경계 밖이어도 fieldMeta 에 흔적이 안 남는다 / 경계 안이면 id 가 규칙에 맞게 들어온다", () => {
  const gone = normalizeV2(inv([dep("shop-api"), bucket("old.backup.v1")])).result;
  assert.deepEqual(outs(gone), ["s3.bucket:old.backup.v1"]);
  assert.ok(!Object.keys(gone.fieldMeta).some((k) => /old|backup/.test(k)), JSON.stringify(Object.keys(gone.fieldMeta)));
  const kept = normalizeV2(inv([dep("shop-api", {}, bucketEnv("shop.assets.v2")), bucket("shop.assets.v2")])).result;
  assert.equal(kept.spec.components.length, 2);
  invariants(kept, "kept");
});

test("PARTOF 경계값: 앞뒤 공백은 잘라 맞추고, 대소문자 다르면 맞는 묶음 없음(0.6 + 입력 언급), 빈 문자열 입력은 입력 없음과 같다", () => {
  const items = (): Raw[] => [dep("shop-api", { [P]: "shop" }), dep("shop-web", { [P]: "shop" }), dep("blog-api", { [P]: "blog" })];
  const trim = normalizeV2(inv(items()), { partOf: "  blog  " }).result;
  assert.deepEqual(ids(trim), ["blog-api"]);
  assert.equal(trim.fieldMeta["components.blog-api.appGroup"]?.confidence, 1);
  const upper = normalizeV2(inv(items()), { partOf: "Shop" }).result;
  assert.deepEqual(ids(upper), ["shop-api", "shop-web"]);
  assert.equal(upper.fieldMeta["components.shop-api.appGroup"]?.confidence, 0.6);
  assert.match(upper.fieldMeta["components.shop-api.appGroup"]!.rationale!, /Shop/);
  const empty = JSON.stringify(normalizeV2(inv(items()), { partOf: "" }).result);
  assert.equal(empty, JSON.stringify(normalizeV2(inv(items())).result));
  const blank = JSON.stringify(normalizeV2(inv(items()), { partOf: "   " }).result);
  assert.equal(blank, empty);
});

test("PARTOF 동수: 묶음 둘이 워크로드 2개씩이면 이름순 앞(blog)을 고르고 0.6, 입력으로 shop 을 주면 shop·1.0 (결정적)", () => {
  const items = (): Raw[] => [dep("shop-api", { [P]: "shop" }), dep("shop-web", { [P]: "shop" }), dep("blog-api", { [P]: "blog" }), dep("blog-web", { [P]: "blog" })];
  const tie = normalizeV2(inv(items())).result;
  assert.deepEqual(ids(tie), ["blog-api", "blog-web"]);
  assert.equal(tie.fieldMeta["components.blog-api.appGroup"]?.confidence, 0.6);
  assert.equal(JSON.stringify(normalizeV2(inv(items().reverse())).result), JSON.stringify(tie));
  const pick = normalizeV2(inv(items()), { partOf: "shop" }).result;
  assert.deepEqual(ids(pick), ["shop-api", "shop-web"]);
  assert.equal(pick.fieldMeta["components.shop-api.appGroup"]?.confidence, 1);
});

test("PARTOF 라벨 값: 빈 값·공백뿐이면 라벨 없음 취급 / part-of 가 name 보다 우선 / 맨 app 라벨만 있으면 묶음 아님", () => {
  const blankOnly = normalizeV2(inv([dep("a", { [P]: "" }), dep("b", { [P]: "   " })])).result;
  assert.deepEqual(ids(blankOnly), ["a", "b"]);
  assert.ok(!Object.keys(blankOnly.fieldMeta).some((k) => k.endsWith(".appGroup")), "라벨이 하나도 없으면 아무것도 안 한다");
  const prio = normalizeV2(inv([dep("a", { [P]: "shop", [N]: "frontend" }), dep("b", { [P]: "shop", [N]: "backend" }), dep("c", { [N]: "other" })])).result;
  // c 는 part-of 가 없어 name 으로 묶음 "other"(1개). shop(2개)이 이겨서 c 는 경계 밖
  assert.deepEqual(ids(prio), ["a", "b"]);
  assert.deepEqual(outs(prio), ["k8s.deployment:c"]);
  assert.equal(prio.fieldMeta["components.a.appGroup"]?.source, `label:most-workloads:${P}=shop`);
});

test("PARTOF 한 앱에 전부 같은 라벨이면 한정할 게 없다: 경계 밖 0, 라벨 없는 워크로드는 남고 0.6 검토", () => {
  const r = normalizeV2(inv([dep("shop-api", { [P]: "shop" }), dep("shop-web", { [P]: "shop" }), dep("tool")])).result;
  assert.deepEqual(ids(r), ["shop-api", "shop-web", "tool"]);
  assert.equal(r.outOfBoundary?.length ?? 0, 0);
  assert.equal(r.fieldMeta["components.tool.appGroup"]?.source, "label:none");
  assert.equal(r.fieldMeta["components.tool.appGroup"]?.needs_review, true);
});

test("DB 예외: 이름 추측 DB 가 둘이면 둘 다 0.6 로 남는다(3티어 '앱마다 DB 하나' 와 다름 — 현재 동작 고정)", () => {
  const r = normalizeV2(inv([dep("shop-api", {}, [{ name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "c", key: "url" } } }]), rds("shop-db"), rds("shop-db-replica")])).result;
  const dbs = r.spec.components.filter((c) => c.kind === "postgres").map((c) => c.id).sort();
  assert.ok(dbs.length >= 1, "적어도 하나는 남아야 이전이 성립");
  for (const id of dbs) assert.equal(r.fieldMeta[`components.${id}.boundary`]?.needs_review, true);
});

test("멱등: 같은 입력을 두 번 가져오면 byte 단위로 같은 결과, previousIds 로 이어 가져와도 id·경계 밖 목록이 안 바뀐다", () => {
  const items = (): Raw[] => [dep("shop-api", { [P]: "shop" }, bucketEnv("shop-assets")), dep("blog-api", { [P]: "blog" }), bucket("shop-assets"), bucket("tfstate")];
  const a = normalizeV2(inv(items()), { partOf: "shop" });
  const b = normalizeV2(inv(items()), { partOf: "shop" });
  assert.equal(JSON.stringify(a.result), JSON.stringify(b.result));
  const c = normalizeV2(inv(items()), { partOf: "shop", previousIds: a.result.ids } as never);
  assert.deepEqual(ids(c.result), ids(a.result));
  assert.deepEqual(outs(c.result), outs(a.result));
});

// VI3fix: I3fix(replicas 0 · 자격 든 연결 URL 의존성) 보강 — 결정성, 경계, 거부
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";

const D = "sha256:" + "ab".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items }) as RawInventory;
const dep = (name: string, ns = "shop", env: Raw[] = [], spec: Raw = {}): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: ns, labels: { app: name } },
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } }, ...spec } });
const pg = (n: string, ns = "shop"): Raw => ({ kind: "cnpg.cluster", metadata: { name: n, namespace: ns }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "1Gi" }, instances: 1 } });
const svc = (name: string): Raw => ({ kind: "k8s.service", metadata: { name, namespace: "shop" }, spec: { selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] } });
const run = (items: Raw[]) => normalizeV2(inv(items), {});
const URL = (host: string, pw = "s3cr3t-pw") => ({ name: "DB_URL", value: `postgres://u:${pw}@${host}/app` });

test("결정성: 항목·env 순서를 뒤섞어도 결과(의존성·신뢰도·검토 표시)가 같다", () => {
  const env = [URL("shop-db-rw.shop.svc"), { name: "LOG", value: "info" }, { name: "API_TOKEN", value: "tok-abcdef" }];
  const a = run([dep("app-a", "shop", env), pg("shop-db"), dep("app-b", "shop", [URL("shop-db-rw.shop.svc", "other-pw")])]);
  const b = run([dep("app-b", "shop", [URL("shop-db-rw.shop.svc", "other-pw")]), pg("shop-db"), dep("app-a", "shop", [...env].reverse())]);
  assert.deepEqual(a.result.spec.links, b.result.spec.links);
  assert.deepEqual(a.result.fieldMeta["links.app-a->shop-db"], b.result.fieldMeta["links.app-a->shop-db"]);
  assert.deepEqual(a.result.fieldMeta["links.app-b->shop-db"], b.result.fieldMeta["links.app-b->shop-db"]);
  assert.equal(a.result.spec.links.length, 2);
});

test("정상: postgres 둘 중 호스트가 맞는 쪽에만 의존성 (다른 쪽은 안 생김)", () => {
  const out = run([dep("app-a", "shop", [URL("orders-db-rw.shop.svc")]), pg("orders-db"), pg("users-db")]);
  assert.deepEqual(out.result.spec.links.map((l) => `${l.from}->${l.to}`), ["app-a->orders-db"]);
});

test("거부: 자격 든 URL 이 다른 서비스 주소를 가리키면 서비스→서비스 의존성을 안 만든다(데이터 리소스만)", () => {
  const out = run([dep("app-a", "shop", [URL("app-b.shop.svc")]), dep("app-b"), svc("app-b")]);
  assert.deepEqual(out.result.spec.links.filter((l) => l.from === "app-a"), []);
});

test("거부: 호스트가 다른 네임스페이스의 같은 이름 DB 면 근거로 안 쓴다", () => {
  const out = run([dep("app-a", "shop", [URL("shop-db-rw.other.svc")]), pg("shop-db", "shop")]);
  assert.deepEqual(out.result.spec.links.filter((l) => l.from === "app-a"), []);
});

test("비밀 비노출: 비밀번호·토큰은 결과·검증 메시지(check)·unmapped 어디에도 없다", () => {
  const out = run([dep("app-a", "shop", [URL("shop-db-rw.shop.svc", "PWzzz9987"), { name: "API_TOKEN", value: "TOKzzz1122" }], { replicas: 0 }), pg("shop-db")]);
  const all = JSON.stringify([out.result, checkV2(out.result.spec)]);
  for (const s of ["PWzzz9987", "TOKzzz1122"]) assert.ok(!all.includes(s), `${s} 가 남음`);
});

test("경계: replicas 0 은 v2 에 그대로(0·0) + 검토, 10·11 도 그대로 (상한 없음)", () => {
  const rep = (n: number) => run([dep("app-a", "shop", [], { replicas: n })]);
  const props = (r: ReturnType<typeof rep>) => (r.result.spec.components[0] as any).props.replicas;
  assert.deepEqual(props(rep(0)), { min: 0, max: 0 });
  assert.deepEqual(props(rep(10)), { min: 10, max: 10 });
  assert.deepEqual(props(rep(11)), { min: 11, max: 11 });
  assert.deepEqual(checkV2(rep(0).result.spec).reviews.filter((x) => x.includes("replicas 0")).length, 1);
  assert.equal(checkV2(rep(2).result.spec).reviews.filter((x) => x.includes("replicas 0")).length, 0);
});

test("두 번 가져와도(같은 입력) 결과 JSON 이 같다 (replicas 0 + 자격 URL 포함)", () => {
  const items = () => [dep("app-a", "shop", [URL("shop-db-rw.shop.svc")], { replicas: 0 }), pg("shop-db")];
  assert.equal(JSON.stringify(run(items()).result), JSON.stringify(run(items()).result));
});

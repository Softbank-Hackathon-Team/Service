// 보안 판정 연결: 사전 점검이 내는 SEC:* 항목 (데모 시나리오). 순수 함수 (DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, PrecheckItem, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "@svc/adapters";
import { secPrecheckOn, securityPrecheckFor, securityPrecheckItems } from "../src/jobs/precheck.js";

// AWS 출발: 서비스 + RDS (저장 암호화 읽음, 비공개)
const imported = (): ImportResultV2 => ImportResultV2.parse(normalizeV2({ provider: "aws", coverage: {}, items: [
  { kind: "k8s.deployment", imageDigest: "sha256:" + "ab".repeat(32), metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
      name: "api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }],
      env: [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }] }] } } } },
  { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20, StorageEncrypted: true, PubliclyAccessible: false,
    Endpoint: { Address: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }, DBInstanceArn: "arn:aws:rds:ap-northeast-2:000000000000:db:shop-db" },
] } as RawInventory).result);
const withReq = (r: ImportResultV2): ImportResultV2 => ({ ...r, spec: { ...r.spec, security: { requirements: { dataClass: "personal", residency: ["KR"], keyOwnership: "customer" } } } });
const SRC = { envId: "s", provider: "aws" as const, region: "ap-northeast-2" };
const run = (r: ImportResultV2, target: { provider: "aws" | "gcp" | "onprem"; region: string | null }) =>
  securityPrecheckItems({ spec: r.spec, securityFacts: r.securityFacts, source: SRC, target: { envId: "t", ...target } });
const ids = (xs: PrecheckItem[]) => xs.map((x) => `${x.id}:${x.level}`);

test("데모: 고객 키 요구 + GCP 도착 → SEC:P-KEY-1 막기 (명세 검토로 되돌림)", () => {
  const items = run(withReq(imported()), { provider: "gcp", region: "asia-northeast3" });
  for (const i of items) PrecheckItem.parse(i);
  const key = items.find((i) => i.id === "SEC:P-KEY-1:shop-db");
  assert.equal(key?.level, "block");
  assert.match(key!.message, /^FAIL 보안 — 고객 키가 제공자 기본 키로 내려간다 \(shop-db\)\./);
  assert.match(key!.message, /kms_key_id 없음|encryption_key_name 없음/);
  // 같은 국가(KR)라 위치 막기는 없다
  assert.ok(!items.some((i) => i.id.startsWith("SEC:P-LOC-1")));
});

test("데모: 같은 명세로 온프레 도착 → 막기 없이 고객 확인 경고 (키 소유를 모름)", () => {
  const items = run(withReq(imported()), { provider: "onprem", region: null });
  assert.ok(!items.some((i) => i.level === "block"), ids(items).join(" "));
  const k = items.find((i) => i.id === "SEC:P-KEY-2:shop-db");
  assert.equal(k?.level, "warn");
  assert.match(k!.message, /^WARN 보안 고객 확인 — /);
  // 온프레 국가는 모름 → 허용 국가가 있으면 고객 확인
  assert.equal(items.find((i) => i.id === "SEC:P-LOC-1:env")?.level, "warn");
});

test("요구사항이 없으면 고객 확인 경고 하나 (P-REQ-0), 위치·키 규칙은 판정하지 않는다", () => {
  const items = run(imported(), { provider: "gcp", region: "asia-northeast3" });
  assert.equal(items.find((i) => i.id === "SEC:P-REQ-0:env")?.level, "warn");
  assert.ok(!items.some((i) => /P-(KEY|LOC)-/.test(i.id)), ids(items).join(" "));
  assert.ok(!items.some((i) => i.level === "block"));
});

test("같은 입력이면 같은 항목 (계획서 해시가 흔들리지 않게)", () => {
  const r = withReq(imported());
  assert.deepEqual(run(r, { provider: "gcp", region: "asia-northeast3" }), run(r, { provider: "gcp", region: "asia-northeast3" }));
});

test("깃발: 기본 꺼짐. SEC_PRECHECK=1 + PLAN_IR=v2 일 때만 켜지고, 아니면 DB 를 보지 않고 빈 목록", async () => {
  const m = { id: "m", sourceEnvId: "s", targetEnvId: "t" } as never;
  assert.deepEqual(await securityPrecheckFor("tenant", m, { PLAN_IR: "v2" }), []);
  assert.deepEqual(await securityPrecheckFor("tenant", m, { PLAN_IR: "v1", SEC_PRECHECK: "1" }), []);
  assert.deepEqual(await securityPrecheckFor("tenant", m, { PLAN_IR: "v2", SEC_PRECHECK: "0" }), []);
  assert.equal(secPrecheckOn({ PLAN_IR: "v2", SEC_PRECHECK: "1" }), true);
});

test("출발 DB 2개: 각 도착 DB 는 같은 이름의 출발 DB 와 비교한다 (버전 16·14 를 엇갈려 비교하지 않는다)", () => {
  const r = imported();
  const pg = r.spec.components.find((c) => c.kind === "postgres")!;
  const old = { ...structuredClone(pg), id: "zz-db", props: { ...structuredClone(pg.props), majorVersion: "14" } };
  const spec = { ...r.spec, components: [...r.spec.components.map((c) => (c.id === pg.id ? { ...c, id: "aa-db" } : c)), old] };
  const items = securityPrecheckItems({ spec, securityFacts: {}, source: SRC, target: { envId: "t", provider: "aws", region: "ap-northeast-2" } });
  assert.ok(!items.some((i) => i.id.startsWith("SEC:P-DB-5")), ids(items).join(" "));
});

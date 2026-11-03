// 보안 판정용 환경 사실: 도착 모듈 고정값이 실제 .tf 와 맞는지(표류), 출발·도착 사실 조립. 순수 함수 + 파일 읽기
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EnvFacts, ImportResultV2, type RawInventory } from "@svc/contracts";
import { normalizeV2, targetFactsV2, sourceFactsV2, sourceDbsV2, appEnvV2, MODULE_DB_FACTS } from "../src/index.js";

const tf = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("표류: 사실표가 근거로 든 도착 모듈 줄이 실제 .tf 에 있다 (모듈이 바뀌면 사실표도 고쳐야 함)", () => {
  const aws = tf("infra/modules/aws/kinds/postgres/main.tf"), gcp = tf("infra/modules/gcp/kinds/postgres/main.tf");
  assert.match(aws, /storage_encrypted\s*=\s*true/);
  assert.match(aws, /"rds\.force_ssl"\s*=\s*"1"/);
  assert.match(aws, /backup_retention_period\s*=\s*[1-9]/);
  assert.doesNotMatch(aws, /kms_key_id/, "고객 키를 쓰게 되면 keyOwner 사실을 고친다");
  assert.match(gcp, /ssl_mode\s*=\s*"ENCRYPTED_ONLY"/);
  assert.match(gcp, /point_in_time_recovery_enabled\s*=\s*true/);
  assert.doesNotMatch(gcp, /encryption_key_name/, "CMEK 를 쓰게 되면 keyOwner 사실을 고친다");
  // 사실표의 근거 문자열이 같은 파일을 가리킨다
  assert.match(MODULE_DB_FACTS.aws.tlsEnforced.source!, /infra\/modules\/aws\/kinds\/postgres\/main\.tf/);
  assert.match(MODULE_DB_FACTS.gcp.tlsEnforced.source!, /infra\/modules\/gcp\/kinds\/postgres\/main\.tf/);
});

// 서비스 + RDS (출발 공개 여부·저장 암호화 읽음)
const imported = (): ImportResultV2 => ImportResultV2.parse(normalizeV2({ provider: "aws", coverage: {}, items: [
  { kind: "k8s.deployment", imageDigest: "sha256:" + "ab".repeat(32), metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
      name: "api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }],
      env: [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }, { name: "LOG_LEVEL", value: "info" }] }] } } } },
  { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 20, StorageEncrypted: true, PubliclyAccessible: false,
    Endpoint: { Address: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }, DBInstanceArn: "arn:aws:rds:ap-northeast-2:000000000000:db:shop-db" },
] } as RawInventory).result);

test("도착 사실: 클라우드는 모듈 고정값(attested), 온프레는 모름 + DB 비공개, 리전으로 국가", () => {
  const { spec } = imported();
  const gcp = targetFactsV2({ envId: "t", provider: "gcp", region: "asia-northeast3" }, spec);
  EnvFacts.parse(gcp.env);
  assert.equal(gcp.env.country.value, "KR");
  assert.equal(gcp.env.platform.secretsEncrypted.value, true);
  assert.deepEqual(gcp.dbs.map((d) => d.componentId), ["shop-db"]);
  const g = gcp.dbs[0]!.db;
  assert.equal(g.keyOwner.value, "provider");
  assert.equal(g.tlsEnforced.value, true);
  assert.equal(g.publicAccess.value, false);
  assert.equal(g.majorVersion.value, 16);
  assert.equal(g.authMethods.origin, "unknown");
  const onprem = targetFactsV2({ envId: "o", provider: "onprem", region: null }, spec);
  EnvFacts.parse(onprem.env);
  assert.equal(onprem.env.country.origin, "unknown");
  const o = onprem.dbs[0]!.db;
  assert.equal(o.keyOwner.origin, "unknown");
  assert.equal(o.encryptedAtRest.origin, "unknown");
  assert.equal(o.publicAccess.value, false);
  // 표에 없는 리전 = 모름 (국가를 지어내지 않는다)
  assert.equal(targetFactsV2({ envId: "t", provider: "aws", region: "mars-1" }, spec).env.country.origin, "unknown");
});

test("출발 사실: 대표 DB 에 securityFacts·명세 공개 여부·버전이 들어가고, 없는 사실은 모름", () => {
  const r = imported();
  const s = sourceFactsV2({ envId: "s", provider: "aws", region: "ap-northeast-2" }, r.spec, r.securityFacts);
  EnvFacts.parse(s);
  assert.equal(s.country.value, "KR");
  assert.equal(s.db.encryptedAtRest.value, true);
  assert.equal(s.db.keyOwner.origin, "unknown");
  assert.equal(s.db.majorVersion.value, 16);
  const none = sourceFactsV2({ envId: "s", provider: "aws", region: null }, r.spec);
  assert.equal(none.db.encryptedAtRest.origin, "unknown");
  assert.equal(none.country.origin, "unknown");
});

test("앱 설정값: 평문 값만 (링크·비밀 참조는 뺀다)", () => {
  const env = appEnvV2(imported().spec);
  assert.ok(env.some((e) => e.name === "LOG_LEVEL" && e.value === "info"));
  assert.ok(env.every((e) => typeof e.value === "string"));
});

test("앱 설정값: 사이드카·init 컨테이너의 평문 값도 읽는다 (비밀 참조는 여전히 뺀다)", () => {
  const spec = structuredClone(imported().spec);
  const svc = spec.components.find((c) => c.kind === "service")!;
  const side = (name: string, env: unknown[]) => ({ name, image: (svc.props as { image: unknown }).image, env, resources: {} });
  Object.assign(svc.props, {
    sidecars: [side("proxy", [{ name: "PROXY_DSN", value: "postgres://x@db/app?sslmode=disable" }])],
    initContainers: [side("migrate", [{ name: "MIG_PW", fromSecret: { secret: "db", key: "pw" } }])],
  });
  const env = appEnvV2(spec);
  assert.ok(env.some((e) => e.name === "PROXY_DSN" && /sslmode=disable/.test(e.value)));
  assert.ok(!env.some((e) => e.name === "MIG_PW"));
});

test("출발 DB 컴포넌트별: sourceDbsV2 는 postgres 마다 자기 사실·버전을 갖는다", () => {
  const r = imported();
  const id = r.spec.components.find((c) => c.kind === "postgres")!.id;
  const dbs = sourceDbsV2(r.spec, r.securityFacts);
  assert.deepEqual(dbs.map((d) => d.componentId), [id]);
  assert.equal(dbs[0]!.db.encryptedAtRest.value, true);
  assert.equal(dbs[0]!.db.majorVersion.value, 16);
  assert.equal(sourceDbsV2(r.spec)[0]!.db.encryptedAtRest.origin, "unknown");
});

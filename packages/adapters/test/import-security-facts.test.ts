// 보안 판정용 출발 DB 사실: 원본 한 줄 → SourceDbFacts, 가져오기 결과의 securityFacts, 재가져오기의 security 유지. 순수 함수
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, SourceDbFacts, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/index.js";
import { sourceDbFactsOf as factsOf } from "../src/import/security-facts.js";
import type { RawItem } from "../src/import/types.js";
import { carryHumanEdits } from "../src/import/carry.js";

type Raw = Record<string, any>;
const sourceDbFactsOf = (r: Raw) => factsOf(r as RawItem);
const D = "sha256:" + "ab".repeat(32);
const ACC = "000000000000";
const inv = (items: Raw[], provider: RawInventory["provider"] = "aws"): RawInventory => ({ provider, coverage: {}, items });
const dep = (name: string, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const rds = (id: string, extra: Raw = {}): Raw => ({ kind: "rds.dbInstance", DBInstanceIdentifier: id, Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20,
  Endpoint: { Address: `${id}.abc.ap-northeast-2.rds.amazonaws.com` }, DBInstanceArn: `arn:aws:rds:ap-northeast-2:${ACC}:db:${id}`, ...extra });
const sql = (ip: Raw | null): Raw => ({ kind: "cloudsql.instance", name: "shop-db", databaseVersion: "POSTGRES_16",
  settings: { dataDiskSizeGb: "20", ipConfiguration: ip } });
const dbEnv = (id: string) => [{ name: "DB_HOST", value: `${id}.abc.ap-northeast-2.rds.amazonaws.com` }];

test("RDS: StorageEncrypted 는 measured, 키 소유·TLS 강제는 못 읽어 unknown (KmsKeyId 가 있어도)", () => {
  const f = sourceDbFactsOf(rds("shop-db", { StorageEncrypted: true, KmsKeyId: "arn:aws:kms:ap-northeast-2:000000000000:key/x" }))!;
  SourceDbFacts.parse(f);
  assert.deepEqual(f.encryptedAtRest, { value: true, origin: "measured", source: "rds:shop-db.StorageEncrypted" });
  assert.equal(f.keyOwner.origin, "unknown");
  assert.equal(f.tlsEnforced.origin, "unknown");
  assert.equal(sourceDbFactsOf(rds("shop-db", { StorageEncrypted: false }))!.encryptedAtRest.value, false);
  // 원본에 칸이 없으면 지어내지 않는다
  assert.deepEqual(sourceDbFactsOf(rds("shop-db"))!.encryptedAtRest, { value: null, origin: "unknown", source: null });
});

test("Cloud SQL: sslMode·requireSsl 로 TLS 강제, 저장 암호화는 제공자 문서 근거(attested)", () => {
  const tls = (ip: Raw | null) => sourceDbFactsOf(sql(ip))!.tlsEnforced;
  assert.deepEqual(tls({ sslMode: "ENCRYPTED_ONLY" }), { value: true, origin: "measured", source: "cloudsql:shop-db.settings.ipConfiguration.sslMode" });
  assert.equal(tls({ sslMode: "TRUSTED_CLIENT_CERTIFICATE_REQUIRED" }).value, true);
  assert.equal(tls({ sslMode: "ALLOW_UNENCRYPTED_AND_ENCRYPTED", requireSsl: true }).value, false);   // sslMode 가 우선
  assert.equal(tls({ requireSsl: true }).value, true);
  assert.equal(tls({ requireSsl: false }).value, false);
  assert.equal(tls({}).origin, "unknown");
  assert.equal(tls(null).origin, "unknown");
  const f = sourceDbFactsOf(sql(null))!;
  SourceDbFacts.parse(f);
  assert.equal(f.encryptedAtRest.origin, "attested");
  assert.equal(f.keyOwner.origin, "unknown");
});

test("postgres 원본이 아니면 사실 없음", () => {
  assert.equal(sourceDbFactsOf({ kind: "cnpg.cluster", metadata: { name: "shop-db" } }), null);
  assert.equal(sourceDbFactsOf({ kind: "s3.bucket", Name: "b" }), null);
});

test("가져오기 결과: 경계 안 postgres 구성요소 id 로 securityFacts 가 붙고, 경계 밖 DB 는 안 붙는다", () => {
  const { result } = normalizeV2(inv([dep("shop-api", dbEnv("shop-db")), rds("shop-db", { StorageEncrypted: true }), rds("shop-analytics", { StorageEncrypted: false })]));
  ImportResultV2.parse(result);
  assert.deepEqual(Object.keys(result.securityFacts ?? {}), ["shop-db"]);
  assert.equal(result.securityFacts!["shop-db"]!.encryptedAtRest.value, true);
  // spec 안에는 넣지 않는다 (사람이 PATCH 로 못 고치게)
  assert.equal("security" in result.spec, false);
  // DB 가 없으면 칸 자체가 없다 (옛 판과 같은 모양)
  assert.equal("securityFacts" in normalizeV2(inv([dep("shop-api")])).result, false);
});

test("재가져오기: 사람이 넣은 security 요구사항은 유지, securityFacts 는 새로 읽은 값", () => {
  const read = (enc: boolean) => normalizeV2(inv([dep("shop-api", dbEnv("shop-db")), rds("shop-db", { StorageEncrypted: enc })])).result;
  const base = read(true);
  const human = structuredClone(base);
  human.spec.security = { requirements: { dataClass: "personal", residency: ["KR"], keyOwnership: "customer" } };
  human.fieldMeta.security = { source: "human", confidence: 1, needs_review: false };
  const { result, report } = carryHumanEdits(read(false), [human, base]);
  ImportResultV2.parse(result);
  assert.deepEqual(result.spec.security, human.spec.security);
  assert.equal(result.fieldMeta.security?.source, "human");
  assert.ok(report.kept.includes("security"));
  assert.equal(result.securityFacts!["shop-db"]!.encryptedAtRest.value, false);
  // 사람이 지운 요구사항(칸 없음 + human 표시)은 다시 생기지 않는다
  const cleared = structuredClone(human); delete cleared.spec.security;
  assert.equal("security" in carryHumanEdits(read(true), [cleared, human, base]).result.spec, false);
});

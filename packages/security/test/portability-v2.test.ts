// IR v2 이식성 판정과 사전 점검 변환: 순수 함수만. DB·클라우드 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvFacts, PortabilityVerdict, PrecheckItem, type SecurityRequirements } from "@svc/contracts";
import {
  evaluatePortabilityV2, toSecurityPrecheckItems, PORTABILITY_RULES, type PortabilityResultV2,
} from "../src/portability/index.js";

const m = <T>(value: T, source = "test") => ({ value, origin: "measured" as const, source });
const u = () => ({ value: null, origin: "unknown" as const, source: null });

type Facts = ReturnType<typeof EnvFacts.parse>;
type Db = Facts["db"];
// 잘 지켜진 관리형 환경 하나 (portability.test.ts 와 같은 기준선). 시험마다 필요한 칸만 바꾼다
const goodDb = (patch: (d: Db) => void = () => {}): Db => {
  const d: Db = {
    publicAccess: m(false), encryptedAtRest: m(true), keyOwner: m("customer" as const), tlsEnforced: m(true),
    authMethods: m(["scram-sha-256"]), majorVersion: m(16), extensions: m(["plpgsql", "pgcrypto"]),
    extensionAllowlist: m(["pgcrypto", "pg_stat_statements"]), encoding: m("UTF8"), collation: m("C.UTF-8"),
    appRoleSuperuser: m(false), pitr: m(true),
  };
  patch(d);
  return d;
};
const env = (provider: Facts["provider"], patch: (f: Facts) => void = () => {}): Facts => {
  const f: Facts = {
    provider, envId: `${provider}-env`, country: m("KR", "region"), db: goodDb(),
    platform: { auditLog: m(true), secretsEncrypted: m(true), workloadIdentity: m(false) },
  };
  patch(f);
  return EnvFacts.parse(f);
};
const req = (r: Partial<SecurityRequirements> = {}): SecurityRequirements =>
  ({ dataClass: "internal", residency: ["KR"], keyOwnership: "customer", ...r });
const ids = (r: PortabilityResultV2) => r.items.map((i) => `${i.ruleId}:${i.componentId ?? "env"}:${i.level}`);

test("규칙표: 모든 규칙에 scope 가 있고, target.db 를 읽는 규칙만 db 다", () => {
  const db = PORTABILITY_RULES.filter((r) => r.scope === "db").map((r) => r.id);
  assert.deepEqual(db, ["P-ENC-1", "P-KEY-1", "P-KEY-2", "P-ENC-2", "P-NET-1", "P-IAM-1", "P-DB-1", "P-DB-4", "P-DB-5", "P-BAK-1"]);
  assert.ok(PORTABILITY_RULES.every((r) => r.scope === "env" || r.scope === "db"));
});

test("postgres 2개: db 규칙은 컴포넌트마다 따로, env 규칙은 한 번만 나온다", () => {
  const r = evaluatePortabilityV2({
    requirements: req({ dataClass: "personal", residency: [] }),
    source: env("aws"),
    target: env("gcp", (f) => { f.country = m("JP"); }),
    targetDbs: [
      { componentId: "pg-b", db: goodDb((d) => { d.keyOwner = m("provider"); }) },
      { componentId: "pg-a", db: goodDb((d) => { d.keyOwner = m("provider"); d.publicAccess = m(true); }) },
    ],
  });
  // 단계 → 규칙표 순서 → 컴포넌트 id 순서
  assert.deepEqual(ids(r), [
    "P-KEY-1:pg-a:block", "P-KEY-1:pg-b:block", "P-NET-1:pg-a:block",
    "P-LOC-2:env:warn", "P-LOC-5:env:advise",
  ]);
  assert.equal(r.verdict, "blocked");
  assert.deepEqual(r.summary, { block: 3, warn: 1, attest: 0, advise: 1 });
  for (const { componentId: _, ...v } of r.items) PortabilityVerdict.parse(v);
});

test("출발 DB 짝짓기: db 규칙은 같은 컴포넌트 id 의 출발 DB 와 비교한다 (없으면 대표 source.db)", () => {
  const v = (n: number) => goodDb((d) => { d.majorVersion = m(n); });
  const base = {
    requirements: req(), source: env("aws", (f) => { f.db = v(16); }), target: env("gcp"),
    targetDbs: [{ componentId: "pg-a", db: v(16) }, { componentId: "pg-b", db: v(14) }],
  };
  // 짝을 주면 pg-b 는 출발 14 → 도착 14, 버전 낮아짐 없음
  const paired = evaluatePortabilityV2({ ...base, sourceDbs: [{ componentId: "pg-a", db: v(16) }, { componentId: "pg-b", db: v(14) }] });
  assert.ok(!ids(paired).some((x) => x.startsWith("P-DB-5")), ids(paired).join(" "));
  // 대조: 짝이 없으면 대표(16)와 비교해 pg-b 에 버전 낮아짐이 나온다 (짝짓기가 실제로 결과를 바꾼다)
  assert.ok(ids(evaluatePortabilityV2(base)).includes("P-DB-5:pg-b:advise"));
});

test("target.db 는 판정에 안 쓴다: 도착 DB 사실은 targetDbs 에서만 온다", () => {
  const base = { requirements: req(), source: env("aws") };
  const badEnvDb = env("gcp", (f) => { f.db = goodDb((d) => { d.keyOwner = m("provider"); d.tlsEnforced = m(false); }); });
  assert.deepEqual(ids(evaluatePortabilityV2({ ...base, target: badEnvDb, targetDbs: [{ componentId: "pg", db: goodDb() }] })), []);
  // postgres 가 없으면 db 규칙은 하나도 안 돈다
  assert.deepEqual(ids(evaluatePortabilityV2({ ...base, target: badEnvDb, targetDbs: [] })), []);
});

test("같은 입력이면 같은 출력 (입력 배열 순서도 결과를 안 바꾼다)", () => {
  const a = { componentId: "a", db: goodDb((d) => { d.tlsEnforced = u(); }) };
  const b = { componentId: "b", db: goodDb((d) => { d.encryptedAtRest = u(); }) };
  const mk = (dbs: typeof a[]) => evaluatePortabilityV2({ requirements: req(), source: env("aws"), target: env("gcp"), targetDbs: dbs });
  assert.deepEqual(mk([a, b]), mk([b, a]));
  assert.deepEqual(toSecurityPrecheckItems(mk([a, b])), toSecurityPrecheckItems(mk([b, a])));
});

test("사전 점검 변환: 단계 대응 4줄, id·fix·근거", () => {
  const r = evaluatePortabilityV2({
    requirements: req({ dataClass: "personal", residency: [] }),
    source: env("aws"),
    target: env("onprem", (f) => { f.country = m("JP"); }),
    targetDbs: [{ componentId: "pg", db: goodDb((d) => { d.keyOwner = u(); d.extensionAllowlist = m(["*"]); }) }],
  });
  const items = toSecurityPrecheckItems(r);
  for (const i of items) PrecheckItem.parse(i);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  // attest(고객 확인) → warn + "고객 확인". 모름 attest 는 묶지 않는다
  assert.equal(byId["SEC:P-KEY-2:pg"]?.level, "warn");
  assert.match(byId["SEC:P-KEY-2:pg"]!.message, /^WARN 보안 고객 확인 — .*\(pg\)\. .*근거: db\.keyOwner=모름 \(unknown\)/);
  assert.equal(byId["SEC:P-LOC-2:env"]?.level, "warn");
  assert.match(byId["SEC:P-LOC-2:env"]!.message, /^WARN 보안 — /);
  assert.equal(byId["SEC:P-LOC-5:env"]?.level, "info");
  assert.match(byId["SEC:P-LOC-5:env"]!.message, /^INFO 보안 — /);
  assert.equal(byId["SEC:P-LOC-5:env"]?.fix, r.items.find((i) => i.ruleId === "P-LOC-5")!.recommend);

  const blocked = toSecurityPrecheckItems(evaluatePortabilityV2({
    requirements: req(), source: env("aws"), target: env("gcp"),
    targetDbs: [{ componentId: "pg", db: goodDb((d) => { d.keyOwner = m("provider"); }) }],
  }));
  assert.deepEqual(blocked.map((i) => [i.id, i.level]), [["SEC:P-KEY-1:pg", "block"]]);
  assert.match(blocked[0]!.message, /^FAIL 보안 — 고객 키가 제공자 기본 키로 내려간다 \(pg\)\./);
});

test("모름 묶기: 클라우드 모름 경고는 쪽마다 한 항목, block 은 그대로", () => {
  const r = evaluatePortabilityV2({
    requirements: req(),
    source: env("aws", (f) => { f.db.extensions = u(); f.country = u(); }),
    target: env("gcp"),
    targetDbs: [
      { componentId: "pg-a", db: goodDb((d) => { d.tlsEnforced = u(); d.encryptedAtRest = u(); }) },
      { componentId: "pg-b", db: goodDb((d) => { d.keyOwner = m("provider"); d.publicAccess = u(); }) },
    ],
  });
  assert.ok(r.items.filter((i) => i.basis === "unknown").length >= 5);
  const items = toSecurityPrecheckItems(r);
  for (const i of items) PrecheckItem.parse(i);
  assert.deepEqual(items.map((i) => i.id), ["SEC:P-KEY-1:pg-b", "SEC:UNKNOWN:target", "SEC:UNKNOWN:source"]);
  const t = items[1]!;
  assert.equal(t.level, "warn");
  assert.match(t.message, /^WARN 보안 — 도착 보안 사실 3개를 모른다/);
  assert.match(t.message, /P-ENC-1\(pg-a\), P-ENC-2\(pg-a\), P-NET-1\(pg-b\)/);
  assert.match(items[2]!.message, /^WARN 보안 — 출발 보안 사실 2개를 모른다.*P-DB-1\(pg-a\), P-DB-1\(pg-b\)/);
  // 같은 id 가 두 번 나오면 승인 항목이 겹친다
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});

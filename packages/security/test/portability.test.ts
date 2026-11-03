// 이식성 판정: 순수 함수만. DB·클라우드 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvFacts, PortabilityResult, type SecurityRequirements } from "@svc/contracts";
import { evaluatePortability, PORTABILITY_RULES } from "../src/portability/index.js";

const m = <T>(value: T, source = "test") => ({ value, origin: "measured" as const, source });
const u = () => ({ value: null, origin: "unknown" as const, source: null });

type Facts = ReturnType<typeof EnvFacts.parse>;
// 잘 지켜진 관리형 환경 하나. 시험마다 필요한 칸만 바꾼다. 계약 스키마로 parse 해서 모양을 맞춘다
const env = (provider: Facts["provider"], patch: (f: Facts) => void = () => {}): Facts => {
  const f: Facts = {
    provider, envId: `${provider}-env`,
    country: m("KR", "region"),
    db: {
      publicAccess: m(false), encryptedAtRest: m(true), keyOwner: m("customer" as const), tlsEnforced: m(true),
      authMethods: m(["scram-sha-256"]), majorVersion: m(16), extensions: m(["plpgsql", "pgcrypto"]),
      extensionAllowlist: m(["pgcrypto", "pg_stat_statements"]), encoding: m("UTF8"), collation: m("C.UTF-8"),
      appRoleSuperuser: m(false), pitr: m(true),
    },
    platform: { auditLog: m(true), secretsEncrypted: m(true), workloadIdentity: m(false) },
  };
  patch(f);
  return EnvFacts.parse(f);
};
const req = (r: Partial<SecurityRequirements> = {}): SecurityRequirements =>
  ({ dataClass: "internal", residency: ["KR"], keyOwnership: "customer", ...r });
const ids = (r: ReturnType<typeof evaluatePortability>) => r.items.map((i) => `${i.ruleId}:${i.level}`);

test("잘 지켜진 AWS → GCP (같은 국가, 고객 키 유지) 는 판정 없음, 결과는 계약 모양", () => {
  const r = evaluatePortability({ requirements: req(), source: env("aws"), target: env("gcp") });
  assert.deepEqual(r.items, []);
  assert.equal(r.verdict, "clear");
  PortabilityResult.parse(r);
});

test("거부: 고객 키가 제공자 기본 키로 내려가면 P-KEY-1 막기", () => {
  const r = evaluatePortability({
    requirements: req(), source: env("aws"), target: env("gcp", (f) => { f.db.keyOwner = m("provider"); }),
  });
  assert.deepEqual(ids(r), ["P-KEY-1:block"]);
  assert.equal(r.verdict, "blocked");
  assert.match(r.items[0]!.evidence, /target\.keyOwner="provider" \(measured/);
});

test("거부: 허용 국가 밖이면 P-LOC-1 막기, 허용 국가가 없으면 개인정보 국외 이전은 P-LOC-2 경고", () => {
  const jp = env("gcp", (f) => { f.country = m("JP"); });
  assert.deepEqual(ids(evaluatePortability({ requirements: req(), source: env("aws"), target: jp })), ["P-LOC-1:block"]);
  const r = evaluatePortability({ requirements: req({ dataClass: "personal", residency: [] }), source: env("aws"), target: jp });
  assert.deepEqual(ids(r), ["P-LOC-2:warn", "P-LOC-5:advise"]);
  assert.equal(r.verdict, "needs_ack");
});

test("거부: 운영 주체 허용 목록 밖이면 P-LOC-3 막기 (공공: 고객 자신만)", () => {
  const r = evaluatePortability({ requirements: req({ operatorAllow: ["customer"] }), source: env("onprem"), target: env("gcp") });
  assert.ok(ids(r).includes("P-LOC-3:block"));
  const ok = evaluatePortability({ requirements: req({ operatorAllow: ["customer"] }), source: env("gcp"), target: env("onprem") });
  assert.ok(!ids(ok).some((x) => x.startsWith("P-LOC-3")));
});

test("모름은 통과가 아니다: 클라우드는 경고, 온프레는 고객 선언 요청", () => {
  const cloud = evaluatePortability({ requirements: req(), source: env("aws"), target: env("gcp", (f) => { f.db.tlsEnforced = u(); }) });
  assert.deepEqual(ids(cloud), ["P-ENC-2:warn"]);
  assert.match(cloud.items[0]!.evidence, /db\.tlsEnforced=모름 \(unknown\)/);
  const onprem = evaluatePortability({
    requirements: req(), source: env("aws"),
    target: env("onprem", (f) => { f.country = u(); f.db.encryptedAtRest = u(); f.db.extensionAllowlist = m(["*"]); }),
  });
  assert.ok(ids(onprem).includes("P-LOC-1:attest"));
  assert.ok(ids(onprem).includes("P-ENC-1:attest"));
  assert.equal(onprem.verdict, "needs_ack");
});

test("클라우드 → 온프레: 관리형이 해 주던 것이 사라진 자리를 잡는다", () => {
  const r = evaluatePortability({
    requirements: req(),
    source: env("aws", (f) => { f.platform.workloadIdentity = m(true); }),
    target: env("onprem", (f) => {
      f.db.keyOwner = m("customer"); f.db.pitr = m(false); f.db.authMethods = m(["scram-sha-256", "trust"]);
      f.db.extensionAllowlist = m(["*"]);
      f.platform.auditLog = m(false); f.platform.secretsEncrypted = m(false);
    }),
  });
  assert.deepEqual(ids(r), [
    "P-IAM-1:block", "P-IAM-2:warn", "P-SEC-2:warn", "P-BAK-1:warn", "P-AUD-1:warn", "G-32:warn", "G-07:advise"]);
  assert.equal(r.summary.block, 1);
});

test("온프레 → 클라우드: 확장·superuser·평문 접속 설정·사설 주소를 잡는다. 비밀값은 근거에 싣지 않는다", () => {
  const r = evaluatePortability({
    requirements: req(),
    source: env("onprem", (f) => { f.db.extensions = m(["plpgsql", "timescaledb"]); f.db.appRoleSuperuser = m(true); }),
    target: env("aws"),
    appEnv: [
      { name: "DATABASE_URL", value: "postgres://app:hunter2@10.0.3.4:5432/shop?sslmode=disable" },
      { name: "LOG_LEVEL", value: "info" },
    ],
  });
  assert.deepEqual(ids(r), ["P-SEC-1:block", "G-21:block", "P-DB-1:block", "P-DB-2:block", "G-23:warn", "G-32:warn"]);
  assert.ok(r.items.every((i) => !i.evidence.includes("hunter2")));
  assert.match(r.items.find((i) => i.ruleId === "P-DB-1")!.reason, /timescaledb/);
});

test("요구사항이 명세에 없으면 선언 요청 하나만 내고 위치 규칙은 판정하지 않는다", () => {
  const r = evaluatePortability({ requirements: null, source: env("aws"), target: env("gcp", (f) => { f.country = m("US"); }) });
  assert.deepEqual(ids(r), ["P-REQ-0:attest"]);
});

test("규칙 번호는 겹치지 않는다", () => {
  const all = PORTABILITY_RULES.map((r) => r.id);
  assert.equal(new Set(all).size, all.length);
});

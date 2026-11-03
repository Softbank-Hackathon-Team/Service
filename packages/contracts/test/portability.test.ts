// 이식성 판정 계약: IR v2 security 칸 모양, 출발 DB 사실 모양, 리전 → 국가 표
import { test } from "node:test";
import assert from "node:assert/strict";
import { PortabilityVerdict, SecuritySpecV2, SourceDbFacts, regionCountry } from "../src/index.js";

const requirements = { dataClass: "personal", residency: ["KR"], keyOwnership: "customer" } as const;

test("SecuritySpecV2: requirements 를 감싼다. 모르는 키는 거부한다", () => {
  assert.deepEqual(SecuritySpecV2.parse({ requirements }), { requirements });
  assert.equal(SecuritySpecV2.safeParse({ requirements, extra: 1 }).success, false);
  assert.equal(SecuritySpecV2.safeParse({ requirements: { ...requirements, residency: ["kr"] } }).success, false);
  assert.equal(SecuritySpecV2.safeParse({}).success, false);
});

test("SourceDbFacts: 가져오기가 읽을 수 있는 세 칸만 받는다", () => {
  const u = { value: null, origin: "unknown", source: null } as const;
  const ok = { encryptedAtRest: { value: true, origin: "measured", source: "rds describe-db-instances" }, keyOwner: u, tlsEnforced: u };
  assert.deepEqual(SourceDbFacts.parse(ok), ok);
  assert.equal(SourceDbFacts.safeParse({ ...ok, publicAccess: u }).success, false);
});

test("PortabilityVerdict.basis 는 선택 칸이다 (기존 판정 그대로 통과)", () => {
  const v = { ruleId: "P-ENC-2", level: "warn", side: "target", title: "t", reason: "r", recommend: "c", evidence: "e" } as const;
  assert.ok(PortabilityVerdict.safeParse(v).success);
  assert.ok(PortabilityVerdict.safeParse({ ...v, basis: "unknown" }).success);
  assert.equal(PortabilityVerdict.safeParse({ ...v, basis: "maybe" }).success, false);
});

test("regionCountry: 표에 있는 리전만 국가, 나머지는 null (모름)", () => {
  assert.equal(regionCountry("aws", "ap-northeast-2"), "KR");
  assert.equal(regionCountry("gcp", "asia-northeast3"), "KR");
  assert.equal(regionCountry("gcp", "asia-northeast1"), "JP");
  assert.equal(regionCountry("aws", "asia-northeast3"), null);   // 다른 제공자의 리전 이름
  assert.equal(regionCountry("aws", "mars-1"), null);
  assert.equal(regionCountry("onprem", "ap-northeast-2"), null);
  assert.equal(regionCountry("gcp", null), null);
});

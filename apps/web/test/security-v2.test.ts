import { test } from "node:test";
import assert from "node:assert/strict";
import {
  draftOf, factRows, precheckLine, requirementRows, requirementsFrom, requirementsSummary, secAckLabel, secGroups, secSummary, secVerdictOf,
  type SourceDbFacts,
} from "../src/features/migration/securityV2";
import { specRowsV2, type MigrationSpecViewV2 } from "../src/features/migration/specV2";
import type { PrecheckItem } from "../src/lib/types";

// 보안 이식성 판정 화면의 판단: 요구사항 고치기 → PATCH 값, 출발 DB 사실 줄, 사전 점검 SEC:* 단계 묶음
// SEC 문장은 워커가 쓰는 모양 그대로 (packages/security portability/precheck.ts, apps/worker test/security-precheck.test.ts)

test("요구사항: 국가는 대문자·중복 없이, 운영 주체는 정해진 순서로, 하나도 안 고르면 칸을 뺀다", () => {
  const got = requirementsFrom({ dataClass: "personal", residency: " kr, jp  KR", keyOwnership: "customer", operatorAllow: ["gcp", "customer"] });
  assert.deepEqual(got.requirements, { dataClass: "personal", residency: ["KR", "JP"], keyOwnership: "customer", operatorAllow: ["customer", "gcp"] });
  const open = requirementsFrom({ dataClass: "public", residency: "", keyOwnership: "provider", operatorAllow: [] });
  assert.deepEqual(open.requirements, { dataClass: "public", residency: [], keyOwnership: "provider" });
  assert.equal("operatorAllow" in open.requirements!, false);     // 빈 배열은 "어디도 안 됨"이라 보내지 않는다
});

test("거부: 데이터 등급·키 소유를 안 골랐거나 국가 코드가 틀리면 보내지 않는다 (기본값을 지어내지 않음)", () => {
  assert.equal(requirementsFrom(draftOf(null)).requirements, null);
  assert.deepEqual(draftOf(null), { dataClass: null, residency: "", keyOwnership: null, operatorAllow: [] });
  const bad = requirementsFrom({ dataClass: "internal", residency: "KR, korea, J1", keyOwnership: "provider", operatorAllow: [] });
  assert.equal(bad.requirements, null);
  assert.deepEqual(bad.badCountries, ["KOREA", "J1"]);
});

test("요구사항 줄·요약: 없으면 정하지 않음, 빈 국가·운영 주체는 제한 없음", () => {
  assert.deepEqual(requirementRows(null), []);
  assert.equal(requirementsSummary(null), "정하지 않음");
  const r = { dataClass: "sensitive" as const, residency: [], keyOwnership: "provider" as const };
  assert.equal(requirementsSummary(r), "민감 정보 · 국가 제한 없음 · 제공자 키");
  assert.deepEqual(requirementRows({ ...r, operatorAllow: ["customer", "aws"] }).map((row) => row.value), ["민감 정보", "제한 없음", "제공자 키", "고객(온프레), AWS"]);
  // 고쳤다가 그대로 저장하면 같은 값 (왕복)
  const full = { dataClass: "personal" as const, residency: ["KR"], keyOwnership: "customer" as const, operatorAllow: ["aws" as const] };
  assert.deepEqual(requirementsFrom(draftOf(full)).requirements, full);
});

test("출발 DB 사실: 칸이 없으면 모름(null), 모름·값 없는 measured 는 비우고, 읽은 값은 출처를 붙인다", () => {
  assert.equal(factRows(undefined), null);
  const facts: Record<string, SourceDbFacts> = {
    "shop-db": {
      encryptedAtRest: { value: true, origin: "measured", source: "rds:shop-db.StorageEncrypted" },
      keyOwner: { value: null, origin: "unknown", source: null },
      tlsEnforced: { value: null, origin: "measured", source: "cloudsql:x" },
    },
  };
  const got = factRows(facts)!;
  assert.deepEqual(got.rows.map((row) => [row.name, row.value, row.origin]), [
    ["shop-db · 저장 암호화", "켜짐", "읽음 · rds:shop-db.StorageEncrypted"],
    ["shop-db · 키 소유", null, null],
    ["shop-db · TLS 강제", null, null],
  ]);
  assert.equal(got.summary, "모름 2칸");
  const attested = factRows({ db: { ...facts["shop-db"]!, keyOwner: { value: "customer", origin: "attested", source: "고객 선언" }, tlsEnforced: { value: false, origin: "measured", source: null } } })!;
  assert.deepEqual(attested.rows.slice(1).map((row) => [row.value, row.origin]), [["고객 키", "선언 · 고객 선언"], ["강제 안 함", "읽음"]]);
  assert.equal(attested.summary, "3칸 읽음");
});

const block: PrecheckItem = {
  id: "SEC:P-KEY-1:shop-db", level: "block",
  message: "FAIL 보안 — 고객 키가 제공자 기본 키로 내려간다 (shop-db). 고객이 쥐던 키가 제공자 기본 키로 바뀐다. 근거: source.keyOwner=모름 (unknown) / target.keyOwner=\"provider\" (attested, x)",
  fix: "도착에 고객 관리 키(CMK·CMEK)를 먼저 만들고 그 키로 DB 를 만든다",
};
const attest: PrecheckItem = {
  id: "SEC:P-KEY-2:shop-db", level: "warn",
  message: "WARN 보안 고객 확인 — 도착의 db.keyOwner 을(를) 모른다. 모름은 통과가 아니다 (shop-db). 확인할 것: 고객 키가 필요한데 도착 키 소유를 모른다. 근거: db.keyOwner=모름 (unknown)",
  fix: "고객이 이 값을 선언하고 그 선언을 감사 기록에 남긴다",
};
const unknown: PrecheckItem = {
  id: "SEC:UNKNOWN:source", level: "warn",
  message: "WARN 보안 — 출발 보안 사실 2개를 모른다. 모름은 통과가 아니다. 규칙: P-DB-1(shop-db), P-DB-3(env). 근거: a; b",
  fix: "observe 역할에 이 값을 읽을 권한을 더하고 다시 점검한다",
};
const advise: PrecheckItem = { id: "SEC:G-07:env", level: "info", message: "INFO 보안 — 패치·운영 책임이 고객에게 넘어간다. 관리형이 하던 패치를 고객이 해야 한다. 근거: aws → onprem", fix: "패치 주기를 고객과 정한다" };
const plain: PrecheckItem = { id: "PC-07", level: "warn", message: "도착 리전의 vCPU 한도가 80%입니다", fix: "한도 증설을 요청해 주세요" };

test("SEC 한 줄: 머리말과 근거를 떼고 제목·이유·조치로. 고객 확인은 warn 이어도 머리말로 가린다", () => {
  assert.deepEqual(secVerdictOf(block), {
    id: "SEC:P-KEY-1:shop-db", level: "block", title: "고객 키가 제공자 기본 키로 내려간다 (shop-db)", reason: "고객이 쥐던 키가 제공자 기본 키로 바뀐다",
    fix: "도착에 고객 관리 키(CMK·CMEK)를 먼저 만들고 그 키로 DB 를 만든다",
  });
  const a = secVerdictOf(attest)!;
  assert.equal(a.level, "attest");
  assert.equal(a.title, "도착의 db.keyOwner 을(를) 모른다");
  assert.equal(a.reason, "모름은 통과가 아니다 (shop-db). 확인할 것: 고객 키가 필요한데 도착 키 소유를 모른다");
  assert.equal(secVerdictOf(unknown)!.level, "warn");
  assert.equal(secVerdictOf(unknown)!.title, "출발 보안 사실 2개를 모른다");
  assert.equal(secVerdictOf(advise)!.level, "advise");
});

test("거부: SEC 가 아니면 null, 모양이 다른 SEC 문장은 그대로 제목으로 (글을 잃지 않는다)", () => {
  assert.equal(secVerdictOf(plain), null);
  const odd = secVerdictOf({ id: "SEC:NEW:env", level: "warn", message: "새 판정 문장" })!;
  assert.deepEqual([odd.level, odd.title, odd.reason, odd.fix], ["warn", "새 판정 문장", "", null]);
  assert.deepEqual(precheckLine(plain), { title: "도착 리전의 vCPU 한도가 80%입니다", detail: null });
  assert.deepEqual(precheckLine(block), { title: "고객 키가 제공자 기본 키로 내려간다 (shop-db)", detail: "고객이 쥐던 키가 제공자 기본 키로 바뀐다" });
});

test("SEC 묶음: 무거운 단계부터(막힘 → 주의 → 고객 확인 → 참고), SEC 아닌 점검은 빼고, 요약은 단계별 수", () => {
  const groups = secGroups([advise, plain, attest, unknown, block]);
  assert.deepEqual(groups.map((group) => [group.level, group.items.map((item) => item.id)]), [
    ["block", ["SEC:P-KEY-1:shop-db"]], ["warn", ["SEC:UNKNOWN:source"]], ["attest", ["SEC:P-KEY-2:shop-db"]], ["advise", ["SEC:G-07:env"]],
  ]);
  assert.equal(secSummary(groups), "막힘 1 · 주의 1 · 고객 확인 1 · 참고 1");
  assert.deepEqual(secGroups([plain]), []);
});

test("승인 확인 항목 종류: SEC 경고는 위험 받아들이기와 고객 확인을 나누고, 나머지는 기본 글자", () => {
  const ack = (item: PrecheckItem) => ({ kind: "precheck_warn" as const, ref: item.id, text: `${item.message} (조치: ${item.fix})` });
  assert.equal(secAckLabel(ack(attest)), "보안 고객 확인");
  assert.equal(secAckLabel(ack(unknown)), "보안 주의");
  assert.equal(secAckLabel(ack(plain)), null);
  assert.equal(secAckLabel({ kind: "cost", text: "예상 월 비용" }), null);
});

test("명세 v2 줄: 요구사항을 저장하면 생기는 security 표시는 읽은 값 줄에 넣지 않는다 (보안 요구사항 카드에서 본다)", () => {
  const view: MigrationSpecViewV2 = {
    migrationId: "m", version: 4, createdAt: "t", source: "accepted", complete: true, spec: {}, needsReview: [],
    specV2: { schemaVersion: "2", app: { name: "shop" }, components: [{ id: "db", kind: "postgres", props: { storageGb: 20 } }], links: [],
      security: { requirements: { dataClass: "personal", residency: ["KR"], keyOwnership: "customer" } } },
    needsReviewV2: [],
    fieldMetaV2: {
      "components.db.storageGb": { source: "rds:db", confidence: 1, needs_review: false },
      security: { source: "human", confidence: 1, needs_review: false },
    },
  };
  assert.deepEqual(specRowsV2(view).map((row) => row.key), ["components.db.storageGb"]);
});

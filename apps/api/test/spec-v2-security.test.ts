// PATCH "security": 앱 보안 요구사항을 넣고 지운다. 측정한 출발 사실(securityFacts)은 PATCH 로 못 바꾼다. 순수 함수 (DB 없음, 라우트 조립 순서만 따라 함)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImportResultV2, SpecPatchInput } from "@svc/contracts";
import { applySpecV2Patch } from "@svc/core";
import { normalizeV2 } from "@svc/adapters";

const requirements = { dataClass: "personal", residency: ["KR"], keyOwnership: "customer" } as const;
// 가져오기 v2 판 하나 (서비스 + RDS postgres, 저장 암호화 읽음 → securityFacts)
const base = (): ImportResultV2 => ImportResultV2.parse(normalizeV2({ provider: "aws", coverage: {}, items: [
  { kind: "k8s.deployment", imageDigest: "sha256:" + "ab".repeat(32), metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
      name: "api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }], env: [{ name: "DB_HOST", value: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }] }] } } } },
  { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16", AllocatedStorage: 20, StorageEncrypted: true,
    Endpoint: { Address: "shop-db.abc.ap-northeast-2.rds.amazonaws.com" }, DBInstanceArn: "arn:aws:rds:ap-northeast-2:000000000000:db:shop-db" },
] }).result);
// 라우트(apps/api routes/spec.ts)와 같은 순서: applySpecV2Patch → AppSpecV2 → 판 나머지 칸은 그대로 이어받아 ImportResultV2
const patch = (b: ImportResultV2, changes: { path: string; value: unknown }[]) => {
  const next = applySpecV2Patch({ spec: b.spec, fieldMeta: b.fieldMeta }, { changes });
  return { next, saved: ImportResultV2.safeParse({ ...b, spec: AppSpecV2.parse(next.spec), fieldMeta: next.fieldMeta }) };
};

test("security 를 넣으면 명세에 들어가고 표시는 사람 것 (검토 필요 아님 = 명세 확정을 막지 않음)", () => {
  const b = base();
  assert.ok(AppSpecV2.safeParse(b.spec).success, "security 없는 기존 판도 그대로 통과");
  const { next, saved } = patch(b, [{ path: "security", value: { requirements } }]);
  assert.ok(saved.success);
  assert.deepEqual(saved.data!.spec.security, { requirements });
  assert.deepEqual(next.fieldMeta.security, { source: "human", confidence: 1, needs_review: false });
  assert.deepEqual(next.changed, ["security"]);
  assert.ok(b.securityFacts?.["shop-db"], "준비: 가져오기가 출발 DB 사실을 붙였다");
  assert.deepEqual(saved.data!.securityFacts, b.securityFacts, "측정 사실은 그대로");
});

test("security null 은 칸을 지운다", () => {
  const withReq = patch(base(), [{ path: "security", value: { requirements } }]).saved.data!;
  const { saved } = patch(withReq, [{ path: "security", value: null }]);
  assert.ok(saved.success);
  assert.equal("security" in saved.data!.spec, false);
});

test("거부: 모양이 틀린 요구사항, 모르는 칸", () => {
  assert.throws(() => patch(base(), [{ path: "security", value: { requirements: { ...requirements, residency: ["korea"] } } }]));
  assert.throws(() => patch(base(), [{ path: "security", value: { requirements, extra: true } }]));
  assert.throws(() => patch(base(), [{ path: "security", value: { dataClass: "personal" } }]));
});

test("거부: securityFacts 는 PATCH 경로가 아니다 (사람이 출발 사실을 고쳐 판정을 낮출 수 없음)", () => {
  const input = (path: string) => SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path, value: {} }] }).success;
  assert.equal(input("security"), true);
  assert.equal(input("securityFacts"), false);
  assert.equal(input("securityFacts.shop-db"), false);
  assert.equal(input("security.requirements"), false);   // 통째로만
});

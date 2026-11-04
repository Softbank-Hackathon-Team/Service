// 검토 키 이름표: 아는 키는 사람이 읽는 말, 모르는 키는 키 그대로 (지어내지 않음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { MigrationSpecView, MigrationView, reviewLabel, reviewLabels } from "../src/index.js";

test("이름표: app.name·check.unread·check.pick·#n·components·links", () => {
  assert.equal(reviewLabel("app.name"), "앱 이름");
  assert.equal(reviewLabel("check.unread.s3"), "못 읽음: S3 버킷 — 출발에 있는지 확인");
  assert.equal(reviewLabel("check.unread.s3.truncated"), "못 읽음: S3 버킷 (일부만 읽음) — 출발에 있는지 확인");
  assert.equal(reviewLabel("check.unread.sqs.orders"), "못 읽음: SQS 큐 orders — 출발에 있는지 확인");
  assert.equal(reviewLabel("check.pick.namespace"), "자동으로 고름: k8s 네임스페이스 — 맞는지 확인");
  assert.equal(reviewLabel("check.pick.cluster#2"), "자동으로 고름: 클러스터 — 맞는지 확인 (2번째)");
  assert.equal(reviewLabel("components.shop.replicas"), "구성요소 shop 의 replicas");
  assert.equal(reviewLabel("links.shop->db"), "연결 shop → db");
  assert.deepEqual(reviewLabels(["app.name", "check.reviews[0]"]), { "app.name": "앱 이름", "check.reviews[0]": "검토 항목 1" });
});

test("거부: 모르는 키는 키 그대로, 모르는 what 도 그대로", () => {
  assert.equal(reviewLabel("weird.key"), "weird.key");
  assert.equal(reviewLabel("check.unread.zzz"), "못 읽음: zzz — 출발에 있는지 확인");
});

test("계약: MigrationView sourceScope 는 SourceScope 모양만 (모르는 칸 거부), MigrationSpecView reviewLabels 는 글자 값만", () => {
  const base = { id: "11111111-1111-4111-8111-111111111111", status: "draft", version: 1, sourceEnvId: "22222222-2222-4222-8222-222222222222",
    targetEnvId: "33333333-3333-4333-8333-333333333333", pausedFrom: null, failedAtStatus: null, failureCode: null, rollbackWindowEndsAt: null, updatedAt: "x" };
  assert.equal(MigrationView.safeParse({ ...base, sourceScope: { namespaces: ["shop"], cluster: "c1" } }).success, true);
  assert.equal(MigrationView.safeParse({ ...base, sourceScope: {} }).success, true);
  assert.equal(MigrationView.safeParse(base).success, true);
  assert.equal(MigrationView.safeParse({ ...base, sourceScope: { bogus: 1 } }).success, false);
  assert.equal(MigrationSpecView.shape.reviewLabels.safeParse({ "app.name": 1 }).success, false);
});

test("PF-A10: 실검증 EKS 입력에서 나오던 키 원문 → 이름표 (못 읽음 k8s·비밀번호 짝·벤더 주소·경계 밖·그 밖 점검)", () => {
  assert.equal(reviewLabel("unread.ClusterRoleBinding"), "못 읽음: k8s ClusterRoleBinding — 출발에 있는지 확인");
  assert.equal(reviewLabel("secrets.shop-db-app.keys.password.pairedWith"), "비밀 shop-db-app 의 password — 도착 DB 비밀번호와 짝 확인");
  assert.equal(reviewLabel("check.shop-api.env.DB_HOST.vendor.188b0b3b"), "shop-api.env.DB_HOST 에 출발 벤더 주소가 값으로 남음");
  assert.equal(reviewLabel("check.shop-api.configs.c.privateIp.0a1b"), "shop-api.configs.c 에 출발 사설 IP가 값으로 남음");
  assert.equal(reviewLabel("check.boundary.postgres"), "경계 밖: postgres — 같이 옮길지 확인");
  assert.equal(reviewLabel("check.shop-api.inCluster#2"), "점검 항목: shop-api.inCluster (2번째)");
  // 거부 쪽: 모르는 모양은 지어내지 않고 키 그대로
  assert.equal(reviewLabel("foo.bar"), "foo.bar");
});

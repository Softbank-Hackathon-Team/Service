import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEMS, displayName, parseOrder, placeOf } from "../items.mjs";

test("옛 시드 행 item-N 은 철물 이름으로, 새 주문은 그대로 보인다", () => {
  assert.equal(displayName("item-1"), ITEMS[0]);
  assert.equal(displayName("item-9"), ITEMS[0]);
  assert.equal(displayName("item-100"), ITEMS[(100 - 1) % ITEMS.length]);
  assert.equal(displayName("망치"), "망치");
});

test("주문 입력: 목록에 있는 상품·1~99개만 받는다", () => {
  assert.deepEqual(parseOrder({ item: "너트", qty: 3 }), { item: "너트", qty: 3 });
  assert.deepEqual(parseOrder({ item: "줄자" }), { item: "줄자", qty: 1 });
  assert.equal(parseOrder({ item: "다이너마이트", qty: 1 }), null);
  assert.equal(parseOrder({ item: "망치", qty: 0 }), null);
  assert.equal(parseOrder({ item: "망치", qty: 1.5 }), null);
  assert.equal(parseOrder(null), null);
});

test("DB 서버 설정으로 위치 이름을 고른다", () => {
  assert.equal(placeOf({ rds: true, cloudsql: false }), "AWS RDS");
  assert.equal(placeOf({ rds: false, cloudsql: true }), "GCP Cloud SQL");
  assert.equal(placeOf({ rds: false, cloudsql: false }), "Postgres (CNPG·자체 운영)");
  // 예전 규칙의 값 모양(문자열, null)은 관리형으로 보지 않는다
  assert.equal(placeOf({ rds: "1", cloudsql: null }), "Postgres (CNPG·자체 운영)");
  assert.equal(placeOf(undefined), "Postgres (CNPG·자체 운영)");
});

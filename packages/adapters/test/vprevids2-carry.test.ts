// VPREVIDS2: carryHumanEdits 순수성·경계·거친 입력
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_INVENTORY, normalizeV2 } from "../src/index.js";
import { carryHumanEdits } from "../src/import/carry.js";

type O = Record<string, any>;
const fresh = () => normalizeV2(structuredClone(DEMO_INVENTORY.gcp!)).result;
const humanPrev = (): any => {
  const p = structuredClone(fresh()) as O;
  p.spec.components.find((c: O) => c.id === "shop-api").props.replicas = { min: 7, max: 7 };
  p.fieldMeta["components.shop-api.replicas"] = { source: "human", confidence: 1, needs_review: false };
  return p;
};

test("입력(fresh·history)을 바꾸지 않는다, 같은 입력이면 결과가 같다", () => {
  const f = fresh(), h = [humanPrev(), fresh()];
  const before = JSON.stringify([f, h]);
  const x = carryHumanEdits(f, h), y = carryHumanEdits(f, h);
  assert.equal(JSON.stringify([f, h]), before);
  assert.deepEqual(x, y);
  assert.deepEqual(x.report.kept, ["shop-api.replicas"]);
});

test("새 판에 그 자원이 없으면(경계 밖) 던지지 않고 아무것도 안 하며 보고(dropped)에 이름으로 남는다", () => {
  const f = fresh(); f.spec.components = f.spec.components.filter((c) => c.id !== "shop-api");
  for (const k of Object.keys(f.fieldMeta)) if (k.startsWith("components.shop-api.")) delete f.fieldMeta[k];
  const { result, report } = carryHumanEdits(f, [humanPrev(), fresh()]);
  assert.deepEqual(result, f);
  assert.deepEqual(report, { kept: [], flagged: [], dropped: ["shop-api.replicas"] });   // PREVIDS3: 이름만 보고
});

test("거친 앞 판: 칸 이름이 constructor·__proto__ 여도 던지지 않고 프로토타입이 오염되지 않는다", () => {
  const h = humanPrev();
  for (const field of ["constructor", "__proto__", "toString"]) h.fieldMeta[`components.shop-api.${field}`] = { source: "human", confidence: 1, needs_review: false };
  const f = fresh();
  for (const field of ["constructor", "__proto__", "toString"]) f.fieldMeta[`components.shop-api.${field}`] = { source: "x", confidence: 1, needs_review: true };
  assert.doesNotThrow(() => carryHumanEdits(f, [h, fresh()]));
  assert.equal(({} as O).replicas, undefined);
  assert.equal(({} as O).min, undefined);
});

test("앞 판이 없으면(첫 가져오기) fresh 그대로 (같은 객체)", () => {
  const f = fresh();
  assert.equal(carryHumanEdits(f, []).result, f);
});

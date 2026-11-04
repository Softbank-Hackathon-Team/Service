// PREVIDS2: carryHumanEdits 순수 함수 시험
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_INVENTORY, normalizeV2, carryHumanEdits, CARRY_NOTE } from "../src/index.js";

const fresh = () => normalizeV2(DEMO_INVENTORY.onprem!).result;
const K = "components.shop-cleanup.resources";
const comp = (r: ReturnType<typeof fresh>, id = "shop-cleanup") => r.spec.components.find((c) => c.id === id)! as { props: Record<string, unknown> };

test("첫 가져오기(앞 판 없음): 입력 그대로", () => {
  const f = fresh();
  const { result, report } = carryHumanEdits(f, []);
  assert.deepEqual(result, f);
  assert.deepEqual(report, { kept: [], flagged: [], dropped: [] });
});

test("사람 수정 + 출발 같음 → 사람 값·표시 유지. 입력(fresh)은 안 바뀜", () => {
  const prev = fresh();
  comp(prev).props.resources = { request: { cpuMilli: 1, memMiB: 2 } };
  prev.fieldMeta[K] = { source: "human", confidence: 1, needs_review: false };
  const base = fresh();
  const snapshot = JSON.stringify(base);
  const { result, report } = carryHumanEdits(base, [prev, fresh()]);
  assert.deepEqual(comp(result).props.resources, { request: { cpuMilli: 1, memMiB: 2 } });
  assert.equal(result.fieldMeta[K]!.source, "human");
  assert.deepEqual(report.kept, ["shop-cleanup.resources"]);
  assert.equal(JSON.stringify(base), snapshot);
});

test("사람 수정 + 출발 바뀜 → 새 값 + needs_review + 메모", () => {
  const prev = fresh();
  comp(prev).props.resources = { request: { cpuMilli: 1, memMiB: 2 } };
  prev.fieldMeta[K] = { source: "human", confidence: 1, needs_review: false };
  const changed = fresh();
  comp(changed).props.resources = { request: { cpuMilli: 500, memMiB: 512 } };
  const { result, report } = carryHumanEdits(changed, [prev, fresh()]);
  assert.deepEqual(comp(result).props.resources, { request: { cpuMilli: 500, memMiB: 512 } });
  assert.equal(result.fieldMeta[K]!.needs_review, true);
  assert.ok(result.fieldMeta[K]!.rationale!.endsWith(CARRY_NOTE));
  assert.deepEqual(report.flagged, ["shop-cleanup.resources"]);
});

test("경계: 앞 판에 있던 자원이 새 판에 없으면(id 다름) 아무 것도 안 가져온다", () => {
  const prev = fresh();
  comp(prev).props.resources = { request: { cpuMilli: 1, memMiB: 2 } };
  prev.fieldMeta[K] = { source: "human", confidence: 1, needs_review: false };
  const f = fresh();
  f.spec.components = f.spec.components.filter((c) => c.id !== "shop-cleanup") as typeof f.spec.components;
  for (const k of Object.keys(f.fieldMeta)) if (k.startsWith("components.shop-cleanup.")) delete f.fieldMeta[k];
  const { result, report } = carryHumanEdits(f, [prev, fresh()]);
  assert.deepEqual(result, f);
  // PREVIDS3: 대상이 없어 못 옮긴 사람 값은 조용히 사라지지 않고 report.dropped 에 이름으로 남는다 (이전엔 보고 없음 — 시험 기대 변경)
  assert.deepEqual(report, { kept: [], flagged: [], dropped: ["shop-cleanup.resources"] });
});

test("확인만 한 칸: 출발 같으면 확인 유지, 바뀌면 다시 검토. 아무것도 안 한 칸은 그대로", () => {
  const prev = fresh();
  prev.fieldMeta[K] = { ...prev.fieldMeta[K]!, needs_review: false };
  const kept = carryHumanEdits(fresh(), [prev]);
  assert.equal(kept.result.fieldMeta[K]!.needs_review, false);
  assert.equal(kept.result.fieldMeta["components.shop-cleanup.probes"]!.needs_review, true);
  const f = fresh();
  comp(f).props.resources = { request: { cpuMilli: 9, memMiB: 9 } };
  const flagged = carryHumanEdits(f, [prev]);
  assert.equal(flagged.result.fieldMeta[K]!.needs_review, true);
  assert.deepEqual(flagged.report.flagged, ["shop-cleanup.resources"]);
});

test("사람이 두 번 고친 뒤에도 가져온 값(맨 처음)과 비교한다", () => {
  const v1 = fresh();
  const v2 = fresh(); comp(v2).props.resources = { request: { cpuMilli: 1, memMiB: 1 } }; v2.fieldMeta[K] = { source: "human", confidence: 1, needs_review: false };
  const v3 = structuredClone(v2); comp(v3).props.resources = { request: { cpuMilli: 2, memMiB: 2 } };
  const { result } = carryHumanEdits(fresh(), [v3, v2, v1]);
  assert.deepEqual(comp(result).props.resources, { request: { cpuMilli: 2, memMiB: 2 } });
});

// G3b-1·G3b-2·G3b-7: 합치기 바탕 = 그 판이 새로 읽은 값(fresh), 검증 못 넘는 단위는 빼고 다시 검토, components 밖 확인 표시 이어받기
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_INVENTORY, normalizeV2 } from "../src/index.js";
import { CARRY_SKIP_NOTE, carryHumanEdits as carry, type PrevSpecV2 } from "../src/import/carry.js";

type O = Record<string, any>;
const C = (f: any, h: any[], opts?: any): { result: any; report: { kept: string[]; flagged: string[]; dropped: string[] } } => carry(f, h as PrevSpecV2[], opts) as any;
const read = (mut?: (spec: O) => void): any => {
  const r = normalizeV2(structuredClone(DEMO_INVENTORY.gcp!)).result as any;
  mut?.(r.spec);
  r.fresh = { links: structuredClone(r.spec.links), ...(r.spec.entry ? { entry: structuredClone(r.spec.entry) } : {}), posture: structuredClone(r.spec.posture) };
  return r;
};
const HUMAN = { source: "human", confidence: 1, needs_review: false };
const extra = { from: "shop-web", to: "shop-worker", intent: "call" };
const addExtra = (s: O) => { s.links = [...s.links, { ...extra }]; };

test("G3b-1 거부: 사람이 고친 뒤 출발에 생겼다 사라진 링크는 '사람이 넣은 것'으로 남지 않는다", () => {
  const v1 = read();
  // v2: 사람이 링크 하나 지움 (PATCH)
  const v2 = structuredClone(v1); v2.spec.links = v2.spec.links.slice(1); v2.fieldMeta.links = { ...HUMAN };
  // v3: 다시 가져오기 — 출발에 extra 가 새로 생김 → 합친 결과(사람 표시 유지)
  const r3 = C(read(addExtra), [v2, v1]).result;
  assert.ok(r3.spec.links.some((l: O) => l.from === extra.from && l.to === extra.to), "새로 생긴 링크는 따라옴");
  assert.equal(r3.fieldMeta.links.source, "human");
  // v4: 출발에서 extra 가 다시 사라짐 → 빠져야 한다 (바탕 = v3 의 fresh 에 extra 가 있었음)
  const r4 = C(read(), [r3, v2, v1]);
  assert.ok(!r4.result.spec.links.some((l: O) => l.from === extra.from && l.to === extra.to), JSON.stringify(r4.result.spec.links));
  assert.equal(r4.result.spec.links.length, v2.spec.links.length, "사람이 지운 링크는 계속 지워짐");
});

test("G3b-1 정상: 사람이 넣은 링크는 바탕이 fresh 여도 남는다", () => {
  const v1 = read();
  const v2 = structuredClone(v1); addExtra(v2.spec); v2.fieldMeta.links = { ...HUMAN };
  const r = C(read(), [v2, v1]);
  assert.ok(r.result.spec.links.some((l: O) => l.from === extra.from && l.to === extra.to));
  assert.deepEqual(r.report.kept, ["links"]);
});

test("G3b-2: skip 에 든 단위는 사람 값을 옮기지 않고 새로 읽은 값 + 다시 검토 메모", () => {
  const v1 = read();
  const v2 = structuredClone(v1);
  v2.spec.components.find((c: O) => c.id === "shop-api").props.replicas = { min: 7, max: 8 };
  v2.fieldMeta["components.shop-api.replicas"] = { ...HUMAN };
  const kept = C(read(), [v2, v1]);
  assert.deepEqual(kept.result.spec.components.find((c: O) => c.id === "shop-api").props.replicas, { min: 7, max: 8 });
  const skipped = C(read(), [v2, v1], { skip: new Set(["shop-api.replicas"]) });
  assert.notDeepEqual(skipped.result.spec.components.find((c: O) => c.id === "shop-api").props.replicas, { min: 7, max: 8 });
  const m = skipped.result.fieldMeta["components.shop-api.replicas"];
  assert.equal(m.needs_review, true);
  assert.match(m.rationale, new RegExp(CARRY_SKIP_NOTE));
  assert.deepEqual(skipped.report.flagged, ["shop-api.replicas"]);
});

test("G3b-7: 확인한 check.* 키·같은 링크의 확인 표시는 이어받고, 바뀐 링크는 다시 검토", () => {
  const v1 = read();
  const lk = `links.${v1.spec.links[0].from}->${v1.spec.links[0].to}`;
  const flag = (r: any) => { r.fieldMeta["check.shop-api.env.X.vendor.0000abcd"] = { source: "checkV2", confidence: 0.6, needs_review: true }; r.fieldMeta[lk] = { source: "env", confidence: 0.9, needs_review: true }; return r; };
  flag(v1);
  const v2 = structuredClone(v1);
  v2.fieldMeta["check.shop-api.env.X.vendor.0000abcd"].needs_review = false; v2.fieldMeta[lk].needs_review = false;   // 사람이 확인
  const r = C(flag(read()), [v2, v1]).result;
  assert.equal(r.fieldMeta["check.shop-api.env.X.vendor.0000abcd"].needs_review, false);
  assert.equal(r.fieldMeta[lk].needs_review, false);
  const changed = flag(read((s) => { s.links[0] = { ...s.links[0], intent: "admin" }; }));
  assert.equal(C(changed, [v2, v1]).result.fieldMeta[lk].needs_review, true, "링크가 바뀌면 다시 검토");
});

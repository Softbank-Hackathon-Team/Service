// PREVIDS3: 재가져오기 때 사람이 PATCH 한 links·entry·posture 유지, 판 창(묶음 밖 복귀), 대상 없음 보고, 멱등
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_INVENTORY, normalizeV2 } from "../src/index.js";
import { CARRY_NOTE, carryHumanEdits as carry } from "../src/import/carry.js";
const carryHumanEdits = (f: any, h: any[]): { result: any; report: { kept: string[]; flagged: string[]; dropped: string[] } } => carry(f, h) as any;

type O = Record<string, any>;
const fresh = (): any => normalizeV2(structuredClone(DEMO_INVENTORY.gcp!)).result;
const HUMAN = { source: "human", confidence: 1, needs_review: false };
// 사람이 고친 판: 바탕 판 위에 mutate 한 것 + 키 표시를 human 으로 (applySpecV2Patch 와 같은 모양)
const edited = (keys: string[], mutate: (spec: O) => void, base: any = fresh()): any => {
  const p = structuredClone(base); mutate(p.spec);
  for (const k of keys) { p.fieldMeta[k] = { ...HUMAN }; for (const m of Object.keys(p.fieldMeta)) if (m.startsWith(`${k}.`)) p.fieldMeta[m] = { ...HUMAN }; }
  return p;
};
const withUnknownIngress = (r: any) => {   // 가져오기가 못 읽은 방화벽 (사전 점검이 사람에게 정하라고 막는 값)
  r.spec.posture.network = [...r.spec.posture.network.filter((n: O) => !(n.scope === "component" && n.subject === "shop-api")),
    { scope: "component", subject: "shop-api", mode: "mirror", ingress: "unknown", public: null }];
  return r;
};
const netOf = (r: any, id: string) => r.spec.posture.network.find((n: O) => n.scope === "component" && n.subject === id);

test("posture: 사람이 정한 ingress 허용 목록이 재가져오기 뒤에도 그대로 (사전 점검이 다시 막지 않음), 표시는 사람 것", () => {
  const base = withUnknownIngress(fresh());
  const human = edited(["posture"], (s) => { Object.assign(s.posture.network.find((n: O) => n.subject === "shop-api"), { ingress: [{ from: "10.0.0.0/16" }], public: false }); }, base);
  const { result, report } = carryHumanEdits(withUnknownIngress(fresh()), [human, base]);
  assert.deepEqual(netOf(result, "shop-api").ingress, [{ from: "10.0.0.0/16" }]);
  assert.equal(netOf(result, "shop-api").public, false);
  assert.equal(result.fieldMeta.posture.source, "human");
  assert.equal(result.fieldMeta.posture.needs_review, false);
  assert.deepEqual(report.kept, ["posture"]);
});

test("links: 사람이 지운 링크는 계속 지워지고, 사람이 더한 링크는 남는다 (출발 안 바뀜)", () => {
  const base = fresh();
  assert.ok(base.spec.links.length >= 2);
  const gone = base.spec.links[0], added = { from: "shop-web", to: "shop-worker", intent: "call" as const };
  const human = edited(["links"], (s) => { s.links = [...s.links.slice(1), added]; }, base);
  const { result, report } = carryHumanEdits(fresh(), [human, base]);
  const key = (l: O) => `${l.from}>${l.to}/${l.intent}`;
  assert.ok(!result.spec.links.some((l: O) => key(l) === key(gone)));
  assert.ok(result.spec.links.some((l: O) => key(l) === key(added)));
  assert.equal(result.spec.links.length, base.spec.links.length);
  assert.deepEqual(report.kept, ["links"]);
});

test("links: 출발이 바뀐 항목은 출발 값 + 다시 검토 + 메모, 사람이 더한 링크는 그대로", () => {
  const base = fresh();
  const added = { from: "shop-web", to: "shop-worker", intent: "call" as const };
  const human = edited(["links"], (s) => { s.links = [...s.links, added]; }, base);
  const changed = fresh();
  changed.spec.links.push({ from: "shop-worker", to: "shop-db", intent: "admin" });   // 출발에서 새로 읽힌 링크
  changed.spec.links[0] = { ...changed.spec.links[0], intent: changed.spec.links[0].intent === "read" ? "write" : "read" };   // 출발이 바뀐 링크 (사람이 안 건드림 → 출발 따름)
  const { result, report } = carryHumanEdits(changed, [human, base]);
  assert.ok(result.spec.links.some((l: O) => l.from === "shop-worker" && l.intent === "admin"), "출발에서 새로 읽힌 링크는 들어옴");
  assert.ok(result.spec.links.some((l: O) => l.from === added.from && l.to === added.to && l.intent === added.intent), "사람이 더한 링크 유지");
  assert.equal(result.spec.links.filter((l: O) => l.from === changed.spec.links[0].from && l.to === changed.spec.links[0].to).length >= 1, true);
  assert.deepEqual(report.kept.concat(report.flagged).filter((x) => x === "links"), ["links"]);
});

test("links: 사람이 바꾼 항목의 출발도 바뀌었으면 출발 값 + needs_review + 메모", () => {
  const base = fresh();
  const target = base.spec.links[0];
  const human = edited(["links"], (s) => { s.links[0] = { ...target, intent: "admin" }; }, base);
  const changed = fresh(); changed.spec.links[0] = { ...target, intent: target.intent === "read" ? "write" : "read" };
  const { result, report } = carryHumanEdits(changed, [human, base]);
  assert.deepEqual(report.flagged, ["links"]);
  assert.equal(result.fieldMeta.links.needs_review, true);
  assert.ok(String(result.fieldMeta.links.rationale).includes(CARRY_NOTE));
  assert.ok(result.spec.links.some((l: O) => l.from === target.from && l.to === target.to && l.intent === changed.spec.links[0].intent));
});

test("links: 대상 자원이 새 판에 없으면 그 사람 링크는 빠지고 report.dropped 에 이름만", () => {
  const base = fresh();
  const human = edited(["links"], (s) => { s.links.push({ from: "shop-web", to: "shop-worker", intent: "call" }); }, base);
  const f = fresh();
  f.spec.components = f.spec.components.filter((c: O) => c.id !== "shop-worker");
  f.spec.links = f.spec.links.filter((l: O) => l.from !== "shop-worker" && l.to !== "shop-worker");
  const { result, report } = carryHumanEdits(f, [human, base]);
  assert.ok(!result.spec.links.some((l: O) => l.to === "shop-worker" || l.from === "shop-worker"));
  assert.ok(report.dropped.some((d) => d.startsWith("links:") && d.includes("shop-worker")));
  assert.ok(!JSON.stringify(report).includes("10.0.0"));
});

test("entry: 사람이 고친 라우팅(가중치)이 재가져오기 뒤에도 그대로", () => {
  const base = fresh();
  assert.ok(base.spec.entry?.hosts?.length, "데모에 entry 있어야 함");
  const human = edited(["entry"], (s) => { s.entry.hosts[0].routes[0].backends[0].weight = 7; }, base);
  const { result, report } = carryHumanEdits(fresh(), [human, base]);
  assert.equal(result.spec.entry.hosts[0].routes[0].backends[0].weight, 7);
  assert.deepEqual(report.kept, ["entry"]);
});

test("바탕 판을 못 찾으면(사람 판 하나뿐) 사람 값 유지 + 다시 검토", () => {
  const base = withUnknownIngress(fresh());
  const human = edited(["posture"], (s) => { Object.assign(s.posture.network.find((n: O) => n.subject === "shop-api"), { ingress: [{ from: "10.0.0.0/16" }], public: false }); }, base);
  const { result, report } = carryHumanEdits(withUnknownIngress(fresh()), [human]);
  assert.deepEqual(netOf(result, "shop-api").ingress, [{ from: "10.0.0.0/16" }]);
  assert.deepEqual(report.flagged, ["posture"]);
  assert.equal(result.fieldMeta.posture.needs_review, true);
});

test("판 창: 한 판 동안 묶음 밖이었다 돌아와도 부품 칸의 사람 값이 유지된다", () => {
  const v1 = fresh();
  const humanApi = edited(["components.shop-api.replicas"], (s) => { s.components.find((c: O) => c.id === "shop-api").props.replicas = { min: 7, max: 8 }; }, v1);
  const outside = fresh();   // shop-api 가 없던 판
  outside.spec.components = outside.spec.components.filter((c: O) => c.id !== "shop-api");
  for (const k of Object.keys(outside.fieldMeta)) if (k.startsWith("components.shop-api.")) delete outside.fieldMeta[k];
  const { result, report } = carryHumanEdits(fresh(), [outside, humanApi, v1]);
  assert.deepEqual(result.spec.components.find((c: O) => c.id === "shop-api").props.replicas, { min: 7, max: 8 });
  assert.deepEqual(report.kept, ["shop-api.replicas"]);
  // 바로 앞 판에서 사람 값을 다시 출발 값으로 되돌렸으면(비사람 표시) 더 옛 사람 값은 되살리지 않는다
  const reverted = fresh();
  assert.deepEqual(carryHumanEdits(fresh(), [reverted, humanApi, v1]).report.kept, []);
});

test("멱등: 합친 결과를 다시 앞 판으로 넣어도 같은 결과, 다시 검토 표시는 사람이 확인하기 전까지 그대로", () => {
  const base = withUnknownIngress(fresh());
  const human = edited(["posture", "links"], (s) => {
    Object.assign(s.posture.network.find((n: O) => n.subject === "shop-api"), { ingress: [{ from: "10.0.0.0/16" }], public: false });
    s.links = s.links.slice(1);
    s.links[0] = { ...s.links[0], intent: "admin" };   // 사람이 링크 하나의 intent 도 바꿈
  }, base);
  const src = () => { const f = withUnknownIngress(fresh()); f.spec.links[1] = { ...f.spec.links[1], intent: f.spec.links[1].intent === "call" ? "read" : "call" }; return f; };
  const r1 = carryHumanEdits(src(), [human, base]);
  const r2 = carryHumanEdits(src(), [r1.result, human, base]);
  const r3 = carryHumanEdits(src(), [r2.result, r1.result, human, base]);
  for (const r of [r2, r3]) { assert.deepEqual(r.result.spec, r1.result.spec); assert.deepEqual(r.result.fieldMeta, r1.result.fieldMeta); }
  assert.equal(r1.result.fieldMeta.links.needs_review, true, "출발이 바뀐 링크가 있어 다시 검토");
  assert.equal(r3.result.fieldMeta.links.needs_review, true, "확인 전까지 유지");
});

test("키 순서만 다른 같은 값은 같다 (DB jsonb 는 키를 다시 정렬해 돌려준다): 부품 칸 유지", () => {
  const v1 = fresh();
  const hv = { memMiB: 256, cpuMilli: 200 };
  const human = edited(["components.shop-api.resources"], (s) => { s.components.find((c: O) => c.id === "shop-api").props.resources = { request: hv }; }, v1);
  // 앞 판 기준(v1) 값을 키 순서를 뒤집어 저장한 것처럼
  const reordered = structuredClone(v1);
  const r = reordered.spec.components.find((c: O) => c.id === "shop-api").props.resources;
  if (r?.request) r.request = { memMiB: r.request.memMiB, cpuMilli: r.request.cpuMilli };
  const { report } = carryHumanEdits(fresh(), [human, reordered]);
  assert.deepEqual(report.kept, ["shop-api.resources"]);
});

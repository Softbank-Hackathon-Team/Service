// VSMOKE: smoke 가 명세 확인 칸을 화면처럼 confirm 하는 본문 (tools/smoke-env.ts smokeReviewBody·smokeConfirmReview)
import { test } from "node:test";
import assert from "node:assert/strict";
import { smokeConfirmReview, smokePostureDecision, smokeReviewBody } from "../../../tools/smoke-env.js";

test("확인 칸 없음 + 받아들인 판 → 요청 안 보냄 (깃발 꺼짐 회차 그대로)", () => {
  assert.equal(smokeReviewBody({ version: 1, source: "accepted", needsReview: [] }), null);
  assert.equal(smokeReviewBody({ version: 1, source: "accepted", needsReview: [], needsReviewV2: [] }), null);
});

test("v2 확인 칸이 있으면 v2 키를 confirm (v1 키 아님), AI 초안이면 acceptDraft 같이, 20칸씩", () => {
  const v2 = Array.from({ length: 25 }, (_, i) => `components.s${i}.resources`);
  assert.deepEqual(smokeReviewBody({ version: 3, source: "accepted", needsReview: ["service.cpu"], needsReviewV2: v2 }),
    { baseVersion: 3, confirm: v2.slice(0, 20) });
  assert.deepEqual(smokeReviewBody({ version: 2, source: "ai_draft", needsReview: [] }), { baseVersion: 2, acceptDraft: 2 });
  assert.deepEqual(smokeReviewBody({ version: 2, source: "accepted", needsReview: ["service.cpu"] }), { baseVersion: 2, confirm: ["service.cpu"] });
});

test("다 없어질 때까지 GET→PATCH, 줄지 않으면 멈춘다(무한 반복 안 함)", async () => {
  let left = 25, version = 1; const sent: unknown[] = [];
  const call = async (m: string, _p: string, b?: unknown) => {
    if (m === "PATCH") { sent.push(b); left -= (b as { confirm: string[] }).confirm.length; version++; return {}; }
    return { version, source: "accepted", needsReview: [], needsReviewV2: Array.from({ length: left }, (_, i) => `k${i}`) };
  };
  assert.equal(await smokeConfirmReview(call, "x"), 25);
  assert.deepEqual(sent.map((b) => (b as { baseVersion: number }).baseVersion), [1, 2]);
  const stuck = async (m: string) => (m === "PATCH" ? {} : { version: 1, source: "accepted", needsReview: ["a"] });
  await assert.rejects(smokeConfirmReview(stuck, "x", 3), /3번 PATCH 뒤에도/);
});

test("방화벽 모름(ingress unknown) 컴포넌트만 빈 허용 목록으로, 나머지(CIDR·앱 범위)는 그대로. 모름이 없으면 null", () => {
  const spec = { posture: { encryption: { atRest: true }, network: [
    { scope: "component", subject: "shop-db", ingress: "unknown", public: false },
    { scope: "component", subject: "shop-cache", ingress: [{ from: "10.0.0.0/16", port: 6379 }], public: false },
    { scope: "app", subject: "app", ingress: "unknown", public: null },
  ] } };
  const d = smokePostureDecision(spec)!;
  assert.deepEqual(d.subjects, ["shop-db"]);
  const net = (d.value as { network: Array<{ subject: string; ingress: unknown }> }).network;
  assert.deepEqual(net.map((x) => x.ingress), [[], [{ from: "10.0.0.0/16", port: 6379 }], "unknown"]);
  assert.deepEqual((d.value as { encryption: unknown }).encryption, { atRest: true });
  assert.equal(smokePostureDecision({ posture: { network: [] } }), null);
  assert.equal(smokePostureDecision(undefined), null);
});

test("E2EKINDS: v2 칸은 다 풀렸는데 v1 칸(service.cpu·memory)만 남으면 components.<앱>.resources 를 confirm / v1 판·앱 이름 없음은 그대로", () => {
  const spec = { app: { name: "shop-api" } };
  assert.deepEqual(smokeReviewBody({ version: 4, source: "accepted", needsReview: ["service.cpu", "service.memory"], needsReviewV2: [], spec }),
    { baseVersion: 4, confirm: ["components.shop-api.resources"] });
  assert.deepEqual(smokeReviewBody({ version: 4, source: "accepted", needsReview: ["service.cpu"], needsReviewV2: ["components.shop-api.resources"], spec }),
    { baseVersion: 4, confirm: ["components.shop-api.resources"] }, "이미 들어 있으면 두 번 안 넣음");
  // 거부: v1 판(needsReviewV2 없음)은 v1 키 그대로, 앱 이름을 모르면 아무것도 안 보냄
  assert.deepEqual(smokeReviewBody({ version: 1, source: "accepted", needsReview: ["service.cpu"], spec }), { baseVersion: 1, confirm: ["service.cpu"] });
  assert.equal(smokeReviewBody({ version: 1, source: "accepted", needsReview: ["service.cpu"], needsReviewV2: [] }), null);
});

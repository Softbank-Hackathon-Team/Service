import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, HttpError, newIdempotencyKey, or404, RETRY } from "../src/http";
import { LABEL, PLAN_STEP_STATUS, progressPct, statusText } from "../src/status";

// 작업 Z46: 화면 HTTP 요청 한 곳(http.ts)의 규칙을 브라우저 없이 확인한다

type Call = { url: string; init: RequestInit };
function fakeFetch(replies: Array<number | "net">) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (r === "net") throw new TypeError("fetch failed");
    const body = r >= 400 ? JSON.stringify({ code: r === 404 ? "NOT_FOUND" : "X", message: "m", status: r }) : '{"ok":true}';
    return new Response(body, { status: r });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const mk = (replies: Array<number | "net">, tenant = "t-1") => {
  const ff = fakeFetch(replies);
  let n = 0;
  const c = createClient({ base: "/api", tenant: () => tenant, fetch: ff.f, sleep: async () => {}, newKey: () => `k${++n}` });
  return { c, calls: ff.calls };
};
const headers = (c: Call) => c.init.headers as Record<string, string>;

test("모든 요청에 회사 번호 헤더, POST 에만 Idempotency-Key", async () => {
  const { c, calls } = mk([200]);
  await c.get("/migrations");
  await c.post("/migrations", { a: 1 });
  await c.post("/migrations/x/start");
  assert.equal(calls[0]!.url, "/api/migrations");
  assert.equal(headers(calls[0]!)["x-dev-tenant"], "t-1");
  assert.equal(headers(calls[0]!)["idempotency-key"], undefined);
  assert.equal(headers(calls[1]!)["idempotency-key"], "k1");
  assert.equal(headers(calls[1]!)["content-type"], "application/json");
  assert.equal(calls[1]!.init.body, '{"a":1}');
  // 본문 없는 POST 는 content-type 도 본문도 없다 (예전 call() 과 같음)
  assert.equal(headers(calls[2]!)["content-type"], undefined);
  assert.equal(calls[2]!.init.body, undefined);
});

test("GET 은 네트워크 오류·502/503/504 에서 한 번만 다시 시도한다", async () => {
  for (const first of ["net", 502, 503, 504] as const) {
    const { c, calls } = mk([first, 200]);
    assert.deepEqual(await c.get("/x"), { ok: true });
    assert.equal(calls.length, RETRY.getAttempts, String(first));
  }
  const { c, calls } = mk([503, 503, 503]);
  await assert.rejects(c.get("/x"), (e) => e instanceof HttpError && e.status === 503);
  assert.equal(calls.length, RETRY.getAttempts);
});

test("4xx·500 과 POST 는 다시 시도하지 않는다", async () => {
  for (const s of [400, 404, 409, 500]) {
    const { c, calls } = mk([s, 200]);
    await assert.rejects(c.get("/x"), HttpError);
    assert.equal(calls.length, 1, String(s));
  }
  const { c, calls } = mk(["net", 200]);
  await assert.rejects(c.post("/x", {}), TypeError);
  assert.equal(calls.length, 1);
});

test("or404: 404 만 null, 다른 오류는 그대로", async () => {
  const { c } = mk([404]);
  assert.equal(await or404(c.get("/x")), null);
  const b = mk([409]);
  await assert.rejects(or404(b.c.get("/x")), (e) => e instanceof HttpError && e.status === 409);
});

test("상태 이름은 LABEL 하나에서 (계획서 단계·칩 글자·용어표 4개)", () => {
  assert.equal(statusText("spec_review"), "명세 검토 · spec_review");
  for (const [step, s] of Object.entries(PLAN_STEP_STATUS)) assert.ok(LABEL[s], step);
  assert.deepEqual(Object.values(PLAN_STEP_STATUS).map((s) => LABEL[s]),
    ["자원 생성", "앱 배포", "DB 복제", "트래픽 이동", "DB 컷오버", "정리"]);
  // GLOSSARY.md 2절 굵은 글씨 4개
  assert.equal(LABEL.shifting, "트래픽 이동");
  assert.equal(LABEL.paused, "일시 정지");
  assert.equal(LABEL.rolling_back, "롤백 중");
  assert.equal(LABEL.rolled_back, "롤백 완료");
  assert.equal(progressPct({ status: "completed" }), 100);
  assert.equal(progressPct({ status: "cancelled" }), 0);
  assert.equal(progressPct({ status: "paused", pausedFrom: "shifting" }), 73);
});

// Z38 REVIEW-4 W-4: 보안 문맥이 아니라 randomUUID 가 없어도 키를 만든다 (서버 패턴 ^[A-Za-z0-9_.:-]{8,200}$ 통과)
test("Idempotency-Key: randomUUID 없는 브라우저(http://IP)에서도 UUIDv4 를 만든다", () => {
  const noUuid = { getRandomValues: <T extends ArrayBufferView | null>(a: T) => globalThis.crypto.getRandomValues(a as Uint8Array) as unknown as T };
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const k = newIdempotencyKey(noUuid as unknown as Pick<Crypto, "getRandomValues">);
    assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(k, /^[A-Za-z0-9_.:-]{8,200}$/);
    seen.add(k);
  }
  assert.equal(seen.size, 50);
  assert.equal(newIdempotencyKey({ getRandomValues: () => { throw new Error("no"); }, randomUUID: () => "r-1234567" } as never), "r-1234567");
});

test("Z38 REVIEW-4 W-2: POST 가 409 RETRY 면 같은 키로 한 번 더, 다른 409 는 그대로 오류", async () => {
  const calls: Call[] = [];
  const replies = [{ s: 409, code: "RETRY" }, { s: 202, code: "" }];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(r.s >= 400 ? JSON.stringify({ status: r.s, code: r.code, message: "m" }) : '{"ok":true}', { status: r.s });
  }) as unknown as typeof fetch;
  let n = 0;
  const c = createClient({ base: "/api", tenant: () => "t", fetch: f, sleep: async () => {}, newKey: () => `k${++n}` });
  assert.deepEqual(await c.post("/m/x/rollback", {}), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(headers(calls[0]!)["idempotency-key"], "k1");
  assert.equal(headers(calls[1]!)["idempotency-key"], "k1");        // 같은 키 → 서버가 두 번 처리하지 않음
  // 다른 409(INVALID_TRANSITION 등)는 다시 보내지 않는다
  const { c: c2, calls: calls2 } = mk([409, 200]);
  await assert.rejects(c2.post("/x", {}), HttpError);
  assert.equal(calls2.length, 1);
});

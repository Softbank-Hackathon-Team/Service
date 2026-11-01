// Z17: 경로 응답 스키마가 실제로 직렬화에 걸리는지, 순수 함수 결과와 맞는지 (DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { buildTimeline } from "@svc/core";
import { Accepted, MigrationList, Timeline, errors } from "../src/routes/responses.js";

function app(response: Record<number, unknown>, body: unknown, code = 200) {
  const a = Fastify({ logger: false });
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  a.get("/x", { schema: { response } as never }, async (_req, reply) => reply.code(code).send(body as never));
  return a;
}

test("모양이 맞으면 본문 그대로", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const r = await app({ 202: Accepted }, { id }, 202).inject("/x");
  assert.equal(r.statusCode, 202);
  assert.deepEqual(r.json(), { id });
});

test("strict 응답에 모르는 칸이 끼면 조용히 새지 않고 500", async () => {
  const r = await app({ 202: Accepted }, { id: "11111111-1111-4111-8111-111111111111", secret: "x" }, 202).inject("/x");
  assert.equal(r.statusCode, 500);
});

test("목록 시각이 Date 객체면 500 (그래서 SQL에서 to_char로 문자열을 만든다)", async () => {
  const row = { id: "11111111-1111-4111-8111-111111111111", status: "draft", version: 0,
    sourceEnvId: "22222222-2222-4222-8222-222222222222", targetEnvId: "33333333-3333-4333-8333-333333333333" };
  const ok = await app({ 200: MigrationList }, { items: [{ ...row, updatedAt: "2026-10-31T17:00:00.000Z" }] }).inject("/x");
  assert.equal(ok.statusCode, 200);
  const bad = await app({ 200: MigrationList }, { items: [{ ...row, updatedAt: new Date() }] }).inject("/x");
  assert.equal(bad.statusCode, 500);
});

test("오류 응답(ApiError)은 4칸 그대로", async () => {
  const e = { status: 409, code: "INVALID_TRANSITION", message: "x", requestId: "req-1" };
  const r = await app({ 200: Accepted, ...errors(409) }, e, 409).inject("/x");
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json(), e);
});

test("core buildTimeline 결과가 Timeline 스키마를 통과 (인터페이스와 Zod가 같은 모양)", () => {
  const t = buildTimeline([
    { seq: "1", at: "2026-10-31T17:00:00.000Z", actor: "user:dev", action: "migration.importing", result: "ok",
      detail: { from: "draft", to: "importing", requestId: "req-1" } },
    { seq: "2", at: new Date("2026-10-31T17:00:01.000Z"), actor: "worker", action: "measure", result: "ok",
      detail: { measurements: [{ name: "replication_lag_ms", value: 120, unit: "ms", env: "target" }] } },
    { seq: "3", at: "2026-10-31T17:00:02.000Z", actor: "worker", action: "migration.spec_review", result: "ok",
      detail: { from: "importing", to: "spec_review", failureCode: null } },
  ], { id: "11111111-1111-4111-8111-111111111111", status: "spec_review", createdAt: "2026-10-31T16:59:59.000Z" },
  new Date("2026-10-31T17:00:03.000Z"));
  const p = Timeline.safeParse(t);
  assert.ok(p.success, p.success ? "" : JSON.stringify(p.error.issues));
  assert.equal(p.data?.items[1]?.measurements[0]?.env, "target"); // 모르는 칸(env)도 남는다
});

// Z38 REVIEW-4 W-3: 실제로 나가는 429(속도 제한, 모든 경로)·403(터널 쓰기 거부, 쓰기 경로)이 문서에 있다
test("문서 오류 코드: 모든 경로에 429, 쓰기(POST) 경로에 403", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8")) as
    { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
  let posts = 0, all = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    if (path.startsWith("/agent/") || path.startsWith("/api/v1/agent/") || path.startsWith("/healthz") || path.startsWith("/readyz")) continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!op?.responses || !Object.keys(op.responses).some((c) => c === "401")) continue;
      all++;
      assert.ok(op.responses["429"], `${method.toUpperCase()} ${path}: 429 없음`);
      // Z93: 로그인·갱신은 개발 헤더를 안 써서 터널 403 이 없다 (토큰·쿠키로만 인증)
      if (method === "post" && !path.startsWith("/api/v1/auth/")) { posts++; assert.ok(op.responses["403"], `POST ${path}: 403 없음`); }
    }
  }
  assert.ok(all >= 18 && posts >= 8, `all=${all} posts=${posts}`);
});

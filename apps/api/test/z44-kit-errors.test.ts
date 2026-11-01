// Z44: 오류 변환 한 곳(errors 플러그인) + 경로 도우미(kit.ts). DB 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { DomainError, NotFound } from "@svc/core";
import { AdapterError, RunnerUnavailable } from "@svc/adapters";
import { errorsPlugin } from "../src/plugins/errors.js";
import { IdParam, auditOk, found, isoUtc, nextJob } from "../src/routes/kit.js";

async function appThrowing(err: unknown) {
  const a = Fastify({ logger: false });
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  await a.register(errorsPlugin);
  a.get("/x", async () => { throw err; });
  a.get("/v/:id", { schema: { params: IdParam } }, async () => ({ ok: true }));
  return a;
}

test("errors 플러그인: 예외 종류 → 상태·코드 (예전 경로별 변환과 같은 결과)", async () => {
  const cases: Array<[unknown, number, string, string]> = [
    [new DomainError(409, "ENV_BUSY", "e1"), 409, "ENV_BUSY", "e1"],
    [new NotFound("migration", "m"), 404, "NOT_FOUND", "migration m"],
    [new RunnerUnavailable("AZURE_MOCK_DISABLED", "AZURE_MOCK=0: Azure는 Mock 실행기만 있다"), 409, "AZURE_MOCK_DISABLED", "AZURE_MOCK=0: Azure는 Mock 실행기만 있다"],
    // RunnerUnavailable 이 아닌 어댑터 오류는 예전처럼 500 (메시지 숨김)
    [new AdapterError("IMAGE_DIGEST_MISSING", "digest 없는 이미지: x"), 500, "INTERNAL", "internal error"],
    [Object.assign(new Error("fk"), { code: "23503" }), 404, "NOT_FOUND", "referenced resource not found"],
    [new Error("boom"), 500, "INTERNAL", "internal error"],
  ];
  for (const [err, status, code, message] of cases) {
    const a = await appThrowing(err);
    const r = await a.inject({ method: "GET", url: "/x" });
    assert.equal(r.statusCode, status, code);
    assert.deepEqual(Object.keys(r.json()), ["status", "code", "message", "requestId"]);
    assert.deepEqual({ ...r.json<Record<string, unknown>>(), requestId: "" }, { status, code, message, requestId: "" });
    await a.close();
  }
});

test("IdParam 검증 실패 → 400 BAD_REQUEST", async () => {
  const a = await appThrowing(null);
  const r = await a.inject({ method: "GET", url: "/v/not-a-uuid" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().code, "BAD_REQUEST");
  await a.close();
});

test("kit: nextJob·auditOk 는 예전 손으로 쓴 객체와 같다", () => {
  const req = { tenantId: "t", id: "req-1", actor: "user:dev" } as FastifyRequest;
  assert.deepEqual(nextJob(req, "import", "m"),
    { queue: "import", data: { tenantId: "t", requestId: "req-1", migrationId: "m" }, opts: { singletonKey: "import:m" } });
  assert.deepEqual(nextJob(req, "apply", "m", { extra: { planId: "p", planHash: "h" }, singletonKey: "apply:env" }),
    { queue: "apply", data: { tenantId: "t", requestId: "req-1", migrationId: "m", planId: "p", planHash: "h" },
      opts: { singletonKey: "apply:env" } });
  assert.deepEqual(auditOk(req, "migration.importing", "m"),
    { actor: "user:dev", action: "migration.importing", target: "m", result: "ok" });
  assert.equal("detail" in auditOk(req, "a", "m"), false);
  assert.deepEqual(auditOk(req, "a", "m", { from: "x" }).detail, { from: "x" });
});

test("kit: isoUtc 는 상세 조회에 쓰던 SQL 식 그대로, found 는 null·undefined 만 404", () => {
  assert.equal(isoUtc("updated_at"), `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  assert.equal(found(0, "x", "1"), 0);
  assert.equal(found("", "x", "1"), "");
  assert.throws(() => found(undefined, "plan", "p"), (e) => e instanceof NotFound && e.message === "plan p");
  assert.throws(() => found(null, "plan", "p"), NotFound);
  assert.ok(IdParam instanceof z.ZodObject);
});

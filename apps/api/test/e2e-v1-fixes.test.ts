// E2E v1 에서 찾은 버그 두 개의 시험 (DB 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { StartInput } from "@svc/contracts";
import { errorsPlugin } from "../src/plugins/errors.js";

test("StartInput: 화면·smoke 의 빈 본문 {} 를 받는다 (깃발 off 때 400 이던 것), 모르는 칸·빈 지문은 거부", () => {
  assert.equal(StartInput.safeParse({}).success, true);
  assert.equal(StartInput.safeParse({ planHash: "abc" }).success, true);
  assert.equal(StartInput.safeParse({ planHash: "" }).success, false);
  assert.equal(StartInput.safeParse({ other: 1 }).success, false);
});

test("errors 플러그인: content-type json + 빈 본문 DELETE 는 500 이 아니라 400 BAD_REQUEST", async () => {
  const app = Fastify();
  await app.register(errorsPlugin);
  app.delete("/x", async () => ({ ok: true }));
  const r = await app.inject({ method: "DELETE", url: "/x", headers: { "content-type": "application/json" } });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().code, "BAD_REQUEST");
  await app.close();
});

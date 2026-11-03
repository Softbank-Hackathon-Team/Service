// LOGLEAK: 로그 가리기. worker·agent-worker(createLogger)와 api(Fastify 옵션) 둘 다
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createLogger, fastifyObservabilityOptions, scrubString, scrubValue } from "../src/index.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sigsigsig1";
const ET = "et_" + "A".repeat(43);
const parse = (ls: string[]) => ls.map((l) => JSON.parse(l) as Record<string, any>);

test("worker 로거: 비밀 이름 칸은 깊이 상관없이, 문자열 속 비밀 모양은 모두 가린다", () => {
  const ls: string[] = [];
  const log = createLogger("worker", {}, { write: (l) => ls.push(l) });
  log.error({
    err: new Error(`connect postgres://app:dbpw-1@db:5432/x failed; Bearer abc.def-ghi; ${JWT}; ${ET}; AKIAABCDEFGHIJKLMNOP; sk-ant-api03-abcdefgh`),
    password: "pw", input: { deep: { apiKey: "k", Authorization: "Bearer zzzzzzzz" } }, DATABASE_URL: "postgres://u:dbpw-2@h/d",
    list: [{ token: "t1" }, "svc_refresh=cookieval; Path=/"], url: "https://x/y?access_token=qq&a=1",
  }, `msg with ${ET}`);
  const all = ls.join("\n");
  for (const s of ["dbpw-1", "dbpw-2", "abc.def-ghi", JWT, ET, "AKIAABCDEFGHIJKLMNOP", "sk-ant-api03", "\"pw\"", "\"k\"", "zzzzzzzz", "t1", "cookieval", "access_token=qq"])
    assert.ok(!all.includes(s), `새는 값: ${s}`);
  const o = parse(ls)[0]!;
  assert.equal(o.input.deep.apiKey, "[redacted]");
  assert.match(o.err.message, /^connect postgres:\/\/app:\[redacted\]@db:5432\/x failed/);
  assert.match(o.url, /a=1$/);                      // 비밀 아닌 쿼리는 남는다
});

test("거부 쪽: 비밀이 아닌 값·숫자 칸은 그대로 (input_tokens, token_count, tenant_id, 일반 문자열)", () => {
  const ls: string[] = [];
  const log = createLogger("worker", {}, { write: (l) => ls.push(l) });
  log.info({ input_tokens: 12, output_tokens: 3, token_count: 5, tenant_id: "t-1", reason: "ok http://example.com/a", external_id: "svc-ext-1", dur: 1 }, "llm call");
  const o = parse(ls)[0]!;
  assert.deepEqual([o.input_tokens, o.output_tokens, o.token_count, o.tenant_id, o.reason, o.external_id], [12, 3, 5, "t-1", "ok http://example.com/a", "svc-ext-1"]);
  assert.equal(scrubValue(null), null);
  assert.equal(scrubString("평범한 문장"), "평범한 문장");
});

test("순환 참조·깊은 객체도 던지지 않는다", () => {
  const a: Record<string, unknown> = { n: 1 }; a.self = a;
  assert.doesNotThrow(() => scrubValue(a));
  let d: Record<string, unknown> = {}; const root = d;
  for (let i = 0; i < 20; i++) { d.x = {}; d = d.x as Record<string, unknown>; }
  assert.doesNotThrow(() => JSON.stringify(scrubValue(root)));
});

test("api 로거: 깊은 칸·헤더 객체·오류 메시지·요청 주소 쿼리의 비밀이 안 남는다", async () => {
  const ls: string[] = [];
  const o = fastifyObservabilityOptions("api");
  const app = Fastify({ ...o, logger: { ...o.logger, level: "debug", stream: { write: (l: string) => { ls.push(l); } } } });
  app.get("/x", async (req) => {
    req.log.info({ body: { password: "pw1", nested: { token: "tk1" } }, headers: { authorization: "Bearer abcdefgh" }, DATABASE_URL: "postgres://u:dbpw@h/d" }, "hi");
    throw new Error("connect postgres://u:dbpw2@h:5432/d failed Bearer sekret.tok.en");
  });
  const r = await app.inject({ url: `/x?token=qtok&ok=1`, headers: { authorization: "Bearer headerval1", cookie: "svc_refresh=ck1" } });
  assert.equal(r.statusCode, 500);
  const all = ls.join("\n");
  for (const s of ["pw1", "tk1", "abcdefgh", "dbpw", "sekret.tok.en", "qtok", "headerval1", "ck1"]) assert.ok(!all.includes(s), `새는 값: ${s}`);
  assert.match(all, /ok=1/);
  const req = parse(ls).find((l) => l.req)!.req;
  assert.deepEqual(Object.keys(req).sort(), ["host", "method", "remoteAddress", "url"]);   // 헤더는 안 찍는다
  await app.close();
});

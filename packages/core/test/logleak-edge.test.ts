// VLOGLEAK: 로그 가리기 경계. 중첩 3단, 배열 안 토큰, Error cause 체인, pg 오류의 접속 주소, 환경변수식 칸 이름, agent-worker 로거
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createLogger, fastifyObservabilityOptions, scrubValue } from "../src/index.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sigsigsig1";
const parse = (ls: string[]) => ls.map((l) => JSON.parse(l) as Record<string, any>);
const grab = () => { const ls: string[] = []; return { ls, log: createLogger("agent-worker", {}, { write: (l) => ls.push(l) }) }; };
const leaks = (all: string, secrets: string[]) => secrets.filter((s) => all.includes(s));

test("중첩 3단·배열 안 객체·배열 안 모양 있는 토큰: 새는 값 0", () => {
  const { ls, log } = grab();
  const S = ["deep-pw-1", "arr-tok-2", "nested-key-3", "pat-4", "cookie-5"];
  log.warn({ a: { b: { c: { password: S[0], list: [{ token: S[1] }, { x: { apiKey: S[2] } }] } } },
    tokens: [`svc_pat_${"Z".repeat(20)}`, JWT, `Bearer ${S[3]}abcdef`], headers: { cookie: `svc_refresh=${S[4]}; a=b` } });
  const all = ls.join("\n");
  assert.deepEqual(leaks(all, [...S, "svc_pat_ZZZZ", JWT]), []);
});

test("Error cause 체인·pg 오류 모양(접속 주소가 message·detail·connectionString 에): 새는 값 0", () => {
  const { ls, log } = grab();
  const inner = new Error("password authentication failed for user app; url postgres://app:cause-pw-1@db:5432/x");
  const pgErr = Object.assign(new Error("connect ECONNREFUSED postgres://u:msg-pw-2@h:5432/d", { cause: inner }),
    { code: "ECONNREFUSED", detail: "postgres://u:detail-pw-3@h/d", connectionString: "postgres://u:cs-pw-4@h/d" });
  log.error({ err: pgErr, e2: pgErr }, `fail ${pgErr.message}`);
  assert.deepEqual(leaks(ls.join("\n"), ["cause-pw-1", "msg-pw-2", "detail-pw-3", "cs-pw-4"]), []);
});

test("debug 에서 stack 도 가린다 (스택 첫 줄에 message 가 들어간다)", () => {
  const prev = process.env.LOG_LEVEL; process.env.LOG_LEVEL = "debug";
  try {
    const { ls, log } = grab();
    log.error({ err: new Error("boom postgres://u:stack-pw-1@h/d") });
    assert.deepEqual(leaks(ls.join("\n"), ["stack-pw-1"]), []);
  } finally { if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev; }
});

test("환경변수식·카멜 칸 이름: AWS_SECRET_ACCESS_KEY, PGPASSWORD, newPassword, ANTHROPIC_API_KEY, awsSessionToken", () => {
  const { ls, log } = grab();
  const env = { AWS_SECRET_ACCESS_KEY: "env-sak-1", PGPASSWORD: "env-pgpw-2", newPassword: "env-npw-3", ANTHROPIC_API_KEY: "env-ant-4",
    awsSessionToken: "env-st-5", AWS_SESSION_TOKEN: "env-st-6", secretKey: "env-sk-7", bearerToken: "env-bt-8", clientSecret: "env-cs-9" };
  log.info({ env });
  assert.deepEqual(leaks(ls.join("\n"), Object.values(env)), []);
});

test("거부: 이름이 비슷한 숫자·일반 칸은 그대로 (tokenizer, passwordPolicy 이름 아님 → 값 보존), 'keys' 개수", () => {
  const { ls, log } = grab();
  log.info({ tokens_used: 5, max_tokens: 100, key_count: 2, primary_key: "id", monkey: "banana" });
  const o = parse(ls)[0]!;
  assert.deepEqual([o.tokens_used, o.max_tokens, o.key_count, o.primary_key, o.monkey], [5, 100, 2, "id", "banana"]);
});

test("api(Fastify 옵션): req.log 에 중첩 헤더·본문·pg 오류를 찍어도 새지 않고, 요청 줄 주소 쿼리 토큰도 가린다", async () => {
  const lines: string[] = [];
  const o = fastifyObservabilityOptions("api");
  const app = Fastify({ ...o, logger: { ...o.logger, level: "debug", stream: { write: (l: string) => { lines.push(l); } } } });
  app.get("/x", async (req) => {
    req.log.info({ ctx: { headers: { authorization: "Bearer hdr-tok-1abcdef", nested: { deeper: { password: "api-pw-2" } } } } }, "deep");
    req.log.error(Object.assign(new Error("db down postgres://a:api-db-3@h/d"), { code: "X" }));
    req.log.warn(["arr", { token: "api-arr-4" }] as unknown as object, "arr");
    return { ok: true };
  });
  await app.inject({ url: "/x?token=qs-tok-5&a=1", headers: { authorization: "Bearer hdr-tok-6abcdef", cookie: "svc_refresh=ck-7" } });
  await app.close();
  assert.deepEqual(leaks(lines.join("\n"), ["hdr-tok-1", "api-pw-2", "api-db-3", "api-arr-4", "qs-tok-5", "hdr-tok-6", "ck-7"]), []);
});

test("scrubValue: Map·Set·Buffer·Date 같은 비-일반 객체도 던지지 않고 비밀을 안 낸다", () => {
  const m = new Map([["password", "map-pw-1"]]);
  const out = JSON.stringify(scrubValue({ m, s: new Set(["set-x"]), b: Buffer.from("buf-secret-2"), d: new Date(0), bi: 12345678901234567890n }));
  assert.ok(!out.includes("map-pw-1") && !out.includes("buf-secret-2"), out);
  assert.match(out, /\[binary 12 bytes\]/);
  assert.match(out, /"bi":"12345678901234567890"/);
  // 실제 로거 한 줄도 BigInt 때문에 던지지 않는다
  const ls: string[] = []; createLogger("worker", {}, { write: (l) => ls.push(l) }).info({ n: 10n });
  assert.equal(JSON.parse(ls[0]!).n, "10");
});

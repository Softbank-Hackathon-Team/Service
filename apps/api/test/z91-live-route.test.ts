// Z91: POST /security/check (GET 의 live 칸은 security.db.test 가 실제 DB 로 지난다). DB 없이 (재료·실행기·기록을 끼움)
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { NotFound } from "@svc/core";
import type { LiveSecurityReport as ZLive } from "@svc/contracts";
import type { ExecRunner, LiveSecurityReport as TLive, LiveTarget } from "@svc/security";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { securityRoutes } from "../src/routes/security.js";
import { clearLiveCache } from "../src/security/live.js";

// 두 모양(Zod 계약 ↔ security 순수 TS)이 같은지 컴파일 때 확인
const toZ = (x: TLive): ZLive => x;
const toT = (x: ZLive): TLive => x;
void toZ; void toT;

const T = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const targets: LiveTarget[] = [
  { side: "source", provider: "onprem", envId: "s", accountId: null, tfOutputs: null, stubOutputs: false },
  { side: "target", provider: "aws", envId: "t", accountId: "123456789012", tfOutputs: { db_address: "x", cluster_name: "" }, stubOutputs: false },
];
const noCreds: ExecRunner = async () => ({ code: 255, stdout: "", stderr: "Unable to locate credentials" });

async function appWith(o: { record?: (t: string, a: string, m: string, r: ZLive[]) => Promise<void>; calls?: string[] } = {}) {
  clearLiveCache();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(securityRoutes, { prefix: "/api/v1", env: {},
    liveTargets: async (t: string, m: string) => { if (m !== M || t !== T) throw new NotFound("migration", m); return targets; },
    run: async (c: string, a: string[]) => { o.calls?.push(`${c} ${a[0]} ${a[1]}`); return noCreds(c, a); },
    record: o.record ?? (async () => {}) });
  return app;
}

test("POST /security/check: 출발·도착 보고서 + 기록, 자격 없으면 unavailable 이유, 계정 번호 없음", async () => {
  const rec: { side: string }[] = [];
  const calls: string[] = [];
  const app = await appWith({ record: async (_t, actor, m, r) => { assert.equal(m, M); assert.match(actor, /^user:/); rec.push(...r); }, calls });
  const res = await app.inject({ method: "POST", url: `/api/v1/migrations/${M}/security/check`, headers: { "x-dev-tenant": T } });
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.recorded, true);
  assert.equal(rec.length, 2);
  assert.equal(b.target.credentials, "unavailable");
  assert.match(b.target.reason, /AWS 자격 없음/);
  assert.equal(b.source.provider, "onprem");
  assert.doesNotMatch(res.body, /123456789012/);
  assert.deepEqual(calls, ["aws sts get-caller-identity"]);   // 자격이 없으면 한 번만 부른다
  const other = await app.inject({ method: "POST", url: `/api/v1/migrations/${M}/security/check`, headers: { "x-dev-tenant": "99999999-9999-4999-8999-999999999999" } });
  assert.equal(other.statusCode, 404);
  await app.close();
});

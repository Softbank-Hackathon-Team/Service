// VVERIFYAPI DB 시험(경계): 환경 목록의 missingPermissions·needsHuman 칸.
//   계정 ID·ARN 계정 칸 가림 · 100개 넘는 목록 자름 · 긴 줄 자름 · docs/openapi.json 의 EnvironmentList 스키마와 응답 일치
//   (SSE 쪽: 연결 확인은 이전 신호를 안 보낸다 → apps/worker/test/obsrole3-verify.db.test.ts)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const H = { "x-dev-tenant": T };
const ACCT = "123456789012";

let core: typeof import("@svc/core");
let contracts: typeof import("@svc/contracts");
let route: typeof import("../src/routes/environments.js");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  contracts = await import("@svc/contracts");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { idempotencyPlugin } = await import("../src/plugins/idempotency.js");
  route = await import("../src/routes/environments.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vverifyapi'), ($2,'test-vverifyapi-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(route.environmentRoutes, { prefix: P });
  await app.ready();
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

// 문서 스키마 검사기 (이 응답에 나오는 키워드만: $ref·type·enum·properties·required·additionalProperties·items·maxItems·maxLength·format uuid).
// DRAFT(ai): ajv 는 fastify 의 간접 의존이라 직접 import 하지 않는다 (새 의존성 안 넣음)
type S = Record<string, any>;
function oasErrors(defs: S, sch: S, x: unknown, at: string): string[] {
  if (sch.$ref) return oasErrors(defs, defs[String(sch.$ref).replace("#/components/schemas/", "")], x, at);
  const out: string[] = [];
  const types: string[] = sch.type === undefined ? [] : [sch.type].flat();
  const tOf = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (types.length && !types.some((t) => t === tOf(x) || (t === "number" && typeof x === "number"))) return [`${at}: type ${tOf(x)} ∉ ${types}`];
  if (sch.enum && !sch.enum.includes(x)) out.push(`${at}: enum`);
  if (typeof x === "string") {
    if (sch.maxLength !== undefined && x.length > sch.maxLength) out.push(`${at}: maxLength`);
    if (sch.pattern && !new RegExp(sch.pattern).test(x)) out.push(`${at}: pattern`);
  }
  if (Array.isArray(x)) {
    if (sch.maxItems !== undefined && x.length > sch.maxItems) out.push(`${at}: maxItems`);
    if (sch.items) x.forEach((v, i) => out.push(...oasErrors(defs, sch.items, v, `${at}[${i}]`)));
  }
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o = x as Record<string, unknown>, props: S = sch.properties ?? {};
    for (const k of sch.required ?? []) if (!(k in o)) out.push(`${at}.${k}: required`);
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) out.push(...oasErrors(defs, props[k], v, `${at}.${k}`));
      else if (sch.additionalProperties === false) out.push(`${at}.${k}: additional`);
    }
  }
  return out;
}

async function seed(name: string, detail: unknown, provider = "aws", tenant = T) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, verify_detail) VALUES ($1,$2,$3,$4,'connected',$5)`,
    [id, tenant, provider, name, JSON.stringify(detail)]);
  return id;
}
async function listRaw() {
  const r = await app.inject({ method: "GET", url: `${P}/environments`, headers: H });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { items: Array<Record<string, unknown>> };
}
const one = async (id: string) => (await listRaw()).items.find((x) => x.id === id)!;

test("가림: 권한 이름·할 일에 섞인 12자리 계정 ID·ARN 계정 칸은 끝 4자리만, 다른 숫자는 그대로", { skip }, async () => {
  const id = await seed("aws-arn", {
    missingPermissions: [`arn:aws:iam::${ACCT}:role/svc-observe`, `s3:GetObject on arn:aws:s3:::app-${ACCT}-logs/*`, "compute.instances.list"],
    needsHuman: [`계정 ${ACCT} 에서 연결 템플릿을 다시 실행 (스택 9876543210987 은 13자리라 그대로)`],
  });
  const e = await one(id);
  const all = JSON.stringify(e);
  assert.equal(all.includes(ACCT), false, all);
  assert.deepEqual(e.missingPermissions, ["arn:aws:iam::••••9012:role/svc-observe", "s3:GetObject on arn:aws:s3:::app-••••9012-logs/*", "compute.instances.list"]);
  assert.match((e.needsHuman as string[])[0]!, /계정 ••••9012 에서/);
  assert.match((e.needsHuman as string[])[0]!, /9876543210987/, "12자리가 아닌 숫자는 안 가림");
  const raw = (await owner.query("SELECT verify_detail FROM environments WHERE id=$1", [id])).rows[0].verify_detail;
  assert.equal(raw.missingPermissions[0].includes(ACCT), true, "DB 원본은 그대로 (가림은 응답에서만)");
});

test("100개 넘는 목록: 앞 100개만, 한 줄은 300자까지 → 500 아니고 계약 통과", { skip }, async () => {
  const many = Array.from({ length: 250 }, (_, i) => `perm.n${String(i).padStart(3, "0")}.list`);
  const id = await seed("gcp-many", { missingPermissions: many, needsHuman: ["x".repeat(5000)] }, "gcp");
  const e = await one(id);
  assert.equal((e.missingPermissions as string[]).length, route.VERIFY_LIST_MAX);
  assert.deepEqual(e.missingPermissions, many.slice(0, 100));
  assert.equal((e.needsHuman as string[])[0]!.length, route.VERIFY_ITEM_MAX);
  assert.equal(contracts.EnvironmentView.safeParse(e).success, true);
  assert.equal(contracts.EnvironmentView.safeParse({ ...e, missingPermissions: many }).success, false, "계약도 100개 상한");
});

test("거부: 모양 틀림(문자열 아닌 값 섞임·객체·문자열 하나)은 칸이 안 붙는다", { skip }, async () => {
  const ids = [
    await seed("bad-mixed", { missingPermissions: ["a.b.list", 7], needsHuman: [null] }),
    await seed("bad-obj", { missingPermissions: { a: 1 }, needsHuman: "다시 실행" }),
    await seed("bad-root", ["a.b.list"]),
  ];
  for (const id of ids) {
    const e = await one(id);
    assert.equal("missingPermissions" in e || "needsHuman" in e, false, id);
  }
});

test("openapi: GET /environments 응답이 docs/openapi.json 의 EnvironmentList 스키마를 통과 (칸 있음·없음·자름 모두)", { skip }, async () => {
  const doc = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8"));
  const ref = doc.paths["/api/v1/environments"].get.responses["200"].content["application/json"].schema.$ref as string;
  assert.equal(ref, "#/components/schemas/EnvironmentList");
  const ev = doc.components.schemas.EnvironmentView;
  for (const k of ["missingPermissions", "needsHuman"]) {
    assert.equal(ev.properties[k]?.maxItems, 100, `${k} maxItems 가 문서에 있어야 함 (openapi 다시 생성)`);
    assert.equal(ev.required?.includes(k) ?? false, false, `${k} 는 선택 칸`);
  }
  const validate = (x: unknown) => oasErrors(doc.components.schemas, { $ref: ref }, x, "$");
  await seed("oas-plain", { clusters: ["c"] });
  await seed("oas-missing", { missingPermissions: ["a.b.list"], needsHuman: ["다시 실행"] }, "gcp");
  const body = await listRaw();
  assert.ok(body.items.some((x) => "missingPermissions" in x) && body.items.some((x) => !("missingPermissions" in x)));
  assert.deepEqual(validate(body), []);
  assert.ok(validate({ items: [{ ...body.items[0], missingPermissions: Array(101).fill("a") }] }).length > 0, "문서 스키마도 101개 거부");
  assert.ok(validate({ items: [{ ...body.items[0], verifyDetail: {} }] }).length > 0, "문서에 없는 칸(verifyDetail)은 거부");
});

test("남의 회사: 다른 회사 verify_detail(계정 ID 포함)은 목록에 안 나온다", { skip }, async () => {
  const id = await seed("other-arn", { missingPermissions: [`arn:aws:iam::${ACCT}:role/x`] }, "aws", OTHER);
  const body = await listRaw();
  assert.equal(body.items.some((x) => x.id === id), false);
});

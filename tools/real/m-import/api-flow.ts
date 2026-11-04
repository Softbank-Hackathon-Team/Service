// M-import API 흐름 (상태: AI 초안). 이전 만들기(가져오기) → spec_review → 명세 저장 → 계획(PLAN_IR=v2) → awaiting_approval → 계획서 저장.
// 승인·시작은 하지 않는다 (자원 0). 사용: npx tsx .m-import/api-flow.ts <출력 폴더>
//   환경: API_PORT(3000) · MI_TENANT(1111…) · MI_SOURCE_ENV(온프레 5555…) · MI_TARGET_ENV(gcp 3333…) · MI_TIMEOUT_MS(180000)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeFromEnv } from "./scope.js";

const out = process.argv[2] ?? "";
if (!out) { console.error("사용: api-flow.ts <출력 폴더>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
// AUTHSMOKE: demo-day 의 API 는 DEV_AUTH 없이 뜬다(x-dev-tenant 는 시험 전용) → 데모 계정 로그인. 비밀번호 찾는 순서는 smoke·env:connect 와 같다
//   (환경변수 → .env 의 DEMO_USER_PASSWORD → auth:seed 가 쓴 .secrets/demo-login.txt). 접근 토큰 15분 → 401 이면 한 번 다시 로그인
const H: Record<string, string> = { "content-type": "application/json" };
const readOr = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const PW = process.env.DEMO_USER_PASSWORD?.trim()
  || readOr(".env").split("\n").filter((l) => l.startsWith("DEMO_USER_PASSWORD=")).pop()?.slice(19).trim().replace(/^["']|["']$/g, "")
  || readOr(".secrets/demo-login.txt").match(/password\s*[:=]\s*(\S+)/i)?.[1];
async function login(): Promise<boolean> {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.DEMO_USER_EMAIL?.trim() || "demo@dev-company.test", password: PW }) });
  if (!r.ok) { console.log(`FAIL 로그인 ${r.status} (npm run auth:seed 로 데모 계정 비밀번호를 넣었는지)`); return false; }
  H.authorization = `Bearer ${((await r.json()) as { accessToken: string }).accessToken}`;
  return true;
}
const LOGGED_IN = PW ? await login() : false;
if (PW && !LOGGED_IN) process.exit(1);
if (!LOGGED_IN) H["x-dev-tenant"] = process.env.MI_TENANT || "11111111-1111-4111-8111-111111111111";
const LIMIT = Number(process.env.MI_TIMEOUT_MS ?? 180000);
const T0 = Date.now();

async function call(method: string, path: string, body?: unknown) {
  const send = () => fetch(`${API}${path}`, { method, headers: method === "PATCH" ? { ...H, "idempotency-key": crypto.randomUUID() } : H, body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  let res = await send();
  if (res.status === 401 && LOGGED_IN && await login()) res = await send();
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status >= 400) { console.log(`FAIL ${method} ${path} ${res.status} ${JSON.stringify(json).slice(0, 400)}`); process.exit(1); }
  return json;
}
let last = "";
async function waitFor(id: string, target: string) {
  for (;;) {
    const m = await call("GET", `/migrations/${id}`) as { status: string; failureCode?: string; failureDetail?: unknown };
    if (m.status !== last) { console.log(`STATUS +${Date.now() - T0}ms ${m.status}`); last = m.status; }
    if (m.status === target) return m;
    if (["failed", "cancelled", "rolled_back"].includes(m.status) || Date.now() - T0 > LIMIT) {
      writeFileSync(join(out, "migration-stopped.json"), JSON.stringify(m, null, 2) + "\n");
      console.log(`FAIL 멈춤 ${m.status} ${m.failureCode ?? ""}`); process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const sourceEnvId = process.env.MI_SOURCE_ENV || "55555555-5555-4555-8555-555555555555";
const targetEnvId = process.env.MI_TARGET_ENV || "33333333-3333-4333-8333-333333333333";
// IR-04: 출발 범위(sourceScope)를 이전 만들 때 넘긴다 → 워커에 IMPORT_NAMESPACE 를 손으로 넣지 않아도 그 네임스페이스만 읽는다.
//   MI_NAMESPACES(쉼표) MI_CLUSTER MI_ECS_CLUSTER MI_DATABASE MI_PART_OF MI_APP_NAME. 하나도 없으면 예전처럼 안 보냄(자동 고르기)
const sourceScope = scopeFromEnv(process.env);
if (sourceScope) console.log(`SCOPE ${JSON.stringify(sourceScope)}`);
const { id } = await call("POST", "/migrations", { sourceEnvId, targetEnvId, ...(sourceScope ? { sourceScope } : {}) }) as { id: string };
console.log(`MIGRATION ${id}`);
writeFileSync(join(out, "migration-id.txt"), `${id}\n`);
await waitFor(id, "spec_review");
const spec = await call("GET", `/migrations/${id}/spec`);
writeFileSync(join(out, "spec-view.json"), JSON.stringify(spec, null, 2) + "\n");
console.log(`SPEC version=${spec.version} v2=${spec.specV2 ? "yes" : "no"} needsReviewV2=${(spec.needsReviewV2 as unknown[] | undefined)?.length ?? 0}`);
if (!spec.specV2) { console.log("FAIL spec_v2 없음 (IMPORT_IR=v2 가 안 먹었거나 v1 로 되돌아감)"); process.exit(1); }

// 사람 검토 자리: 검토 필요 칸이 있으면 /plan 이 409 GUARD_FAILED 로 막는다 (정상 동작). 시험 실행이라 그 칸을 PATCH confirm 으로 확인한다.
//   v2 판은 v2 키로만 확인 가능 → v1 service.cpu·memory(단계 올림) 는 components.<주 서비스>.resources 로. 확인한 키는 confirmed.json 에 남긴다
// DRAFT(ai): 자동 확인은 이 시험 스크립트에서만. 실제 화면에서는 사람이 값을 보고 확인한다
const v1Review = (spec.needsReview as string[] | undefined) ?? [];
const v2Review = (spec.needsReviewV2 as string[] | undefined) ?? [];
if (v1Review.length || v2Review.length) {
  const main = ((spec.spec as { app?: { name?: string } } | undefined)?.app?.name) ?? "";
  const confirm = [...new Set([...v2Review, ...(v1Review.some((k) => /^service\.(cpu|memory)$/.test(k)) ? [`components.${main}.resources`] : [])])];
  const other = v1Review.filter((k) => !/^service\.(cpu|memory)$/.test(k) && !k.startsWith("service.env."));
  const patched = await call("PATCH", `/migrations/${id}/spec`, { baseVersion: spec.version, confirm: confirm.slice(0, 20) });
  const left = [...((patched.needsReview as string[] | undefined) ?? []), ...((patched.needsReviewV2 as string[] | undefined) ?? [])];
  writeFileSync(join(out, "confirmed.json"), JSON.stringify({ v1Review, v2Review, confirm, other, left, version: patched.version }, null, 2) + "\n");
  console.log(`REVIEW v1=${v1Review.join(",") || "-"} v2=${v2Review.length} confirm=${confirm.join(",")} left=${left.join(",") || "0"}`);
  if (left.length) { console.log(`FAIL 검토 칸이 남음: ${left.join(",")}`); process.exit(1); }
}

await call("POST", `/migrations/${id}/plan`);
await waitFor(id, "awaiting_approval");
const plan = await call("GET", `/migrations/${id}/plan`);
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
const doc = (plan.doc ?? plan) as Record<string, unknown>;
console.log(`PLAN ${plan.planId} irVersion=${doc.irVersion ?? "?"} specSource=${doc.specSource ?? "?"} instances=${Array.isArray(doc.instances) ? doc.instances.length : "?"}`);
console.log("OK");

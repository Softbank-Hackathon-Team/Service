// 실제 서버 응답을 docs/openapi.json 스키마로 검증 (ajv 2020). 문서 = 코드인지 확인
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
const doc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
ajv.addSchema({ $id: "oas", components: doc.components });
const fix = (s) => JSON.parse(JSON.stringify(s).replaceAll('"#/components/', '"oas#/components/'));
const API = "http://localhost:3000";
const H = { "content-type": "application/json", "x-dev-tenant": "11111111-1111-4111-8111-111111111111" };
let ok = 0, bad = 0;
async function call(method, path, tmpl, body, hdr = H) {
  const res = await fetch(API + path, { method, headers: hdr, body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  const ct = res.headers.get("content-type") ?? "";
  const json = ct.includes("json") ? await res.json() : await res.text();
  const resp = doc.paths[tmpl][method.toLowerCase()].responses[String(res.status)];
  if (!resp) { bad++; console.log("UNDOCUMENTED STATUS", method, tmpl, res.status, json); return json; }
  if (!ct.includes("json")) {
    const mt = ct.split(";")[0];
    if (resp.content?.[mt]) { ok++; console.log("ok ", res.status, method, tmpl, mt); } else { bad++; console.log("BAD media", mt, method, tmpl); }
    return json;
  }
  const schema = resp.content?.["application/json"]?.schema ?? (resp.$ref ? doc.components.responses[resp.$ref.split("/").pop()].content["application/json"].schema : null);
  if (!schema) { ok++; return json; }
  const v = ajv.compile(fix(schema));
  if (v(json)) { ok++; console.log("ok ", res.status, method, tmpl); }
  else { bad++; console.log("BAD", res.status, method, tmpl, JSON.stringify(v.errors).slice(0, 300)); }
  return json;
}
const wait = async (id, target) => { for (let i = 0; i < 300; i++) { const r = await fetch(`${API}/api/v1/migrations/${id}`, { headers: H }).then(r => r.json()); if (r.status === target) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("timeout " + target); };
await call("GET", "/healthz", "/healthz");
await call("GET", "/readyz", "/readyz");
await call("GET", "/api/v1/environments", "/api/v1/environments");
await call("GET", "/api/v1/migrations", "/api/v1/migrations", undefined, { "x-dev-tenant": "x" }); // 401 (헤더 값 잘못 = RLS 오류?)
await call("GET", "/api/v1/migrations", "/api/v1/migrations", undefined, {});
const { id } = await call("POST", "/api/v1/migrations", "/api/v1/migrations", { sourceEnvId: "22222222-2222-4222-8222-222222222222", targetEnvId: "33333333-3333-4333-8333-333333333333" });
await call("POST", "/api/v1/migrations", "/api/v1/migrations", { sourceEnvId: "nope" });
await call("POST", "/api/v1/migrations", "/api/v1/migrations", { sourceEnvId: "99999999-2222-4222-8222-222222222222", targetEnvId: "33333333-3333-4333-8333-333333333333" });
await wait(id, "spec_review");
await call("GET", `/api/v1/migrations/${id}`, "/api/v1/migrations/{id}");
await call("GET", "/api/v1/migrations/99999999-9999-4999-8999-999999999999", "/api/v1/migrations/{id}");
await call("GET", "/api/v1/migrations", "/api/v1/migrations");
await call("GET", `/api/v1/migrations/${id}/plan`, "/api/v1/migrations/{id}/plan");
await call("GET", `/api/v1/migrations/${id}/plan/resources`, "/api/v1/migrations/{id}/plan/resources"); // Z86
await call("POST", `/api/v1/migrations/${id}/start`, "/api/v1/migrations/{id}/start");
await call("POST", `/api/v1/migrations/${id}/plan`, "/api/v1/migrations/{id}/plan");
await wait(id, "awaiting_approval");
const plan = await call("GET", `/api/v1/migrations/${id}/plan`, "/api/v1/migrations/{id}/plan");
await call("GET", `/api/v1/plans/${plan.planId}`, "/api/v1/plans/{id}");
await call("POST", `/api/v1/plans/${plan.planId}/approvals`, "/api/v1/plans/{id}/approvals", { decision: "approve", planHash: "wrong" });
await call("POST", `/api/v1/plans/${plan.planId}/approvals`, "/api/v1/plans/{id}/approvals", { decision: "approve", planHash: plan.planHash });
await call("POST", `/api/v1/migrations/${id}/start`, "/api/v1/migrations/{id}/start");
// 통합본 16:49 판에서 추가된 것: 같은 환경 거부, 멱등 재생, 되돌리기·취소, 리포트, 문서
const SRC = "22222222-2222-4222-8222-222222222222", DST = "33333333-3333-4333-8333-333333333333";
await call("POST", "/api/v1/migrations", "/api/v1/migrations", { sourceEnvId: SRC, targetEnvId: SRC });
const key = "conform-" + Date.now();
const r1 = await fetch(API + "/api/v1/migrations", { method: "POST", headers: { ...H, "idempotency-key": key }, body: JSON.stringify({ sourceEnvId: SRC, targetEnvId: DST }) });
const r2 = await fetch(API + "/api/v1/migrations", { method: "POST", headers: { ...H, "idempotency-key": key }, body: JSON.stringify({ sourceEnvId: SRC, targetEnvId: DST }) });
const a = await r1.json(), b = await r2.json();
if (r2.status === 202 && a.id === b.id && r2.headers.get("idempotent-replayed") === "true") { ok++; console.log("ok  idempotent replay same id", a.id.slice(0, 8)); } else { bad++; console.log("BAD idempotent", r1.status, r2.status, a, b); }
await call("POST", "/api/v1/migrations", "/api/v1/migrations", { sourceEnvId: DST, targetEnvId: SRC }, { ...H, "idempotency-key": key });
await call("POST", "/api/v1/migrations", "/api/v1/migrations", { sourceEnvId: SRC, targetEnvId: DST }, { ...H, "idempotency-key": "bad key!" });
await wait(a.id, "spec_review");
await call("POST", `/api/v1/migrations/${a.id}/rollback`, "/api/v1/migrations/{id}/rollback");
await call("POST", `/api/v1/migrations/${a.id}/cancel`, "/api/v1/migrations/{id}/cancel", { reason: "conformance" });
await call("POST", `/api/v1/migrations/${a.id}/cancel`, "/api/v1/migrations/{id}/cancel");
// 진행 중인 이전을 잡아 되돌리기 (워커가 빨라 상태는 그때그때 다름: 202 또는 409 둘 다 문서에 있어야 함)
await wait(id, "completed");
const { id: m2 } = await call("POST", "/api/v1/migrations", "/api/v1/migrations", { sourceEnvId: SRC, targetEnvId: DST });
await wait(m2, "spec_review");
await call("POST", `/api/v1/migrations/${m2}/plan`, "/api/v1/migrations/{id}/plan");
await wait(m2, "awaiting_approval");
const p2 = await call("GET", `/api/v1/migrations/${m2}/plan`, "/api/v1/migrations/{id}/plan");
await call("POST", `/api/v1/plans/${p2.planId}/approvals`, "/api/v1/plans/{id}/approvals", { decision: "approve", planHash: p2.planHash });
await call("POST", `/api/v1/migrations/${m2}/start`, "/api/v1/migrations/{id}/start");
for (let i = 0; i < 100; i++) { const st = (await fetch(`${API}/api/v1/migrations/${m2}`, { headers: H }).then(r => r.json())).status; if (["deploying","syncing","shifting","rollback_window"].includes(st)) break; await new Promise(r => setTimeout(r, 30)); }
const rb = await call("POST", `/api/v1/migrations/${m2}/rollback`, "/api/v1/migrations/{id}/rollback", { reason: "conformance" });
console.log("    rollback from:", rb.from ?? rb.code);
await call("GET", `/api/v1/migrations/${id}/report`, "/api/v1/migrations/{id}/report");
await call("GET", `/api/v1/migrations/${id}/report?format=md`, "/api/v1/migrations/{id}/report");
await call("GET", `/api/v1/migrations/${id}/report?format=html`, "/api/v1/migrations/{id}/report");
await call("GET", `/api/v1/migrations/99999999-9999-4999-8999-999999999999/report`, "/api/v1/migrations/{id}/report");
await call("GET", "/api/v1/docs", "/api/v1/docs", undefined, {});
await call("GET", "/api/v1/docs/openapi.yaml", "/api/v1/docs/openapi.yaml", undefined, {});
await call("GET", "/api/v1/docs/openapi.json", "/api/v1/docs/openapi.json", undefined, {});
const req = JSON.parse(readFileSync(process.argv[3], "utf8"));
await call("POST", "/api/v1/cost/estimate", "/api/v1/cost/estimate", req);
// Z17: int3에서 늘어난 경로 (비용 비교·타임라인·환경 상태)
await call("GET", `/api/v1/migrations/${id}/cost`, "/api/v1/migrations/{id}/cost");
await call("GET", `/api/v1/migrations/99999999-9999-4999-8999-999999999999/cost`, "/api/v1/migrations/{id}/cost");
await call("GET", `/api/v1/migrations/${id}/timeline`, "/api/v1/migrations/{id}/timeline");
await call("GET", `/api/v1/migrations/${m2}/timeline`, "/api/v1/migrations/{id}/timeline");
await call("GET", `/api/v1/migrations/99999999-9999-4999-8999-999999999999/timeline`, "/api/v1/migrations/{id}/timeline");
await call("GET", "/api/v1/migrations/x/timeline", "/api/v1/migrations/{id}/timeline");
const envs = await (await fetch(API + "/api/v1/environments", { headers: H })).json();
for (const e of envs.items) await call("GET", `/api/v1/environments/${e.id}/status`, "/api/v1/environments/{id}/status");
for (const e of envs.items) await call("GET", `/api/v1/environments/${e.id}/inventory`, "/api/v1/environments/{id}/inventory"); // Z86
await call("GET", "/api/v1/environments/99999999-9999-4999-8999-999999999999/status", "/api/v1/environments/{id}/status");
await call("GET", "/api/v1/environments/99999999-9999-4999-8999-999999999999/status", "/api/v1/environments/{id}/status", undefined, {});
console.log(`conformance: ok ${ok} bad ${bad}`);
process.exit(bad ? 1 : 0);

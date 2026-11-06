// 실제 Fastify 경로에 붙은 Zod 스키마를 모아 OpenAPI 3.1 문서(docs/openapi.yaml)를 만든다.
// 추가 패키지 없음: zod 4의 z.toJSONSchema(JSON Schema 2020-12 = OpenAPI 3.1과 같은 판)와 Fastify onRoute 훅만 쓴다.
// 실행: npx tsx tools/openapi/gen-openapi.ts          → docs/openapi.yaml 쓰기
//       npx tsx tools/openapi/gen-openapi.ts --check  → 파일이 코드와 다르면 1로 끝남 (CI용)
// 경로 처리기는 부르지 않는다. DB·큐 없이 돈다 (pg Pool은 첫 query 때만 연결)
import Fastify, { type RouteOptions } from "fastify";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import * as C from "@svc/contracts";
import { CostEstimate } from "@svc/contracts";
import { API_PREFIX, ROUTE_PLUGINS } from "../../apps/api/src/routes/index.js";
import { EvidenceReport } from "../../apps/api/src/report/schema.js";
import { NAMED_RESPONSES } from "../../apps/api/src/routes/responses.js";
import { AuthTokenResponse, AuthUser, AuthConfig, LoginBody } from "../../apps/api/src/routes/auth.js";

// Z81: 경로 목록·접두어는 apps/api/src/routes/index.ts 한 곳 (서버 buildApp 과 같은 목록, 예전 PROPOSAL.md §2)

// Z17: 업무 경로 15개는 이제 경로 파일에 schema.response(200/202 + 4xx·500)가 달려 있다 → 응답 문서는 코드에서 바로 나온다.
// 아래 표는 두 가지만 남는다
//   1) 응답 설명(summary) 한 줄 = 사람 말 설명. 스키마가 아니다
//   2) JSON이 아닌 응답(md·html·yaml)과 docs 경로(문자열 send라 Zod 응답 스키마가 의미 없음)
// 경로에 응답 스키마가 있으면 schema 칸은 무시되고 x-response-source: supplement도 붙지 않는다
type Sup = { status?: number; schema?: z.ZodType; desc: string; alt?: Record<string, string> };
const SUPPLEMENT: Record<string, Sup> = {
  "POST /api/v1/migrations/{id}/rollback": { desc: "되돌리기 시작, rollback 작업 예약 (지금 상태→rolling_back)" },
  "POST /api/v1/migrations/{id}/cancel": { desc: "취소 (지금 상태→cancelled, 끝 상태라 환경 잠금 해제)" },
  "GET /api/v1/migrations/{id}/report": { desc: "증적 리포트 (감사 사슬 재검증·승인 지문·타임라인). format=md|html이면 문서로",
    alt: { "text/markdown": "format=md", "text/html": "format=html" } },
  "GET /api/v1/migrations/{id}/tfstate": { desc: "끝난 이전의 고객 Terraform state 파일 그대로 (Content-Disposition: attachment, layer=app 앱 층 | env 도착 환경 층). worker 창구에서 흘려보낸다. 감사 migration.tfstate_download" },
  "GET /api/v1/docs": { status: 200, desc: "API 문서 표 (HTML)", alt: { "text/html": "경로 표" } },
  "GET /api/v1/docs/openapi.yaml": { status: 200, desc: "이 문서 (YAML)", alt: { "application/yaml": "OpenAPI 3.1" } },
  "GET /api/v1/docs/openapi.json": { status: 200, desc: "이 문서 (JSON)", alt: { "application/json": "OpenAPI 3.1" } },
  "POST /api/v1/migrations": { desc: "이전 생성, 가져오기 작업 예약 (draft→importing)" },
  "GET /api/v1/migrations": { desc: "최근 50개" },
  "GET /api/v1/migrations/{id}": { desc: "이전 한 건의 상태" },
  "POST /api/v1/migrations/{id}/plan": { desc: "점검 작업 예약 (spec_review→prechecking)" },
  "GET /api/v1/migrations/{id}/plan": { desc: "이 이전의 최신 계획서" },
  "GET /api/v1/migrations/{id}/agent-review": { desc: "AI 점검 결과 (종류별 최신 실행 1건, remediate 기록이 없으면 STUB 대본 결과)" },
  "POST /api/v1/migrations/{id}/agent-review/run": { desc: "장애 점검(remediate) 시작: agent_runs queued + agent-run 작업 예약. 상태 전이 없음 (Z65)" },
  "GET /api/v1/plans/{id}": { desc: "계획서와 planHash" },
  "POST /api/v1/plans/{id}/approvals": { desc: "승인/거절 결과" },
  "POST /api/v1/migrations/{id}/start": { desc: "apply 작업 예약 (approved→provisioning)" },
  "GET /api/v1/environments": { desc: "환경 목록" },
  "POST /api/v1/cost/estimate": { desc: "환경별 월 비용 추정 (DB 쓰기 없음)" },
  "GET /api/v1/migrations/{id}/cost": { desc: "출발 vs 도착 월 비용 비교 (저장된 추정, 없으면 미리보기)" },
  "GET /api/v1/migrations/{id}/timeline": { desc: "감사 기록으로 만든 상태 전이 타임라인" },
  "POST /api/v1/migrations/{id}/security/check": { desc: "출발·도착 실제 보안 점검(클라우드·k8s 읽기 전용) + 감사 security.live_check 기록 (Z91)" },
  "GET /api/v1/environments/{id}/status": { desc: "환경 자체의 자원 상태 (지금은 Azure Mock만 실제 값)" },
  "GET /api/v1/environments/{id}/inventory": { desc: "환경별 자원: 환경 자체 + 이전마다 이 환경 쪽 앱 자원(생길 것·생김·바뀜·걷힘)과 값의 출처 (Z86). cloud 칸 = aws·gcloud·kubectl 읽기 명령으로 읽은 실자원(30초 캐시), 자격 없으면 status unavailable" },
  "GET /api/v1/events": { status: 200, desc: "화면 신호 (SSE). 로그인한 회사의 신호만 계속 보낸다. `data:` 줄마다 SseEvent 하나, `:` 줄은 연결 유지용 주석. 신호는 \"다시 읽어\"라는 뜻",
    alt: { "text/event-stream": "data: <SseEvent JSON>" } },
  "GET /api/v1/migrations/{id}/plan/resources": { desc: "클라우드 서비스 대응표: 출발 서비스 → 도착 서비스, 이전 방식(재배포·논리 복제·트래픽 전환·새로 만듦), 계획서 단계와 진행 (Z86)" },
};

// 경로에서 실제로 나는 오류 코드 (errors.ts·advance.ts·처리기에서 읽음). 모두 ApiError 모양
const ERRORS: Record<string, Record<number, string>> = {
  "*": { 400: "BAD_REQUEST (Zod 검증 실패)", 401: "UNAUTHENTICATED (Bearer 토큰 없음·만료, DEV_AUTH=1 이면 x-dev-tenant 없음)", 403: "TUNNEL_READ_ONLY (개발 헤더 인증 + Cloudflare 터널로 온 쓰기, Z47)", 429: "RATE_LIMITED (회사·읽기/쓰기별 분당 한도, retry-after 헤더, Z52)", 500: "INTERNAL" },
  "POST /api/v1/migrations": { 404: "NOT_FOUND (없는/남의 환경 번호, FK 23503)", 409: "INVALID_TRANSITION · GUARD_FAILED · IDEMPOTENCY_KEY_REUSED" },
  "POST /api/v1/migrations/{id}/rollback": { 404: "NOT_FOUND", 409: "INVALID_TRANSITION (이 상태에서 되돌릴 수 없음) · GUARD_FAILED · IDEMPOTENCY_KEY_REUSED" },
  "POST /api/v1/migrations/{id}/cancel": { 404: "NOT_FOUND", 409: "INVALID_TRANSITION · GUARD_FAILED (failed에서 manualCleanupConfirmed 없음) · IDEMPOTENCY_KEY_REUSED" },
  "GET /api/v1/migrations/{id}/report": { 404: "NOT_FOUND" },
  "GET /api/v1/migrations/{id}/tfstate": { 404: "NOT_FOUND (없는/남의 이전) · STATE_NOT_FOUND (worker 에 state 파일 없음)", 409: "INVALID_TRANSITION (끝난 이전이 아님)",
    503: "STATE_EXPORT_NOT_CONFIGURED (WORKER_STATE_EXPORT_URL·INTERNAL_STATE_TOKEN 없음) · STATE_EXPORT_UNAVAILABLE (worker 창구 연결 실패·시간 초과·5xx)" },
  "GET /api/v1/migrations/{id}/agent-review": { 404: "NOT_FOUND (없는/남의 이전 번호)" },
  "POST /api/v1/migrations/{id}/agent-review/run": { 404: "NOT_FOUND (없는/남의 이전 번호)", 409: "AGENT_RUN_IN_PROGRESS (같은 이전에 queued·running 점검이 있음) · JOB_NOT_CREATED · IDEMPOTENCY_KEY_REUSED" },
  "GET /api/v1/migrations/{id}/cost": { 404: "NOT_FOUND" },
  "GET /api/v1/migrations/{id}/timeline": { 404: "NOT_FOUND" },
  "POST /api/v1/migrations/{id}/security/check": { 404: "NOT_FOUND" },
  "GET /api/v1/environments/{id}/status": { 404: "NOT_FOUND", 409: "AZURE_MOCK_DISABLED (AZURE_MOCK=0인데 azure_mock 환경, adapters RunnerUnavailable)" },
  "GET /api/v1/environments/{id}/inventory": { 404: "NOT_FOUND", 409: "AZURE_MOCK_DISABLED (AZURE_MOCK=0인데 azure_mock 환경)" },
  "GET /api/v1/migrations/{id}/plan/resources": { 404: "NOT_FOUND" },
  "GET /api/v1/docs": { 404: "DOCS_NOT_GENERATED" },
  "GET /api/v1/docs/openapi.yaml": { 404: "DOCS_NOT_GENERATED" },
  "GET /api/v1/docs/openapi.json": { 404: "DOCS_NOT_GENERATED" },
  "GET /api/v1/migrations/{id}": { 404: "NOT_FOUND" },
  "POST /api/v1/migrations/{id}/plan": { 404: "NOT_FOUND", 409: "INVALID_TRANSITION · GUARD_FAILED · IDEMPOTENCY_KEY_REUSED" },
  "GET /api/v1/migrations/{id}/plan": { 404: "NOT_FOUND" },
  "GET /api/v1/plans/{id}": { 404: "NOT_FOUND" },
  "POST /api/v1/plans/{id}/approvals": { 404: "NOT_FOUND", 409: "PLAN_SUPERSEDED · PLAN_HASH_MISMATCH · PLAN_EXPIRED · ENV_BUSY · INVALID_TRANSITION · GUARD_FAILED · IDEMPOTENCY_KEY_REUSED" },
  "POST /api/v1/migrations/{id}/start": { 404: "NOT_FOUND", 409: "PLAN_NOT_APPROVED · INVALID_TRANSITION · GUARD_FAILED · IDEMPOTENCY_KEY_REUSED" },
};

// 상태를 바꾸는 경로 = advance() 한 번. 설명에 전이 번호를 붙인다 (상태기계는 contracts/migration.ts VALID)
const STATE_CHANGE: Record<string, string> = {
  "POST /api/v1/migrations": "T01 draft→importing",
  "POST /api/v1/migrations/{id}/plan": "T04 spec_review→prechecking",
  "POST /api/v1/plans/{id}/approvals": "T09 awaiting_approval→approved | T10 →rejected",
  "POST /api/v1/migrations/{id}/start": "T15 approved→provisioning",
  "POST /api/v1/migrations/{id}/rollback": "지금 상태→rolling_back (deploying·syncing·shifting·rollback_window·paused에서만)",
  "POST /api/v1/migrations/{id}/cancel": "지금 상태→cancelled (준비 단계·failed에서만)",
};

// ---- 1) 경로 모으기 ----
type Captured = { method: string; url: string; schema: RouteOptions["schema"]; file: string };
let currentFile = "apps/api/src/main.ts";
const routes: Captured[] = [];
const app = Fastify({ logger: false });
app.setValidatorCompiler(validatorCompiler);   // main.ts와 같게 (안 하면 Fastify가 Zod 객체를 JSON Schema로 오해)
app.setSerializerCompiler(serializerCompiler);
app.addHook("onRoute", (r) => {
  // Z30: Swagger UI(@fastify/swagger-ui)가 만드는 화면·정적 파일 경로는 API가 아니라서 명세에서 뺀다
  if (r.url.startsWith("/api/v1/docs/ui")) return;
  for (const m of [r.method].flat()) {
    if (m === "HEAD") continue;
    routes.push({ method: m, url: r.url, schema: r.schema, file: currentFile });
  }
});
app.get("/healthz", async () => ({ ok: true }));
app.get("/readyz", async () => ({ ok: true }));
for (const p of ROUTE_PLUGINS) {
  // onRoute는 register가 실제로 돌 때 불린다 → 하나씩 ready 대신 after로 파일 이름을 맞춘다
  app.register(async (inner) => { currentFile = p.file; await p.plugin(inner); }, { prefix: API_PREFIX });
  await app.after();
}
await app.ready();

// ---- 2) 이름 붙은 스키마(contracts 내보내기)를 components로 ----
// 같은 Zod 객체면 $ref로 잇는다. 이름 없는 경로 안 스키마(예: CreateMigration)는 그 자리에 풀어 쓴다
const named = new Map<z.ZodType, string>();
for (const [k, v] of Object.entries(C)) if (v instanceof z.ZodType) named.set(v, k);
for (const [k, v] of Object.entries({ ...NAMED_RESPONSES, EvidenceReport, AuthTokenResponse, AuthUser, AuthConfig, LoginBody })) named.set(v, k);

const REF = (id: string) => `#/components/schemas/${id}`;
function toSchema(s: z.ZodType, io: "input" | "output") {
  const reg = z.registry<{ id: string }>();
  for (const [schema, id] of named) reg.add(schema, { id });
  const self = named.get(s);
  if (self) return { $ref: REF(io === "input" && differs(s) ? `${self}Input` : self) };
  // 이름 없는 스키마: 안쪽 이름 붙은 조각만 $ref로
  const js = z.toJSONSchema(s, { io, target: "draft-2020-12", metadata: reg, unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  // 단일 스키마 모드에서 zod는 이름 붙은 조각을 #/$defs/X 로 낸다 → components로 옮겨 가리키게 바꾼다
  const defs = (js.$defs ?? {}) as Record<string, unknown>;
  delete js.$defs;
  for (const id of Object.keys(defs)) refIds.add(id);
  return JSON.parse(JSON.stringify(js).replaceAll('"#/$defs/', `"${REF("")}`));
}
const refIds = new Set<string>();
function differs(s: z.ZodType) {
  return JSON.stringify(z.toJSONSchema(s, { io: "input", unrepresentable: "any" }))
    !== JSON.stringify(z.toJSONSchema(s, { io: "output", unrepresentable: "any" }));
}

// ---- 3) paths ----
const used = new Set<z.ZodType>();
const walkUse = (s: unknown) => { if (s instanceof z.ZodType && named.has(s)) used.add(s); };
const paths: Record<string, Record<string, unknown>> = {};
const inputNamed = new Set<z.ZodType>();
for (const r of routes) {
  const oapiPath = r.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  const key = `${r.method} ${oapiPath}`;
  const sc = (r.schema ?? {}) as Record<string, unknown>;
  const op: Record<string, unknown> = {
    operationId: opId(r.method, oapiPath),
    tags: [tagOf(oapiPath)],
    summary: SUPPLEMENT[key]?.desc ?? (oapiPath.startsWith("/api/") ? oapiPath : "쿠버네티스 프로브"),
  };
  op.description = `코드: ${r.file}` + (STATE_CHANGE[key] ? `\n상태 전이: ${STATE_CHANGE[key]} (advance() 한 번)` : "");
  if (STATE_CHANGE[key]) op["x-state-transition"] = STATE_CHANGE[key];
  const params: unknown[] = [];
  for (const [where, slot] of [["path", "params"], ["query", "querystring"]] as const) {
    const s = sc[slot];
    if (!(s instanceof z.ZodObject)) continue;
    const js = z.toJSONSchema(s, { io: "input" }) as { properties: Record<string, unknown>; required?: string[] };
    for (const [name, p] of Object.entries(js.properties))
      params.push({ name, in: where, required: where === "path" || (js.required ?? []).includes(name), schema: p });
  }
  if (sc.body instanceof z.ZodType) {
    if (named.has(sc.body) && differs(sc.body)) inputNamed.add(sc.body); else walkUse(sc.body);
    op.requestBody = { required: true, content: { "application/json": { schema: toSchema(sc.body, "input") } } };
  }
  if (oapiPath.startsWith("/api/v1/docs") || /^\/api\/v1\/auth\/(login|refresh|logout|config)$/.test(oapiPath)) {
    op.security = [];   // Z93: 로그인·갱신·로그아웃·설정은 토큰 없이 (리프레시는 HttpOnly 쿠키 svc_refresh)   // 개발 모드에서는 헤더 없이 열림 (DOCS_PUBLIC, apps/api/src/plugins/auth.ts)
  } else if (oapiPath.startsWith("/api/")) {
    params.push({ $ref: "#/components/parameters/DevTenant" });
    op.security = [{ bearerAuth: [] }, { devTenant: [] }];   // Z93: 로그인 토큰, 또는 DEV_AUTH=1 일 때만 개발 헤더
  } else op.security = [];
  if (STATE_CHANGE[key])
    params.push({ $ref: "#/components/parameters/IdempotencyKey" });
  if (params.length) op.parameters = params;

  const responses: Record<string, unknown> = {};
  const declared = (sc.response ?? {}) as Record<string, z.ZodType>;
  const sup = SUPPLEMENT[key];
  const errDesc: Record<number, string> = { ...ERRORS["*"], ...(ERRORS[key] ?? {}) };
  if (STATE_CHANGE[key]) errDesc[400] = (errDesc[400] ?? "BAD_REQUEST") + " · BAD_IDEMPOTENCY_KEY";
  let declaredErr = false;
  for (const [code, s] of Object.entries(declared)) {
    if (Number(code) >= 400 && s === C.ApiError) {
      // 오류 응답: 경로가 선언한 코드만 문서에 낸다. 설명(어떤 code 값이 나오나)은 ERRORS 표
      declaredErr = true;
      responses[code] = { $ref: `#/components/responses/E${code}`, description: errDesc[Number(code)] ?? "ApiError" };
      continue;
    }
    walkUse(s);
    const content: Record<string, unknown> = { "application/json": { schema: toSchema(s, "output") } };
    for (const [mt, d] of Object.entries(sup?.alt ?? {}))
      if (!content[mt]) content[mt] = { schema: { type: "string", description: d } };
    responses[code] = { description: sup?.desc ?? "OK", content };
  }
  if (!Object.keys(declared).length) {
    if (sup) {
      const content: Record<string, unknown> = {};
      if (sup.schema) { walkUse(sup.schema); content["application/json"] = { schema: toSchema(sup.schema, "output") }; }
      for (const [mt, d] of Object.entries(sup.alt ?? {}))
        if (!content[mt]) content[mt] = { schema: mt.includes("json") ? { type: "object", description: d } : { type: "string", description: d } };
      responses[String(sup.status ?? 200)] = { description: sup.desc, "x-response-source": "supplement", content };
    } else if (!oapiPath.startsWith("/api/")) {
      responses["200"] = { description: "OK", content: { "application/json": { schema: {
        type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } } };
      if (oapiPath === "/readyz") responses["500"] = { description: "DB 연결 실패 (SELECT 1 예외)" };
    } else responses["200"] = { description: "OK (응답 스키마 없음)" };
  }
  // 오류 코드를 선언 안 한 업무 경로(docs 3개)는 예전처럼 표에서 채운다
  if (oapiPath.startsWith("/api/") && !declaredErr) {
    const errs = { ...errDesc };
    if (!sc.body && !sc.params && !sc.querystring) delete errs[400];
    if (oapiPath.startsWith("/api/v1/docs")) { delete errs[401]; delete errs[429]; }
    if (r.method !== "POST") delete errs[403];
    for (const [code, d] of Object.entries(errs)) responses[code] = { $ref: `#/components/responses/E${code}`, description: d };
  }
  // $ref 옆 description은 3.1에서 허용 (Reference Object summary/description)
  op.responses = responses;
  (paths[oapiPath] ??= {})[r.method.toLowerCase()] = op;
}

// ---- 4) components ----
const reg = z.registry<{ id: string }>();
for (const [schema, id] of named) reg.add(schema, { id });
const outAll = z.toJSONSchema(reg, { io: "output", target: "draft-2020-12", uri: REF, unrepresentable: "any" }) as { schemas: Record<string, Record<string, unknown>> };
// 쓰인 것 + 그 안에서 $ref로 닿는 것만 남긴다
const keep = new Set<string>();
const visit = (id: string, pool: Record<string, unknown>) => {
  if (keep.has(id)) return; keep.add(id);
  JSON.stringify(pool[id], (_k, v) => {
    if (typeof v === "string" && v.startsWith(REF(""))) visit(v.slice(REF("").length), pool);
    return v;
  });
};
const schemas: Record<string, unknown> = {};
for (const s of used) visit(named.get(s)!, outAll.schemas);
visit("ApiError", outAll.schemas);
for (const id of refIds) visit(id, outAll.schemas);
for (const id of [...keep].sort()) { const s = { ...outAll.schemas[id] }; delete s.$schema; delete s.$id; schemas[id] = s; }
// 입력판(기본값 있는 필드가 선택)은 따로 만든다. 안쪽 조각도 입력·출력 모양이 같을 때만 공유하고, 다르면 풀어 쓴다
for (const s of inputNamed) {
  const id = named.get(s)!;
  const same = z.registry<{ id: string }>();
  for (const [schema, sid] of named) if (schema !== s && !differs(schema)) same.add(schema, { id: sid });
  const js = z.toJSONSchema(s, { io: "input", target: "draft-2020-12", metadata: same, unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  const defs = (js.$defs ?? {}) as Record<string, unknown>; delete js.$defs;
  for (const d of Object.keys(defs)) visit(d, outAll.schemas);
  schemas[`${id}Input`] = JSON.parse(JSON.stringify(js).replaceAll('"#/$defs/', `"${REF("")}`));
}
for (const id of [...keep].sort()) if (!schemas[id]) { const t = { ...outAll.schemas[id] }; delete t.$schema; delete t.$id; schemas[id] = t; }

const errResp = (d: string) => ({ description: d, content: { "application/json": { schema: { $ref: REF("ApiError") } } } });
const doc = {
  openapi: "3.1.0",
  info: {
    title: "멀티클라우드 이전 제어판 API",
    version: "0.1.0-skeleton",
    license: { name: "UNLICENSED (해커톤 비공개)", identifier: "LicenseRef-Proprietary" },
    description: [
      "코드에서 생성한 문서다 (tools/openapi/gen-openapi.ts). 손으로 고치지 말고 경로의 Zod 스키마를 고친 뒤 다시 생성한다.",
      "인증은 POST /api/v1/auth/login(이메일+비밀번호)이 주는 Bearer 접근 토큰(JWT HS256, 15분)이다. 갱신은 HttpOnly 쿠키 svc_refresh 로 POST /api/v1/auth/refresh. x-dev-tenant 헤더는 DEV_AUTH=1(시험 전용)일 때만, NODE_ENV=production이면 절대 안 받는다 (Z93).",
      "x-response-source: supplement 인 응답은 경로에 response 스키마가 없어 처리기 코드를 읽고 보충한 것이다.",
      "상태를 바꾸는 POST는 x-state-transition에 전이 번호를 적었다.",
    ].join("\n"),
  },
  servers: [{ url: "http://localhost:3000", description: "로컬 (API_PORT 기본값)" }],
  tags: [
    { name: "migrations", description: "이전 한 건의 생성·조회·시작" },
    { name: "plans", description: "계획서와 승인 (planHash 바인딩)" },
    { name: "environments", description: "연결된 환경" },
    { name: "cost", description: "비용 추정 (순수 계산)" },
    { name: "control", description: "비상 버튼: 되돌리기·취소" },
    { name: "report", description: "증적 리포트" },
    { name: "docs", description: "이 API 문서" },
    { name: "auth", description: "로그인·토큰 갱신·로그아웃 (Z93)" },
    { name: "health", description: "쿠버네티스 프로브" },
  ],
  paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT",
        description: "POST /api/v1/auth/login 응답의 accessToken. 회사 번호는 토큰의 tid 클레임 (apps/api/src/plugins/auth.ts, Z93)" },
      devTenant: { type: "apiKey", in: "header", name: "x-dev-tenant",
        description: "시험 전용: DEV_AUTH=1 일 때만 회사 번호(uuid)를 그대로 받는다. 운영(NODE_ENV=production)에서는 꺼짐 (apps/api/src/plugins/auth.ts)" },
    },
    parameters: {
      DevTenant: { name: "x-dev-tenant", in: "header", required: false, schema: { type: "string", format: "uuid" },
        description: "회사 번호. RLS가 이 값으로 행을 거른다" },
      IdempotencyKey: { name: "Idempotency-Key", in: "header", required: false,
        schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{8,200}$" },
        description: "같은 키 재요청이면 첫 응답 재생 (응답 헤더 Idempotent-Replayed: true). 같은 키·다른 요청이면 409 IDEMPOTENCY_KEY_REUSED. 없으면 키 없이 처리 (DRAFT(ai), apps/api/src/plugins/idempotency.ts)" },
    },
    responses: {
      E400: errResp("요청 모양이 틀림"), E401: errResp("인증 없음"), E404: errResp("없음 (남의 회사 것도 RLS로 404)"),
      E409: errResp("상태·지문·잠금 충돌"), E500: errResp("서버 오류"),
      E403: errResp("터널로 온 쓰기 거부 (개발 헤더 인증일 때만)"), E429: errResp("속도 제한 초과 (retry-after 초 뒤 다시)"),
    },
    schemas,
  },
};

// ---- 5) YAML로 쓰기 (의존성 없이). 문자열은 JSON 따옴표 = YAML 큰따옴표 문자열과 호환 ----
function yaml(v: unknown, ind = ""): string {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return v.map((x) => {
      const inner = yaml(x, ind + "  ");
      return `\n${ind}- ${isBlock(x) ? inner.trimStart() : inner}`;
    }).join("");
  }
  if (typeof v === "object") {
    const ents = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!ents.length) return "{}";
    return ents.map(([k, x]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$\-]*$/.test(k) ? k : JSON.stringify(k);
      return `\n${ind}${key}:${isBlock(x) ? yaml(x, ind + "  ") : " " + yaml(x, ind + "  ")}`;
    }).join("");
  }
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
function isBlock(x: unknown) {
  return x !== null && typeof x === "object" && (Array.isArray(x) ? x.length > 0 : Object.keys(x).length > 0);
}

const out = "# 생성 파일: npx tsx tools/openapi/gen-openapi.ts (손으로 고치지 말 것)" + yaml(doc) + "\n";
const target = new URL("../../docs/openapi.yaml", import.meta.url);
// 같은 내용의 JSON판도 쓴다: API의 GET /api/v1/docs/openapi.json이 YAML 파서 없이 그대로 내보낸다
const targetJson = new URL("../../docs/openapi.json", import.meta.url);
const outJson = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const read = (u: URL) => { try { return readFileSync(u, "utf8"); } catch { return ""; } };
  if (read(target) !== out || read(targetJson) !== outJson) {
    console.error("docs/openapi.{yaml,json} is stale: run npx tsx tools/openapi/gen-openapi.ts"); process.exit(1); }
  console.log("docs/openapi.yaml up to date");
} else {
  // Z75: 내용이 같으면 쓰지 않는다 → 파일 시각이 그대로라 도커 층·감시 도구가 괜히 다시 돌지 않는다
  mkdirSync(new URL("../../docs/", import.meta.url), { recursive: true });
  const read = (u: URL) => { try { return readFileSync(u, "utf8"); } catch { return ""; } };
  const changed = [[target, out], [targetJson, outJson]].filter(([u, s]) => read(u as URL) !== s);
  for (const [u, s] of changed) writeFileSync(u as URL, s as string);
  console.log(`${changed.length ? "wrote" : "unchanged"} docs/openapi.yaml: ${routes.length} operations, ${Object.keys(schemas).length} schemas`);
}
process.exit(0); // pg Pool·boss가 이벤트 루프를 잡지 않게

function opId(method: string, p: string) {
  const parts = p.replace(/^\/api\/v1\//, "/").split("/").filter(Boolean)
    .map((s) => s.startsWith("{") ? "By" + cap(s.slice(1, -1)) : cap(s.replace(/-/g, "")));
  return method.toLowerCase() + parts.join("");
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
function tagOf(p: string) {
  if (!p.startsWith("/api/")) return "health";
  if (p.startsWith("/api/v1/plans") || p.endsWith("/plan")) return "plans";
  if (p.endsWith("/rollback") || p.endsWith("/cancel")) return "control";
  if (p.endsWith("/report")) return "report";
  return p.split("/")[3];
}

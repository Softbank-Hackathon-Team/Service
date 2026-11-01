import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../plugins/errors.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

// API 문서 내보내기. 파일은 tools/openapi/gen-openapi.ts가 만든 것을 그대로 읽는다 (서버가 매번 생성하지 않음)
//   GET /api/v1/docs               사람이 보는 HTML (파일 링크 + 경로 표). 외부 스크립트 없음
//   GET /api/v1/docs/openapi.yaml  OpenAPI 3.1 YAML
//   GET /api/v1/docs/openapi.json  같은 내용 JSON (Swagger UI·Postman 가져오기용)
//   GET /api/v1/docs/ui            Swagger UI (브라우저에서 경로 펼쳐 보기 + Try it out) (Z30)
// DRAFT(ai): 문서에는 회사 데이터가 없어서 인증 없이 연다(Z30부터 운영 모드 포함). 닫으려면 DOCS_PUBLIC=false
// DRAFT(ai) Z30: Swagger UI를 붙인다. 스크립트·CSS는 npm 패키지(@fastify/swagger-ui) 안의 파일을 서버가 직접 준다
//   → CDN 없음. CSP는 'self'만 허용(staticCSP). 명세는 위 openapi.json 파일을 그대로 쓴다(static 모드, 런타임 생성 없음)
const DEV_TENANT_EXAMPLE = "11111111-1111-4111-8111-111111111111"; // db/migrations/0002_seed_dev.sql 회사 A
// 문서 파일 위치. 개발(tsx)과 이미지(esbuild 묶음 main.mjs 하나)에서 import.meta.url이 다르다 (Z51)
//   개발:   apps/api/src/routes/docs.ts 기준 ../../../../docs/  = Service/docs/
//   이미지: /app/main.mjs 기준 ./docs/  (deploy/docker/bundle.mjs가 openapi.json·yaml을 복사)
//   DOCS_DIR 환경변수가 있으면 그것만 본다
function pickDocsDir(): URL {
  const env = process.env.DOCS_DIR;
  if (env) return pathToFileURL(env.endsWith("/") ? env : `${env}/`);
  const candidates = [new URL("./docs/", import.meta.url), new URL("../../../../docs/", import.meta.url)];
  return candidates.find((u) => existsSync(new URL("openapi.json", u))) ?? candidates[candidates.length - 1]!;
}
const DOCS_DIR = pickDocsDir();

// Swagger UI 정적 파일(js·css·logo). 개발에서는 플러그인이 node_modules 안 자기 폴더를 쓴다.
// 이미지에는 node_modules가 없고, 묶음 안에서는 플러그인의 __dirname도 없다(ESM) → bundle.mjs가 ./swagger-ui/로 복사하고
// 여기서 그 폴더를 baseDir로, logo를 직접 넘긴다 (Z51)
function pickSwaggerUiAssets(): { baseDir: string; logo: { type: string; content: Buffer } } | null {
  const dir = new URL("./swagger-ui/", import.meta.url);
  if (!existsSync(new URL("swagger-ui-bundle.js", dir))) return null;
  return { baseDir: fileURLToPath(dir), logo: { type: "image/svg+xml", content: readFileSync(new URL("logo.svg", dir)) } };
}

function loadOnce(name: string): string | null {
  try { return readFileSync(new URL(name, DOCS_DIR), "utf8"); } catch { return null; }
}

export async function docsRoutes(app: FastifyInstance) {
  const yaml = loadOnce("openapi.yaml");
  const json = loadOnce("openapi.json");

  const missing = (req: FastifyRequest, reply: FastifyReply) =>
    sendError(req, reply, 404, "DOCS_NOT_GENERATED", "run: npx tsx tools/openapi/gen-openapi.ts");

  app.get("/docs/openapi.yaml", async (req, reply) => {
    if (!yaml) return missing(req, reply);
    return reply.type("application/yaml; charset=utf-8").header("cache-control", "no-cache").send(yaml);
  });
  app.get("/docs/openapi.json", async (req, reply) => {
    if (!json) return missing(req, reply);
    return reply.type("application/json; charset=utf-8").header("cache-control", "no-cache").send(json);
  });
  if (json) {
    const doc = JSON.parse(json) as { servers?: { url: string; description?: string }[] };
    // "Try it out"이 지금 연 주소로 요청하게 같은 출처("/")를 첫 서버로 둔다. 파일의 localhost:3000은 뒤에 남긴다
    doc.servers = [{ url: "/", description: "지금 연 서버 (같은 출처)" }, ...(doc.servers ?? [])];
    // "Try it out" 칸에 개발용 회사 번호(시드 0002의 회사 A)를 미리 채운다. 화면용 사본만 바꾸고 파일은 그대로
    // DRAFT(ai) Z30: 운영 모드에서는 어차피 헤더 로그인이 꺼져 401이라 채워도 위험 없음
    const devTenant = (doc as { components?: { parameters?: Record<string, { example?: string }> } }).components?.parameters?.DevTenant;
    if (devTenant) devTenant.example ??= DEV_TENANT_EXAMPLE;
    await app.register(swagger, { mode: "static", specification: { document: doc as never } });
    await app.register(swaggerUi, {
      ...(pickSwaggerUiAssets() ?? {}),
      routePrefix: "/docs/ui",
      // 이 플러그인은 /api/v1 아래에 등록된다 → 끝에 / 없는 주소(/docs/ui)에서도 정적 파일 주소에 /api/v1이 붙게 한다
      indexPrefix: app.prefix,
      staticCSP: true,
      // 기본 CSP를 조인다: 외부(https:) 스타일·글꼴 금지, Swagger UI가 쓰는 인라인 style만 허용,
      // upgrade-insecure-requests 제거 (로컬 http://localhost 에서 브라우저가 https로 바꿔 깨지지 않게)
      transformStaticCSP: (h: string) => h
        .replace("font-src 'self' https: data:", "font-src 'self' data:")
        .replace("style-src 'self' https:", "style-src 'self' 'unsafe-inline'")
        .replace(" validator.swagger.io", "")   // 외부 검증 배지 끔 (validatorUrl: null)
        .replace(/ ?upgrade-insecure-requests;?/, ""),
      uiConfig: { validatorUrl: null, docExpansion: "list", deepLinking: true, persistAuthorization: false, tryItOutEnabled: false },
    });
  }

  app.get("/docs", async (req, reply) => {
    if (!json) return missing(req, reply);
    const doc = JSON.parse(json) as { info: { title: string; version: string };
      paths: Record<string, Record<string, { summary?: string; "x-state-transition"?: string }>> };
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
    const rows = Object.entries(doc.paths).flatMap(([p, ops]) => Object.entries(ops).map(([m, o]) =>
      `<tr><td><code>${m.toUpperCase()}</code></td><td><code>${esc(p)}</code></td><td>${esc(o.summary ?? "")}</td><td>${esc(o["x-state-transition"] ?? "")}</td></tr>`));
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(doc.info.title)}</title>
<style>body{font:14px system-ui;margin:24px}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left}</style>
<h1>${esc(doc.info.title)} <small>${esc(doc.info.version)}</small></h1>
<p><a href="docs/ui">Swagger UI로 보기</a> · <a href="docs/openapi.yaml">openapi.yaml</a> · <a href="docs/openapi.json">openapi.json</a></p>
<table><tr><th>메서드</th><th>경로</th><th>설명</th><th>상태 전이</th></tr>${rows.join("")}</table>`;
    return reply.type("text/html; charset=utf-8")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .send(html);
  });
}

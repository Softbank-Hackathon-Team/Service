// 서버 앱 하나(api | worker | agent-worker)를 JS 파일 한 개로 묶는다.
// 왜: 우리 패키지(@svc/*)는 .ts 원본을 그대로 내보낸다(exports: ./src/index.ts).
//     운영 이미지에서 tsx로 매번 변환하지 않으려고, 빌드 단계에서 esbuild로 한 번만 묶는다.
// 사용: node deploy/docker/bundle.mjs api   →  dist/api/{main,healthcheck}.mjs (+ .map)
// DRAFT(ai): 외부 npm 패키지까지 전부 묶는다(런타임 이미지에 node_modules 없음).
//            pg-native 는 pg 가 "있으면 쓰는" 선택 모듈이라 빼 둔다.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const APPS = ["api", "worker", "agent-worker"];
const app = process.argv[2];
if (!APPS.includes(app)) {
  console.error(`usage: node deploy/docker/bundle.mjs <${APPS.join("|")}>`);
  process.exit(2);
}

const outdir = `dist/${app}`;
rmSync(outdir, { recursive: true, force: true });

const t0 = Date.now();
const result = await build({
  entryPoints: {
    main: `apps/${app}/src/main.ts`,
    healthcheck: "deploy/docker/healthcheck.mjs",
    // api 이미지가 OTel 게이트웨이 입구도 겸한다 (node metrics-gateway.mjs)
    ...(app === "api" ? { "metrics-gateway": "apps/api/src/metrics-gateway-main.ts" } : {}),
  },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  external: ["pg-native"],
  // CJS 패키지(pg, fastify 등)가 ESM 묶음 안에서 require 를 부를 수 있게 한다
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  metafile: true,
  logLevel: "warning",
});

// packages/cost 는 import.meta.url 기준 ./data/sample-prices.json 을 읽는다 → 묶음 옆에 복사
if (existsSync("packages/cost/src/data")) {
  cpSync("packages/cost/src/data", `${outdir}/data`, { recursive: true });
}

// api: 문서 화면(/api/v1/docs, /docs/ui)이 쓰는 파일을 묶음 옆에 복사 (Z51)
//   docs/openapi.{json,yaml}          → dist/api/docs/       (routes/docs.ts 가 ./docs/ 를 먼저 찾는다)
//   @fastify/swagger-ui 의 static 폴더 → dist/api/swagger-ui/ (묶음 안에는 __dirname 이 없어 플러그인이 자기 폴더를 못 찾는다)
// 없으면 이미지에서 문서가 404 가 되므로 빌드를 멈춘다
if (app === "api") {
  for (const f of ["openapi.json", "openapi.yaml"]) {
    if (!existsSync(`docs/${f}`)) {
      console.error(`docs/${f} 없음 → 먼저 npm run openapi (이미지 빌드면 .dockerignore 의 !docs/${f} 확인)`);
      process.exit(1);
    }
    mkdirSync(`${outdir}/docs`, { recursive: true });
    cpSync(`docs/${f}`, `${outdir}/docs/${f}`);
  }
  const uiStatic = join(dirname(createRequire(import.meta.url).resolve("@fastify/swagger-ui/package.json")), "static");
  cpSync(uiStatic, `${outdir}/swagger-ui`, { recursive: true });
}

const bytes = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`bundled ${app} → ${outdir}/ (${(bytes / 1024).toFixed(0)} KiB incl. map, ${Date.now() - t0} ms)`);

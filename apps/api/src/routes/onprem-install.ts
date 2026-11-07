import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";

// 온프레 설치 한 줄이 받는 파일 (인증 없음: 회사 데이터·비밀이 없다. 비밀은 등록 응답으로만 간다)
//   GET /api/v1/install/onprem.sh          설치 스크립트 (tools/onprem-bootstrap.sh 의 __SVC_*__ 자리를 채움)
//   GET /api/v1/install/onprem/<경로>       설치 묶음 파일 하나 (스크립트에 박힌 sha256 목록에 있는 것만)
// 묶음 = 레포의 tools/onprem-install.sh + 고정 yaml 4개 + External Secrets 차트 tgz + deploy/helm/onprem-agent 차트. 이미지에는 /app/onprem-bundle 로 복사한다
// 필요한 설정: ONPREM_AGENT_IMAGE (고객이 받을 수 있는 공개 레지스트리 이름 @sha256:..., CI publish-onprem-agent 가 찍는 값)
//   없으면 설치 스크립트 대신 "설정 없음" 을 알리고 끝나는 스크립트를 준다 (503)

export const BUNDLE_FILES = ["tools/onprem-install.sh", "tools/argocd-core-install-v2.13.3.yaml",
  "tools/sealed-secrets-controller-v0.40.0.yaml", "tools/onprem-argocd-health.yaml", "tools/cnpg-1.30.1.yaml", "tools/external-secrets-2.14.0.tgz"];
export const BUNDLE_DIRS = ["deploy/helm/onprem-agent"];
const BOOTSTRAP = "tools/onprem-bootstrap.sh";
const IMAGE_RE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

// 묶음 뿌리. 이미지: /app/onprem-bundle. 개발(tsx): apps/api/src/routes 에서 레포 뿌리. ONPREM_BUNDLE_DIR 이 있으면 그것만
export function bundleRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ONPREM_BUNDLE_DIR) return env.ONPREM_BUNDLE_DIR;
  const candidates = ["/app/onprem-bundle", fileURLToPath(new URL("../../../../", import.meta.url))];
  return candidates.find((d) => existsSync(join(d, BOOTSTRAP))) ?? candidates[candidates.length - 1]!;
}

export interface Bundle { files: Map<string, Buffer>; manifest: string; bootstrap: string }
export function loadBundle(root: string): Bundle {
  const files = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const n of readdirSync(join(root, dir)).sort()) {
      const p = join(dir, n);
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else files.set(p, readFileSync(join(root, p)));
    }
  };
  for (const f of BUNDLE_FILES) files.set(f, readFileSync(join(root, f)));
  for (const d of BUNDLE_DIRS) walk(d);
  const manifest = [...files].map(([p, b]) => `${createHash("sha256").update(b).digest("hex")}  ${p}`).join("\n");
  return { files, manifest, bootstrap: readFileSync(join(root, BOOTSTRAP), "utf8") };
}

export function renderBootstrap(b: Bundle, api: string, image: string): string {
  // 채우는 값은 모양을 검사한 것만 (스크립트 안 따옴표를 깨지 않게)
  if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(api)) throw new Error("api base 모양이 아니다");
  if (!IMAGE_RE.test(image)) throw new Error("ONPREM_AGENT_IMAGE 는 <레지스트리>/<이름>@sha256:<64자> 이어야 한다");
  return b.bootstrap.split("__SVC_API__").join(api).split("__SVC_AGENT_IMAGE__").join(image).split("__SVC_MANIFEST__").join(b.manifest);
}

const apiBase = (req: FastifyRequest) => (process.env.PUBLIC_API_URL?.trim() || `${req.protocol}://${req.host}`).replace(/\/+$/, "");
const notConfigured = (why: string) => `#!/usr/bin/env bash\necho "svc-onprem: 플랫폼에 온프레 설치가 준비되지 않았다 (${why}). 플랫폼 운영자에게 알려 주세요" >&2\nexit 1\n`;

export async function onpremInstallRoutes(app: FastifyInstance) {
  let cached: Bundle | null = null;
  const bundle = () => (cached ??= loadBundle(bundleRoot()));

  app.get("/install/onprem.sh", { schema: { hide: true } }, async (req, reply) => {
    reply.header("content-type", "text/x-shellscript; charset=utf-8").header("cache-control", "no-store");
    const image = process.env.ONPREM_AGENT_IMAGE?.trim() ?? "";
    if (!IMAGE_RE.test(image)) return reply.code(503).send(notConfigured("ONPREM_AGENT_IMAGE"));
    try { return reply.send(renderBootstrap(bundle(), apiBase(req), image)); }
    catch (e) { req.log.error({ err: (e as Error).message }, "onprem install bundle"); return reply.code(503).send(notConfigured("설치 묶음")); }
  });

  app.get<{ Params: { "*": string } }>("/install/onprem/*", { schema: { hide: true } }, async (req, reply) => {
    const b = (() => { try { return bundle(); } catch { return null; } })();
    const file = b?.files.get(req.params["*"]);
    if (!file) return reply.code(404).header("content-type", "text/plain").send("not found\n");
    return reply.header("content-type", "application/octet-stream").header("cache-control", "no-store").send(file);
  });
}

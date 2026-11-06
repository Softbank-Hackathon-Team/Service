import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { envLayerBackend, envLayerDirOf, findWorkDir, TENANT_DIR_RE, workDirOf, workRootOf } from "@svc/adapters";
import { envNumber, STATE_EXPORT_PATH_PREFIX, STATE_EXPORT_TOKEN_HEADER, type TfStateLayer } from "@svc/contracts";

// 고객 Terraform state 내려받기의 worker 쪽 창구 (클러스터 안에서만, api 가 부른다).
// state 는 worker 디스크(TF_WORK_DIR, PVC)에만 있다. api 는 그 디스크에 못 붙으므로 api → 이 창구 → 파일 읽기 → api 가 그대로 흘려보낸다.
//   복사본을 만들지 않는다 (S3·DB·api 디스크 어디에도). 읽기만 하고 원본은 지우지 않는다.
// GET /internal/state/<회사 slug>/<app|env>/<id>
//   app: id = 이전 id. 작업 폴더 <뿌리>/<회사>/<이전>/terraform.tfstate (infra/modules/<환경>/root backend "local" path = "../terraform.tfstate")
//   env: id = 환경 id. 환경 층 폴더 <뿌리>/<회사>/env-<환경>/terraform.tfstate (adapters envLayerBackend 한 곳)
// 회사 확인(이 사람이 이 이전의 회사인가)은 api 가 DB 로 한다. 여기서는 "그 폴더가 정말 그 회사 폴더 아래인가"만 본다
// 로그에는 상태 코드·종류·id 만 남긴다 (파일 내용·토큰·경로는 안 남김)

// DRAFT(ai): 기본 8081. 차트 apps.worker.stateExportPort 와 같다
export const DEFAULT_STATE_EXPORT_PORT = 8081;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Log { info: (o: Record<string, unknown>, msg: string) => void; warn: (o: Record<string, unknown>, msg: string) => void }

export interface StateExportOpts {
  token: string;
  root: string;          // TF_WORK_DIR
  port: number;          // 0 = 아무 빈 포트 (시험)
  host?: string;         // 기본 0.0.0.0 (api 파드가 Service 로 부른다)
  log?: Log;
}

/** 환경 변수 → 설정. INTERNAL_STATE_TOKEN 이 없거나 포트가 0 이면 null (창구를 안 연다) */
export function stateExportFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<StateExportOpts, "log"> | null {
  const token = env.INTERNAL_STATE_TOKEN?.trim();
  const port = envNumber(env.WORKER_STATE_EXPORT_PORT, DEFAULT_STATE_EXPORT_PORT);
  if (!token || port <= 0) return null;
  return { token, root: workRootOf(env), port };
}

// 길이가 달라도 같은 시간: 둘 다 sha256 으로 줄인 뒤 비교한다
const sha = (s: string) => createHash("sha256").update(s).digest();
function tokenOk(got: string | string[] | undefined, want: string): boolean {
  if (typeof got !== "string" || got.length === 0) return false;
  return timingSafeEqual(sha(got), sha(want));
}

type Parsed = { tenant: string; layer: TfStateLayer; id: string };
/** 경로 → 회사·종류·id. 모양이 틀리면 null. 퍼센트 인코딩·점 조각은 받지 않는다 (../ 우회 차단) */
export function parseStatePath(rawUrl: string): Parsed | null {
  const path = rawUrl.split("?")[0]!;
  if (!path.startsWith(STATE_EXPORT_PATH_PREFIX)) return null;
  const parts = path.slice(STATE_EXPORT_PATH_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  const [tenant, layer, id] = parts as [string, string, string];
  if (!TENANT_DIR_RE.test(tenant)) return null;
  if (layer !== "app" && layer !== "env") return null;
  if (!ID_RE.test(id)) return null;
  return { tenant, layer, id };
}

/** state 파일 경로. 없거나 그 회사 폴더 밖이면 null */
export function stateFileOf(root: string, p: Parsed): string | null {
  let file: string;
  if (p.layer === "app") {
    const dir = findWorkDir(root, p.id);
    // 예전 <뿌리>/<이전> 폴더나 다른 회사 폴더면 "없음" (다른 회사 것인지도 알려 주지 않는다)
    if (!dir || resolve(dir) !== resolve(workDirOf(root, p.id, p.tenant))) return null;
    file = join(dir, "terraform.tfstate");
  } else {
    file = envLayerBackend(envLayerDirOf(root, p.tenant, p.id)).file;
  }
  // 심볼릭 링크로 회사 폴더 밖을 가리키는 것도 막는다
  try {
    const real = realpathSync(file);
    const base = realpathSync(join(root, p.tenant));
    if (!real.startsWith(base + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export async function startStateExportServer(o: StateExportOpts) {
  const log = o.log;
  const done = (r: ServerResponse, code: number, info: Record<string, unknown> = {}) => {
    r.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    r.end(JSON.stringify({ status: code }));
    log?.[code >= 500 ? "warn" : "info"]({ status: code, ...info }, "state export");
  };
  const handle = async (q: IncomingMessage, r: ServerResponse) => {
    if (q.method !== "GET") { r.setHeader("allow", "GET"); return done(r, 405); }
    if (!tokenOk(q.headers[STATE_EXPORT_TOKEN_HEADER], o.token)) return done(r, 401);
    const p = parseStatePath(q.url ?? "");
    if (!p) return done(r, 400);
    const info = { layer: p.layer, id: p.id };
    let file: string | null;
    try { file = stateFileOf(o.root, p); } catch { return done(r, 500, info); }   // findWorkDir: 같은 이전이 두 회사에 (있을 수 없음)
    if (!file) return done(r, 404, info);
    const size = statSync(file).size;
    r.writeHead(200, { "content-type": "application/json", "content-length": String(size), "cache-control": "no-store" });
    try {
      await pipeline(createReadStream(file), r);
      log?.info({ status: 200, ...info }, "state export");
    } catch {
      // 머리글은 이미 나갔다. 연결을 끊어 api 가 덜 받은 본문을 알게 한다
      r.destroy();
      log?.warn({ status: 200, aborted: true, ...info }, "state export");
    }
  };
  const server = createServer((q, r) => { void handle(q, r); });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(o.port, o.host ?? "0.0.0.0", res); });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    // 받던 내려받기는 끝까지 보낸다 (state 는 작다). 남은 놀고 있는 연결만 닫는다
    close: () => new Promise<void>((res) => { server.close(() => res()); server.closeIdleConnections(); }),
  };
}

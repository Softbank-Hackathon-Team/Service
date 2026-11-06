import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rehearsalSettings, type RehearsalInput } from "@svc/contracts";
import { scrubString } from "@svc/core";
import { TempRoleDenied } from "@svc/security";
import { envFor, isPublicImage, registryOf, spawnExec, type Exec } from "@svc/adapters";
import { withStepRoles, type StepRoles } from "../jobs/_roles.js";
import { MOCK_CREDENTIALS, realStsEnabled } from "../platform.js";
import type { MigrationRow } from "../jobs/_step.js";

// 리허설 이미지 복사 (설계 결정 38: 이미지는 해시로 회사별 플랫폼 저장소에 복사, 샌드박스에 고객 자격 없음).
// 고객 이미지를 다이제스트 그대로 플랫폼 ECR 샌드박스 자리(SANDBOX_IMAGE_REGISTRY = <호스트>/<접두어>)로 복사하고
// 렌더 결과의 주소 → 샌드박스 주소 짝(RehearsalInput.images, vCluster translateImage 표)을 돌려준다.
// 출발 ECR·Artifact Registry 읽기 = 출발 관찰 역할 15분 대여(STEP_ROLES.image_mirror, 그 클라우드의 받기 동작만). 플랫폼 쪽 쓰기 = 워커 자기 Pod Identity(sandbox/* 만).
// 태그로는 절대 복사하지 않는다: 렌더 주소·원본 둘 다 @sha256 이어야 하고 같은 다이제스트여야 한다

/** ref = 렌더 결과(파드)가 받는 주소, source = 바이트가 있는 고객 원본 (명세 image.repository@digest) */
export interface MirrorImage { ref: string; source: string }
export type MirrorFailReason = "registry_unset" | "not_by_digest" | "unsupported_registry" | "role_denied"
  | "tool_missing" | "auth_failed" | "copy_failed" | "digest_mismatch" | "budget_exceeded";
export type MirrorOutcome =
  | { ok: true; images: RehearsalInput["images"]; skipped?: "mock" }
  | { ok: false; code: "REHEARSAL_IMAGE_MIRROR_FAILED"; reason: MirrorFailReason; image: string | null; message: string };
export interface MirrorDeps { exec?: Exec; env?: NodeJS.ProcessEnv; withRoles?: typeof withStepRoles; now?: () => number }

// 원본 레지스트리 종류. platform = 이미 이 회사 샌드박스 자리에 있음(샌드박스 노드가 바로 읽음, 복사 없음)
// DRAFT(ai): 출발 사설 레지스트리는 ECR·Artifact Registry(gcr.io 포함)만. 온프레 레지스트리는 unsupported_registry (설계 7장 질문 4)
type SourceKind = "public" | "ecr" | "ar" | "platform";
interface Planned { ref: string; sandboxRef: string; kind: SourceKind; host: string; from: string; digest: string; repository: string }

const DIGEST = /@(sha256:[a-f0-9]{64})$/;
const ECR_HOST = /^\d{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/;
const ecrRegion = (host: string) => host.match(ECR_HOST)?.[1] ?? null;
const AR_HOST = /^([a-z0-9-]+-docker\.pkg\.dev|((us|eu|asia)\.)?gcr\.io)$/;
// DRAFT(ai): 단계 시간 상한. 토큰 20초(STS_CLI_TIMEOUT_MS 와 같음), 다이제스트 확인 30초, 복사 300초
const TOKEN_MS = 20_000, DIGEST_MS = 30_000, COPY_MS = 300_000;
// DRAFT(ai): 복사 한 번(역할 대여 + 모든 단계) 전체 예산 600초. deploy 작업 만료는 pg-boss 기본 900초다 (core boss.ts POLICY 의 deploy 에
//   expireInSeconds 없음). 남는 300초는 같은 작업 안의 비밀 그릇 확인·렌더·줄 넣기와, 시간 초과로 끊은 명령이 끝나는 몫이다.
//   단계마다 시간 상한 = min(단계 상한, 남은 예산). 이미지가 여럿이면 복사 300초 × 개수가 작업 만료를 넘을 수 있어서 둔다
export const MIRROR_BUDGET_MS = 600_000;
class OutOfBudget extends Error { constructor(readonly image: string | null, step: string) { super(step); } }
// crane 은 클라우드 자격이 필요 없다 (레지스트리 토큰은 DOCKER_CONFIG 파일로만)
const PLAIN_ENV = /^(PATH|HOME|TMPDIR|LANG|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;
// 빌린 자격으로 부를 때 워커 자기 신원(Pod Identity·IRSA)이 뒤에서 대신 쓰이지 않게 지운다 (envFor 는 프로필·키만 지움)
const OWN_IDENTITY = /^AWS_(CONTAINER_[A-Z_]+|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN|ROLE_SESSION_NAME)$/;

const fail = (reason: MirrorFailReason, image: string | null, message: string): MirrorOutcome =>
  ({ ok: false, code: "REHEARSAL_IMAGE_MIRROR_FAILED", reason, image, message: scrubString(message).trim().slice(-300) });

function plan(i: MirrorImage, reg: { host: string; prefix: string }, tenantId: string): Planned | MirrorOutcome {
  const d = i.source.match(DIGEST)?.[1];
  if (!d || i.ref.match(DIGEST)?.[1] !== d) return fail("not_by_digest", i.ref, `다이제스트로 고정되지 않았거나 렌더 주소와 원본 다이제스트가 다름: ${i.source}`);
  const named = i.source.slice(0, -(d.length + 1));
  const slash = named.lastIndexOf("/"), colon = named.lastIndexOf(":");
  const from = colon > slash ? named.slice(0, colon) : named;   // 태그는 버리고 다이제스트로만 받는다
  const host = registryOf(i.source);
  const kind: SourceKind | null = host === reg.host ? "platform" : isPublicImage(i.source) ? "public" : ecrRegion(host) ? "ecr"
    : AR_HOST.test(host) ? "ar" : null;
  if (!kind) return fail("unsupported_registry", i.ref, `출발 레지스트리 종류 미지원: ${host}`);
  // 플랫폼 레지스트리의 다른 자리(platform/<회사>, 다른 회사 자리)는 sbx-pod-guard 가 <SANDBOX_IMAGE_REGISTRY>/<회사>/ 밖이라 거부하고,
  //   워커는 sandbox/* 밖을 읽을 권한이 없어 복사도 못 한다. 샌드박스에서 뜰 수 없는 주소를 넘기지 않고 여기서 멈춘다
  const own = `${reg.host}/${reg.prefix}/${tenantId}/`;
  if (kind === "platform" && !from.startsWith(own)) return fail("unsupported_registry", i.ref, `플랫폼 레지스트리 이미지는 ${own} 아래만 샌드박스에서 받는다: ${from}`);
  // platformImageRef(adapters common/base.ts)와 같은 모양: <접두어>/<회사>/<원본 마지막 경로 조각>
  const repository = `${reg.prefix}/${tenantId}/${from.split("/").pop()!}`;
  const sandboxRef = kind === "platform" ? `${from}@${d}` : `${reg.host}/${repository}@${d}`;
  return { ref: i.ref, sandboxRef, kind, host, from, digest: d, repository };
}

/** deploy 리허설 문이 렌더 직후 부른다. MOCK_SANDBOX=1 이면 아무것도 안 하고 빈 표 */
export async function mirrorImages(j: { tenantId: string; migrationId: string }, m: MigrationRow,
  images: readonly MirrorImage[], deps: MirrorDeps = {}): Promise<MirrorOutcome> {
  const now = deps.now ?? Date.now;
  const deadline = now() + MIRROR_BUDGET_MS;
  const env = deps.env ?? process.env;
  const s = rehearsalSettings(env);
  if (s.mock) return { ok: true, images: [], skipped: "mock" };
  if (!s.imageRegistry) return fail("registry_unset", null, "SANDBOX_IMAGE_REGISTRY 없음");
  const [host, ...rest] = s.imageRegistry.split("/");
  const reg = { host: host!, prefix: rest.join("/") };
  const planned: Planned[] = [];
  for (const i of images) {
    const p = plan(i, reg, j.tenantId);
    if ("ok" in p) return p;
    planned.push(p);
  }
  const copy = (r: StepRoles | null) => copyAll(planned, reg, r, deps.exec ?? spawnExec, env, () => deadline - now());
  try {
    return planned.some((p) => p.kind === "ecr" || p.kind === "ar") ? await (deps.withRoles ?? withStepRoles)("image_mirror", j, m, copy) : await copy(null);
  } catch (e) {
    if (e instanceof TempRoleDenied) return fail("role_denied", null, e.code);
    throw e;
  }
}

async function copyAll(planned: Planned[], reg: { host: string; prefix: string }, r: StepRoles | null, exec: Exec,
  env: NodeJS.ProcessEnv, leftMs: () => number): Promise<MirrorOutcome> {
  if (r?.denied.length) return fail("role_denied", null, r.denied.map((d) => d.code).join(","));
  const dir = mkdtempSync(join(tmpdir(), "svc-mirror-"));
  chmodSync(dir, 0o700);
  try {
    // 예산이 없으면 시작하지 않고, 예산 때문에 끊긴 실패는 그 명령의 실패가 아니라 budget_exceeded 로 본다
    const run = async (cmd: string, args: string[], e: NodeJS.ProcessEnv, capMs: number, image: string | null = null) => {
      const step = `${cmd} ${args[0] === "ecr" ? args[1] : args[0]}`;
      const timeoutMs = Math.min(capMs, leftMs());
      if (timeoutMs <= 0) throw new OutOfBudget(image, step);
      const out = await exec(cmd, args, { cwd: dir, env: e, timeoutMs });
      if (out.code !== 0 && leftMs() <= 0) throw new OutOfBudget(image, step);
      return out;
    };
    const token = async (region: string, e: NodeJS.ProcessEnv) => {
      const t = await run("aws", ["ecr", "get-login-password", "--region", region], e, TOKEN_MS);
      return t.code === 0 ? { auth: Buffer.from(`AWS:${t.stdout.trim()}`).toString("base64") }
        : fail(t.code === 127 ? "tool_missing" : "auth_failed", null, `ecr get-login-password (${region}): ${t.stderr}`);
    };
    // STUB 발급기(REAL_STS=0·시드 환경)는 빌린 자격 파일이 없다 → 가져오기와 같이 프로세스 자격 (import.ts borrowObserve)
    const borrowed = r?.awsEnv?.source;
    const sourceEnv = borrowed
      ? Object.fromEntries(Object.entries(envFor(borrowed, env)).filter(([k]) => !OWN_IDENTITY.test(k))) : env;
    const auths: Record<string, { auth: string }> = {};
    for (const h of new Set(planned.filter((p) => p.kind === "ecr").map((p) => p.host))) {
      const a = await token(ecrRegion(h)!, sourceEnv);
      if ("ok" in a) return a;
      auths[h] = a;
    }
    // AR 레지스트리 암호 = 빌린 출발 관찰 SA 토큰 (사용자 이름 oauth2accesstoken). 메모리에서 아래 config.json(0600)으로만 간다
    //   빌린 토큰이 없을 때 워커 자기 gcloud 로그인으로 읽는 것은 REAL_STS=0(로컬·시험)뿐이다 (ECR 의 프로세스 자격과 같은 자리).
    //   진짜 발급기 모드에서 없으면(흉내 자격·출발이 GCP 아님) 워커 자기 계정으로 고객 레지스트리를 읽게 되니 멈춘다 (platform.ts refuseMockCredentials)
    const arHosts = new Set(planned.filter((p) => p.kind === "ar").map((p) => p.host));
    if (arHosts.size) {
      let t = r?.gcpToken?.source;
      if (!t && realStsEnabled(env)) return fail("role_denied", null, `Artifact Registry 를 읽을 출발 관찰 SA 토큰 없음 (${MOCK_CREDENTIALS} 이거나 출발이 GCP 아님)`);
      if (!t) {
        const own = await run("gcloud", ["auth", "print-access-token"], env, TOKEN_MS);
        if (own.code !== 0) return fail(own.code === 127 ? "tool_missing" : "auth_failed", null, `gcloud auth print-access-token: ${own.stderr}`);
        t = own.stdout.trim();
      }
      for (const h of arHosts) auths[h] = { auth: Buffer.from(`oauth2accesstoken:${t}`).toString("base64") };
    }
    // DRAFT(ai): 샌드박스 자리가 ECR 이 아니면(로컬 kind 시험용 레지스트리) 토큰·저장소 만들기 없이 익명으로 올린다
    const platformRegion = ecrRegion(reg.host);
    const toCopy = [...new Map(planned.filter((p) => p.kind !== "platform").map((p) => [p.sandboxRef, p])).values()];
    if (platformRegion && toCopy.length) {
      const a = await token(platformRegion, env);
      if ("ok" in a) return a;
      auths[reg.host] = a;
    }
    writeFileSync(join(dir, "config.json"), JSON.stringify({ auths }), { mode: 0o600 });
    const craneEnv = { ...Object.fromEntries(Object.entries(env).filter(([k]) => PLAIN_ENV.test(k))), DOCKER_CONFIG: dir };
    const crane = (args: string[], capMs: number, image: string) => run("crane", args, craneEnv, capMs, image);

    for (const p of toCopy) {
      const have = await crane(["digest", p.sandboxRef], DIGEST_MS, p.ref);
      if (have.code === 127) return fail("tool_missing", p.ref, have.stderr);
      if (have.code === 0 && have.stdout.trim() === p.digest) continue;   // 이미 있으면 안 올림
      if (platformRegion) {
        // 회사별 저장소. 플랫폼 앱 저장소와 같이 태그 못 바꿈 + 올릴 때 스캔
        const c = await run("aws", ["ecr", "create-repository", "--region", platformRegion, "--repository-name", p.repository,
          "--image-tag-mutability", "IMMUTABLE", "--image-scanning-configuration", "scanOnPush=true"], env, TOKEN_MS, p.ref);
        if (c.code !== 0 && !c.stderr.includes("RepositoryAlreadyExistsException"))
          return fail(c.code === 127 ? "tool_missing" : "copy_failed", p.ref, `ecr create-repository: ${c.stderr}`);
      }
      const c = await crane(["copy", `${p.from}@${p.digest}`, p.sandboxRef], COPY_MS, p.ref);
      if (c.code !== 0) return fail("copy_failed", p.ref, `crane copy: ${c.stderr}`);
      const got = await crane(["digest", p.sandboxRef], DIGEST_MS, p.ref);
      if (got.code !== 0 || got.stdout.trim() !== p.digest)
        return fail("digest_mismatch", p.ref, `복사 뒤 다이제스트 ${got.stdout.trim() || "없음"} ≠ ${p.digest}`);
    }
    const byRef = new Map(planned.map((p) => [p.ref, p.sandboxRef]));
    return { ok: true, images: [...byRef].map(([ref, sandboxRef]) => ({ ref, sandboxRef })) };
  } catch (e) {
    if (e instanceof OutOfBudget) return fail("budget_exceeded", e.image, `이미지 복사 예산 ${MIRROR_BUDGET_MS / 1000}초를 다 씀 (${e.message})`);
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

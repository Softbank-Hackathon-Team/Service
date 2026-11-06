import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageV2 } from "@svc/contracts";
import { scrubString } from "@svc/core";
import { TempRoleDenied } from "@svc/security";
import { adapterFor, envFor, flattenTfOutputsV2, iacMockEnabled, isPublicImage, registryOf, spawnExec, type Exec } from "@svc/adapters";
import { envFacts, fillPlaceholders, GitopsError, type DeployInput } from "../gitops/index.js";
import { realStsEnabled } from "../platform.js";
import { withStepRoles, type StepRoles } from "./_roles.js";
import type { MigrationRow, StepOutcome } from "./_step.js";

// 배포 이미지 복사 (FM-APP-01 "그대로 이식"의 나머지 반). 도착 렌더 값은 사설 이미지를 도착 플랫폼 저장소 주소로 가리킨다
//   (adapters common/base.ts platformImageRef: <계정>.dkr.ecr.<리전>.amazonaws.com/platform/<회사>/<이름>, <리전>-docker.pkg.dev/<프로젝트>/platform/<회사>/<이름>).
//   GitOps 커밋 직전에 그 자리를 채운다: 출발 원본을 다이제스트 그대로 복사하고 다시 읽어 같은지 본다. 이미 있으면 건너뛴다 (재개해도 같은 끝).
// 자격 = STEP_ROLES.image_copy: 출발 관찰 역할(그 클라우드의 받기 동작만) + 도착 실행 역할(apply 단계). 실환경(REAL_STS)에서 못 빌리면 워커 자기 자격으로 대신하지 않는다.
// crane·예산·다이제스트 확인은 리허설 복사(rehearsal/image-mirror.ts)와 같은 방식. 그쪽 자리는 플랫폼 샌드박스, 이쪽은 고객 도착 레지스트리

/** ref = 렌더 값이 가리키는 도착 주소(자리표시 채움), source = 바이트가 있는 고객 원본 (명세 image.repository@digest) */
export interface ImageCopy { ref: string; source: string; digest: string }
export type ImageCopyFailReason = "not_by_digest" | "unsupported_registry" | "role_denied" | "no_credentials" | "same_registry_host"
  | "tool_missing" | "auth_failed" | "repo_failed" | "copy_failed" | "digest_mismatch" | "budget_exceeded";
type Fail = { ok: false; reason: ImageCopyFailReason; image: string | null; message: string };
export type ImageCopyOutcome = { ok: true; copied: string[]; present: string[] } | Fail;
export interface ImageCopyDeps { exec?: Exec; env?: NodeJS.ProcessEnv; withRoles?: typeof withStepRoles; now?: () => number }

type Side = "source" | "target";
// 자격으로 들어갈 수 있는 사설 레지스트리 (호스트 모양으로 고름). gcr.io 는 Artifact Registry 가 받는 옛 주소
type RegistryKind = "ecr" | "gar";
const REGISTRY_HOST: Record<RegistryKind, RegExp> = {
  ecr: /^\d{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/,
  gar: /^(?:[a-z0-9-]+-docker\.pkg\.dev|(?:[a-z]+\.)?gcr\.io)$/,
};
const kindOf = (host: string) => (Object.keys(REGISTRY_HOST) as RegistryKind[]).find((k) => REGISTRY_HOST[k].test(host)) ?? null;
const ecrRegion = (host: string) => REGISTRY_HOST.ecr.exec(host)![1]!;

interface Planned { ref: string; from: string; digest: string; target: { host: string; kind: RegistryKind; repository: string }; source: { host: string; kind: RegistryKind } }

const DIGEST = /@(sha256:[a-f0-9]{64})$/;
// DRAFT(ai): 단계 시간 상한. 토큰·저장소 만들기 20초, 다이제스트 확인 30초, 복사 300초 (리허설 복사와 같음)
const TOKEN_MS = 20_000, DIGEST_MS = 30_000, COPY_MS = 300_000;
// DRAFT(ai): 복사 전체 예산 480초. 같은 deploy 작업(만료 900초) 안에서 이 뒤에 렌더·커밋·Argo 반영 대기(ARGO_WAIT_SEC 기본 180초)가 남는다
export const IMAGE_COPY_BUDGET_MS = 480_000;
class OutOfBudget extends Error { constructor(readonly image: string | null, step: string) { super(step); } }
// crane 은 클라우드 자격이 필요 없다 (레지스트리 토큰은 DOCKER_CONFIG 파일로만)
const PLAIN_ENV = /^(PATH|HOME|TMPDIR|LANG|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;
// 빌린 자격으로 부를 때 워커 자기 신원(Pod Identity·IRSA)이 뒤에서 대신 쓰이지 않게 지운다 (envFor 는 프로필·키만 지움)
const OWN_IDENTITY = /^AWS_(CONTAINER_[A-Z_]+|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN|ROLE_SESSION_NAME)$/;
const b64 = (s: string) => Buffer.from(s).toString("base64");

const fail = (reason: ImageCopyFailReason, image: string | null, message: string): Fail =>
  ({ ok: false, reason, image, message: scrubString(message).trim().slice(-300) });

/** 명세의 사설 이미지 → 도착 렌더 주소 짝. 주소는 Helm 값과 같은 함수(어댑터 imageRef + 자리표시 채움)로 만든다. 공개 레지스트리 이미지는 원본 그대로라 복사 대상이 아니다 */
export function imageCopiesOf(i: DeployInput): ImageCopy[] {
  if (!i.spec) return [];
  const t = { envId: i.target.envId, provider: i.target.provider, region: i.target.region, migrationId: i.plan.migrationId };
  const facts = { tf: flattenTfOutputsV2(i.tfOutputs), env: envFacts(i) };
  const out = new Map<string, ImageCopy>();
  for (const c of i.spec.components) {
    if (c.kind !== "service" && c.kind !== "job") continue;
    const p = c.props as { image: ImageV2; sidecars?: Array<{ image: ImageV2 }>; initContainers?: Array<{ image: ImageV2 }> };
    for (const img of [p.image, ...(p.sidecars ?? []).map((x) => x.image), ...(p.initContainers ?? []).map((x) => x.image)]) {
      if (img.source !== "registry" || !img.digest) continue;
      const source = `${img.repository}@${img.digest}`;
      if (isPublicImage(source)) continue;
      const filled = fillPlaceholders({ ref: adapterFor(i.target.provider).imageRef(source, t) }, facts);
      if (filled.missing.length) throw new GitopsError("GITOPS_PLACEHOLDER_MISSING", `이미지 주소의 채우지 못한 자리표시: ${filled.missing.join(", ")}`);
      const ref = filled.values.ref as string;
      out.set(ref, { ref, source, digest: img.digest });
    }
  }
  return [...out.values()];
}

// 시험이 deploy 길에 가짜 crane·자격을 꽂는다 (꽂으면 흉내 IaC 에서도 돈다)
let injected: ImageCopyDeps | undefined;
export const setImageCopyDeps = (d?: ImageCopyDeps) => { injected = d; };

/** deploy 가 GitOps 커밋 직전에 부른다. 실패면 paused(IMAGE_COPY_FAILED): 커밋 전이라 고객 클러스터엔 아무것도 안 들어갔고, 재개하면 남은 이미지만 다시 복사한다 */
export async function imageCopyStep(j: { tenantId: string; migrationId: string }, m: MigrationRow, i: DeployInput,
  deps: ImageCopyDeps | undefined = injected): Promise<{ outcome: StepOutcome } | { detail: Record<string, unknown> }> {
  // DRAFT(ai): 온프레·Azure Mock 도착은 이 단계가 채우지 않는다 (온프레 레지스트리는 고객 Agent 쪽, Azure 는 흉내). 감사 detail 에 남긴다
  if (i.target.provider !== "aws" && i.target.provider !== "gcp") return { detail: { skipped: "target_not_cloud" } };
  // 흉내 IaC 는 도착 레지스트리가 없다 (비밀 그릇 확인과 같은 규칙). MOCK_IAC 는 DEMO_MODE 에서 켤 수 없다 (contracts config)
  if (!deps && iacMockEnabled()) return { detail: { skipped: "mock_iac" } };
  const r = await copyImages(j, m, imageCopiesOf(i), deps ?? {});
  if (r.ok) return { detail: { copied: r.copied, present: r.present } };
  return { outcome: { to: "paused", failureCode: "IMAGE_COPY_FAILED", detail: { deploy: { error: "IMAGE_COPY_FAILED", step: r.reason, image: r.image,
    reason: `사설 이미지를 도착 레지스트리로 복사하지 못함 (${r.reason}): ${r.message} → 원인을 고치고 재개하면 남은 이미지만 다시 복사` } } } };
}

function plan(c: ImageCopy): Planned | Fail {
  if (c.source.match(DIGEST)?.[1] !== c.digest || c.ref.match(DIGEST)?.[1] !== c.digest)
    return fail("not_by_digest", c.ref, `렌더 주소와 원본이 같은 다이제스트로 고정되지 않음: ${c.source}`);
  const named = c.source.slice(0, -(c.digest.length + 1));
  const slash = named.lastIndexOf("/"), colon = named.lastIndexOf(":");
  const from = colon > slash ? named.slice(0, colon) : named;   // 태그는 버리고 다이제스트로만 받는다
  const th = registryOf(c.ref), sh = registryOf(c.source);
  const tk = kindOf(th), sk = kindOf(sh);
  if (!tk || !sk) return fail("unsupported_registry", c.ref, `자격으로 들어갈 수 없는 레지스트리: ${!tk ? `도착 ${th}` : `출발 ${sh}`} (ECR·Artifact Registry 만)`);
  return { ref: c.ref, from, digest: c.digest,
    target: { host: th, kind: tk, repository: c.ref.slice(th.length + 1, -(c.digest.length + 1)) }, source: { host: sh, kind: sk } };
}

export async function copyImages(j: { tenantId: string; migrationId: string }, m: MigrationRow, copies: readonly ImageCopy[],
  deps: ImageCopyDeps = {}): Promise<ImageCopyOutcome> {
  if (!copies.length) return { ok: true, copied: [], present: [] };
  const planned: Planned[] = [];
  for (const c of copies) {
    const p = plan(c);
    if ("ok" in p) return p;
    planned.push(p);
  }
  const now = deps.now ?? Date.now;
  const deadline = now() + IMAGE_COPY_BUDGET_MS;
  try {
    return await (deps.withRoles ?? withStepRoles)("image_copy", j, m,
      (r) => copyAll(planned, r, deps.exec ?? spawnExec, deps.env ?? process.env, () => deadline - now()));
  } catch (e) {
    if (e instanceof TempRoleDenied) return fail("role_denied", null, e.code);
    throw e;
  }
}

async function copyAll(planned: Planned[], r: StepRoles, exec: Exec, env: NodeJS.ProcessEnv, leftMs: () => number): Promise<ImageCopyOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "svc-imgcopy-"));
  chmodSync(dir, 0o700);
  try {
    // 예산이 없으면 시작하지 않고, 예산 때문에 끊긴 실패는 그 명령의 실패가 아니라 budget_exceeded 로 본다
    const run = async (cmd: string, args: string[], e: NodeJS.ProcessEnv, capMs: number, image: string | null = null) => {
      const step = `${cmd} ${args[0] === "ecr" || args[0] === "auth" ? args[1] : args[0]}`;
      const timeoutMs = Math.min(capMs, leftMs());
      if (timeoutMs <= 0) throw new OutOfBudget(image, step);
      const out = await exec(cmd, args, { cwd: dir, env: e, timeoutMs });
      if (out.code !== 0 && leftMs() <= 0) throw new OutOfBudget(image, step);
      return out;
    };
    // 한 쪽 레지스트리에 들어갈 자격: 빌린 GCP 토큰, 또는 CLI env(빌린 AWS 자격 / 로컬·시험의 프로세스 자격). who = 누구 자격인가
    type Cred = { who: Side | "process" } & ({ token: string } | { env: NodeJS.ProcessEnv });
    const credOf = (side: Side, kind: RegistryKind): Cred | Fail => {
      const denied = r.denied.filter((d) => d.side === side);
      if (denied.length) return fail("role_denied", null, `${side}: ${denied.map((d) => d.code).join(",")}`);
      const token = kind === "gar" ? r.gcpToken?.[side] : undefined;
      if (token) return { who: side, token };
      const aws = kind === "ecr" ? r.awsEnv?.[side] : undefined;
      if (aws) return { who: side, env: Object.fromEntries(Object.entries(envFor(aws, env)).filter(([k]) => !OWN_IDENTITY.test(k))) };
      // 실환경(REAL_STS)에서 그 쪽 자격을 못 빌렸으면 워커 자기 자격으로 고객 레지스트리를 만지지 않는다
      if (realStsEnabled(env)) return fail("no_credentials", null, `${side} 쪽 ${kind === "ecr" ? "AWS" : "GCP"} 자격을 빌리지 못함 (연결 링크로 연결한 환경인지, 이미지 레지스트리가 그 환경의 클라우드인지 확인)`);
      return { who: "process", env };   // 로컬·시험(REAL_STS=0): 흉내 발급기라 빌린 자격이 없다 → 프로세스 자격 (가져오기와 같음)
    };
    const login = async (side: Side, host: string, kind: RegistryKind): Promise<{ auth: string; who: Cred["who"]; env?: NodeJS.ProcessEnv } | Fail> => {
      const c = credOf(side, kind);
      if ("ok" in c) return c;
      if ("token" in c) return { auth: b64(`oauth2accesstoken:${c.token}`), who: c.who };
      const t = kind === "ecr"
        ? await run("aws", ["ecr", "get-login-password", "--region", ecrRegion(host)], c.env, TOKEN_MS)
        : await run("gcloud", ["auth", "print-access-token"], c.env, TOKEN_MS);
      if (t.code !== 0) return fail(t.code === 127 ? "tool_missing" : "auth_failed", null, `${side} ${host} 토큰: ${t.stderr}`);
      return { auth: b64(`${kind === "ecr" ? "AWS" : "oauth2accesstoken"}:${t.stdout.trim()}`), who: c.who, env: c.env };
    };
    const auths = new Map<string, { auth: string; who: Cred["who"] }>();
    const writeConfig = () => writeFileSync(join(dir, "config.json"),
      JSON.stringify({ auths: Object.fromEntries([...auths].map(([h, a]) => [h, { auth: a.auth }])) }), { mode: 0o600 });
    const craneEnv = { ...Object.fromEntries(Object.entries(env).filter(([k]) => PLAIN_ENV.test(k))), DOCKER_CONFIG: dir };
    const crane = (args: string[], capMs: number, image: string) => run("crane", args, craneEnv, capMs, image);

    // 도착 토큰 → 이미 있는지 (있으면 출발 자격도 안 씀)
    const targetEnv = new Map<string, NodeJS.ProcessEnv>();
    for (const p of planned) {
      if (auths.has(p.target.host)) continue;
      const a = await login("target", p.target.host, p.target.kind);
      if ("ok" in a) return a;
      auths.set(p.target.host, a);
      if (a.env) targetEnv.set(p.target.host, a.env);
    }
    writeConfig();
    const pending: Planned[] = [], present: string[] = [];
    for (const p of planned) {
      const have = await crane(["digest", p.ref], DIGEST_MS, p.ref);
      if (have.code === 127) return fail("tool_missing", p.ref, have.stderr);
      if (have.code === 0 && have.stdout.trim() === p.digest) present.push(p.ref);
      else pending.push(p);
    }
    if (!pending.length) return { ok: true, copied: [], present };

    // 출발 토큰. 같은 호스트에 도착과 다른 자격이 필요하면 crane 한 번(설정 파일 하나)으로는 못 옮긴다
    const sourceHosts = new Set<string>();
    for (const p of pending) {
      if (sourceHosts.has(p.source.host)) continue;
      sourceHosts.add(p.source.host);
      const a = await login("source", p.source.host, p.source.kind);
      if ("ok" in a) return a;
      const have = auths.get(p.source.host);
      if (!have) auths.set(p.source.host, a);
      else if (have.who !== a.who)
        return fail("same_registry_host", p.ref, `출발과 도착이 같은 레지스트리 호스트(${p.source.host})인데 자격이 다름. 같은 계정·같은 리전 사이 복사는 아직 못 함`);
    }
    writeConfig();

    const copied: string[] = [];
    for (const p of pending) {
      if (p.target.kind === "ecr") {
        // 이미지별 저장소 platform/<회사>/<이름>. 플랫폼 저장소와 같이 태그 못 바꿈 + 올릴 때 스캔, 우리 표시 태그(지우기 권한 조건 managed-by)
        const c = await run("aws", ["ecr", "create-repository", "--region", ecrRegion(p.target.host), "--repository-name", p.target.repository,
          "--image-tag-mutability", "IMMUTABLE", "--image-scanning-configuration", "scanOnPush=true", "--tags", "Key=managed-by,Value=platform"],
          targetEnv.get(p.target.host)!, TOKEN_MS, p.ref);
        if (c.code !== 0 && !c.stderr.includes("RepositoryAlreadyExistsException"))
          return fail(c.code === 127 ? "tool_missing" : "repo_failed", p.ref, `ecr create-repository: ${c.stderr}`);
      }
      const c = await crane(["copy", `${p.from}@${p.digest}`, p.ref], COPY_MS, p.ref);
      if (c.code !== 0) return fail("copy_failed", p.ref, `crane copy: ${c.stderr}`);
      const got = await crane(["digest", p.ref], DIGEST_MS, p.ref);
      if (got.code !== 0 || got.stdout.trim() !== p.digest)
        return fail("digest_mismatch", p.ref, `복사 뒤 다이제스트 ${got.stdout.trim() || "없음"} ≠ ${p.digest}`);
      copied.push(p.ref);
    }
    return { ok: true, copied, present };
  } catch (e) {
    if (e instanceof OutOfBudget) return fail("budget_exceeded", e.image, `이미지 복사 예산 ${IMAGE_COPY_BUDGET_MS / 1000}초를 다 씀 (${e.message})`);
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

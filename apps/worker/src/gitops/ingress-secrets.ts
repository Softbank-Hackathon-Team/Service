// deploy 커밋 전, 도착 비밀 그릇 중 입구 비밀 두 개(cloudflared-token·svc-metric-token)가 비어 있으면 플랫폼이 채운다.
// DRAFT(ai): ADR-072(플랫폼은 비밀 값을 복사하지 않음)의 예외. 고객 앱 비밀은 손대지 않는다 (11/6 인프라 영역 요청). 팀 검토 전
//   GCP 도착만 채운다. AWS 도착은 고객 실행 역할에 secretsmanager:PutSecretValue 가 없어 기존 검사에 맡긴다.
//   TODO(human): AWS 도착도 채울지 (고객 템플릿에 PutSecretValue 를 넣을지)
import { createHash, randomBytes } from "node:crypto";
import { METRIC_TOKEN_PREFIX } from "@svc/contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec, type Exec } from "@svc/adapters";
import { scrubString, withTenant, writeAudit } from "@svc/core";
import { checkSecretValues } from "./secret-values.js";

// 차트가 읽는 입구 비밀 이름 (packages/adapters/src/target/cloud.ts TUNNEL_SECRET·METRIC_SECRET 과 같다)
const TUNNEL_SECRET = "cloudflared-token";
const METRIC_SECRET = "svc-metric-token";
const INGRESS_SECRETS: readonly string[] = [TUNNEL_SECRET, METRIC_SECRET];
const CLI_TIMEOUT_MS = 30_000;

export class SecretFillError extends Error {}

export interface NamedSecret { name: string; remoteKey: string }
export type SkipWhy = "has_value" | "unknown" | "no_source";
export interface SecretFillResult {
  filled: string[];                                   // 비밀 이름만 (원격 키는 회사 번호가 들어가 감사엔 안 남긴다)
  skipped: Array<{ name: string; why: SkipWhy }>;
  failed: Array<{ name: string; error: string }>;
}
/** 토큰 하나를 만들어 write 에 넘긴다. write 가 실패하면 발급도 되돌린다 (지표 토큰) */
export type MetricIssuer = (write: (token: string) => Promise<void>) => Promise<void>;
export type TokenSource = () => Promise<string>;

// ---- 터널 토큰 출처 ----
// TODO(human): 출처 비밀의 targetToken 은 온프레 VM 도착(shop-api-cloudflared-token)도 쓰는 토큰이다. GCP·AWS 도착이 같은 토큰을 쓰면
//   두 도착이 동시에 떠 있을 때 같은 터널에 커넥터가 두 곳 생겨 트래픽이 섞인다. 도착별로 키를 나눌지(예: gcpTargetToken) 정해야 한다
// TODO(human): platform/shop-tunnels 는 shop 데모 앱 전용 이름이다. 앱이 여러 개면 비밀 id 를 앱 이름으로 고를지 정해야 한다
export interface TunnelSourceRef { secretId: string; key: string; region: string }
/** 비밀 id·키가 둘 다 있어야 켠다. 비면 null → 채우지 않고 예전처럼 검사에서 paused(SECRET_VALUES_MISSING) */
export function tunnelSourceFromEnv(env: NodeJS.ProcessEnv = process.env): TunnelSourceRef | null {
  const secretId = env.TARGET_TUNNEL_SECRET_ID?.trim();
  const key = env.TARGET_TUNNEL_SECRET_KEY?.trim();
  if (!secretId || !key) return null;
  // DRAFT(ai): 출처 비밀 리전 기본값 = 플랫폼 계정 리전(서울)
  return { secretId, key, region: env.TARGET_TUNNEL_SECRET_REGION?.trim() || "ap-northeast-2" };
}

/** worker 자기 자격(플랫폼 AWS 계정, Pod Identity)으로 터널 토큰을 읽는다. 고객 계정에서 빌린 env 로 읽으면 안 된다 */
export async function readTunnelToken(src: TunnelSourceRef, exec: Exec = spawnExec, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const r = await exec("aws", ["secretsmanager", "get-secret-value", "--secret-id", src.secretId, "--region", src.region,
    "--query", "SecretString", "--output", "text"], { cwd: process.cwd(), env, timeoutMs: CLI_TIMEOUT_MS });
  if (r.code !== 0) throw new SecretFillError(`터널 토큰 출처(${src.secretId})를 못 읽음: ${scrubString(r.stderr.trim().slice(0, 200)) || `exit ${r.code}`}`);
  let v: unknown;
  // 오류 문장에 출력(비밀 원문)을 넣지 않는다
  try { v = (JSON.parse(r.stdout) as Record<string, unknown>)[src.key]; } catch { throw new SecretFillError(`터널 토큰 출처(${src.secretId})가 JSON 이 아님`); }
  if (typeof v !== "string" || !v.trim()) throw new SecretFillError(`터널 토큰 출처(${src.secretId})에 키 ${src.key} 가 없음`);
  return v.trim();
}

// ---- 지표 토큰 발급 (api POST /environments/:id/metric-token 과 같은 처리) ----
// 토큰 모양·해시는 apps/api/src/auth/metric-token.ts 와 같다 (원문 = 접두사 + 무작위 32바이트 base64url, DB 에는 sha256 hex 만). 바꾸면 둘 다 바꾼다
export const hashMetricToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newMetricToken = () => `${METRIC_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
/** 도착 환경이 connected/unstable 일 때만. 기존 토큰 끊기 → 해시 넣기 → 감사 env.metric_token_issued → 그릇에 쓰기.
 *  DRAFT(ai): 그릇 쓰기를 같은 트랜잭션 안에서 한다. 쓰기가 실패하면 되돌려 기존 토큰이 살아 있다.
 *    대가: 쓰는 동안(최대 30초) 환경 줄 잠금을 쥔다. 쓰기 성공 뒤 COMMIT 만 실패하면 그릇엔 DB 에 없는 토큰이 남는다(드묾. 그릇을 비우고 재개)
 *  TODO(human): 환경마다 살아 있는 토큰은 하나다. 같은 도착 환경의 다른 앱 그릇·수집기가 이미 토큰을 쓰고 있으면 여기서 끊긴다 (그릇이 빈 앱이 있을 때만) */
export function dbMetricIssuer(tenantId: string, envId: string, migrationId: string): MetricIssuer {
  return (write) => withTenant(tenantId, async (tx) => {
    const e = await tx.query<{ connection_status: string }>("SELECT connection_status FROM environments WHERE id = $1 FOR UPDATE", [envId]);
    const st = e.rows[0]?.connection_status;
    if (st !== "connected" && st !== "unstable") throw new SecretFillError(`도착 환경이 ${st ?? "없음"} 이라 지표 토큰을 발급하지 않음`);
    const token = newMetricToken();
    await tx.query("UPDATE metric_tokens SET revoked_at = now() WHERE env_id = $1 AND revoked_at IS NULL", [envId]);
    await tx.query("INSERT INTO metric_tokens (tenant_id, env_id, token_hash) VALUES ($1, $2, $3)", [tenantId, envId, hashMetricToken(token)]);
    await writeAudit(tx, tenantId, { actor: "worker", action: "env.metric_token_issued", target: envId, result: "ok",
      detail: { by: "deploy", migrationId, secret: METRIC_SECRET } });
    await write(token);
  });
}

// ---- 그릇 쓰기 (도착 실행 역할을 빌린 env) ----
const hide = (s: string, ...secrets: string[]) => scrubString(secrets.reduce((o, x) => (x ? o.split(x).join("***") : o), s));

/** 차트 ExternalSecret 이 remoteRef.property: token 으로 읽으므로 원격 값은 JSON {"token":"<값>"}.
 *  값은 0600 임시 파일로만 넘기고(argv 에는 경로만) 끝나면 지운다 */
//  gcp 만: svc-operate 커스텀 역할 secretmanager.versions.add (그릇은 앱 층 apply 가 값 없이 만든다)
export async function writeIngressSecret(o: { remoteKey: string; token: string; projectId?: string | null; env?: NodeJS.ProcessEnv },
  exec: Exec = spawnExec): Promise<void> {
  const payload = JSON.stringify({ token: o.token });
  const dir = await mkdtemp(join(tmpdir(), "svc-ingress-secret-"));
  try {
    const file = join(dir, "value.json");
    await writeFile(file, payload, { mode: 0o600 });
    const args = ["secrets", "versions", "add", o.remoteKey, ...(o.projectId ? [`--project=${o.projectId}`] : []), `--data-file=${file}`];
    const r = await exec("gcloud", args, { cwd: process.cwd(), env: o.env ?? process.env, timeoutMs: CLI_TIMEOUT_MS });
    if (r.code !== 0) throw new SecretFillError(`그릇에 못 씀: ${hide(r.stderr.trim().slice(0, 200), o.token, payload) || `exit ${r.code}`}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** GCP 도착: 입구 비밀 중 빈 그릇만 채운다. 출처가 없거나(null) 값이 이미 있거나 상태를 못 읽은 그릇은 건너뛴다(뒤 검사가 판정) */
export async function fillIngressSecrets(o: {
  secrets: NamedSecret[]; projectId?: string | null; env?: NodeJS.ProcessEnv;
  tunnel: TokenSource | null; metric: MetricIssuer | null;
}, exec: Exec = spawnExec): Promise<SecretFillResult> {
  const out: SecretFillResult = { filled: [], skipped: [], failed: [] };
  const targets = o.secrets.filter((s) => INGRESS_SECRETS.includes(s.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!targets.length) return out;
  const check = await checkSecretValues({ provider: "gcp", keys: targets.map((t) => t.remoteKey), projectId: o.projectId, region: "", ...(o.env ? { env: o.env } : {}) }, exec);
  const unknown = new Set(check.unknown.map((u) => u.key));
  for (const t of targets) {
    if (!check.missing.includes(t.remoteKey)) { out.skipped.push({ name: t.name, why: unknown.has(t.remoteKey) ? "unknown" : "has_value" }); continue; }
    const write = (token: string) => writeIngressSecret({ remoteKey: t.remoteKey, token, projectId: o.projectId, ...(o.env ? { env: o.env } : {}) }, exec);
    try {
      if (t.name === TUNNEL_SECRET) {
        if (!o.tunnel) { out.skipped.push({ name: t.name, why: "no_source" }); continue; }
        await write(await o.tunnel());
      } else if (t.name === METRIC_SECRET) {
        if (!o.metric) { out.skipped.push({ name: t.name, why: "no_source" }); continue; }
        await o.metric(write);
      }
      out.filled.push(t.name);
    } catch (e) {
      // SecretFillError 문장은 위에서 원문을 지웠다. 그 밖(DB 오류 등)도 scrubString 을 거친다
      out.failed.push({ name: t.name, error: e instanceof SecretFillError ? e.message : scrubString(String((e as Error)?.message ?? e)).slice(0, 200) });
    }
  }
  return out;
}

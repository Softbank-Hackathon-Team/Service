import { spawnExec, type Exec } from "../terraform/real-runner.js";
import { AdapterError } from "./errors.js";

// Z88: 클라우드 CLI 읽기 공통 조각 (가져오기 discover·사전 점검 precheck 가 같이 쓴다).
// Z86 inventory.ts 와 같은 방식: SDK 를 새로 넣지 않고 맥에 이미 있는 aws·gcloud·kubectl 을 인자 배열로 부른다(셸 없음).
// 쓰기 명령은 부르지 않는다. 예외 하나: kubeconfig 를 "임시 파일"에 만드는 명령(aws eks update-kubeconfig --kubeconfig <임시>,
// gcloud container clusters get-credentials + KUBECONFIG=<임시>) — 클라우드 쪽은 안 바뀌고 로컬 임시 파일만 생긴다(끝나면 지움).

export interface CliDeps {
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
}

export const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
export const str = (x: unknown): string | null => (typeof x === "string" ? x : typeof x === "number" ? String(x) : null);
export const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
export const lastLine = (t: string) => t.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "";
/** Z86 R8-46: AWS 계정 번호 12자리는 화면·응답에 끝 4자리만 (inventory·discover·precheck 공통) */
export const maskAccount = (a: string | null) => (a && a.length >= 4 ? `••••${a.slice(-4)}` : "?");
/** CLI 오류 글(ARN 등)에 섞인 12자리 계정 번호도 끝 4자리만 남긴다 (Z104 03) */
export const scrubAccountIds = (t: string) => t.replace(/\b\d{12}\b/g, (m) => maskAccount(m));

/** CLI 하나 실패 = 이 오류. code 127 = 명령 없음 */
export class CliError extends Error {
  constructor(public readonly bin: string, public readonly args: string[], public readonly exitCode: number, public readonly stderr: string) {
    super(`${bin} ${args.slice(0, 3).join(" ")} 실패 (exit ${exitCode}): ${lastLine(scrubAccountIds(stderr)) || "출력 없음"}`);
  }
  get missing() { return this.exitCode === 127; }
}

export function timeoutOf(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** 명령 하나 → JSON. 실패면 CliError */
export async function runJson(d: CliDeps, bin: string, args: string[], extraEnv: Record<string, string> = {}): Promise<unknown> {
  const env = { ...(d.env ?? process.env), ...extraEnv };
  const r = await (d.exec ?? spawnExec)(bin, args, { cwd: process.cwd(), env, timeoutMs: timeoutOf(env, "CLOUD_READ_TIMEOUT_MS", 20_000) });
  if (r.code !== 0) throw new CliError(bin, args, r.code, r.stderr);
  try { return JSON.parse(r.stdout || "null"); }
  catch (e) { throw new CliError(bin, args, 1, `응답 JSON 해석 실패: ${(e as Error).message.slice(0, 100)}`); }
}

/** 명령 하나 → 글자 (JSON 아닌 출력) */
export async function runText(d: CliDeps, bin: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const env = { ...(d.env ?? process.env), ...extraEnv };
  const r = await (d.exec ?? spawnExec)(bin, args, { cwd: process.cwd(), env, timeoutMs: timeoutOf(env, "CLOUD_READ_TIMEOUT_MS", 20_000) });
  if (r.code !== 0) throw new CliError(bin, args, r.code, r.stderr);
  return r.stdout;
}

/** 출발 환경을 못 읽음 → 가짜 값 없이 이유를 들고 멈춘다. worker 는 failed(IMPORT_SOURCE_UNAVAILABLE) */
export const unavailable = (why: string) => new AdapterError("SOURCE_UNAVAILABLE", `출발 환경을 읽을 수 없음: ${why}`);
/** 읽긴 읽었는데 명세를 만들 재료가 없음 (앱 Deployment 없음, 실행 중 Pod 없음 등) */
export const incomplete = (why: string) => new AdapterError("SOURCE_INCOMPLETE", `출발 환경에서 명세 재료를 못 찾음: ${why}`);

/** 데모 원본 허용 여부. MOCK_SEED=1 (시험·e2e 전용) 일 때만 */
export const mockSeed = (env: NodeJS.ProcessEnv = process.env) => env.MOCK_SEED === "1";

// Z104 04: 빈 값(.env 의 `AWS_REGION=`)도 "설정 안 함"으로 본다 (Z81 envNumber 와 같은 규칙, precheck 는 이미 이렇게 읽었다)
export const awsRegion = (env: NodeJS.ProcessEnv) => env.AWS_REGION || env.AWS_DEFAULT_REGION || "ap-northeast-2";
export const gcpRegion = (env: NodeJS.ProcessEnv) => env.GCP_REGION || "asia-northeast3";
export const onpremContext = (env: NodeJS.ProcessEnv) => env.ONPREM_KUBE_CONTEXT || "k3d-onprem";

/** GCP 프로젝트: GCP_PROJECT → GOOGLE_CLOUD_PROJECT → gcloud 기본값. 못 정하면 null */
export async function gcpProject(d: CliDeps): Promise<string | null> {
  const env = d.env ?? process.env;
  const p = env.GCP_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
  if (p) return p;
  try {
    const v = (await runText(d, "gcloud", ["config", "get-value", "project"])).trim();
    return v && v !== "(unset)" ? v : null;
  } catch (e) {
    if (e instanceof CliError && e.missing) throw unavailable("gcloud 명령이 없음");
    return null;
  }
}

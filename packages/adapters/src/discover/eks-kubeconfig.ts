import { rename, rm, writeFile } from "node:fs/promises";
import { spawnExec, type Exec } from "../terraform/real-runner.js";
import { CliError, get, str, timeoutOf, type CliDeps } from "../common/cli.js";

// #373 B4: 가져오기의 EKS kubeconfig.
//   aws eks update-kubeconfig 가 쓰는 kubeconfig 는 사용자 칸이 exec 플러그인(command: aws, args: eks get-token …)이다.
//   kubectl 은 부를 때마다 새 프로세스라 받은 토큰을 기억하지 못한다 → kubectl 한 번 = kubectl + aws(파이썬) 두 프로세스.
//   가져오기 한 번에 kubectl 이 20~30번이라 aws CLI 시작이 그만큼 더 붙었다 (awscli 2.x customizations/eks/update_kubeconfig.py 로 확인).
//   그래서 토큰을 한 번 받아(aws eks get-token) describe-cluster 의 주소·CA 와 함께 정적 토큰 kubeconfig 를 임시 파일(0600)에 쓴다.
//   토큰이 끝나기 EKS_TOKEN_REFRESH_MS 안이면 다음 kubectl 앞에서 다시 받는다. 어느 단계든 실패하면 예전 exec kubeconfig 로 돌아간다.
//   토큰은 파일에만 쓴다: 로그·오류 글·명령 인자(--token)에 넣지 않는다. 파일은 discover 가 끝나면 임시 폴더째 지운다

type Obj = Record<string, unknown>;

// DRAFT(ai): 토큰이 끝나기 120초 안이면 다시 받는다. get-token 이 주는 만료는 받은 때 + 14분 (STS 미리 서명 URL 은 15분)
export const EKS_TOKEN_REFRESH_MS = 120_000;
// DRAFT(ai): get-token 응답에 만료 시각이 없거나 못 읽으면 10분으로 본다 (14분보다 짧게 잡아 일찍 다시 받는 쪽)
const EKS_TOKEN_DEFAULT_TTL_MS = 600_000;
// get-token 토큰 모양 (k8s-aws-v1. + base64url). 모양이 다르면 파일에 쓰지 않고 예전 길로
const TOKEN_RE = /^k8s-aws-v1\.[A-Za-z0-9_-]+$/;
const ENDPOINT_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/;
const CA_RE = /^[A-Za-z0-9+/=\s]+$/;

/** DRAFT(ai): 정적 토큰 kubeconfig 를 쓰나. 기본 켬, IMPORT_EKS_STATIC_TOKEN=0 이면 예전처럼 update-kubeconfig(exec 플러그인) */
export const eksStaticTokenEnabled = (env: NodeJS.ProcessEnv) => env.IMPORT_EKS_STATIC_TOKEN?.trim() !== "0";

export interface EksKubeInput {
  cluster: string;
  region: string;
  /** describe-cluster 의 cluster 객체 (endpoint·certificateAuthority.data 를 쓴다. 이미 부른 결과라 다시 부르지 않음) */
  desc: Obj | undefined;
  /** kubeconfig 임시 파일 경로 (mkdtemp 폴더 안) */
  path: string;
  /** 예전 길: exec kubeconfig 를 path 에 쓴다 (aws eks update-kubeconfig). 실패하면 그 오류를 던진다 */
  execKubeconfig: () => Promise<void>;
  /** 시험용 시계 (ms) */
  now?: () => number;
}
export interface EksKube {
  /** kubectl 읽기에 쓸 CliDeps. 정적 토큰이면 kubectl 앞에서 토큰 만료를 본다 */
  deps: CliDeps;
  /** 지금 kubeconfig 종류 (정적 토큰 → 실패하면 exec 로 바뀜) */
  mode: () => "static" | "exec";
}

interface Token { token: string; expMs: number }

/** aws eks get-token 한 번. 응답 글은 토큰이 들어 있어 오류 글에 넣지 않는다 (runJson 의 JSON 해석 오류는 입력 조각을 붙일 수 있어 안 씀) */
async function fetchToken(d: CliDeps, cluster: string, region: string, now: () => number): Promise<Token> {
  const env = d.env ?? process.env;
  const r = await (d.exec ?? spawnExec)("aws", ["eks", "get-token", "--cluster-name", cluster, "--region", region, "--output", "json"],
    { cwd: process.cwd(), env, timeoutMs: timeoutOf(env, "CLOUD_READ_TIMEOUT_MS", 20_000) });
  if (r.code !== 0) throw new CliError("aws", ["eks", "get-token", "--cluster-name", cluster], r.code, r.stderr);
  let j: unknown;
  try { j = JSON.parse(r.stdout || "null"); } catch { throw new Error("aws eks get-token 응답을 해석하지 못함"); }
  const token = get(j, "status", "token");
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new Error("aws eks get-token 응답에 토큰 모양이 없음");
  const exp = Date.parse(str(get(j, "status", "expirationTimestamp")) ?? "");
  return { token, expMs: Number.isFinite(exp) ? exp : now() + EKS_TOKEN_DEFAULT_TTL_MS };
}

/** 정적 토큰 kubeconfig (JSON 도 kubeconfig 로 읽힌다). 같은 폴더 임시 이름에 0600 으로 쓰고 이름을 바꿔, 도는 kubectl 이 반쯤 쓴 파일을 읽지 않게 한다 */
async function writeStatic(path: string, endpoint: string, ca: string, token: string): Promise<void> {
  const cfg = {
    apiVersion: "v1", kind: "Config", preferences: {},
    clusters: [{ name: "eks", cluster: { server: endpoint, "certificate-authority-data": ca.replace(/\s+/g, "") } }],
    users: [{ name: "eks", user: { token } }],
    contexts: [{ name: "eks", context: { cluster: "eks", user: "eks" } }],
    "current-context": "eks",
  };
  const tmp = `${path}.next`;
  await writeFile(tmp, JSON.stringify(cfg), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * EKS kubeconfig 준비. 정적 토큰이 되면 deps.exec 가 kubectl 앞에서 토큰 만료를 보고(한 번에 하나만) 다시 받는다.
 * 정적 토큰을 못 쓰는 경우(끔·주소/CA 없음·Outposts·get-token 실패·파일 쓰기 실패) = execKubeconfig() 로 예전 길. 그것도 실패하면 그 오류를 던진다
 */
export async function eksKubeconfig(d: CliDeps, i: EksKubeInput): Promise<EksKube> {
  const env = d.env ?? process.env, now = i.now ?? Date.now;
  let mode: "static" | "exec" = "exec";
  const asExec = async (): Promise<EksKube> => { await i.execKubeconfig(); return { deps: d, mode: () => mode }; };
  const endpoint = str(get(i.desc, "endpoint")), ca = str(get(i.desc, "certificateAuthority", "data"));
  // Outposts 로컬 클러스터는 토큰을 --cluster-id 로 받아야 한다 → 예전 길 (update-kubeconfig 가 알아서 고름)
  if (!eksStaticTokenEnabled(env) || !endpoint || !ENDPOINT_RE.test(endpoint) || !ca || !CA_RE.test(ca) || get(i.desc, "outpostConfig")) return asExec();
  let tok: Token;
  try {
    tok = await fetchToken(d, i.cluster, i.region, now);
    await writeStatic(i.path, endpoint, ca, tok.token);
  } catch {
    await rm(`${i.path}.next`, { force: true });
    return asExec();   // 이유는 남기지 않는다 (예전 길이 같은 자격으로 다시 시도하고, 그것도 안 되면 그 오류가 이유가 된다)
  }
  mode = "static";
  const base = d.exec ?? spawnExec;
  let refreshing: Promise<void> | null = null;
  const fresh = async () => {
    if (now() < tok.expMs - EKS_TOKEN_REFRESH_MS) return;
    refreshing ??= (async () => {
      try {
        tok = await fetchToken(d, i.cluster, i.region, now);
        await writeStatic(i.path, endpoint, ca, tok.token);
      } catch {
        // 다시 받기 실패 → 예전 exec kubeconfig 로 바꾼다. update-kubeconfig 는 있는 파일에 합치므로 먼저 지운다
        mode = "exec";
        await rm(`${i.path}.next`, { force: true });
        await rm(i.path, { force: true });
        await i.execKubeconfig();
      } finally { refreshing = null; }
    })();
    await refreshing;
  };
  const exec: Exec = async (cmd, args, o) => {
    if (cmd === "kubectl" && mode === "static" && args.includes(i.path)) await fresh();
    return base(cmd, args, o);
  };
  return { deps: { ...d, exec }, mode: () => mode };
}

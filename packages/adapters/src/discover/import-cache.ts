import { createHash } from "node:crypto";
import { basename } from "node:path";
import { envNumber } from "@svc/contracts";
import { spawnExec, type Exec } from "../terraform/real-runner.js";

// #373 B3: 가져오기 읽기 CLI 출력의 짧은 기록·재생 캐시 (프로세스 메모리).
//   온프레 출발은 Agent 스냅숏(600초 안)을 다시 써서 0.16초인데, AWS 출발은 매번 CLI 로 전부 읽어 80~124초였다 (11/07 실측).
//   같은 회사·같은 환경·같은 빌린 역할로 TTL 안에 같은 읽기 명령을 다시 부르면(재시도·다시 가져오기·같은 출발 환경의 다른 이전) 기록한 출력을 돌려준다.
//   - 키 = 회사 + 환경 번호 + 빌린 역할 신원(역할 ARN·SA 이메일, 자격 값 아님) + 명령 인자. 임시 kubeconfig 경로는 파일 이름(클러스터 신원)으로 바꿔 넣는다
//   - 읽기 명령만: aws describe-*·list-*·get-* / kubectl get·api-resources / gcloud describe·list·get-iam-policy. 그 밖(update-kubeconfig·get-credentials 등)은 그대로 부른다
//   - 비밀값이 나올 수 있는 명령은 안 담는다: Secret·시크릿 관리자·토큰·비밀번호·자격 (아래 DENY)
//   - 성공(exit 0)만 담는다. 실패는 다음에 다시 부른다
//   - 워커는 한 대(replica 1)라 DB 없이 메모리만. 워커가 재시작하면 비어 있다
// 남는 위험: 워크로드 원본(Deployment env·ConfigMap·ECS 작업 정의)의 평문 값은 담긴다 (가져오기가 원래 읽어 명세로 옮기는 값, 메모리에서만 TTL 동안)

/** 이 가져오기 한 번의 캐시 쓰임 (감사 detail.cache → 타임라인) */
export interface ImportCacheStats {
  ttlSec: number;
  /** 기록에서 돌려준 수 */
  hits: number;
  /** 담을 수 있는데 없어서 부른 수 */
  misses: number;
  /** 담지 않는 명령이라 그대로 부른 수 (비밀·쓰기·클러스터 신원 모름 등) */
  bypass: number;
  /** 돌려준 기록 중 가장 오래된 것의 나이 (초) */
  maxAgeSec: number;
}
export interface ImportCacheScope { tenantId: string; envId: string; role: string }
export interface ImportCacheOpts { scope: ImportCacheScope; ttlSec: number; stats?: ImportCacheStats; now?: () => number }

/** DRAFT(ai): TTL 기본 300초 (온프레 스냅숏 600초보다 짧게: 다시 가져오기에서 출발 쪽 변경이 늦게 보이는 시간을 줄임). 0(또는 숫자 아님) = 끔 */
export function importCacheSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = envNumber(env.IMPORT_CACHE_SEC, 300);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
export const newImportCacheStats = (ttlSec: number): ImportCacheStats => ({ ttlSec, hits: 0, misses: 0, bypass: 0, maxAgeSec: 0 });

// 비밀값이 나올 수 있는 명령 (정규화한 인자 어디에든 나오면 안 담음): Secret·ExternalSecret·SecretStore·시크릿 관리자, 토큰(eks get-token 등),
//   비밀번호(ec2 get-password-data·ecr get-login-password), 자격(get-credentials), 복호화
const DENY = /secret|token|password|passwd|credential|login|private-?key|decrypt/i;
// aws: 서비스째 안 담음 (값 읽기 동사가 섞인 서비스)
const AWS_DENY_SERVICES = new Set(["secretsmanager", "ssm", "kms", "sso", "sso-oidc", "cognito-identity", "sts"]);
const AWS_ALLOW_STS = new Set(["get-caller-identity"]);
const AWS_READ = /^(describe|list|get)-[a-z0-9-]+$/;
const GCLOUD_READ = new Set(["describe", "list", "get-iam-policy"]);
// kubectl: 값을 받는 옵션 (위치 인자와 가르려고)
const KUBE_VALUE_FLAGS = new Set(["--kubeconfig", "--context", "-n", "--namespace", "-l", "--selector", "-o", "--output"]);
// 임시 kubeconfig 는 "<클러스터 신원>.kubeconfig" 이름이어야 담는다 (discover withTempKube). 이름이 없으면 어느 클러스터인지 몰라 안 담음
const LABELED_KUBECONFIG = /^[A-Za-z0-9._-]+\.kubeconfig$/;

/** 담을 수 있는 읽기 명령이면 키용 인자(임시 경로를 클러스터 신원으로 바꾼 것), 아니면 null */
export function importCacheArgs(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): string[] | null {
  let out: string[] | null = null;
  if (cmd === "aws") {
    const [svc, op] = args;
    if (!svc || !op || svc.startsWith("-") || !AWS_READ.test(op)) return null;
    if (AWS_DENY_SERVICES.has(svc) && !(svc === "sts" && AWS_ALLOW_STS.has(op))) return null;
    out = [...args];
  } else if (cmd === "kubectl") {
    const pos: string[] = [];
    out = [];
    let cluster = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--kubeconfig") {
        const name = basename(args[i + 1] ?? "");
        if (!LABELED_KUBECONFIG.test(name)) return null;
        out.push(a, `<${name}>`); i++; cluster = true; continue;
      }
      if (a.startsWith("--kubeconfig=")) return null;
      if ((a === "--context" && args[i + 1]) || (a.startsWith("--context=") && a.length > 10)) cluster = true;
      if (a === "--raw" || a.startsWith("--raw=") || a === "-w" || a === "--watch" || a.startsWith("--watch=")) return null;
      out.push(a);
      if (KUBE_VALUE_FLAGS.has(a)) { if (i + 1 < args.length) out.push(args[++i]!); continue; }
      if (!a.startsWith("-")) pos.push(a);
    }
    // KUBECONFIG 환경변수로 고른 클러스터는 인자에 안 보인다 → 안 담음
    if (!cluster || (env.KUBECONFIG && !args.includes("--kubeconfig"))) return null;
    if (pos[0] === "get") { if (!pos[1]) return null; }
    else if (pos[0] !== "api-resources") return null;
  } else if (cmd === "gcloud") {
    const words: string[] = [];
    for (const a of args) { if (a.startsWith("-")) break; words.push(a); }
    if (!words.some((w) => GCLOUD_READ.has(w))) return null;
    out = [...args];
  } else return null;
  return out.some((a) => DENY.test(a)) ? null : out;
}

interface Entry { at: number; stdout: string; stderr: string; bytes: number }
// DRAFT(ai): 기록 전체 64MB 상한 (넘으면 오래된 것부터 버림), 출력 하나가 16MB 를 넘으면 안 담음. 워커 메모리 요청(수백 MB) 기준
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const store = new Map<string, Entry>();
let storeBytes = 0;
const drop = (k: string) => { const e = store.get(k); if (e) { storeBytes -= e.bytes; store.delete(k); } };

/** 시험용: 기록을 비운다 */
export function clearImportCache(): void { store.clear(); storeBytes = 0; }
/** 시험·점검용: 지금 담긴 기록 수 */
export const importCacheSize = () => store.size;

const keyOf = (s: ImportCacheScope, cmd: string, args: string[]) =>
  createHash("sha256").update(JSON.stringify([s.tenantId, s.envId, s.role, cmd, args])).digest("hex");

/** 가져오기용 exec: 읽기 명령은 TTL 안이면 기록을 돌려주고, 아니면 불러서 성공 출력을 담는다. ttlSec 0 이면 그대로 */
export function importCacheExec(base: Exec = spawnExec, o: ImportCacheOpts): Exec {
  if (!(o.ttlSec > 0)) return base;
  const ttlMs = o.ttlSec * 1000, now = o.now ?? Date.now, st = o.stats;
  return async (cmd, args, opts) => {
    const norm = importCacheArgs(cmd, args, opts.env);
    if (!norm) { if (st) st.bypass++; return base(cmd, args, opts); }
    const key = keyOf(o.scope, cmd, norm), t = now();
    const e = store.get(key);
    if (e && t - e.at < ttlMs) {
      if (st) { st.hits++; st.maxAgeSec = Math.max(st.maxAgeSec, Math.floor((t - e.at) / 1000)); }
      return { code: 0, stdout: e.stdout, stderr: e.stderr, ms: 0 };
    }
    if (e) drop(key);
    if (st) st.misses++;
    const r = await base(cmd, args, opts);
    if (r.code !== 0) return r;
    const bytes = Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr);
    if (bytes > MAX_ENTRY_BYTES) return r;
    const at = now();
    // 오래된 것부터: 넣은 순서 = 시각 순서 (같은 키는 지우고 다시 넣음)
    for (const [k, v] of store) { if (at - v.at >= ttlMs || storeBytes + bytes > MAX_BYTES) drop(k); else break; }
    store.set(key, { at, stdout: r.stdout, stderr: r.stderr, bytes });
    storeBytes += bytes;
    return r;
  };
}

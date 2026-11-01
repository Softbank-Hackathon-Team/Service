import { execFile } from "node:child_process";

// Z91: 클라우드·k8s 읽기 명령 실행기. 맥에 이미 있는 aws·gcloud·kubectl 과 그 자격(AWS_PROFILE, gcloud auth, kubeconfig)을 그대로 쓴다.
//   → 이 프로세스는 키를 받지 않고, 새 npm 의존성(SDK)도 없다. terraform 실행기(adapters real-runner.ts)와 같은 방식
// 안전장치: 읽기 동작만 허용 목록으로 통과. 쓰기 명령은 실행 전에 ReadOnlyViolation 으로 막는다 (코드 실수로 자원을 바꾸지 않게)
// 버린 것: AWS SDK v3·Google 클라이언트 라이브러리 → npm 의존성 추가 금지(결선 직전) + 자격 체계를 하나 더 만들게 됨

export interface ExecResult { code: number; stdout: string; stderr: string; missing?: boolean; timedOut?: boolean }
export type ExecRunner = (cmd: string, args: string[]) => Promise<ExecResult>;

export class ReadOnlyViolation extends Error {
  constructor(readonly cmd: string, readonly args: string[]) { super(`읽기 전용 점검에서 허용 안 된 명령: ${cmd} ${args.slice(0, 3).join(" ")}`); }
}

// Z38b 리뷰 반영(11/01 00:06Z): "describe|get|list 로 시작하면 통과" 는 빈틈이 있었다
//   (aws secretsmanager get-secret-value, ssm get-parameter --with-decryption, ecr get-login-password, kubectl get secrets,
//    kubectl --token x get delete pod). → 이 점검이 실제로 부르는 명령만 정확히 적은 허용 목록으로 바꿈. 목록 밖은 전부 거부
export const AWS_ALLOWED = new Set([
  "sts get-caller-identity",
  "rds describe-db-instances", "rds describe-db-parameters",
  "ec2 describe-security-groups",
  "eks describe-cluster",
  "iam get-role", "iam list-attached-role-policies", "iam list-role-policies", "iam get-role-policy",
]);
// 값 없이 쓰는 aws 옵션은 없음. 값 받는 옵션만 허용 (--profile·--endpoint-url 같은 것은 거부: 자격·대상 바꾸기)
const AWS_FLAGS = new Set(["--region", "--output", "--query", "--group-ids", "--name", "--role-name", "--policy-name", "--db-parameter-group-name"]);
export const GCLOUD_ALLOWED = [
  ["projects", "get-iam-policy"], ["sql", "instances", "describe"], ["container", "clusters", "describe"], ["compute", "firewall-rules", "list"],
];
const GCLOUD_FLAGS = /^--(project|region|format)(=.*)?$/;
export const KUBECTL_RESOURCES = new Set(["services", "ingresses", "pods", "configmaps", "rolebindings", "clusterrolebindings", "clusters.postgresql.cnpg.io"]);

const bad = (cmd: string, args: string[]): never => { throw new ReadOnlyViolation(cmd, args); };
// 옵션 목록 검사: 허용 옵션 뒤 값 하나씩(또는 --a=b). 위치 인자는 positional 개수만큼만
function flagsOnly(cmd: string, args: string[], rest: string[], allowed: (f: string) => boolean, valued: (f: string) => boolean, maxValuesAfter = 1) {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const name = a.split("=")[0]!;
    if (!a.startsWith("-") || !allowed(name)) bad(cmd, args);
    if (!a.includes("=") && valued(name)) {
      // --group-ids 는 값 여러 개 (sg-…)
      let n = 0;
      while (i + 1 < rest.length && !rest[i + 1]!.startsWith("-") && n < (name === "--group-ids" ? 20 : maxValuesAfter)) { i++; n++; }
      if (n === 0) bad(cmd, args);
    }
  }
}

export function assertReadOnly(cmd: string, args: string[]): void {
  if (args.some((a) => typeof a !== "string")) bad(cmd, args);
  if (cmd === "aws") {
    if (!AWS_ALLOWED.has(`${args[0]} ${args[1]}`)) bad(cmd, args);
    flagsOnly(cmd, args, args.slice(2), (f) => AWS_FLAGS.has(f), () => true);
    return;
  }
  if (cmd === "gcloud") {
    const g = GCLOUD_ALLOWED.find((p) => p.every((w, i) => args[i] === w));
    if (!g) return bad(cmd, args);
    let rest = args.slice(g.length);
    // describe·get-iam-policy 는 이름 하나를 받는다
    if (g.at(-1) !== "list") { if (!rest[0] || rest[0].startsWith("-")) bad(cmd, args); rest = rest.slice(1); }
    flagsOnly(cmd, args, rest, (f) => GCLOUD_FLAGS.test(f), () => true);
    return;
  }
  if (cmd === "kubectl") {
    // 모양 고정: --context <이름> get <자원> [-n <ns>] -o json  (--token·--server·--raw·secrets·쓰기 낱말은 전부 거부)
    if (args[0] !== "--context" || !args[1] || args[1].startsWith("-") || args[2] !== "get" || !KUBECTL_RESOURCES.has(args[3] ?? "")) bad(cmd, args);
    const rest = args.slice(4);
    for (let i = 0; i < rest.length; i += 2) {
      const f = rest[i], v = rest[i + 1];
      if (f === "-n" && v && !v.startsWith("-")) continue;
      if (f === "-o" && v === "json") continue;
      bad(cmd, args);
    }
    return;
  }
  bad(cmd, args);
}

export interface ExecOptions { timeoutMs?: number; env?: NodeJS.ProcessEnv }
export function createExecRunner(o: ExecOptions = {}): ExecRunner {
  const timeout = o.timeoutMs ?? 20_000;
  return (cmd, args) => {
    assertReadOnly(cmd, args);
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: o.env ?? process.env, windowsHide: true },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
          if (e && e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: `${cmd} 없음`, missing: true });
          if (e && e.killed) return resolve({ code: 124, stdout: String(stdout), stderr: "시간 초과", timedOut: true });
          resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
        });
    });
  };
}

// JSON 출력 하나 읽기. 실패면 이유 한 줄 (stderr 첫 줄, 계정 번호 가림, 200자)
export type Json = Record<string, unknown>;
export async function readJson(run: ExecRunner, cmd: string, args: string[]): Promise<{ ok: true; json: unknown } | { ok: false; why: string; missing?: boolean }> {
  let r: ExecResult;
  try { r = await run(cmd, args); }
  catch (e) { if (e instanceof ReadOnlyViolation) throw e; return { ok: false, why: `실행 실패: ${(e as Error).message}`.slice(0, 200) }; }
  if (r.missing) return { ok: false, why: `${cmd} CLI 없음`, missing: true };
  if (r.timedOut) return { ok: false, why: `${cmd} 시간 초과` };
  if (r.code !== 0) return { ok: false, why: firstLine(r.stderr) || `${cmd} 종료 코드 ${r.code}` };
  try { return { ok: true, json: JSON.parse(r.stdout || "null") }; }
  catch { return { ok: false, why: `${cmd} 출력이 JSON 이 아님` }; }
}
export const firstLine = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).find((x) => x.length > 0)?.replace(/\b\d{12}\b/g, "<계정>").slice(0, 200) ?? "";

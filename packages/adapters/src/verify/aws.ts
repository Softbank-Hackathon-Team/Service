import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsRoleName } from "@svc/contracts";
import { arr, classifyCliError, CliError, get, runJson, runText, str, type CliDeps } from "../common/cli.js";

// L4: 연결 확인(verify-connection) — 빌린 관찰 역할 자격으로 고객 AWS 를 실제로 읽어 본다 (설계 IA 6.1 4단계).
//   CLI 호출은 어댑터에 모은다 (discover/precheck 와 같은 common/cli.ts runJson·runText). 셸 없음, 쓰기 명령 없음.
//   예외: kubeconfig 를 임시 파일에 만드는 명령 (discover 와 같음. 클라우드 쪽은 안 바뀌고 끝나면 지움)
// 순서대로 하나라도 실패하면 거기서 끝. 사유는 ConnectionFailure 또는 "PERMISSION_MISSING:<서비스:동작>"

// roleSuffix = environments.aws_role_suffix (한 계정에 환경 여럿, 0056). 없으면 옛 이름 svc-operate
export interface VerifyAwsInput { region: string; clusterName: string; cliEnv: Record<string, string>; roleSuffix?: string | null }
export type VerifyAwsResult = { ok: true; clusters: string[]; missingPermissions?: string[] } | { ok: false; reason: string };

// PF02: EKS 클러스터 이름 모양 (AWS 규칙). 사용자 입력이 CLI 인자로 들어가므로 "--" 로 시작하는 값 등을 막는다
export const EKS_CLUSTER_NAME_RE = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;

// 워커 자기 자격이 섞이지 않게 지우는 이름 (프로필·장기 키·세션). 빌린 자격(cliEnv)만 쓰게 한다
const OWN_CRED_KEYS = ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"] as const;

/** 워커 환경에서 자기 자격을 지우고 빌린 자격을 덮은 환경 (HOME·PATH·CLOUD_READ_TIMEOUT_MS 등은 남김). L5 가 재사용 */
export function envFor(cliEnv: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of OWN_CRED_KEYS) delete env[k];
  return { ...env, ...cliEnv };
}

// DRAFT(ai): 고객 쪽 실행 역할 이름 바탕. platform.ts resolveEnv 의 svc-<purpose> 규칙·L3 온보딩 템플릿 역할 이름과 같음 (+ 환경 꼬리, awsRoleName)
export const OPERATE_ROLE_NAME = "svc-operate";

// kubectl 이 인증 실패(401)일 때 찍는 글. EKS 는 접근 항목이 없거나 옛 IAM 역할(같은 이름으로 다시 만들기 전)에 묶이면 이렇게 된다
const K8S_UNAUTHORIZED_RE = /Unauthorized|You must be logged in to the server/;

class Stop extends Error { constructor(readonly reason: string) { super(reason); } }

/** CLI 실패 → 사유. 명령 없음(127)·시간 초과·알 수 없는 오류는 그대로 던짐 (작업 재시도 대상) */
export function reasonOf(e: unknown, action: string): string {
  if (!(e instanceof CliError) || e.missing) throw e;
  const s = e.stderr;
  if (/service control policy/i.test(s)) return "ORG_POLICY_BLOCKED";
  if (/\((AccessDenied|AccessDeniedException|UnauthorizedOperation|UnauthorizedException)\)/.test(s)) return `PERMISSION_MISSING:${action}`;
  if (/\(NoSuchEntity\)/.test(s)) return "ROLE_NOT_FOUND";
  throw e;
}

/** iam get-role 의 신뢰 정책(URL 인코딩일 수 있음)에 sts:ExternalId 조건이 있는가 (security/src/trust.ts parseTrustDoc 와 같은 풀기) */
export function trustHasExternalId(doc: unknown): boolean {
  let parsed: unknown;
  try {
    parsed = typeof doc === "string" ? JSON.parse(doc.trimStart().startsWith("%") ? decodeURIComponent(doc) : doc) : doc;
  } catch { return false; }
  const st = get(parsed, "Statement");
  const stmts = Array.isArray(st) ? st : st ? [st] : [];
  return stmts.some((s) => get(s, "Effect") === "Allow" &&
    Object.values((get(s, "Condition") ?? {}) as Record<string, unknown>).some((c) =>
      c && typeof c === "object" && Object.keys(c).some((k) => k.toLowerCase() === "sts:externalid")));
}

async function withTempKube<T>(f: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "svc-verify-"));
  try { return await f(join(dir, "kubeconfig")); } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function verifyAwsObserve(d: CliDeps, i: VerifyAwsInput): Promise<VerifyAwsResult> {
  const dd: CliDeps = { ...d, env: envFor(i.cliEnv, d.env ?? process.env) };
  const r = ["--region", i.region, "--output", "json"];
  const step = async <T>(action: string, f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) { throw new Stop(reasonOf(e, action)); }
  };
  if (!EKS_CLUSTER_NAME_RE.test(i.clusterName)) return { ok: false, reason: "K8S_ACCESS_MISSING" };
  try {
    // 1. 클러스터 목록. DRAFT(ai): 이름 틀림도 "쿠버네티스를 못 봄"으로 묶는다 (K8S_ACCESS_MISSING)
    const clusters = arr(get(await step("eks:ListClusters", () => runJson(dd, "aws", ["eks", "list-clusters", ...r])), "clusters"))
      .map((x) => str(x)).filter((x): x is string => !!x);
    if (!clusters.includes(i.clusterName)) return { ok: false, reason: "K8S_ACCESS_MISSING" };
    // 2~5. 꼭 필요한 읽기 API
    await step("eks:DescribeCluster", () => runJson(dd, "aws", ["eks", "describe-cluster", "--name", i.clusterName, ...r]));
    await step("rds:DescribeDBInstances", () => runJson(dd, "aws", ["rds", "describe-db-instances", "--max-items", "5", ...r]));
    // 실행 역할은 빌리지 않는다 (broker 가 실행 역할에 이전 번호·단계를 요구). 있는지 + ExternalId 조건만 본다 (설계 IA 6.1 4단계와 다름)
    const role = await step("iam:GetRole", () => runJson(dd, "aws", ["iam", "get-role", "--role-name", awsRoleName(OPERATE_ROLE_NAME, i.roleSuffix), "--output", "json"]));
    // DRAFT(ai): 실행 역할 신뢰 정책에 ExternalId 조건이 없으면 권한 부족으로 본다 (혼동된 대리인 방어 빠짐)
    if (!trustHasExternalId(get(role, "Role", "AssumeRolePolicyDocument"))) return { ok: false, reason: "PERMISSION_MISSING:sts:ExternalId" };
    // PF02 FM-CLD-02: GuardDuty 읽기는 보안 현황용 선택 권한. 조직 SCP 가 막거나 빠져도 연결 자체는 막지 않고 사람이 할 일로 남긴다
    //   (예전: 하나 빠지면 PERMISSION_MISSING 으로 연결 전체가 실패 → 고객이 영영 연결 못 함). GCP probeOptional 과 같은 모양
    const missingPermissions: string[] = [];
    try { await runJson(dd, "aws", ["guardduty", "list-detectors", ...r]); }
    catch (e) {
      const why = reasonOf(e, "guardduty:ListDetectors");
      if (why.startsWith("PERMISSION_MISSING:") || why === "ORG_POLICY_BLOCKED") missingPermissions.push("guardduty:ListDetectors");
      else throw new Stop(why);
    }
    // 6. 쿠버네티스: 임시 kubeconfig (같은 빌린 자격, --profile 없음) → can-i
    const can = await withTempKube(async (kc) => {
      await step("eks:DescribeCluster", () => runText(dd, "aws", ["eks", "update-kubeconfig", "--name", i.clusterName, "--kubeconfig", kc, "--region", i.region]));
      const kube = async (args: string[]): Promise<string> => {
        try { return (await runText(dd, "kubectl", ["--kubeconfig", kc, ...args])).trim(); }
        catch (e) {
          // FM-CON-09 (실측): 인증 자체가 안 되면(401) 접근 항목이 없거나 옛 역할에 묶인 것 → 따로 표시해 사람이 고칠 곳을 알게
          if (e instanceof CliError && !e.missing && K8S_UNAUTHORIZED_RE.test(e.stderr)) return "unauthorized";
          // PF03 FM-NET: 네트워크 끊김·시간 초과(API 서버에 못 붙음)까지 "no" 로 보면 K8S_ACCESS_MISSING 으로 거짓 실패 → 일시 오류는 던져 재시도
          if (e instanceof CliError && !e.missing && classifyCliError(e) !== "transient") return "no";   // can-i 는 "no" 일 때 exit 1
          throw e;
        }
      };
      const c = await kube(["auth", "can-i", "list", "deployments", "--all-namespaces"]);
      if (c !== "yes") return c;
      // FM-CON-09 (실측): can-i 가 yes 여도 관찰 역할로 실제 목록을 한 번 읽는다 (verify connected 인데 맥에서 svc-observe kubectl 401 이었음).
      //   읽기 결과는 버리고 성공만 본다 (이름은 기록 안 함)
      const ns = await kube(["get", "namespaces", "-o", "name", "--request-timeout=15s"]);
      return ns === "unauthorized" || ns === "no" ? ns : "yes";
    });
    if (can === "unauthorized") return { ok: false, reason: "K8S_ACCESS_MISSING:UNAUTHORIZED" };
    if (can !== "yes") return { ok: false, reason: "K8S_ACCESS_MISSING" };
    return { ok: true, clusters, ...(missingPermissions.length ? { missingPermissions } : {}) };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: e.reason };
    throw e;
  }
}

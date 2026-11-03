import { arr, CliError, get, runJson, str, type CliDeps } from "../common/cli.js";

// L7i: GCP 연결 확인 — 빌린 관찰 SA 의 토큰으로 고객 프로젝트를 실제로 읽어 본다 (설계 IA 6.2).
//   CLI 호출은 어댑터에 모은다 (verify/aws.ts 와 같은 common/cli.ts). 셸 없음, 쓰기 명령 없음
//   순서대로 하나라도 실패하면 거기서 끝:
//     1) 프로젝트 번호 일치  gcloud projects describe        (resourcemanager.projects.get)
//     2) container.clusters.list   3) sql.instances.list   4) iam.serviceAccounts.get (svc-operate 가 있나)
//   사유는 ConnectionFailure 또는 "PERMISSION_MISSING:<권한>"
// STUB: 쿠버네티스 can-i(gke-gcloud-auth-plugin·kubeconfig) 는 안 한다. 계획의 읽기 3개 + 프로젝트 번호까지만

export interface VerifyGcpInput {
  projectId: string;
  /** 처음 확인 때 고정한 프로젝트 번호. 없으면(첫 확인) 지금 값을 돌려줘 고정하게 한다 */
  expectedProjectNumber?: string | null;
  clusterName?: string | null;
  token: string;
}
export type VerifyGcpResult =
  | { ok: true; clusters: string[]; projectNumber: string }
  | { ok: false; reason: string };

// 워커 자기 gcloud 자격이 섞이지 않게 지우는 이름. 빌린 토큰만 쓰게 한다
const OWN_CRED_KEYS = ["CLOUDSDK_CORE_ACCOUNT", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", "CLOUDSDK_AUTH_ACCESS_TOKEN"] as const;
export function gcpEnvFor(token: string, projectId: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of OWN_CRED_KEYS) delete env[k];
  return { ...env, CLOUDSDK_AUTH_ACCESS_TOKEN: token, CLOUDSDK_CORE_PROJECT: projectId };
}

class Stop extends Error { constructor(readonly reason: string) { super(reason); } }

/** CLI 실패 → 사유. 명령 없음(127)·시간 초과·알 수 없는 오류는 그대로 던짐 (작업 재시도 대상) */
export function gcpReasonOf(e: unknown, permission: string, notFoundReason?: string): string {
  if (!(e instanceof CliError) || e.missing) throw e;
  const s = e.stderr;
  if (/organization policy|constraints\/|VPC Service Controls|VPC_SERVICE_CONTROLS/i.test(s)) return "ORG_POLICY_BLOCKED";
  if (/PERMISSION_DENIED|does not have permission|\b403\b|forbidden/i.test(s)) return `PERMISSION_MISSING:${permission}`;
  if (notFoundReason && /NOT_FOUND|\b404\b|not found|does not exist/i.test(s)) return notFoundReason;
  throw e;
}

export async function verifyGcpObserve(d: CliDeps, i: VerifyGcpInput): Promise<VerifyGcpResult> {
  const dd: CliDeps = { ...d, env: gcpEnvFor(i.token, i.projectId, d.env ?? process.env) };
  const p = ["--project", i.projectId, "--format", "json", "--quiet"];
  const step = async <T>(permission: string, f: () => Promise<T>, notFound?: string): Promise<T> => {
    try { return await f(); } catch (e) { throw new Stop(gcpReasonOf(e, permission, notFound)); }
  };
  try {
    const proj = await step("resourcemanager.projects.get", () => runJson(dd, "gcloud", ["projects", "describe", i.projectId, "--format", "json", "--quiet"]));
    const number = str(get(proj, "projectNumber"));
    // VL7i: environments.gcp_project_number CHECK(^[0-9]{6,20}$) 와 같은 모양만 인정. 아니면 UPDATE 가 CHECK 위반으로 트랜잭션째 죽어 재시도만 돈다
    if (!number || !/^[0-9]{6,20}$/.test(number) || get(proj, "projectId") !== i.projectId) return { ok: false, reason: "ACCOUNT_MISMATCH" };
    if (i.expectedProjectNumber && i.expectedProjectNumber !== number) return { ok: false, reason: "ACCOUNT_MISMATCH" };
    const clusters = arr(await step("container.clusters.list", () => runJson(dd, "gcloud", ["container", "clusters", "list", ...p])))
      .map((c) => str(c.name)).filter((x): x is string => !!x);
    // DRAFT(ai): 환경에 클러스터 이름이 있는데 목록에 없으면 "쿠버네티스를 못 봄" (AWS 와 같은 규칙)
    if (i.clusterName && !clusters.includes(i.clusterName)) return { ok: false, reason: "K8S_ACCESS_MISSING" };
    await step("sql.instances.list", () => runJson(dd, "gcloud", ["sql", "instances", "list", ...p]));
    // 실행 SA 는 빌리지 않는다. 있는지만 본다 (AWS 의 iam get-role 과 같은 자리). 없으면 ROLE_NOT_FOUND
    await step("iam.serviceAccounts.get", () => runJson(dd, "gcloud",
      ["iam", "service-accounts", "describe", `svc-operate@${i.projectId}.iam.gserviceaccount.com`, ...p]), "ROLE_NOT_FOUND");
    return { ok: true, clusters, projectNumber: number };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: e.reason };
    throw e;
  }
}

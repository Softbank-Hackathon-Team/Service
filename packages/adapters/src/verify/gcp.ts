import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arr, CliError, get, runJson, runText, str, type CliDeps } from "../common/cli.js";
import { GCP_COMMAND_PERMISSIONS } from "../common/observe-permissions.js";

// L7i: GCP 연결 확인 — 빌린 관찰 SA 의 토큰으로 고객 프로젝트를 실제로 읽어 본다 (설계 IA 6.2).
//   CLI 호출은 어댑터에 모은다 (verify/aws.ts 와 같은 common/cli.ts). 셸 없음, 쓰기 명령 없음
//   순서대로 하나라도 실패하면 거기서 끝:
//     1) 프로젝트 번호 일치  gcloud projects describe        (resourcemanager.projects.get)
//     2) container.clusters.list   3) cloudsql.instances.list   4) iam.serviceAccounts.get (svc-operate 가 있나)
//   사유는 ConnectionFailure 또는 "PERMISSION_MISSING:<권한>"
//   5) 클러스터 이름이 있으면 쿠버네티스 can-i: 임시 KUBECONFIG 에 get-credentials(같은 빌린 토큰, gke-gcloud-auth-plugin 이 CLOUDSDK_AUTH_ACCESS_TOKEN 을 씀)
//      → kubectl auth can-i list deployments -A (SelfSubjectAccessReview, 모든 로그인 사용자에게 열림). AWS verify 와 같은 규칙
//      관찰 SA 의 쿠버네티스 읽기는 GKE IAM 권한(gcp-connect.sh GKE-READ: container.deployments.list 등)으로 준다

export interface VerifyGcpInput {
  projectId: string;
  /** 처음 확인 때 고정한 프로젝트 번호. 없으면(첫 확인) 지금 값을 돌려줘 고정하게 한다 */
  expectedProjectNumber?: string | null;
  clusterName?: string | null;
  token: string;
  /** 결정 3번 A안: 이전 전용 프로젝트. 있으면 번호 고정·svc-operate 존재 확인을 이 프로젝트에서 하고, 클러스터는 원래 → 전용 순으로 찾는다 */
  targetProjectId?: string | null;
  expectedTargetProjectNumber?: string | null;
  /** OBSROLE3: true 면 필수 읽기 4개 뒤에 "선택 권한"(가져오기용 데이터·둘레 자원 읽기)을 하나씩 찔러 본다. 기본 false = 지금 그대로 */
  probeOptional?: boolean;
}
export type VerifyGcpResult =
  | { ok: true; clusters: string[]; projectNumber: string; targetProjectNumber?: string; missingPermissions?: string[] }
  | { ok: false; reason: string };

// 워커 자기 gcloud 자격이 섞이지 않게 지우는 이름. 빌린 토큰만 쓰게 한다
const OWN_CRED_KEYS = ["CLOUDSDK_CORE_ACCOUNT", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", "CLOUDSDK_AUTH_ACCESS_TOKEN"] as const;
export function gcpEnvFor(token: string, projectId: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of OWN_CRED_KEYS) delete env[k];
  return { ...env, CLOUDSDK_AUTH_ACCESS_TOKEN: token, CLOUDSDK_CORE_PROJECT: projectId };
}

// OBSROLE3: 연결 확인을 막지는 않지만 가져오기·점검이 쓰는 읽기 권한. 관찰 역할을 예전 스크립트로 만든 고객은 여기가 비어 있다.
//   명령 하나 = 권한 하나 이상 (표 원본 = common/observe-permissions.ts GCP_COMMAND_PERMISSIONS). 목록 1건만 가져오고(--limit=1) 값은 안 읽는다.
//   권한 이름을 직접 확인할 방법이 없는 것(storage.buckets.getIamPolicy·compute.regions.get·iam.serviceAccounts.list)은 찌르지 않는다 — 같은 역할의 다른 권한이 없을 때 같이 드러남
export const OPTIONAL_PROBES: ReadonlyArray<{ key: string; args: string[] }> = [
  { key: "projects get-iam-policy", args: ["projects", "get-iam-policy", "{project}"] },
  { key: "services list", args: ["services", "list", "--enabled", "--limit=1"] },
  { key: "compute networks list", args: ["compute", "networks", "list", "--limit=1"] },
  { key: "compute forwarding-rules list", args: ["compute", "forwarding-rules", "list", "--limit=1"] },
  { key: "compute firewall-rules list", args: ["compute", "firewall-rules", "list", "--limit=1"] },
  { key: "compute instances list", args: ["compute", "instances", "list", "--limit=1"] },   // VMIMPORT
  { key: "artifacts repositories list", args: ["artifacts", "repositories", "list", "--limit=1"] },
  { key: "secrets list", args: ["secrets", "list", "--limit=1"] },
  { key: "storage buckets list", args: ["storage", "buckets", "list", "--limit=1"] },
  { key: "pubsub topics list", args: ["pubsub", "topics", "list", "--limit=1"] },
  { key: "pubsub subscriptions list", args: ["pubsub", "subscriptions", "list", "--limit=1"] },
  { key: "redis instances list", args: ["redis", "instances", "list", "--region=-", "--limit=1"] },
  // CRIMPORT: Cloud Run 출발 읽기. 이름·지역이 있어야 부를 수 있는 것(run.revisions.get·run.services.getIamPolicy·run.domainmappings.list·cloudscheduler.jobs.list)은 찌르지 않는다
  { key: "run services list", args: ["run", "services", "list", "--limit=1"] },
  { key: "run jobs list", args: ["run", "jobs", "list", "--limit=1"] },
];
// 권한이 없어서 거절된 것만 센다. API 가 꺼져 있는 프로젝트(SERVICE_DISABLED)·조직 정책·네트워크 오류는 권한 문제가 아니므로 세지 않는다
const API_OFF = /SERVICE_DISABLED|has not been used|is disabled|accessNotConfigured|API .* not enabled/i;
const DENIED = /PERMISSION_DENIED|does not have permission|\b403\b|forbidden/i;
async function probeOptional(dd: CliDeps, projectId: string, p: string[]): Promise<string[]> {
  const missing = new Set<string>();
  for (const pr of OPTIONAL_PROBES) {
    try { await runJson(dd, "gcloud", [...pr.args.map((a) => (a === "{project}" ? projectId : a)), ...p]); }
    catch (e) {
      if (!(e instanceof CliError) || e.missing) continue;
      if (DENIED.test(e.stderr) && !API_OFF.test(e.stderr) && !/organization policy|constraints\/|VPC_SERVICE_CONTROLS/i.test(e.stderr))
        for (const perm of GCP_COMMAND_PERMISSIONS[pr.key] ?? []) missing.add(perm);
    }
  }
  return [...missing].sort();
}

async function withTempKube<T>(f: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "svc-verify-gcp-"));
  try { return await f(join(dir, "kubeconfig")); } finally { await rm(dir, { recursive: true, force: true }); }
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
    // 결정 3번 A안: 전용 프로젝트도 같은 규칙으로 번호를 고정한다 (관찰 SA 는 전용 프로젝트에도 읽기 역할을 받는다 — gcp-connect.sh)
    const tp = i.targetProjectId && i.targetProjectId !== i.projectId ? i.targetProjectId : null;
    let targetNumber: string | undefined;
    if (tp) {
      const tproj = await step("resourcemanager.projects.get", () => runJson(dd, "gcloud", ["projects", "describe", tp, "--format", "json", "--quiet"]));
      targetNumber = str(get(tproj, "projectNumber")) ?? undefined;
      if (!targetNumber || !/^[0-9]{6,20}$/.test(targetNumber) || get(tproj, "projectId") !== tp) return { ok: false, reason: "ACCOUNT_MISMATCH" };
      if (i.expectedTargetProjectNumber && i.expectedTargetProjectNumber !== targetNumber) return { ok: false, reason: "ACCOUNT_MISMATCH" };
    }
    const tpArgs = tp ? ["--project", tp, "--format", "json", "--quiet"] : p;
    const clusterRows = arr(await step("container.clusters.list", () => runJson(dd, "gcloud", ["container", "clusters", "list", ...p])));
    let clusterProject = i.projectId;
    // DRAFT(ai): 원래 프로젝트에 이름이 없으면 전용 프로젝트에서 찾는다 (A안 도착 GKE 는 전용 프로젝트에 있음)
    if (tp && i.clusterName && !clusterRows.some((c) => c.name === i.clusterName)) {
      const more = arr(await step("container.clusters.list", () => runJson(dd, "gcloud", ["container", "clusters", "list", ...tpArgs])));
      if (more.some((c) => c.name === i.clusterName)) { clusterRows.push(...more); clusterProject = tp; }
    }
    const clusters = clusterRows.map((c) => str(c.name)).filter((x): x is string => !!x);
    // DRAFT(ai): 환경에 클러스터 이름이 있는데 목록에 없으면 "쿠버네티스를 못 봄" (AWS 와 같은 규칙)
    if (i.clusterName && !clusters.includes(i.clusterName)) return { ok: false, reason: "K8S_ACCESS_MISSING" };
    // 5) 쿠버네티스 can-i (클러스터 이름이 있을 때만. 없으면 가져오기가 GKE 없이 Cloud Run·VM 만 볼 수 있음)
    if (i.clusterName) {
      const loc = str(get(clusterRows.find((c) => c.name === i.clusterName), "location")) ?? str(get(clusterRows.find((c) => c.name === i.clusterName), "zone"));
      if (!loc) return { ok: false, reason: "K8S_ACCESS_MISSING" };
      const can = await withTempKube(async (kc) => {
        await step("container.clusters.get", () => runText(dd, "gcloud", ["container", "clusters", "get-credentials", i.clusterName!, "--location", loc, "--project", clusterProject, "--quiet"], { KUBECONFIG: kc }));
        try { return (await runText(dd, "kubectl", ["--kubeconfig", kc, "auth", "can-i", "list", "deployments", "--all-namespaces"])).trim(); }
        catch (e) {
          if (e instanceof CliError && !e.missing) return "no";   // can-i 는 "no" 일 때 exit 1
          throw e;
        }
      });
      if (can !== "yes") return { ok: false, reason: "K8S_ACCESS_MISSING" };
    }
    await step("cloudsql.instances.list", () => runJson(dd, "gcloud", ["sql", "instances", "list", ...p]));
    // 실행 SA 는 빌리지 않는다. 있는지만 본다 (AWS 의 iam get-role 과 같은 자리). 없으면 ROLE_NOT_FOUND. A안이면 전용 프로젝트의 svc-operate
    const opProject = tp ?? i.projectId;
    await step("iam.serviceAccounts.get", () => runJson(dd, "gcloud",
      ["iam", "service-accounts", "describe", `svc-operate@${opProject}.iam.gserviceaccount.com`, ...tpArgs]), "ROLE_NOT_FOUND");
    if (i.probeOptional) {
      const missingPermissions = await probeOptional(dd, i.projectId, p);
      if (missingPermissions.length) return { ok: true, clusters, projectNumber: number, ...(targetNumber ? { targetProjectNumber: targetNumber } : {}), missingPermissions };
    }
    return { ok: true, clusters, projectNumber: number, ...(targetNumber ? { targetProjectNumber: targetNumber } : {}) };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: e.reason };
    throw e;
  }
}

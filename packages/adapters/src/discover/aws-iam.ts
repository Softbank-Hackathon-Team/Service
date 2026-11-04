import { arr, CliError, classifyCliError, get, runJson, sourceFail, str, type CliDeps } from "../common/cli.js";

// PF-A13 DRAFT(ai): 앱 신원 권한 읽기도 일시 오류(네트워크·스로틀)는 던져서 가져오기를 다시 한다. 예전엔 "못 읽음" 검토 줄이 되어 사람이 확인하면 grants 가 빈 채로 넘어갔다
const rethrowTransient = (e: unknown, label: string) => { if (classifyCliError(e) === "transient") throw sourceFail(e, `${label} (${(e as Error).message.slice(0, 160)})`); };
import type { RawAwsIamPolicy } from "../import/mappers/iam-grants.js";

// I4: 출발 앱 신원의 IAM 정책 읽기 (list·get 만. 바꾸는 명령 없음). 결과 = 원본 항목 aws.iamPolicy (신원 하나 = 역할 하나 = 항목 하나)
//   신원 찾기: ① EKS Pod Identity association (네임스페이스 + ServiceAccount → 역할)  ② IRSA (ServiceAccount 주석 eks.amazonaws.com/role-arn)
//   정책 문서: 붙은 관리형 정책(기본 판 문서) + 인라인 정책 + 권한 경계(PermissionsBoundary, iam get-role → 경계 정책 문서)
// 관찰 역할에 필요한 권한 (infra/onboarding/aws-connect.json ObserveRole 에 이미 있음):
//   eks:ListPodIdentityAssociations, eks:DescribePodIdentityAssociation,
//   iam:ListAttachedRolePolicies, iam:GetPolicy, iam:GetPolicyVersion, iam:ListRolePolicies, iam:GetRolePolicy
//   iam:GetRole (권한 경계 이름)도 표에 이미 있음
// IB-1 DRAFT(ai): 권한 경계는 읽어서 grants 를 경계 안으로 좁힌다 (출발에서 실제로 허용된 범위 그대로).
// TODO(human): 조직 SCP 는 관리 계정(또는 위임 관리자)에서만 읽힌다(organizations:ListPoliciesForTarget·DescribePolicy, 권한 표에 없음).
//   읽을지·어느 계정 역할로 읽을지 정할 때까지 scp = "unread" 로 남겨 기준선에 "못 읽음" 줄이 뜬다

type Obj = Record<string, unknown>;

/** 앱이 쓰는 ServiceAccount 하나. irsaRoleArn 은 k8s 주석에서 */
export interface AppIdentity { namespace: string; serviceAccount: string; irsaRoleArn?: string; /** WI-1: GKE Workload Identity GSA 메일 */ gsa?: string }

const roleNameOf = (arn: string): string => arn.split("/").pop() ?? arn;   // arn:aws:iam::<계정>:role[/path]/<이름>

/** 정책 문서: 객체면 그대로, 글자면 URL 인코딩일 수 있어 풀어 본다 (CLI 는 보통 이미 객체로 준다) */
function docOf(x: unknown): Obj | null {
  if (x && typeof x === "object") return x as Obj;
  if (typeof x !== "string") return null;
  for (const t of [x, (() => { try { return decodeURIComponent(x); } catch { return x; } })()]) {
    try { const j = JSON.parse(t); if (j && typeof j === "object") return j as Obj; } catch { /* 다음 */ }
  }
  return null;
}
const statementsOf = (doc: Obj | null): unknown[] => {
  const s = doc?.Statement;
  return s == null ? [] : Array.isArray(s) ? s : [s];
};

/**
 * @param r       aws 공통 인자 (--region … --output json)
 * @param cluster EKS 클러스터 이름 (Pod Identity association 찾기)
 * @param ids     앱이 쓰는 ServiceAccount 들 (네임스페이스 안 Deployment·CronJob 이 쓰는 것만)
 */
/** ID-5: 못 읽은 신원 → F-1 과 같은 "못 읽음" 항목 (pipeline 이 unread.<resource> 검토 줄로). "권한 없음"과 구별 */
export const iamUnreadItem = (resource: string, reason: string): Obj => ({ kind: "k8s.unread", resource, reason, source: "aws:iam" });

export async function readAwsIam(d: CliDeps, r: string[], cluster: string, ids: AppIdentity[], notes: string[], account?: string | null, unread: Obj[] = []): Promise<RawAwsIamPolicy[]> {
  const wanted = [...new Map(ids.map((i) => [`${i.namespace}/${i.serviceAccount}`, i])).values()]
    .sort((a, b) => `${a.namespace}/${a.serviceAccount}`.localeCompare(`${b.namespace}/${b.serviceAccount}`));
  if (!wanted.length) return [];
  const roles = new Map<string, { roleArn: string; source: "pod-identity" | "irsa"; id: AppIdentity }>();

  // ① Pod Identity: 네임스페이스마다 목록 → association 마다 describe (목록엔 역할 ARN 이 없다)
  for (const ns of [...new Set(wanted.map((w) => w.namespace))]) {
    let list: Obj[] = [];
    try {
      list = arr(get(await runJson(d, "aws", ["eks", "list-pod-identity-associations", "--cluster-name", cluster, "--namespace", ns, ...r]), "associations"));
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
    rethrowTransient(e, "앱 신원 권한(IAM)");
      rethrowTransient(e, "앱 신원 권한(IAM)");
      notes.push(`Pod Identity 목록 못 읽음 (${ns}): ${e.message.slice(0, 160)}`);
      unread.push(iamUnreadItem(`IAM.${ns}`, `Pod Identity 목록: ${e.message.slice(0, 120)}`));
      continue;
    }
    for (const a of list.sort((x, y) => String(x.associationId).localeCompare(String(y.associationId)))) {
      const sa = str(a.serviceAccount), id = wanted.find((w) => w.namespace === ns && w.serviceAccount === sa);
      if (!id || !str(a.associationId)) continue;
      try {
        const desc = get(await runJson(d, "aws", ["eks", "describe-pod-identity-association", "--cluster-name", cluster,
          "--association-id", String(a.associationId), ...r]), "association");
        const roleArn = str(get(desc, "roleArn"));
        if (roleArn) roles.set(`${ns}/${sa}`, { roleArn, source: "pod-identity", id });
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
    rethrowTransient(e, "앱 신원 권한(IAM)");
      rethrowTransient(e, "앱 신원 권한(IAM)");
        notes.push(`Pod Identity ${ns}/${sa} 못 읽음: ${e.message.slice(0, 160)}`);
        unread.push(iamUnreadItem(`IAM.${ns}/${sa}`, `Pod Identity: ${e.message.slice(0, 120)}`));
      }
    }
  }
  // ② IRSA: Pod Identity 가 없는 신원만 (둘 다 있으면 EKS 가 Pod Identity 를 먼저 쓴다 【추정: AWS 문서 credential chain 순서】)
  for (const w of wanted) if (w.irsaRoleArn && !roles.has(`${w.namespace}/${w.serviceAccount}`))
    roles.set(`${w.namespace}/${w.serviceAccount}`, { roleArn: w.irsaRoleArn, source: "irsa", id: w });

  const out: RawAwsIamPolicy[] = [];
  for (const [, x] of [...roles].sort((a, b) => a[0].localeCompare(b[0]))) {
    const got = await readRolePolicies(d, x.roleArn, notes, account);
    if (!got) { unread.push(iamUnreadItem(`IAM.${x.id.namespace}/${x.id.serviceAccount}`, "역할 정책을 못 읽음 (notes 참고)")); continue; }
    out.push({ kind: "aws.iamPolicy", roleName: got.roleName, serviceAccount: x.id.serviceAccount, namespace: x.id.namespace, source: x.source, policies: got.policies, statements: got.statements,
      ...(got.boundary ? { boundary: got.boundary } : {}), ...(got.boundaryUnread ? { boundaryUnread: true } : {}), scp: "unread" });
  }
  return out;
}

/** RF-3: ECS 작업 역할(taskRoleArn)의 정책. 예전엔 EKS 신원만 읽어 ECS 앱은 grants 근거가 없었다.
 *  ECS 매퍼는 serviceAccount = 역할 이름이라 같은 이름으로 붙인다 (source "ecs-task", 네임스페이스 없음) */
export async function readEcsTaskIam(d: CliDeps, ecsItems: Obj[], notes: string[], account?: string | null): Promise<RawAwsIamPolicy[]> {
  const arns = [...new Set(ecsItems.filter((i) => i.kind === "ecs.service").map((i) => str(get(i, "taskDefinition", "taskRoleArn"))).filter((a): a is string => !!a))].sort();
  const out: RawAwsIamPolicy[] = [];
  for (const arn of arns) {
    const got = await readRolePolicies(d, arn, notes, account);
    if (got) out.push({ kind: "aws.iamPolicy", roleName: got.roleName, serviceAccount: got.roleName, source: "ecs-task", policies: got.policies, statements: got.statements });
  }
  return out;
}

/** 역할 하나의 관리형·인라인 정책 문장. 다른 계정 역할·못 읽음이면 null + notes */
async function readRolePolicies(d: CliDeps, roleArn: string, notes: string[], account?: string | null): Promise<{ roleName: string; policies: string[]; statements: unknown[]; boundary?: { arn: string; statements: unknown[] }; boundaryUnread?: true } | null> {
  const roleName = roleNameOf(roleArn);
  // RF-3: 역할 ARN 의 계정이 읽는 계정과 다르면 이름만으로 읽지 않는다 (우리 계정의 같은 이름 역할 정책을 읽게 됨) → 근거 없음 + 이유
  const roleAccount = /^arn:aws[a-z-]*:iam::(\d{12}):role\//.exec(roleArn)?.[1];
  if (account && roleAccount && roleAccount !== account) {
    notes.push(`IAM 역할 ${roleName} 은 다른 계정(••••${roleAccount.slice(-4)}) 역할 → 이 계정에서 정책을 못 읽음, 이 신원의 권한 근거 없음`);
    return null;
  }
  const statements: unknown[] = [];
  const policies: string[] = [];
  try {
    // 관리형 정책: 붙은 목록 → 기본 판 번호 → 문서
    const att = arr(get(await runJson(d, "aws", ["iam", "list-attached-role-policies", "--role-name", roleName, "--output", "json"]), "AttachedPolicies"));
    for (const p of att.sort((a, b) => String(a.PolicyArn).localeCompare(String(b.PolicyArn)))) {
      const arn = str(p.PolicyArn);
      if (!arn) continue;
      const ver = str(get(await runJson(d, "aws", ["iam", "get-policy", "--policy-arn", arn, "--output", "json"]), "Policy", "DefaultVersionId"));
      if (!ver) { notes.push(`정책 ${arn} 기본 판 번호 없음`); continue; }
      const doc = docOf(get(await runJson(d, "aws", ["iam", "get-policy-version", "--policy-arn", arn, "--version-id", ver, "--output", "json"]), "PolicyVersion", "Document"));
      statements.push(...statementsOf(doc));
      policies.push(arn);
    }
    // 인라인 정책
    const inl = arr(get(await runJson(d, "aws", ["iam", "list-role-policies", "--role-name", roleName, "--output", "json"]), "PolicyNames") as unknown)
      .map((n) => String(n)).sort();
    for (const name of inl) {
      const doc = docOf(get(await runJson(d, "aws", ["iam", "get-role-policy", "--role-name", roleName, "--policy-name", name, "--output", "json"]), "PolicyDocument"));
      statements.push(...statementsOf(doc));
      policies.push(`inline:${name}`);
    }
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    rethrowTransient(e, "앱 신원 권한(IAM)");
    // 일부만 읽은 정책으로 grants 를 만들면 출발보다 좁아진다 → 이 신원은 통째로 빼고 이유를 남긴다
    notes.push(`IAM 역할 ${roleName} 정책 못 읽음 → 이 신원의 권한 근거 없음: ${e.message.slice(0, 160)}`);
    return null;
  }
  let boundary: { arn: string; statements: unknown[] } | undefined;
  let boundaryUnread = false;
  try {
    // IB-1: 권한 경계 (있으면 그 정책 문서까지). 못 읽으면 정책은 그대로 두고 "경계 못 읽음" 표시 (정책만으로는 출발보다 넓을 수 있음)
    const bArn = str(get(await runJson(d, "aws", ["iam", "get-role", "--role-name", roleName, "--output", "json"]), "Role", "PermissionsBoundary", "PermissionsBoundaryArn"));
    if (bArn) {
      const bv = str(get(await runJson(d, "aws", ["iam", "get-policy", "--policy-arn", bArn, "--output", "json"]), "Policy", "DefaultVersionId"));
      if (!bv) throw new CliError("aws", ["iam", "get-policy", bArn], 1, "권한 경계 기본 판 번호 없음");
      boundary = { arn: bArn, statements: statementsOf(docOf(get(await runJson(d, "aws", ["iam", "get-policy-version", "--policy-arn", bArn, "--version-id", bv, "--output", "json"]), "PolicyVersion", "Document"))) };
    }
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    rethrowTransient(e, "앱 신원 권한(IAM)");
    boundaryUnread = true;
    notes.push(`IAM 역할 ${roleName} 권한 경계 못 읽음: ${e.message.slice(0, 160)}`);
  }
  return { roleName, policies, statements, ...(boundary ? { boundary } : {}), ...(boundaryUnread ? { boundaryUnread: true as const } : {}) };
}

/** 원본 항목들에서 앱이 쓰는 ServiceAccount 를 모은다 (Deployment·CronJob 의 serviceAccountName, 없으면 default) */
export function appIdentities(items: Obj[]): AppIdentity[] {
  const sas = new Map<string, string>(), gsas = new Map<string, string>();
  for (const i of items) if (i.kind === "k8s.serviceAccount") {
    const ns = str(get(i, "metadata", "namespace")) ?? "", n = str(get(i, "metadata", "name")) ?? "";
    const irsa = str(i.irsaRoleArn), gsa = str(i.gcpServiceAccount);
    if (irsa) sas.set(`${ns}/${n}`, irsa);
    if (gsa) gsas.set(`${ns}/${n}`, gsa);
  }
  const out: AppIdentity[] = [];
  for (const i of items) {
    const pod = i.kind === "k8s.deployment" ? get(i, "spec", "template", "spec")
      : i.kind === "k8s.cronjob" ? get(i, "spec", "jobTemplate", "spec", "template", "spec") : undefined;
    if (!pod) continue;
    const ns = str(get(i, "metadata", "namespace"));
    if (!ns) continue;
    const sa = str(get(pod, "serviceAccountName")) ?? "default";
    const irsa = sas.get(`${ns}/${sa}`), gsa = gsas.get(`${ns}/${sa}`);
    out.push({ namespace: ns, serviceAccount: sa, ...(irsa ? { irsaRoleArn: irsa } : {}), ...(gsa ? { gsa } : {}) });
  }
  return out;
}

// ---- WI-1: GKE Workload Identity → 프로젝트 IAM 바인딩 ----
// DRAFT(ai): 프로젝트 정책(get-iam-policy) 한 번만 읽는다. 자원(버킷·토픽)별 정책은 아직 안 읽음 (관찰 권한 storage.buckets.getIamPolicy 등을 더해야 함)
//   member serviceAccount:<GSA> 로 걸린 역할만. 조건(condition) 붙은 바인딩은 역할 이름 뒤에 표시해 검토로 남긴다
export interface RawGcpIamBinding { kind: "gcp.iamBinding"; gsa: string; namespace: string; serviceAccount: string; project: string; roles: string[]; conditional: string[] }

export async function readGcpIam(d: CliDeps, project: string, ids: AppIdentity[], notes: string[], unread: Obj[] = []): Promise<RawGcpIamBinding[]> {
  const wanted = [...new Map(ids.filter((i) => i.gsa).map((i) => [`${i.namespace}/${i.serviceAccount}`, i])).values()]
    .sort((a, b) => `${a.namespace}/${a.serviceAccount}`.localeCompare(`${b.namespace}/${b.serviceAccount}`));
  if (!wanted.length) return [];
  let bindings: Obj[] = [];
  try { bindings = arr(get(await runJson(d, "gcloud", ["projects", "get-iam-policy", project, "--format", "json"]), "bindings")); }
  catch (e) {
    if (!(e instanceof CliError)) throw e;
    rethrowTransient(e, "앱 신원 권한(IAM)");
    notes.push(`프로젝트 ${project} IAM 정책 못 읽음 → 앱 신원 권한 근거 없음: ${e.message.slice(0, 160)}`);
    for (const w of wanted) unread.push({ kind: "k8s.unread", resource: `IAM.${w.namespace}/${w.serviceAccount}`, reason: `프로젝트 IAM 정책: ${e.message.slice(0, 120)}`, source: "gcp:iam" });
    return [];
  }
  return wanted.map((w) => {
    const member = `serviceaccount:${w.gsa!.toLowerCase()}`;
    const mine = bindings.filter((b) => arr(b.members).some((m) => String(m).toLowerCase() === member));
    const roles = [...new Set(mine.filter((b) => !b.condition).map((b) => String(b.role)))].sort();
    const conditional = [...new Set(mine.filter((b) => b.condition).map((b) => String(b.role)))].sort();
    return { kind: "gcp.iamBinding" as const, gsa: w.gsa!, namespace: w.namespace, serviceAccount: w.serviceAccount, project, roles, conditional };
  });
}

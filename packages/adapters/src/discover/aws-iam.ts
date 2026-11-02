import { arr, CliError, get, runJson, str, type CliDeps } from "../common/cli.js";
import type { RawAwsIamPolicy } from "../import/mappers/iam-grants.js";

// I4: 출발 앱 신원의 IAM 정책 읽기 (list·get 만. 바꾸는 명령 없음). 결과 = 원본 항목 aws.iamPolicy (신원 하나 = 역할 하나 = 항목 하나)
//   신원 찾기: ① EKS Pod Identity association (네임스페이스 + ServiceAccount → 역할)  ② IRSA (ServiceAccount 주석 eks.amazonaws.com/role-arn)
//   정책 문서: 붙은 관리형 정책(기본 판 문서) + 인라인 정책. 권한 경계·SCP·세션 정책은 안 읽는다 (아래 STUB)
// 관찰 역할에 필요한 권한 (infra/onboarding/aws-connect.json ObserveRole 에 이미 있음):
//   eks:ListPodIdentityAssociations, eks:DescribePodIdentityAssociation,
//   iam:ListAttachedRolePolicies, iam:GetPolicy, iam:GetPolicyVersion, iam:ListRolePolicies, iam:GetRolePolicy
// STUB: 권한 경계(PermissionsBoundary)·조직 SCP 는 "출발에서 실제로 허용된 범위"를 더 좁힌다. 지금은 정책 문서 그대로(넓게)만 읽는다

type Obj = Record<string, unknown>;

/** 앱이 쓰는 ServiceAccount 하나. irsaRoleArn 은 k8s 주석에서 */
export interface AppIdentity { namespace: string; serviceAccount: string; irsaRoleArn?: string }

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
export async function readAwsIam(d: CliDeps, r: string[], cluster: string, ids: AppIdentity[], notes: string[]): Promise<RawAwsIamPolicy[]> {
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
      notes.push(`Pod Identity 목록 못 읽음 (${ns}): ${e.message.slice(0, 160)}`);
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
        notes.push(`Pod Identity ${ns}/${sa} 못 읽음: ${e.message.slice(0, 160)}`);
      }
    }
  }
  // ② IRSA: Pod Identity 가 없는 신원만 (둘 다 있으면 EKS 가 Pod Identity 를 먼저 쓴다 【추정: AWS 문서 credential chain 순서】)
  for (const w of wanted) if (w.irsaRoleArn && !roles.has(`${w.namespace}/${w.serviceAccount}`))
    roles.set(`${w.namespace}/${w.serviceAccount}`, { roleArn: w.irsaRoleArn, source: "irsa", id: w });

  const out: RawAwsIamPolicy[] = [];
  for (const [, x] of [...roles].sort((a, b) => a[0].localeCompare(b[0]))) {
    const roleName = roleNameOf(x.roleArn);
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
      // 일부만 읽은 정책으로 grants 를 만들면 출발보다 좁아진다 → 이 신원은 통째로 빼고 이유를 남긴다
      notes.push(`IAM 역할 ${roleName} 정책 못 읽음 → 이 신원의 권한 근거 없음: ${e.message.slice(0, 160)}`);
      continue;
    }
    out.push({ kind: "aws.iamPolicy", roleName, serviceAccount: x.id.serviceAccount, namespace: x.id.namespace, source: x.source, policies, statements });
  }
  return out;
}

/** 원본 항목들에서 앱이 쓰는 ServiceAccount 를 모은다 (Deployment·CronJob 의 serviceAccountName, 없으면 default) */
export function appIdentities(items: Obj[]): AppIdentity[] {
  const sas = new Map<string, string>();
  for (const i of items) if (i.kind === "k8s.serviceAccount") {
    const ns = str(get(i, "metadata", "namespace")) ?? "", n = str(get(i, "metadata", "name")) ?? "";
    const irsa = str(i.irsaRoleArn);
    if (irsa) sas.set(`${ns}/${n}`, irsa);
  }
  const out: AppIdentity[] = [];
  for (const i of items) {
    const pod = i.kind === "k8s.deployment" ? get(i, "spec", "template", "spec")
      : i.kind === "k8s.cronjob" ? get(i, "spec", "jobTemplate", "spec", "template", "spec") : undefined;
    if (!pod) continue;
    const ns = str(get(i, "metadata", "namespace"));
    if (!ns) continue;
    const sa = str(get(pod, "serviceAccountName")) ?? "default";
    const irsa = sas.get(`${ns}/${sa}`);
    out.push({ namespace: ns, serviceAccount: sa, ...(irsa ? { irsaRoleArn: irsa } : {}) });
  }
  return out;
}

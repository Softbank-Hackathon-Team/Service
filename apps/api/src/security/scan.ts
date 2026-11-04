import {
  actionsOfPolicy, checkSessionPolicy, compactSessionPolicy, parseClusterRole, parseGcpCustomRole, TempRoleDenied,
  AWS_SESSION_POLICY_MAX, SECRET_PATTERNS, type Stage,
} from "@svc/security";

// 보안 표 재료 중 "파일·문자열을 읽어서 세는" 부분. 전부 순수 함수다 (파일 읽기는 load.ts)

const READ_VERB = /^(describe|list|get|batchget|watch|lookup|search)/i;
const isRead = (a: string) => READ_VERB.test(a.split(/[:.]/).pop() ?? "");

interface Stmt { Effect: string; Action: string | string[]; Resource?: unknown; Condition?: unknown; Sid?: string }
interface PolicyDoc { Version: string; Statement: Stmt[] }
const acts = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const anyResource = (r: unknown) => r === "*" || (Array.isArray(r) && r.includes("*"));

// IAM 역할을 만들거나 정책을 붙이는 동작. 권한 경계 조건 없이 가지면 자기 권한 상승 경로 (위협 모델 A-4)
const IAM_ESCALATION = ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"];

export interface AwsPermScan {
  ceiling: number;
  wildcard: string[];
  writesOnAnyResource: number;          // Resource "*" 문장 안의 쓰기 동작 수 (태그·이름 조건 없음)
  escalationWithoutBoundary: string[];  // 경계 조건 없는 문장에 있는 IAM 쓰기 동작
  sessions: { stage: Stage; chars: number; limit: number; actions: number; error: string | null }[];
}

export function scanAwsPermissions(ceilingJson: string, sessions: Partial<Record<Stage, string>>): AwsPermScan {
  const doc = JSON.parse(ceilingJson) as PolicyDoc;
  const allow = doc.Statement.filter((s) => s.Effect === "Allow");
  const ceiling = actionsOfPolicy(doc);
  const escalation = allow
    .filter((s) => !JSON.stringify(s.Condition ?? {}).includes("iam:PermissionsBoundary"))
    .flatMap((s) => acts(s).filter((a) => IAM_ESCALATION.includes(a)));
  const out: AwsPermScan["sessions"] = [];
  for (const stage of ["plan", "apply", "destroy"] as const) {
    const raw = sessions[stage];
    if (raw === undefined) continue;
    const compact = JSON.stringify(JSON.parse(raw));
    let actions = 0, error: string | null = null;
    try { actions = checkSessionPolicy(compact, ceiling).length; }
    catch (e) { if (e instanceof TempRoleDenied) error = e.code; else throw e; }
    // 길이 = AWS 로 실제 보내는 판 (발급기가 실효 권한이 같은 와일드카드 판으로 줄여 보낸다, security compactSessionPolicy)
    out.push({ stage, chars: compactSessionPolicy(compact, ceiling).length, limit: AWS_SESSION_POLICY_MAX, actions, error });
  }
  return {
    ceiling: ceiling.length,
    wildcard: ceiling.filter((a) => a.includes("*")),
    // ID-4: managed-by=platform 태그 조건이 붙은 문장은 "아무 자원"이 아니다 (우리가 만든 것만)
    writesOnAnyResource: [...new Set(allow.filter((s) => anyResource(s.Resource) && !JSON.stringify(s.Condition ?? {}).includes("aws:ResourceTag/managed-by"))
      .flatMap(acts).filter((a) => !isRead(a)))].length,
    escalationWithoutBoundary: [...new Set(escalation)].sort(),
    sessions: out,
  };
}

export interface GcpPermScan { permissions: number; wildcard: string[]; setIamPolicy: string[] }
export function scanGcpPermissions(customRoleYaml: string): GcpPermScan {
  const perms = parseGcpCustomRole(customRoleYaml);
  return { permissions: perms.length, wildcard: perms.filter((p) => p.includes("*")),
    setIamPolicy: perms.filter((p) => p.endsWith(".setIamPolicy")) };
}

export interface OnpremPermScan {
  clusterRoles: number;
  boundClusterWide: string[];     // ClusterRoleBinding 으로 클러스터 전체에 묶인 ClusterRole 이름
  bindingInFile: boolean;         // 파일 안에 ClusterRoleBinding 이 있나 (없으면 전부 클러스터 전체로 본다)
  rules: number;
  clusterWideAppWrites: number;
}
// 클러스터 전체에 묶인 ClusterRole 안에서 namespaces 말고 앱 자원(Deployment 등)에 쓰기가 있으면
// kube-system 까지 닿는다 (위협 모델 K-1). 정의만 하고 RoleBinding 으로 네임스페이스에 묶는 역할(G3)은 뺀다
export function scanOnpremPermissions(yaml: string): OnpremPermScan {
  const docs = yaml.split(/^---\s*$/m);
  const roles = docs.filter((d) => /^kind:\s*ClusterRole\s*$/m.test(d))
    .map((d) => ({ name: d.match(/^metadata:\s*\n\s+name:\s*(\S+)/m)?.[1] ?? "?", body: d }));
  const bound = docs.filter((d) => /^kind:\s*ClusterRoleBinding\s*$/m.test(d))
    .map((d) => d.match(/roleRef:[\s\S]*?name:\s*(\S+)/)?.[1]).filter((n): n is string => !!n);
  const bindingInFile = bound.length > 0;
  const wide = roles.filter((r) => !bindingInFile || bound.includes(r.name));
  const entries = wide.flatMap((r) => parseClusterRole(r.body));
  return {
    clusterRoles: roles.length,
    boundClusterWide: wide.map((r) => r.name),
    bindingInFile,
    rules: (yaml.match(/^\s*-\s*apiGroups:/gm) ?? []).length,
    clusterWideAppWrites: entries.filter((e) => !e.startsWith("core/namespaces:") && !isRead(e.split(":").pop() ?? "")).length,
  };
}

export interface ChartScan {
  securityContext: boolean;     // Pod·컨테이너 securityContext 가 템플릿에 있나
  runAsNonRoot: boolean;
  privilegedTrue: boolean;      // privileged: true 가 적혀 있나
  dbPasswordFromSecret: boolean | null;  // DB_PASSWORD 가 secretKeyRef 로 들어가나 (DB 블록이 없으면 null)
  literalSecretEnv: string[];   // 이름이 비밀값 같은데 value: 로 직접 들어가는 env
  automountTokenOff: boolean;   // ServiceAccount 또는 Pod 에 automountServiceAccountToken: false
}
export function scanChart(deploymentYaml: string, serviceAccountYaml: string): ChartScan {
  const lit = [...deploymentYaml.matchAll(/name:\s*"?([A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*)"?\s*,\s*value:/g)].map((m) => m[1]!);
  const db = deploymentYaml.match(/name:\s*DB_PASSWORD\s*\n\s*valueFrom:\s*\{\s*secretKeyRef/);
  return {
    securityContext: /securityContext:/.test(deploymentYaml),
    runAsNonRoot: /runAsNonRoot:\s*true/.test(deploymentYaml),
    privilegedTrue: /privileged:\s*true/.test(deploymentYaml),
    dbPasswordFromSecret: /DB_PASSWORD/.test(deploymentYaml) ? db !== null : null,
    literalSecretEnv: lit,
    automountTokenOff: /automountServiceAccountToken:\s*false/.test(deploymentYaml + "\n" + serviceAccountYaml),
  };
}

// ── 평문 비밀값 찾기 ──
// 감사 detail·명세·계획서 같은 "DB 에 남는 JSON" 을 훑어서 비밀값처럼 생긴 것을 센다. 값은 돌려주지 않고 위치만.
// 패턴 표는 packages/security secret-patterns.ts (Z91: 실제 점검과 같이 쓰려고 옮김). 예전 import 를 위해 다시 내보낸다
export { SECRET_PATTERNS };
const SECRET_KEYS = new Set(["password", "passwd", "secret", "secretaccesskey", "token", "accesstoken",
  "sessiontoken", "apikey", "privatekey", "clientsecret", "material"]);
const MASKED = /^(\[redacted\]|\*+|)$/i;

export interface SecretHit { where: string; kind: string }
export interface SecretScan { scannedDocs: number; scannedStrings: number; hits: SecretHit[] }

export function scanSecrets(docs: { where: string; value: unknown }[]): SecretScan {
  const hits: SecretHit[] = [];
  let strings = 0;
  const walk = (v: unknown, path: string, key: string | null) => {
    if (typeof v === "string") {
      strings++;
      if (key && SECRET_KEYS.has(key.toLowerCase()) && !MASKED.test(v)) hits.push({ where: path, kind: "secret_field" });
      for (const p of SECRET_PATTERNS) if (p.re.test(v)) hits.push({ where: path, kind: p.kind });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEYS.has(k.toLowerCase()) && x !== null && typeof x === "object") hits.push({ where: `${path}.${k}`, kind: "secret_field" });
        walk(x, `${path}.${k}`, k);
      }
    }
  };
  for (const d of docs) walk(d.value, d.where, null);
  return { scannedDocs: docs.length, scannedStrings: strings, hits };
}

// 접속 문자열에 비밀번호가 들어 있나 (값은 안 돌려준다)
export function urlHasPassword(u: string | undefined): boolean | null {
  if (!u) return null;
  try { return new URL(u).password.length > 0; } catch { return null; }
}

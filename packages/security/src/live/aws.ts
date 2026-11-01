import { checkAppRoleTrust } from "../trust.js";
import { readJson, type ExecRunner, type Json } from "./exec.js";
import { check, maskAccount, type LiveCheck, type LiveCheckKey } from "./types.js";

// Z91: AWS 도착(또는 출발) 환경 실제 점검. 전부 읽기 API (describe/get/list), aws CLI + AWS_PROFILE 자격.
// 읽는 자원은 apply 가 남긴 terraform 출력(infra.ready tfOutputs)으로 찾는다: db_address, cluster_name, app_role_arn

export interface AwsFacts {
  region: string;
  dbAddress?: string;          // tfOutputs.db_address (RDS 엔드포인트 주소)
  clusterName?: string;        // tfOutputs.cluster_name (빈 값 = 클러스터 없이 만든 데모)
  appRoleArn?: string;         // tfOutputs.app_role_arn
  dbMasterSecretArn?: string;  // tfOutputs.db_master_secret_arn
}
export interface ProviderOutcome { credentials: "ok" | "unavailable" | "n_a"; reason: string | null; checks: LiveCheck[] }

const WORLD = new Set(["0.0.0.0/0", "::/0"]);
const arr = <T = Json>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

// ── 보안그룹 들어오는 규칙 → 세상에 열린 포트 ──
export interface OpenRule { group: string; ports: string; world: boolean; cidrs: number }
export function openIngress(groups: unknown[]): OpenRule[] {
  const out: OpenRule[] = [];
  for (const g of groups.map(obj)) {
    for (const p of arr(g.IpPermissions)) {
      const cidrs = [...arr(p.IpRanges).map((r) => String(r.CidrIp)), ...arr(p.Ipv6Ranges).map((r) => String(r.CidrIpv6))];
      if (cidrs.length === 0) continue;   // 다른 보안그룹에서만 들어옴 (EKS 클러스터 SG) → 공개 아님
      const proto = String(p.IpProtocol);
      const ports = proto === "-1" ? "전체" : p.FromPort === p.ToPort ? `${proto}/${p.FromPort}` : `${proto}/${p.FromPort}-${p.ToPort}`;
      out.push({ group: String(g.GroupId ?? "?"), ports, world: cidrs.some((c) => WORLD.has(c)), cidrs: cidrs.length });
    }
  }
  return out;
}

export function analyzeRds(inst: Json, groups: unknown[], forceSsl: string | null, src: { db: string; sg: string; param: string }): LiveCheck[] {
  const addr = String(obj(inst.Endpoint).Address ?? inst.DBInstanceIdentifier ?? "?");
  const id = String(inst.DBInstanceIdentifier ?? addr);
  const rules = openIngress(groups);
  const world = rules.filter((r) => r.world);
  const pub = inst.PubliclyAccessible === true;
  const out: LiveCheck[] = [];
  // 공개 = PubliclyAccessible(공인 주소 받음) + 보안그룹이 그 주소로 들어오게 둠. 둘 다여야 실제로 열림
  out.push(check("public_ports.db", !pub ? "pass" : world.length ? "fail" : rules.length ? "warn" : "pass", `RDS ${id}`,
    !pub ? `PubliclyAccessible=false · 보안그룹 CIDR 규칙 ${rules.length}개`
      : world.length ? `PubliclyAccessible=true · 0.0.0.0/0 허용 ${world.map((r) => r.ports).join(", ")}`
        : rules.length ? `PubliclyAccessible=true · 허용 목록 CIDR ${rules.reduce((n, r) => n + r.cidrs, 0)}개만 (데모 DB_PUBLIC)` : "PubliclyAccessible=true · CIDR 규칙 0 (들어올 길 없음)",
    `${src.db} + ${src.sg}`));
  const others = world.filter((r) => r.ports !== "tcp/5432");
  out.push(check("public_ports.network", others.length ? "fail" : world.length ? "warn" : "pass", `DB 보안그룹 ${groups.length}개`,
    others.length ? `세상에 열린 포트 ${others.map((r) => `${r.group} ${r.ports}`).join(", ")}`
      : world.length ? "5432 만 세상에 열림" : `세상(0.0.0.0/0·::/0)에 열린 규칙 0 · 규칙 ${rules.length}개`, src.sg));
  const enc = inst.StorageEncrypted === true;
  out.push(check("storage_encryption.db", enc ? "pass" : "fail", `RDS ${id}`,
    enc ? `StorageEncrypted=true · KMS 키 ${inst.KmsKeyId ? "있음" : "없음"}` : "StorageEncrypted=false (만든 뒤엔 못 바꿈, 스냅숏 복사로만)", src.db));
  out.push(check("tls.db", forceSsl === "1" ? "pass" : forceSsl === "0" ? (pub ? "fail" : "warn") : "unavailable", `RDS ${id} 파라미터 그룹`,
    forceSsl === null ? "rds.force_ssl 값을 못 읽음" : `rds.force_ssl=${forceSsl} · CA ${String(inst.CACertificateIdentifier ?? "?")}`, src.param));
  const ms = obj(inst.MasterUserSecret);
  out.push(check("secrets.db_credential", ms.SecretArn ? (ms.SecretStatus === "active" || ms.SecretStatus === undefined ? "pass" : "warn") : "warn", `RDS ${id}`,
    ms.SecretArn ? `마스터 비밀번호 = Secrets Manager 관리(manage_master_user_password) · 상태 ${String(ms.SecretStatus ?? "?")}`
      : "마스터 비밀번호를 Secrets Manager 가 관리하지 않음 (Terraform 상태에 남을 수 있음)", src.db));
  return out;
}

export function analyzeEks(cluster: Json, src: string): LiveCheck[] {
  const vpc = obj(cluster.resourcesVpcConfig);
  const name = String(cluster.name ?? "?");
  const pub = vpc.endpointPublicAccess === true;
  const cidrs = arr<string>(vpc.publicAccessCidrs).map(String);
  const world = cidrs.length === 0 || cidrs.some((c) => WORLD.has(c));
  const encSecrets = arr(cluster.encryptionConfig).some((e) => arr<string>(e.resources).map(String).includes("secrets"));
  return [
    check("public_ports.cluster_api", !pub ? "pass" : world ? "fail" : "warn", `EKS ${name}`,
      !pub ? `공개 엔드포인트 꺼짐 · 사설 ${vpc.endpointPrivateAccess === true ? "켜짐" : "꺼짐"}`
        : world ? "공개 엔드포인트 0.0.0.0/0 (Z39 위반 줄과 같은 것)" : `공개 엔드포인트 허용 CIDR ${cidrs.length}개`, src),
    check("storage_encryption.k8s_secrets", encSecrets ? "pass" : "warn", `EKS ${name}`,
      encSecrets ? "encryptionConfig: secrets 를 고객 KMS 키로 봉투 암호화" : "고객 KMS 봉투 암호화 없음 (EKS 기본 암호화만 【미확인: 버전별 기본값】)", src),
  ];
}

// 붙은 관리형 정책·인라인 정책을 보고 과다 권한 판정. 신뢰 정책은 Z47-04 checkAppRoleTrust 그대로
const ADMIN_MANAGED = /(^|\/)(AdministratorAccess|PowerUserAccess|IAMFullAccess)$/;
export function analyzeIamRole(role: Json, attached: unknown[], inline: { name: string; doc: unknown }[], src: string): LiveCheck {
  const name = String(role.RoleName ?? "?");
  const bad: string[] = [];
  const weak: string[] = [];
  for (const a of attached.map(obj)) if (ADMIN_MANAGED.test(String(a.PolicyArn ?? ""))) bad.push(String(a.PolicyName ?? a.PolicyArn));
  for (const p of inline) {
    let d: Json;
    try { d = obj(typeof p.doc === "string" ? JSON.parse(p.doc.trimStart().startsWith("%") ? decodeURIComponent(p.doc) : p.doc) : p.doc); }
    catch { weak.push(`${p.name}(읽기 실패)`); continue; }
    for (const s of arr(d.Statement)) {
      if (s.Effect !== "Allow") continue;
      const acts = (Array.isArray(s.Action) ? s.Action : [s.Action]).map(String);
      const res = (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map(String);
      if (acts.some((a) => a === "*" || a.endsWith(":*"))) { bad.push(`${p.name}: ${acts.filter((a) => a === "*" || a.endsWith(":*")).join(",")}`); continue; }
      if (s.NotAction !== undefined) { bad.push(`${p.name}: NotAction`); continue; }
      if (res.includes("*") && acts.some((a) => !/^[a-z0-9-]+:(Describe|Get|List)/i.test(a))) weak.push(`${p.name}: 쓰기 동작 Resource "*"`);
    }
  }
  const trust = checkAppRoleTrust(role.AssumeRolePolicyDocument);
  if (!trust.ok) bad.push(`신뢰 정책 ${trust.violations.join(",")}`);
  return check("iam.app_identity", bad.length ? "fail" : weak.length ? "warn" : "pass", `IAM 역할 ${maskAccount(name)}`,
    bad.length ? `과다 권한 ${bad.join(" · ")}`.slice(0, 300)
      : weak.length ? weak.join(" · ").slice(0, 300) : `관리형 ${attached.length}개·인라인 ${inline.length}개 · 전체 권한·와일드카드 없음 · 신뢰 정책 pods.eks 만`, src);
}

const unavailable = (keys: LiveCheckKey[], resource: string, why: string, source: string) =>
  keys.map((k) => check(k, "unavailable", resource, why, source));

export async function checkAws(run: ExecRunner, f: AwsFacts): Promise<ProviderOutcome> {
  const R = ["--region", f.region, "--output", "json"];
  // 자격 먼저: 실패면 나머지를 부르지 않는다 (같은 오류 8번 대신 이유 하나)
  const who = await readJson(run, "aws", ["sts", "get-caller-identity", ...R]);
  const DB_KEYS: LiveCheckKey[] = ["public_ports.db", "public_ports.network", "storage_encryption.db", "tls.db", "secrets.db_credential"];
  const EKS_KEYS: LiveCheckKey[] = ["public_ports.cluster_api", "storage_encryption.k8s_secrets"];
  if (!who.ok) {
    const why = who.missing ? "aws CLI 없음" : `AWS 자격 없음: ${who.why}`;
    return { credentials: "unavailable", reason: why, checks: unavailable([...DB_KEYS, ...EKS_KEYS, "iam.app_identity"], "AWS", why, "aws sts get-caller-identity") };
  }
  const checks: LiveCheck[] = [];

  // RDS
  if (!f.dbAddress) checks.push(...DB_KEYS.map((k) => check(k, "n_a", "RDS", "terraform 출력 db_address 없음 (DB 없이 만든 이전)", "infra.ready tfOutputs")));
  else {
    const d = await readJson(run, "aws", ["rds", "describe-db-instances", ...R]);
    const inst = d.ok ? arr(obj(d.json).DBInstances).find((i) => obj(i.Endpoint).Address === f.dbAddress) : undefined;
    if (!d.ok) checks.push(...unavailable(DB_KEYS, `RDS ${f.dbAddress}`, d.why, "aws rds describe-db-instances"));
    else if (!inst) checks.push(...unavailable(DB_KEYS, `RDS ${f.dbAddress}`, "그 주소의 RDS 인스턴스가 없음 (이미 지웠거나 다른 리전)", "aws rds describe-db-instances"));
    else {
      const ids = arr(inst.VpcSecurityGroups).map((g) => String(g.VpcSecurityGroupId)).filter(Boolean);
      const sg = ids.length ? await readJson(run, "aws", ["ec2", "describe-security-groups", "--group-ids", ...ids, ...R]) : { ok: true as const, json: { SecurityGroups: [] } };
      const pg = String(obj(arr(inst.DBParameterGroups)[0]).DBParameterGroupName ?? "");
      const pr = pg ? await readJson(run, "aws", ["rds", "describe-db-parameters", "--db-parameter-group-name", pg,
        "--query", "Parameters[?ParameterName=='rds.force_ssl']", ...R]) : null;
      const force = pr && pr.ok ? (arr(pr.json)[0]?.ParameterValue as string | undefined) ?? null : null;
      const rds = analyzeRds(inst, sg.ok ? arr(obj(sg.json).SecurityGroups) : [], force,
        { db: "aws rds describe-db-instances", sg: "aws ec2 describe-security-groups", param: "aws rds describe-db-parameters" });
      if (!sg.ok) for (const c of rds) if (c.key === "public_ports.network") Object.assign(c, { state: "unavailable", evidence: sg.why });
      checks.push(...rds);
    }
  }

  // EKS
  if (!f.clusterName) checks.push(...EKS_KEYS.map((k) => check(k, "n_a", "EKS", "클러스터 없이 만든 이전 (TF_FACT_CLUSTER_NAME 빈 값)", "infra.ready tfOutputs")));
  else {
    const c = await readJson(run, "aws", ["eks", "describe-cluster", "--name", f.clusterName, ...R]);
    checks.push(...(c.ok ? analyzeEks(obj(obj(c.json).cluster), "aws eks describe-cluster") : unavailable(EKS_KEYS, `EKS ${f.clusterName}`, c.why, "aws eks describe-cluster")));
  }

  // IAM 앱 역할 (IRSA·Pod Identity)
  const roleName = f.appRoleArn?.split("/").pop();
  if (!roleName) checks.push(check("iam.app_identity", "n_a", "IAM 앱 역할", "terraform 출력 app_role_arn 없음 (클러스터 없는 이전)", "infra.ready tfOutputs"));
  else {
    const src = "aws iam get-role + list-attached-role-policies + list-role-policies + get-role-policy";
    const role = await readJson(run, "aws", ["iam", "get-role", "--role-name", roleName, "--output", "json"]);
    const att = await readJson(run, "aws", ["iam", "list-attached-role-policies", "--role-name", roleName, "--output", "json"]);
    const inl = await readJson(run, "aws", ["iam", "list-role-policies", "--role-name", roleName, "--output", "json"]);
    if (!role.ok || !att.ok || !inl.ok) checks.push(check("iam.app_identity", "unavailable", `IAM 역할 ${roleName}`, [role, att, inl].find((x) => !x.ok && "why" in x)?.["why" as never] ?? "읽기 실패", src));
    else {
      const names = arr<string>(obj(inl.json).PolicyNames).map(String);
      const docs: { name: string; doc: unknown }[] = [];
      for (const n of names) {
        const p = await readJson(run, "aws", ["iam", "get-role-policy", "--role-name", roleName, "--policy-name", n, "--output", "json"]);
        docs.push({ name: n, doc: p.ok ? obj(p.json).PolicyDocument : "%" });
      }
      checks.push(analyzeIamRole(obj(obj(role.json).Role), arr(obj(att.json).AttachedPolicies), docs, src));
    }
  }
  return { credentials: "ok", reason: null, checks };
}

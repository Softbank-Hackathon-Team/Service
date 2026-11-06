import { readJson, type ExecRunner, type Json } from "./exec.js";
import type { ProviderOutcome } from "./aws.js";
import { check, type LiveCheck, type LiveCheckKey } from "./types.js";

// Z91: GCP 실제 점검. gcloud CLI(이미 로그인된 계정) 읽기 명령만. 자원은 infra.ready tfOutputs 로 찾는다
export interface GcpFacts {
  projectId: string;               // environments.account_id (apply-real 과 같은 규칙)
  region: string;
  dbConnectionName?: string;       // project:region:instance
  clusterName?: string;
  /** 앱 신원의 IAM 주체 그대로 (gcp/root 출력 app_principal = principal://…/subject/ns/<구역>/sa/<KSA>).
   *  #317 가 전에 만든 이전은 GSA 라 serviceAccount:<메일> 로 들어온다 (run.ts 가 app_gsa_email 에서 만듦) */
  appMember?: string;
  dbPasswordSecretId?: string;
}

const arr = <T = Json>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const WORLD = new Set(["0.0.0.0/0", "::/0"]);

export function analyzeCloudSql(inst: Json, src: string): LiveCheck[] {
  const name = String(inst.name ?? "?");
  const ip = obj(obj(inst.settings).ipConfiguration);
  const pub = ip.ipv4Enabled === true;
  const nets = arr(ip.authorizedNetworks).map((n) => String(n.value));
  const world = nets.some((n) => WORLD.has(n));
  const mode = String(ip.sslMode ?? (ip.requireSsl === true ? "ENCRYPTED_ONLY" : "ALLOW_UNENCRYPTED_AND_ENCRYPTED"));
  const tlsOk = mode === "ENCRYPTED_ONLY" || mode === "TRUSTED_CLIENT_CERTIFICATE_REQUIRED";
  const kms = obj(inst.diskEncryptionConfiguration).kmsKeyName;
  return [
    check("public_ports.db", !pub ? "pass" : world ? "fail" : nets.length ? "warn" : "pass", `Cloud SQL ${name}`,
      !pub ? "공인 IP 꺼짐 (사설 IP 만)" : world ? "공인 IP + 승인 네트워크 0.0.0.0/0" : nets.length ? `공인 IP + 승인 네트워크 ${nets.length}개만 (데모 DB_PUBLIC)` : "공인 IP 있음 · 승인 네트워크 0 (직접 접속 불가)", src),
    check("tls.db", tlsOk ? "pass" : pub ? "fail" : "warn", `Cloud SQL ${name}`, `sslMode=${mode}`, src),
    // 【사실】 Cloud SQL 데이터는 저장 시 항상 암호화 (Google 관리 키 기본). CMEK 면 고객 키
    check("storage_encryption.db", "pass", `Cloud SQL ${name}`, kms ? "고객 관리 키(CMEK)" : "Google 관리 키 기본 암호화 (CMEK 아님)", src),
  ];
}

// 방화벽: 켜진 INGRESS 규칙 중 0.0.0.0/0 에서 오는 것. 80/443 만이면 warn(cloudflared 쓰면 필요 없음), 그 밖 포트는 fail
export function analyzeFirewall(rules: unknown[], network: string | null, src: string): LiveCheck {
  const open = rules.map(obj).filter((r) => r.direction === "INGRESS" && r.disabled !== true
    && arr<string>(r.sourceRanges).map(String).some((c) => WORLD.has(c))
    && (!network || String(r.network ?? "").endsWith(`/${network}`)));
  const portsOf = (r: Json) => arr(r.allowed).map((a) => `${String(a.IPProtocol)}/${arr<string>(a.ports).join(",") || "전체"}`);
  const risky = open.filter((r) => portsOf(r).some((p) => !/^tcp\/(80|443)(,(80|443))*$/.test(p)));
  return check("public_ports.network", risky.length ? "fail" : open.length ? "warn" : "pass", network ? `VPC ${network} 방화벽` : "프로젝트 방화벽",
    risky.length ? `세상에 열림: ${risky.map((r) => `${String(r.name)} ${portsOf(r).join(" ")}`).join(" · ")}`.slice(0, 300)
      : open.length ? `80/443 만 세상에 열림 (${open.map((r) => String(r.name)).join(", ")})` : `세상(0.0.0.0/0)에서 들어오는 켜진 규칙 0 · 전체 ${rules.length}개`, src);
}

export function analyzeGke(c: Json, src: string): LiveCheck[] {
  const name = String(c.name ?? "?");
  const priv = obj(c.privateClusterConfig);
  const man = obj(c.masterAuthorizedNetworksConfig);
  const blocks = arr(man.cidrBlocks).map((b) => String(b.cidrBlock));
  const enc = obj(c.databaseEncryption).state === "ENCRYPTED";
  const state = priv.enablePrivateEndpoint === true ? "pass"
    : man.enabled === true && !blocks.some((b) => WORLD.has(b)) ? "warn" : "fail";
  return [
    check("public_ports.cluster_api", state, `GKE ${name}`,
      state === "pass" ? "사설 엔드포인트만" : state === "warn" ? `공개 엔드포인트 + 승인 네트워크 ${blocks.length}개` : "공개 엔드포인트, 승인 네트워크 없음 또는 0.0.0.0/0 (Z39 위반 줄과 같은 것)", src),
    check("storage_encryption.k8s_secrets", enc ? "pass" : "warn", `GKE ${name}`,
      enc ? "애플리케이션 레이어 Secret 암호화(Cloud KMS)" : "애플리케이션 레이어 암호화 꺼짐 (GKE 기본 저장 암호화만)", src),
  ];
}

const BROAD_ROLES = new Set(["roles/owner", "roles/editor", "roles/iam.securityAdmin", "roles/iam.serviceAccountAdmin",
  "roles/iam.serviceAccountTokenCreator", "roles/resourcemanager.projectIamAdmin", "roles/secretmanager.admin", "roles/cloudsql.admin"]);
// 표 칸 이름: KSA 주체면 "KSA <구역>/<이름>", 옛 GSA 면 "GSA <메일 앞부분>"
export function appMemberLabel(member: string): string {
  const ksa = /\/subject\/ns\/([^/]+)\/sa\/([^/]+)$/.exec(member);
  if (member.startsWith("principal://") && ksa) return `KSA ${ksa[1]}/${ksa[2]}`;
  return `GSA ${member.replace(/^serviceAccount:/, "").split("@")[0]}`;
}
// member = IAM 정책에 적힌 주체 그대로 (principal://… 또는 serviceAccount:<메일>). 프로젝트 정책에서 그 주체가 받은 역할을 본다
export function analyzeGcpIam(policy: Json, member: string, src: string): LiveCheck {
  const roles = arr(policy.bindings).filter((b) => arr<string>(b.members).map(String).includes(member)).map((b) => String(b.role));
  const broad = roles.filter((r) => BROAD_ROLES.has(r));
  return check("iam.app_identity", broad.length ? "fail" : roles.length > 3 ? "warn" : "pass", appMemberLabel(member),
    broad.length ? `프로젝트 전체 넓은 역할 ${broad.join(", ")}` : `프로젝트 수준 역할 ${roles.length}개${roles.length ? ` (${roles.join(", ")})` : ""}`.slice(0, 300), src);
}

const unavailable = (keys: LiveCheckKey[], resource: string, why: string, source: string) => keys.map((k) => check(k, "unavailable", resource, why, source));

export async function checkGcp(run: ExecRunner, f: GcpFacts): Promise<ProviderOutcome> {
  const P = ["--project", f.projectId, "--format=json"];
  const DB_KEYS: LiveCheckKey[] = ["public_ports.db", "tls.db", "storage_encryption.db"];
  const GKE_KEYS: LiveCheckKey[] = ["public_ports.cluster_api", "storage_encryption.k8s_secrets"];
  const all: LiveCheckKey[] = [...DB_KEYS, "public_ports.network", ...GKE_KEYS, "iam.app_identity", "secrets.db_credential"];
  if (!f.projectId) return { credentials: "unavailable", reason: "GCP 프로젝트 번호 없음 (environments.account_id)", checks: unavailable(all, "GCP", "프로젝트 없음", "environments") };
  // 자격 확인 = 프로젝트 IAM 정책 읽기 (iam.app_identity 에 다시 씀)
  const pol = await readJson(run, "gcloud", ["projects", "get-iam-policy", f.projectId, "--format=json"]);
  if (!pol.ok) {
    const why = pol.missing ? "gcloud CLI 없음" : `GCP 자격 없음: ${pol.why}`;
    return { credentials: "unavailable", reason: why, checks: unavailable(all, `GCP ${f.projectId}`, why, "gcloud projects get-iam-policy") };
  }
  const checks: LiveCheck[] = [];
  const inst = f.dbConnectionName?.split(":").pop();
  if (!inst) checks.push(...DB_KEYS.map((k) => check(k, "n_a", "Cloud SQL", "terraform 출력 db_connection_name 없음", "infra.ready tfOutputs")));
  else {
    const d = await readJson(run, "gcloud", ["sql", "instances", "describe", inst, ...P]);
    checks.push(...(d.ok ? analyzeCloudSql(obj(d.json), "gcloud sql instances describe") : unavailable(DB_KEYS, `Cloud SQL ${inst}`, d.why, "gcloud sql instances describe")));
  }
  let network: string | null = null;
  if (!f.clusterName) checks.push(...GKE_KEYS.map((k) => check(k, "n_a", "GKE", "클러스터 없이 만든 이전", "infra.ready tfOutputs")));
  else {
    const c = await readJson(run, "gcloud", ["container", "clusters", "describe", f.clusterName, "--region", f.region, ...P]);
    if (c.ok) { network = String(obj(c.json).network ?? "") || null; checks.push(...analyzeGke(obj(c.json), "gcloud container clusters describe")); }
    else checks.push(...unavailable(GKE_KEYS, `GKE ${f.clusterName}`, c.why, "gcloud container clusters describe"));
  }
  const fw = await readJson(run, "gcloud", ["compute", "firewall-rules", "list", ...P]);
  checks.push(fw.ok ? analyzeFirewall(arr(fw.json), network, "gcloud compute firewall-rules list")
    : check("public_ports.network", "unavailable", "방화벽", fw.why, "gcloud compute firewall-rules list"));
  checks.push(f.appMember ? analyzeGcpIam(obj(pol.json), f.appMember, "gcloud projects get-iam-policy")
    : check("iam.app_identity", "n_a", "앱 신원", "terraform 출력 app_principal 없음", "infra.ready tfOutputs"));
  checks.push(f.dbPasswordSecretId ? check("secrets.db_credential", "pass", "Secret Manager", "DB 비밀번호 = Secret Manager 비밀 (값은 안 읽음)", "infra.ready tfOutputs db_password_secret_id")
    : check("secrets.db_credential", inst ? "warn" : "n_a", "DB 비밀번호", inst ? "Secret Manager 비밀 id 출력 없음" : "DB 없음", "infra.ready tfOutputs"));
  return { credentials: "ok", reason: null, checks };
}

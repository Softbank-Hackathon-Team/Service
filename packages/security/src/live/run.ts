import type { Provider } from "@svc/contracts";
import { checkAws, type ProviderOutcome } from "./aws.js";
import { checkGcp } from "./gcp.js";
import { checkK8s } from "./k8s.js";
import { createExecRunner, readJson, type ExecRunner, type Json } from "./exec.js";
import { ALL_KEYS, check, type LiveCheck, type LiveCheckKey, type LiveSecurityReport } from "./types.js";

// Z91: 한 환경(출발 또는 도착)의 실제 보안 점검. API 보안 표(GET /security)와 보안 회귀(Z95)가 같이 쓴다.
// 재료: 환경 표(provider, account_id) + 그 환경에 마지막으로 만든 자원의 terraform 출력(infra.ready) + 환경 변수(리전·kube 컨텍스트)
// 못 읽는 것은 전부 unavailable + 이유. STUB 출력(가짜 자원 이름)이면 클라우드를 부르지 않는다

export interface LiveTarget {
  side: "source" | "target";
  provider: Provider;
  envId: string;
  accountId: string | null;                     // AWS 계정 / GCP 프로젝트
  tfOutputs: Record<string, string> | null;     // null = 이 환경에 만든 자원 기록 없음
  stubOutputs: boolean;                         // true = STUB_TF_OUTPUTS (진짜 terraform 을 안 돈 이전)
}

export const AWS_DEFAULT_REGION_LIVE = "ap-northeast-2";
export const GCP_DEFAULT_REGION_LIVE = "asia-northeast3";
const ENV_KEY: Record<Provider, string> = { aws: "AWS", gcp: "GCP", onprem: "ONPREM", azure_mock: "AZURE" };

// SEC_LIVE=0 이면 끔 (시험·CI). 기본은 켬
export const liveEnabled = (env: NodeJS.ProcessEnv = process.env) => env.SEC_LIVE !== "0";

export function kubeFacts(t: LiveTarget, env: NodeJS.ProcessEnv) {
  const k = ENV_KEY[t.provider];
  const context = env[`SEC_KUBE_CONTEXT_${k}`];
  const namespace = env[`SEC_KUBE_NAMESPACE_${k}`] || t.tfOutputs?.namespace;
  return context && namespace ? { context, namespace } : null;
}

export function summarize(checks: LiveCheck[]): LiveSecurityReport["summary"] {
  const s = { pass: 0, warn: 0, fail: 0, unavailable: 0, na: 0 };
  for (const c of checks) { if (c.state === "n_a") s.na++; else s[c.state]++; }
  return s;
}

const fill = (keys: LiveCheckKey[], state: "unavailable" | "n_a", resource: string, why: string, source: string) =>
  keys.map((k) => check(k, state, resource, why, source));

async function checkOnpremDb(run: ExecRunner, kf: { context: string; namespace: string } | null): Promise<LiveCheck[]> {
  const DB: LiveCheckKey[] = ["public_ports.db", "tls.db", "storage_encryption.db", "secrets.db_credential"];
  if (!kf) return fill(DB, "unavailable", "CNPG", "kube 컨텍스트·네임스페이스 없음 (SEC_KUBE_CONTEXT_ONPREM)", "환경 변수");
  const S = `kubectl get clusters.postgresql.cnpg.io -n ${kf.namespace}`;
  const r = await readJson(run, "kubectl", ["--context", kf.context, "get", "clusters.postgresql.cnpg.io", "-n", kf.namespace, "-o", "json"]);
  if (!r.ok) return fill(DB, "unavailable", "CNPG", r.why, S);
  const cl = (Array.isArray((r.json as Json)?.items) ? (r.json as Json).items : []) as Json[];
  if (!cl.length) return fill(DB, "n_a", "CNPG", "이 네임스페이스에 CNPG 클러스터 없음", S);
  const c = cl[0]!;
  const name = String((c.metadata as Json)?.name ?? "?");
  const spec = (c.spec ?? {}) as Json;
  const hba = (((spec.postgresql ?? {}) as Json).pg_hba ?? []) as string[];
  const plainHost = hba.filter((l) => /^\s*host\s/.test(String(l)));
  const sec = ((spec.superuserSecret ?? {}) as Json).name;
  return [
    // CNPG 는 클러스터 안 Service(ClusterIP)만 만든다. 밖으로 여는 것은 public_ports.services 가 본다
    check("public_ports.db", "pass", `CNPG ${name}`, "DB 는 ClusterIP Service 만 (NodePort 로 연 것은 Service 줄에서 따로 봄)", S),
    // 【사실】 CNPG 는 서버 인증서를 자동으로 만들어 TLS 를 켠다. pg_hba 에 host(평문 허용) 줄이 있으면 약점
    check("tls.db", plainHost.length ? "warn" : "pass", `CNPG ${name}`, plainHost.length ? `pg_hba 평문 허용 host 줄 ${plainHost.length}개` : "CNPG 자동 TLS · pg_hba 평문 허용 줄 0", S),
    check("storage_encryption.db", "unavailable", `CNPG ${name}`, "온프레 디스크 암호화(LUKS 등)는 k8s API 로 보이지 않음", S),
    check("secrets.db_credential", "pass", `CNPG ${name}`, `비밀번호 = k8s Secret ${sec ? "(superuserSecret 지정)" : "(CNPG 자동 생성)"}`, S),
  ];
}

export async function runLiveChecks(t: LiveTarget, o: { run?: ExecRunner; env?: NodeJS.ProcessEnv; now?: () => Date } = {}): Promise<LiveSecurityReport> {
  const env = o.env ?? process.env;
  const run = o.run ?? createExecRunner({ env });
  const now = o.now ?? (() => new Date());
  const t0 = Date.now();
  const tf = t.tfOutputs ?? {};
  let out: ProviderOutcome;
  const kf = kubeFacts(t, env);

  if (t.provider === "azure_mock") {
    out = { credentials: "n_a", reason: "Azure 는 모의 환경 (실제 Azure API 없음, 아키텍처 결정)", checks: fill(ALL_KEYS, "unavailable", "Azure Mock", "모의 환경이라 읽을 실제 자원 없음", "-") };
  } else if (t.provider !== "onprem" && (t.tfOutputs === null || t.stubOutputs)) {
    const why = t.tfOutputs === null ? "이 환경에 만든 자원 기록(infra.ready) 없음" : "STUB 자원 출력 (진짜 terraform 을 안 돈 이전: USE_TERRAFORM=1 + TF_REAL_APPLY=1 아님)";
    out = { credentials: "unavailable", reason: why, checks: fill(ALL_KEYS, "unavailable", t.provider, why, "infra.ready tfOutputs") };
  } else if (t.provider === "aws") {
    const a = await checkAws(run, { region: env.AWS_REGION || env.AWS_DEFAULT_REGION || AWS_DEFAULT_REGION_LIVE,
      dbAddress: tf.db_address || undefined, clusterName: tf.cluster_name || undefined,
      appRoleArn: tf.app_role_arn || undefined, dbMasterSecretArn: tf.db_master_secret_arn || undefined });
    out = { ...a, checks: [...a.checks, ...(tf.cluster_name ? await checkK8s(run, kf) : fill(["public_ports.services", "tls.ingress", "secrets.workload", "iam.k8s_rbac"], "n_a", "k8s", "클러스터 없이 만든 이전", "infra.ready tfOutputs"))] };
  } else if (t.provider === "gcp") {
    const g = await checkGcp(run, { projectId: t.accountId ?? env.GCP_PROJECT ?? "", region: env.GCP_REGION || GCP_DEFAULT_REGION_LIVE,
      dbConnectionName: tf.db_connection_name || undefined, clusterName: tf.cluster_name || undefined,
      // #317 가: 앱 신원 = KSA 주체(app_principal). 그 전에 만든 이전의 출력은 GSA 메일(app_gsa_email)
      appMember: tf.app_principal || (tf.app_gsa_email ? `serviceAccount:${tf.app_gsa_email}` : undefined),
      dbPasswordSecretId: tf.db_password_secret_id || undefined });
    out = { ...g, checks: [...g.checks, ...(tf.cluster_name ? await checkK8s(run, kf) : fill(["public_ports.services", "tls.ingress", "secrets.workload", "iam.k8s_rbac"], "n_a", "k8s", "클러스터 없이 만든 이전", "infra.ready tfOutputs"))] };
  } else {
    // 온프레: 클라우드 API 없음. k8s 하나로 본다. 클러스터 API 공개·보안그룹·클라우드 신원은 해당 없음
    out = { credentials: "n_a", reason: kf ? null : "kube 컨텍스트 없음 (SEC_KUBE_CONTEXT_ONPREM, SEC_KUBE_NAMESPACE_ONPREM)", checks: [
      ...(await checkOnpremDb(run, kf)),
      ...(await checkK8s(run, kf)),
      check("public_ports.network", "n_a", "온프레", "클라우드 보안그룹·방화벽 없음 (호스트 방화벽은 범위 밖)", "-"),
      check("public_ports.cluster_api", "unavailable", "k3s API", "API 서버 바인딩 주소는 kubeconfig 밖에서만 보임", "-"),
      check("storage_encryption.k8s_secrets", "unavailable", "k3s", "k3s --secrets-encryption 여부는 k8s API 로 보이지 않음", "-"),
      check("iam.app_identity", "n_a", "온프레", "클라우드 신원 없음 (k8s RBAC 줄이 대신)", "-"),
    ] };
  }
  // 열쇠 순서를 고정 (화면·비교가 같은 순서로 보게)
  const checks = ALL_KEYS.flatMap((k) => out.checks.filter((c) => c.key === k));
  return { side: t.side, provider: t.provider, envId: t.envId, checkedAt: now().toISOString(), durationMs: Date.now() - t0,
    origin: "live", credentials: out.credentials, reason: out.reason, summary: summarize(checks), checks };
}

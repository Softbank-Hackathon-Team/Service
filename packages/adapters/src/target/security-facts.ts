// 보안 판정용 환경 사실 (EnvFacts) 조립. 순수 함수: DB·네트워크 없음.
// 도착: 우리 모듈이 고정으로 박은 값 → attested (계획 단계에는 아직 만들어진 자원이 없어 실측 불가)
// 출발: 가져오기가 읽은 securityFacts + 명세 값. 못 읽은 칸은 unknown 그대로 (모름은 판정이 경고·고객 확인으로 바꾼다)
// 판정 자체는 packages/security (adapters 는 security 를 모른다)
import { regionCountry, type AgentReport, type AppSpecV2, type EnvFacts, type Provider, type SourceDbFacts } from "@svc/contracts";
import { postgresOf, postureOfComponent } from "./shared.js";
import { cnpgName } from "./onprem.js";

type Fact<T> = { value: T | null; origin: "measured" | "attested" | "unknown"; source: string | null };
type Db = EnvFacts["db"];
type Platform = EnvFacts["platform"];
const unknown = (): Fact<never> => ({ value: null, origin: "unknown", source: null });
const attested = <T>(value: T, source: string): Fact<T> => ({ value, origin: "attested", source });
const measured = <T>(value: T, source: string): Fact<T> => ({ value, origin: "measured", source });

const AWS_PG = "infra/modules/aws/kinds/postgres/main.tf";
const GCP_PG = "infra/modules/gcp/kinds/postgres/main.tf";

// 도착 postgres 모듈이 고정한 값. 근거 줄은 test/security-facts.test.ts 가 .tf 파일에서 다시 확인한다 (모듈이 바뀌면 시험이 깨진다)
// DRAFT(ai): 온프레(CNPG)는 TLS·저장 암호화·키를 우리 차트가 정하지 않아 모름 = 고객 확인. azure_mock 은 모양만이라 전부 모름
type ModuleDbFacts = Pick<Db, "encryptedAtRest" | "keyOwner" | "tlsEnforced" | "pitr">;
export const MODULE_DB_FACTS: Record<Provider, ModuleDbFacts> = {
  aws: {
    encryptedAtRest: attested(true, `${AWS_PG}: storage_encrypted = true`),
    keyOwner: attested("provider" as const, `${AWS_PG}: kms_key_id 없음 (AWS 관리 키)`),
    tlsEnforced: attested(true, `${AWS_PG}: rds.force_ssl = 1 (require_tls 기본 true)`),
    pitr: attested(true, `${AWS_PG}: backup_retention_period = coalesce(backup_retention_days, 1) (출발이 0 이 아니면 켬)`),
  },
  gcp: {
    encryptedAtRest: attested(true, "GCP Cloud SQL 기본 저장 암호화 (제공자 문서)"),
    keyOwner: attested("provider" as const, `${GCP_PG}: encryption_key_name 없음 (Google 관리 키)`),
    tlsEnforced: attested(true, `${GCP_PG}: ssl_mode = ENCRYPTED_ONLY (require_tls 기본 true)`),
    pitr: attested(true, `${GCP_PG}: point_in_time_recovery_enabled = coalesce(pitr, true) (출발이 끄지 않았으면 켬)`),
  },
  onprem: { encryptedAtRest: unknown(), keyOwner: unknown(), tlsEnforced: unknown(), pitr: unknown() },
  azure_mock: { encryptedAtRest: unknown(), keyOwner: unknown(), tlsEnforced: unknown(), pitr: unknown() },
};

// 비밀 저장소 암호화. 클라우드 비밀 저장소(Secrets Manager·Secret Manager)는 끌 수 없는 암호화
// 온프레 k3s 의 secrets-encryption 은 고객 클러스터 설정이라 모름 = 고객 확인. 감사 로그·앱 신원은 도착 쪽을 보는 규칙이 없어 모름으로 둔다
const PLATFORM: Record<Provider, Platform> = {
  aws: { auditLog: unknown(), secretsEncrypted: attested(true, "AWS Secrets Manager 기본 KMS 암호화 (제공자 문서)"), workloadIdentity: unknown() },
  gcp: { auditLog: unknown(), secretsEncrypted: attested(true, "GCP Secret Manager 기본 암호화 (제공자 문서)"), workloadIdentity: unknown() },
  onprem: { auditLog: unknown(), secretsEncrypted: unknown(), workloadIdentity: attested(false, "온프레는 클라우드 역할이 없다") },
  azure_mock: { auditLog: unknown(), secretsEncrypted: unknown(), workloadIdentity: unknown() },
};

const blankDb = (): Db => ({
  publicAccess: unknown(), encryptedAtRest: unknown(), keyOwner: unknown(), tlsEnforced: unknown(), authMethods: unknown(),
  majorVersion: unknown(), extensions: unknown(), extensionAllowlist: unknown(), encoding: unknown(), collation: unknown(),
  appRoleSuperuser: unknown(), pitr: unknown(),
});

// 명세에 있는 값 (버전·확장). 가져오기가 읽었거나 사람이 명세 검토에서 고친 값
function specDb(c: ReturnType<typeof postgresOf>[number]): Pick<Db, "majorVersion" | "extensions"> {
  const v = c.props.majorVersion;
  return {
    majorVersion: v ? measured(Number(v), `spec_v2 components.${c.id}.majorVersion`) : unknown(),
    extensions: c.props.extensions ? measured([...c.props.extensions].sort(), `spec_v2 components.${c.id}.extensions`) : unknown(),
  };
}

function country(provider: Provider, region: string | null): EnvFacts["country"] {
  const c = regionCountry(provider, region);
  return c ? attested(c, `environments.region ${region}`) : unknown();
}

export interface EnvSide { envId: string; provider: Provider; region: string | null }

// W5: 온프레 Agent 가 보낸 최근 보안 사실 (kind "facts"). 워커가 신선한 것만 골라 넘긴다 (precheck.ts latestAgentFacts)
export type AgentFacts = Extract<AgentReport, { kind: "facts" }>;

// 온프레 postgres 구성요소 하나에 Agent 가 잰 CNPG 사실을 덮는다. 앱 차트가 만든 Cluster 이름(cnpgName)으로 짝짓는다
//   null(못 읽음)인 칸은 덮지 않는다. 짝이 없으면(아직 안 만든 도착 DB) 그대로
function agentDb(spec: AppSpecV2, componentId: string, f: AgentFacts | undefined): Partial<Db> {
  const d = f?.dbs.find((x) => x.cluster === cnpgName(spec, componentId));
  if (!f || !d) return {};
  const src = (what: string) => `agent facts ${f.sentAt} ${d.namespace}/${d.cluster} ${what}`;
  return {
    ...(d.tlsEnforced !== null ? { tlsEnforced: measured(d.tlsEnforced, src("pg_hba (hostnossl reject 여부)")) } : {}),
    ...(d.majorVersion !== null ? { majorVersion: measured(d.majorVersion, src("image")) } : {}),
    ...(d.authMethods !== null ? { authMethods: measured(d.authMethods, src("pg_hba 인증 방식")) } : {}),
    ...(d.exposed !== null ? { publicAccess: measured(d.exposed, src("NodePort·LoadBalancer Service")) } : {}),
  };
}

/** 도착 환경 사실 + 도착 postgres 구성요소마다 DB 사실 (env.db 는 판정에 안 쓰여 빈 칸)
 *  agent: 온프레 도착이면 Agent 의 최근 facts 보고 (W5). 있으면 잰 칸이 고정값·모름을 덮는다 */
export function targetFactsV2(t: EnvSide, spec: AppSpecV2, agent?: AgentFacts): { env: EnvFacts; dbs: { componentId: string; db: Db }[] } {
  const mod = MODULE_DB_FACTS[t.provider];
  const dbs = postgresOf(spec).map((c) => ({
    componentId: c.id,
    db: {
      ...blankDb(), ...mod, ...specDb(c),
      // SSL-1: 출발이 평문을 허용(tlsRequired false)이면 aws.ts·gcp.ts 가 require_tls = false 를 넘김 → 도착도 TLS 강제 아님
      ...((t.provider === "aws" || t.provider === "gcp") && c.props.tlsRequired === false
        ? { tlsEnforced: attested(false, `${t.provider === "aws" ? AWS_PG : GCP_PG}: require_tls = false (출발 평문 허용 그대로, SSL-1)`) } : {}),
      // BK-1: 출발 백업을 그대로 옮기므로 출발이 백업 끔(0일)·PITR 끔이면 도착도 PITR 아님
      ...((t.provider === "aws" || t.provider === "gcp") && (c.props.backup?.retentionDays === 0 || (t.provider === "gcp" && c.props.backup?.pitr === false))
        ? { pitr: attested(false, `${t.provider === "aws" ? AWS_PG : GCP_PG}: 출발 백업 설정 그대로 (BK-1, 백업 ${c.props.backup?.retentionDays ?? "?"}일·PITR ${String(c.props.backup?.pitr)})`) } : {}),
      // 클라우드: 모듈 public = postureOfComponent (aws.ts·gcp.ts 와 같은 함수)
      // 온프레: 앱 차트가 CNPG Service 를 ClusterIP 로만 만든다 (NodePort·LoadBalancer 없음) → 클러스터 밖에서 안 닿음
      //   예전 근거("netpol 기본 차단")는 틀렸다: 어댑터가 NetworkPolicy 를 0개 넘겨 만들어지지 않는다 (W3 에서 기본 차단을 더한다)
      publicAccess: t.provider === "aws" || t.provider === "gcp"
        ? attested(postureOfComponent(spec, c.id).public, `target ${t.provider} postgres public (postureOfComponent)`)
        : t.provider === "onprem" ? attested(false, "gitops/charts/app/templates/cnpg.yaml: CNPG 기본 Service(ClusterIP)만, NodePort·LoadBalancer 없음") : unknown(),
      ...(t.provider === "onprem" ? agentDb(spec, c.id, agent) : {}),
    },
  }));
  return { env: { provider: t.provider, envId: t.envId, country: country(t.provider, t.region), db: blankDb(), platform: PLATFORM[t.provider] }, dbs };
}

// 출발 postgres 구성요소 하나의 DB 사실: 가져오기가 읽은 securityFacts + 명세 값 + 명세의 공개 여부
function sourceDbOf(spec: AppSpecV2, c: ReturnType<typeof postgresOf>[number], securityFacts: Record<string, SourceDbFacts>): Db {
  const net = spec.posture.network.find((n) => n.scope === "component" && n.subject === c.id);
  const pub = net && net.scope === "component" && typeof net.public === "boolean" ? measured(net.public, `spec_v2 posture.network ${c.id}.public`) : unknown();
  return { ...blankDb(), ...(securityFacts[c.id] ?? {}), ...specDb(c), publicAccess: pub };
}

/** 출발 환경 사실. db 칸은 env 규칙용 대표 DB 하나 (postgres 구성요소 id 순 첫째). db 규칙은 sourceDbsV2 로 컴포넌트마다 짝짓는다 */
export function sourceFactsV2(s: EnvSide, spec: AppSpecV2, securityFacts: Record<string, SourceDbFacts> = {}): EnvFacts {
  const c = [...postgresOf(spec)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return {
    provider: s.provider, envId: s.envId, country: country(s.provider, s.region), db: c ? sourceDbOf(spec, c, securityFacts) : blankDb(),
    platform: { auditLog: unknown(), secretsEncrypted: unknown(), workloadIdentity: unknown() },
  };
}

/** 출발 postgres 구성요소마다 DB 사실. 같은 명세라 도착 targetFactsV2().dbs 와 컴포넌트 id 로 짝이 맞는다 */
export function sourceDbsV2(spec: AppSpecV2, securityFacts: Record<string, SourceDbFacts> = {}): { componentId: string; db: Db }[] {
  return postgresOf(spec).map((c) => ({ componentId: c.id, db: sourceDbOf(spec, c, securityFacts) }));
}

/** 앱 설정값 중 평문 값만 (비밀 참조·링크·템플릿은 뺀다). 본 컨테이너 + 사이드카·init 컨테이너. 판정 규칙 P-SEC-1·G-21·G-23 이 본다 */
export function appEnvV2(spec: AppSpecV2): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const take = (env: unknown) => {
    if (!Array.isArray(env)) return;
    for (const e of env) if (e && typeof e === "object" && typeof (e as { value?: unknown }).value === "string")
      out.push({ name: (e as { name: string }).name, value: (e as { value: string }).value });
  };
  for (const c of spec.components) {
    const p = c.props as { env?: unknown; sidecars?: unknown; initContainers?: unknown };
    take(p.env);
    for (const list of [p.sidecars, p.initContainers]) if (Array.isArray(list)) for (const s of list) take((s as { env?: unknown })?.env);
  }
  return out;
}

/** SG-1: IR 서비스·잡의 보안 칸 → 이식성 workload 규칙 입력(packages/security WorkloadSecurity 와 같은 모양, adapters 는 security 를 모름).
 *  컨테이너(주·사이드카·init) securityContext 원문 + 파드 host·hostPath */
export interface WorkloadSecurity {
  componentId: string;
  containers: { name: string; securityContext: Record<string, unknown> | null }[];
  host: { network?: boolean; pid?: boolean; ipc?: boolean } | null;
  hostPaths: string[];
}
export function workloadSecurityV2(spec: AppSpecV2): WorkloadSecurity[] {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
  return spec.components.filter((c) => c.kind === "service" || c.kind === "job").map((c) => {
    const p = c.props as { securityContext?: unknown; sidecars?: unknown; initContainers?: unknown; host?: unknown; podVolumes?: unknown };
    const more = (label: string, list: unknown) => (Array.isArray(list) ? list : [])
      .map((x) => ({ name: `${label}.${String((x as { name?: unknown }).name)}`, securityContext: obj((x as { securityContext?: unknown }).securityContext) }));
    const host = obj(p.host) as WorkloadSecurity["host"];
    const hostPaths = (Array.isArray(p.podVolumes) ? p.podVolumes : []).filter((v) => (v as { type?: unknown }).type === "hostPath")
      .map((v) => String(obj((v as { source?: unknown }).source)?.path ?? (v as { name?: unknown }).name));
    return { componentId: c.id, containers: [{ name: "main", securityContext: obj(p.securityContext) }, ...more("sidecars", p.sidecars), ...more("initContainers", p.initContainers)],
      host, hostPaths };
  });
}

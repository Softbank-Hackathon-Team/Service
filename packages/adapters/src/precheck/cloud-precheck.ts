import { connect } from "node:net";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Exec } from "../terraform/real-runner.js";
import { awsRegion, gcpRegion, maskAccount, onpremContext, scrubAccountIds } from "../common/cli.js";
import { envNumber } from "@svc/contracts";

// Z97: 사전 점검(precheck) 실조회. 예전 STUB(PC-01·02 "확인됨" 고정 글자)을 실제 읽기 호출로 바꾼다.
// 읽기만 한다: aws/gcloud/kubectl 의 describe·list·get 과 TCP 연결, 디스크 statfs. 자원 생성·변경 명령은 없다.
// 결과 = 항목마다 PASS/WARN/FAIL + 이유 한 문장 (+고치는 법). 자격을 못 읽으면 FAIL("자격 없음") — 가짜 PASS 를 내지 않는다.
// 흉내는 MOCK_PRECHECK=1 (시험 전용) 일 때만. 그 결과에는 "MOCK" 이 글자로 붙는다.
// 규칙 출처: Z78 tools/cloud-precheck.sh (z75-51·52: 할당량 코드, Cloud SQL edition), replication precheck DB-03(PG14+).

export type CloudProvider = "aws" | "gcp" | "onprem" | "azure_mock";
export type Verdict = "PASS" | "WARN" | "FAIL";
export interface PrecheckEnvInfo {
  side: "source" | "target"; provider: CloudProvider; name?: string;
  accountId?: string | null;   // environments.account_id (AWS 계정 번호 / GCP 프로젝트)
  externalId?: string | null;
  // pull 모드(ONPREM_FLOOR_VIA_GIT≠0) 온프레 도착: 워커는 고객 클러스터에 들어가지 않는다 (들어오는 포트 0, 고객 Argo CD 가 당긴다).
  //   그래서 자격·API 를 kubectl 대신 Agent 하트비트로 본다. 워커가 채운다 (agent_keys·agent_reports). 없으면 예전처럼 kubectl (push 시연: 로컬 k3d)
  agent?: { keys: number; lastHeartbeatAgeSec: number | null; staleSec: number; k3sVersion?: string | null } | null;
}
export interface CloudCheck { id: string; side: "source" | "target" | "both"; item: string; verdict: Verdict; reason: string; fix?: string; ms?: number }
export interface PrecheckInput {
  source: PrecheckEnvInfo; target: PrecheckEnvInfo;
  sourcePgMajor?: number | null;      // 출발 DB 버전(주 번호). 모르면 null → WARN
  sourceDbBytes?: number | null;      // 출발 DB 크기. 알면 도착 저장소와 견준다
  endpoints?: { name: string; host: string; port: number }[];   // TCP 도달성 대상 (DB 주소 등)
}
export interface PrecheckDeps {
  exec: Exec;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  tcp?: (host: string, port: number, timeoutMs: number) => Promise<{ ok: boolean; ms: number; error?: string }>;
  diskFree?: (path: string) => Promise<number>;   // 남은 바이트
  // L5c: 쪽마다 빌린 관찰 자격 env (워커 _roles.ts awsEnv → envFor 로 워커 자기 자격을 지운 것). 있으면 그쪽 클라우드 CLI 는 이 env 로 부른다.
  //   없으면 지금처럼 env (프로세스 자격: 맥 프로필·gcloud 로그인)
  sideEnv?: Partial<Record<"source" | "target", NodeJS.ProcessEnv>>;
}

// 할당량 코드 (Z78 cloud-precheck.sh 와 같은 값). 필요 수 = 도착 모듈 하나가 만드는 수
export const AWS_QUOTAS = [
  { key: "vpc", svc: "vpc", code: "L-F678F1CE", label: "VPC", need: 1, usage: ["ec2", "describe-vpcs", "--query", "length(Vpcs)"] },
  { key: "eip", svc: "ec2", code: "L-0263D0A3", label: "탄력적 IP(NAT)", need: 1, usage: ["ec2", "describe-addresses", "--query", "length(Addresses)"] },
  { key: "rds", svc: "rds", code: "L-7B6409FD", label: "RDS 인스턴스", need: 1, usage: ["rds", "describe-db-instances", "--query", "length(DBInstances)"] },
] as const;
// GCP 도착 모듈(gcp/app)이 쓰는 API
// FM-CLD-14: iam = 3티어 IR identity(google_service_account) 가 쓰고 apply 가 안 켬. iamcredentials = 고객 SA 빌리기(verify·plan·apply·destroy)
export const GCP_APIS = ["compute.googleapis.com", "container.googleapis.com", "sqladmin.googleapis.com", "artifactregistry.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com"];
// 도착이 받을 수 있는 PostgreSQL 주 번호.
// 【사실】RDS 는 describe-db-engine-versions 로 실조회한다. Cloud SQL 은 목록 API 가 없어 문서 값을 쓴다
// (cloud.google.com/sql/docs/postgres/db-versions, 2026-10 확인 기준 9.6~17) — CLOUDSQL_PG_MAJORS 로 덮을 수 있다
export const CLOUDSQL_PG_MAJORS_DEFAULT = [9.6, 10, 11, 12, 13, 14, 15, 16, 17];
export const MIN_REPL_PG_MAJOR = 14;   // replication DB-03 과 같은 선
export const DISK_FAIL_BYTES = 512 * 1024 ** 2;
export const DISK_WARN_BYTES = 2 * 1024 ** 3;

const T = (env: NodeJS.ProcessEnv) => envNumber(env.PRECHECK_TIMEOUT_MS, 10_000);
const short = (s: string, n = 160) => scrubAccountIds(s).replace(/\s+/g, " ").trim().slice(0, n);

/** CLI 실패를 사람이 읽을 이유로. 명령 없음·자격 없음·권한 없음을 가른다 */
export function cliProblem(cmd: string, r: { code: number; stderr: string }): { kind: "missing" | "nocred" | "denied" | "other"; reason: string } {
  const e = r.stderr;
  if (r.code === 127 || /ENOENT|not found/i.test(e)) return { kind: "missing", reason: `${cmd} 명령이 없음` };
  if (/Unable to locate credentials|ExpiredToken|InvalidClientTokenId|could not be found|SSO session|no active account|Reauthentication|login|credentials/i.test(e))
    return { kind: "nocred", reason: `자격 없음 (${short(e, 100)})` };
  if (/AccessDenied|UnauthorizedOperation|PERMISSION_DENIED|forbidden|403/i.test(e)) return { kind: "denied", reason: `권한 없음 (${short(e, 100)})` };
  return { kind: "other", reason: `${cmd} 실패 rc=${r.code} (${short(e, 100)})` };
}

interface Ctx { deps: PrecheckDeps; env: NodeJS.ProcessEnv; region: string; gcpRegion: string; gcpProject?: string; kubeCtx: string }

async function run(c: Ctx, cmd: string, args: string[]) {
  const r = await c.deps.exec(cmd, args, { cwd: tmpdir(), env: c.env, timeoutMs: T(c.env) });
  let json: unknown;
  if (r.code === 0) { try { json = JSON.parse(r.stdout || "null"); } catch { json = undefined; } }
  return { ...r, json };
}
const aws = (c: Ctx, args: string[]) => run(c, "aws", [...args, "--region", c.region, "--output", "json"]);
const gcloud = (c: Ctx, args: string[]) => run(c, "gcloud", [...args, ...(c.gcpProject ? ["--project", c.gcpProject] : []), "--format=json"]);
const kubectl = (c: Ctx, args: string[]) => run(c, "kubectl", ["--context", c.kubeCtx, ...args]);

// ── 1. 자격 ───────────────────────────────────────────────────
async function credCheck(c: Ctx, e: PrecheckEnvInfo): Promise<CloudCheck> {
  const id = `PC-CRED-${e.side === "source" ? "S" : "T"}`, item = `${e.side === "source" ? "출발" : "도착"} 자격 증명`;
  const side = e.side;
  if (e.provider === "azure_mock") return { id, side, item, verdict: "PASS", reason: "Azure Mock 환경 — 실클라우드가 아니라 자격 조회 대상 아님" };
  if (e.provider === "aws") {
    const r = await aws(c, ["sts", "get-caller-identity"]);
    if (r.code !== 0) { const p = cliProblem("aws", r); return { id, side, item, verdict: "FAIL", reason: p.kind === "missing" ? `자격 없음 — ${p.reason}` : p.reason, fix: "AWS_PROFILE 로그인(aws sso login 또는 aws configure) 뒤 다시 점검" }; }
    const acct = String((r.json as { Account?: string })?.Account ?? "");
    if (e.accountId && acct && e.accountId !== acct)
      return { id, side, item, verdict: "FAIL", reason: `로그인한 계정 ${maskAccount(acct)} 이 환경에 등록된 계정 ${maskAccount(e.accountId)} 과 다름`, fix: "AWS_PROFILE 을 이 환경 계정으로 바꾸거나 환경 연결을 다시 등록" };
    return { id, side, item, verdict: "PASS", reason: `STS GetCallerIdentity 성공 — 계정 ${maskAccount(acct)}`, ms: Math.round(r.ms) };
  }
  if (e.provider === "gcp") {
    // RV-27: 빌린 관찰 토큰(sideEnv 의 CLOUDSDK_AUTH_ACCESS_TOKEN)이 있으면 그것을 본다. 없으면 워커 자기 gcloud 로그인 → 이유 글에 그렇게 적는다
    const borrowed = c.env.CLOUDSDK_AUTH_ACCESS_TOKEN?.trim();
    const whose = borrowed ? "빌린 고객 관찰 자격" : "워커 자기 gcloud 로그인 (빌린 자격 아님)";
    const t = borrowed ? { code: 0, stdout: borrowed, stderr: "", ms: 0 } : await run(c, "gcloud", ["auth", "print-access-token"]);
    if (t.code !== 0 || !t.stdout.trim()) { const p = cliProblem("gcloud", t); return { id, side, item, verdict: "FAIL", reason: p.kind === "missing" ? `자격 없음 — ${p.reason}` : (t.code === 0 ? "자격 없음 (빈 토큰)" : p.reason), fix: "gcloud auth login (또는 서비스 계정 활성화) 뒤 다시 점검" }; }
    const f = c.deps.fetch ?? fetch;
    try {
      // 토큰은 URL 에 넣지 않는다 (본문 POST). 로그·결과에도 안 남긴다
      const res = await f("https://oauth2.googleapis.com/tokeninfo", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `access_token=${encodeURIComponent(t.stdout.trim())}`, signal: AbortSignal.timeout(T(c.env)) });
      const j = await res.json() as { email?: string; expires_in?: string | number; error_description?: string };
      if (!res.ok) return { id, side, item, verdict: "FAIL", reason: `자격 없음 — tokeninfo 거절 (${short(j.error_description ?? String(res.status), 80)})`, fix: "gcloud auth login 다시" };
      const left = Number(j.expires_in ?? 0);
      if (left < 300) return { id, side, item, verdict: "WARN", reason: `토큰 남은 시간 ${left}초 — 이전 도중 만료될 수 있음 (${j.email ?? "계정 모름"})`, fix: "gcloud 가 자동 갱신하지만 장시간 단계 전에 다시 로그인 권장" };
      return { id, side, item, verdict: "PASS", reason: `tokeninfo 확인 — ${whose}, ${j.email ?? "서비스 계정"}, 남은 ${left}초${c.gcpProject ? `, 프로젝트 ${c.gcpProject}` : ""}` };
    } catch (err) {
      return { id, side, item, verdict: "FAIL", reason: `tokeninfo 조회 실패 (${short((err as Error).message, 80)})`, fix: "네트워크(oauth2.googleapis.com:443) 확인" };
    }
  }
  if (e.agent) return agentCredCheck(id, side, item, e.agent);
  // onprem push: kubeconfig 자격 = 그 컨텍스트로 API 서버에 읽기 권한이 있나
  const r = await kubectl(c, ["auth", "can-i", "get", "pods", "-A"]);
  if (r.code !== 0 && !/^no/m.test(r.stdout)) { const p = cliProblem("kubectl", r); return { id, side, item, verdict: "FAIL", reason: p.kind === "missing" ? `자격 없음 — ${p.reason}` : `자격 없음 — 컨텍스트 ${c.kubeCtx} (${p.reason})`, fix: `kubectl config get-contexts 로 ${c.kubeCtx} 확인 (ONPREM_KUBE_CONTEXT)` }; }
  if (r.stdout.trim() !== "yes") return { id, side, item, verdict: "FAIL", reason: `컨텍스트 ${c.kubeCtx} 에 파드 읽기 권한 없음`, fix: "kubeconfig 사용자에 view 이상 역할" };
  return { id, side, item, verdict: "PASS", reason: `kubectl 컨텍스트 ${c.kubeCtx} 로 읽기 권한 확인` };
}

// 온프레 pull: 키가 살아 있고 하트비트가 staleSec 안에 왔으면 "닿는다". 사유 이름은 연결 확인(verify-connection)과 같다
function agentCredCheck(id: string, side: CloudCheck["side"], item: string, a: NonNullable<PrecheckEnvInfo["agent"]>): CloudCheck {
  if (a.keys <= 0) return { id, side, item, verdict: "FAIL", reason: "AGENT_KEY_MISSING — 이 환경에 살아 있는 Agent 키가 없음", fix: "콘솔에서 등록 토큰 발급 → 고객 서버에서 onprem-agent --enroll → tools/onprem-install.sh" };
  if (a.lastHeartbeatAgeSec == null) return { id, side, item, verdict: "FAIL", reason: "AGENT_HEARTBEAT_STALE — Agent 하트비트가 한 번도 안 옴", fix: "고객 서버에서 kubectl -n svc-agent logs deploy/onprem-agent 로 보고 실패 이유 확인" };
  if (a.lastHeartbeatAgeSec > a.staleSec) return { id, side, item, verdict: "FAIL", reason: `AGENT_HEARTBEAT_STALE — 마지막 하트비트 ${a.lastHeartbeatAgeSec}초 전 (기준 ${a.staleSec}초)`, fix: "고객 서버에서 kubectl -n svc-agent get pods 로 Agent 가 도는지 확인" };
  return { id, side, item, verdict: "PASS", reason: `Agent 하트비트 ${a.lastHeartbeatAgeSec}초 전 (살아 있는 키 ${a.keys}개, pull 모드라 워커는 클러스터에 직접 안 붙음)` };
}

// ── 2. 도착 리전·API 활성 ─────────────────────────────────────
async function apiCheck(c: Ctx, e: PrecheckEnvInfo): Promise<CloudCheck | null> {
  const id = "PC-API", side = "target" as const, item = "도착 리전·API 활성";
  if (e.provider === "aws") {
    const r = await aws(c, ["ec2", "describe-regions", "--all-regions", "--region-names", c.region]);
    if (r.code !== 0) return { id, side, item, verdict: "FAIL", reason: cliProblem("aws", r).reason };
    const s = (r.json as { Regions?: { OptInStatus?: string }[] })?.Regions?.[0]?.OptInStatus;
    if (s === "not-opted-in") return { id, side, item, verdict: "FAIL", reason: `리전 ${c.region} 이 계정에서 꺼져 있음(opt-in 안 함)`, fix: "AWS 콘솔 계정 설정에서 리전 활성화" };
    return { id, side, item, verdict: "PASS", reason: `리전 ${c.region} 사용 가능 (${s ?? "opt-in 불필요"})` };
  }
  if (e.provider === "gcp") {
    if (!c.gcpProject) return { id, side, item, verdict: "FAIL", reason: "GCP 프로젝트가 정해지지 않음", fix: "GCP_PROJECT 또는 환경 account_id 에 프로젝트 ID" };
    const r = await gcloud(c, ["services", "list", "--enabled"]);
    if (r.code !== 0) return { id, side, item, verdict: "FAIL", reason: cliProblem("gcloud", r).reason };
    const on = new Set(((r.json as { config?: { name?: string }; name?: string }[]) ?? []).map((s) => s.config?.name ?? s.name?.split("/").pop() ?? ""));
    const miss = GCP_APIS.filter((a) => !on.has(a));
    if (miss.length) return { id, side, item, verdict: "FAIL", reason: `꺼진 API: ${miss.join(", ")}`, fix: `gcloud services enable ${miss.join(" ")} --project ${c.gcpProject} (사람이 실행)` };
    return { id, side, item, verdict: "PASS", reason: `필요 API ${GCP_APIS.length}개 켜짐 (프로젝트 ${c.gcpProject}, 리전 ${c.gcpRegion})` };
  }
  if (e.provider === "onprem" && e.agent) {
    // credCheck 가 PASS 일 때만 온다 = 하트비트가 새것. CNPG CRD 는 하트비트에 없어 여기서 못 본다 → 배포 확인(Agent deploy 보고)이 본다
    const v = e.agent.k3sVersion?.trim();
    if (!v) return { id, side, item, verdict: "WARN", reason: "Agent 하트비트에 k3s 버전이 없음 — 클러스터 버전 확인 못 함" };
    return { id, side, item, verdict: "PASS", reason: `k3s ${v} (Agent 하트비트 기준). CNPG 운영자는 배포 확인 때 Agent 보고로 봄` };
  }
  if (e.provider === "onprem") {
    const r = await kubectl(c, ["get", "--raw", "/readyz"]);
    if (r.code !== 0) return { id, side, item, verdict: "FAIL", reason: `API 서버 준비 안 됨 — ${cliProblem("kubectl", r).reason}` };
    const crd = await kubectl(c, ["get", "crd", "clusters.postgresql.cnpg.io", "-o", "name"]);
    if (crd.code !== 0) return { id, side, item, verdict: "WARN", reason: "API 서버는 준비됨, CNPG(DB 운영자) CRD 없음 — DB 를 만들 수 없음", fix: "CNPG 운영자 설치" };
    return { id, side, item, verdict: "PASS", reason: `k8s API 준비됨 + CNPG CRD 있음 (${c.kubeCtx})` };
  }
  return null;
}

// ── 3. 결제 연결 ─────────────────────────────────────────────
async function billingCheck(c: Ctx, e: PrecheckEnvInfo, cred: CloudCheck): Promise<CloudCheck | null> {
  const id = "PC-BILL", side = "target" as const, item = "결제 연결";
  if (e.provider === "gcp") {
    if (!c.gcpProject) return { id, side, item, verdict: "FAIL", reason: "GCP 프로젝트가 정해지지 않음" };
    const r = await run(c, "gcloud", ["billing", "projects", "describe", c.gcpProject, "--format=json"]);
    if (r.code !== 0) { const p = cliProblem("gcloud", r); return { id, side, item, verdict: p.kind === "denied" ? "WARN" : "FAIL", reason: p.kind === "denied" ? `결제 정보 읽기 권한 없음 — 확인 못 함 (${p.reason})` : p.reason, fix: "roles/billing.viewer 또는 콘솔에서 결제 계정 연결 확인" }; }
    const b = r.json as { billingEnabled?: boolean; billingAccountName?: string };
    if (!b?.billingEnabled) return { id, side, item, verdict: "FAIL", reason: `프로젝트 ${c.gcpProject} 에 결제가 연결돼 있지 않음 — 자원 생성이 거절됨`, fix: "콘솔 결제 → 프로젝트에 결제 계정 연결 (사람)" };
    return { id, side, item, verdict: "PASS", reason: `결제 연결됨 (${b.billingAccountName ?? "결제 계정"})` };
  }
  if (e.provider === "aws") {
    // 【사실】AWS 는 "결제 수단 연결 여부"를 읽는 공개 API 가 없다(결제 콘솔 전용). 계정이 STS 로 살아 있으면 결제 수단이 있는 계정이다.
    // Cost Explorer 는 호출마다 요금(0.01달러)이 붙어 쓰지 않는다
    if (cred.verdict !== "PASS") return { id, side, item, verdict: "FAIL", reason: "자격이 없어 계정 상태를 못 봄" };
    return { id, side, item, verdict: "PASS", reason: "AWS 는 결제 수단 없이 계정 활성 불가 — STS 성공으로 판단(결제 연결 직접 조회 API 없음)" };
  }
  return null;   // 온프레·Azure Mock 은 결제 개념 없음
}

// ── 4. 할당량 ────────────────────────────────────────────────
async function quotaChecks(c: Ctx, e: PrecheckEnvInfo): Promise<CloudCheck[]> {
  const out: CloudCheck[] = [];
  if (e.provider === "aws") {
    for (const q of AWS_QUOTAS) {
      const id = `PC-QUOTA-${q.key.toUpperCase()}`, item = `할당량 ${q.label}`;
      const [lim, use] = await Promise.all([
        aws(c, ["service-quotas", "get-service-quota", "--service-code", q.svc, "--quota-code", q.code]),
        aws(c, [...q.usage]),
      ]);
      const L = Number((lim.json as { Quota?: { Value?: number } })?.Quota?.Value);
      const U = Number(use.json);
      if (lim.code !== 0 || !Number.isFinite(L)) { out.push({ id, side: "target", item, verdict: "WARN", reason: `한도 못 읽음 (${lim.code ? cliProblem("aws", lim).reason : "값 없음"}, ${q.svc} ${q.code})` }); continue; }
      if (use.code !== 0 || !Number.isFinite(U)) { out.push({ id, side: "target", item, verdict: "WARN", reason: `지금 쓰는 수 못 읽음 (${cliProblem("aws", use).reason})` }); continue; }
      const left = L - U;
      out.push(left < q.need
        ? { id, side: "target", item, verdict: "FAIL", reason: `남은 ${left} < 필요 ${q.need} (한도 ${L}, 사용 ${U})`, fix: `Service Quotas 에서 ${q.code} 증설 요청 또는 안 쓰는 ${q.label} 정리` }
        : { id, side: "target", item, verdict: left === q.need ? "WARN" : "PASS", reason: `한도 ${L} − 사용 ${U} = 남은 ${left}, 필요 ${q.need}${left === q.need ? " (여유 없음)" : ""}` });
    }
  } else if (e.provider === "gcp" && c.gcpProject) {
    const r = await gcloud(c, ["compute", "regions", "describe", c.gcpRegion]);
    if (r.code !== 0) out.push({ id: "PC-QUOTA-GCE", side: "target", item: "할당량 리전 주소·CPU", verdict: "WARN", reason: `리전 할당량 못 읽음 (${cliProblem("gcloud", r).reason})` });
    else {
      const qs = ((r.json as { quotas?: { metric: string; limit: number; usage: number }[] })?.quotas ?? []);
      for (const [metric, label, need] of [["CPUS", "vCPU", 4], ["IN_USE_ADDRESSES", "외부 IP", 1], ["STATIC_ADDRESSES", "고정 IP", 1]] as const) {
        const q = qs.find((x) => x.metric === metric);
        const id = `PC-QUOTA-${metric}`, item = `할당량 ${label}`;
        if (!q) { out.push({ id, side: "target", item, verdict: "WARN", reason: `${metric} 항목이 없음` }); continue; }
        const left = q.limit - q.usage;
        out.push({ id, side: "target", item, verdict: left < need ? "FAIL" : left === need ? "WARN" : "PASS",
          reason: `한도 ${q.limit} − 사용 ${q.usage} = 남은 ${left}, 필요 ${need} (${c.gcpRegion})`, ...(left < need ? { fix: "IAM 및 관리자 → 할당량에서 증설 요청" } : {}) });
      }
    }
    // Cloud SQL: 인스턴스 할당량 API 없음 → 지금 개수 + edition 규칙(Z78 z75-52)
    const s = await gcloud(c, ["sql", "instances", "list"]);
    const n = s.code === 0 ? ((s.json as unknown[]) ?? []).length : NaN;
    const ver = c.env.CLOUDSQL_DB_VERSION ?? "POSTGRES_16", tier = c.env.CLOUDSQL_TIER ?? "db-f1-micro";
    const ed = c.env.CLOUDSQL_EDITION ?? "ENTERPRISE";   // gcp/app 모듈 기본 (z77-sql-edition)
    const major = Number(ver.split("_").pop());
    let v: Verdict = "PASS", why = `Cloud SQL 지금 ${Number.isNaN(n) ? "개수 못 읽음" : `${n}개`}, ${ver}/${tier}/${ed}`;
    if (major >= 16 && ed === "ENTERPRISE_PLUS" && /^db-(f1-micro|g1-small)$/.test(tier)) { v = "FAIL"; why = `ENTERPRISE_PLUS 는 공유 코어 ${tier} 를 받지 않음 ("Invalid Tier")`; }
    else if (Number.isNaN(n)) v = "WARN";
    out.push({ id: "PC-QUOTA-SQL", side: "target", item: "할당량 Cloud SQL", verdict: v, reason: why, ...(v === "FAIL" ? { fix: "CLOUDSQL_EDITION=ENTERPRISE 또는 전용 코어 티어" } : {}) });
  }
  return out;
}

// ── 5. DB 버전 호환 ──────────────────────────────────────────
async function dbVersionCheck(c: Ctx, i: PrecheckInput): Promise<CloudCheck | null> {
  const id = "PC-DBVER", side = "both" as const, item = "DB 버전 호환";
  const t = i.target.provider;
  if (t === "azure_mock") return null;
  const src = i.sourcePgMajor;
  if (src == null) return { id, side, item, verdict: "WARN", reason: "출발 DB 버전을 못 읽음 (REPL_SOURCE_URL 없음 또는 접속 실패) — 호환 확인 못 함", fix: "REPL_SOURCE_URL 을 넣고 다시 점검" };
  if (src < MIN_REPL_PG_MAJOR) return { id, side, item, verdict: "FAIL", reason: `출발 PostgreSQL ${src} — 논리 복제 경로는 ${MIN_REPL_PG_MAJOR} 이상 필요`, fix: "출발 DB 를 먼저 올리거나 덤프 방식으로 바꿈" };
  let majors: number[] = [], from = "";
  if (t === "aws") {
    const r = await aws(c, ["rds", "describe-db-engine-versions", "--engine", "postgres", "--query", "DBEngineVersions[].EngineVersion"]);
    if (r.code !== 0) return { id, side, item, verdict: "WARN", reason: `RDS 지원 버전 못 읽음 (${cliProblem("aws", r).reason})` };
    majors = [...new Set(((r.json as string[]) ?? []).map((v) => Number(v.split(".")[0])))];
    from = "RDS describe-db-engine-versions";
  } else if (t === "gcp") {
    majors = (c.env.CLOUDSQL_PG_MAJORS ? c.env.CLOUDSQL_PG_MAJORS.split(",").map(Number) : CLOUDSQL_PG_MAJORS_DEFAULT);
    from = "Cloud SQL 문서 목록";
  } else {
    majors = [14, 15, 16, 17]; from = "CNPG 이미지(ghcr.io/cloudnative-pg/postgresql) 지원";
  }
  // 논리 복제는 같은 주 번호 또는 더 높은 쪽으로만 옮긴다 (낮은 쪽은 문법·카탈로그 차이)
  const ok = majors.filter((m) => m >= src);
  if (!ok.length) return { id, side, item, verdict: "FAIL", reason: `출발 PG ${src} 이상을 도착이 지원하지 않음 (도착 최대 ${Math.max(...majors)}, ${from})` };
  if (!majors.includes(src)) return { id, side, item, verdict: "WARN", reason: `도착에 같은 PG ${src} 없음 — ${Math.min(...ok)} 로 올려 옮김 (${from})` };
  return { id, side, item, verdict: "PASS", reason: `출발 PG ${src} = 도착 지원 목록에 있음 (${from})` };
}

// ── 6. 네트워크 도달성 ───────────────────────────────────────
export const tcpProbe = (host: string, port: number, timeoutMs: number) => new Promise<{ ok: boolean; ms: number; error?: string }>((res) => {
  const t0 = performance.now();
  const s = connect({ host, port });
  const done = (ok: boolean, error?: string) => { s.destroy(); res({ ok, ms: Math.round(performance.now() - t0), ...(error ? { error } : {}) }); };
  s.setTimeout(timeoutMs, () => done(false, `시간 초과 ${timeoutMs}ms`));
  s.once("connect", () => done(true));
  s.once("error", (e) => done(false, e.message));
});

export function apiEndpoint(p: CloudProvider, region: string): { name: string; host: string; port: number } | null {
  if (p === "aws") return { name: "AWS API", host: `sts.${region}.amazonaws.com`, port: 443 };
  if (p === "gcp") return { name: "GCP API", host: "sqladmin.googleapis.com", port: 443 };
  return null;
}

async function netChecks(c: Ctx, i: PrecheckInput): Promise<CloudCheck[]> {
  const tcp = c.deps.tcp ?? tcpProbe, to = Number(c.env.PRECHECK_TCP_TIMEOUT_MS ?? 3000);
  const list = [...(i.endpoints ?? [])];
  for (const e of [i.source, i.target]) { const a = apiEndpoint(e.provider, c.region); if (a && !list.some((x) => x.host === a.host)) list.push(a); }
  const out = await Promise.all(list.map(async (ep, n) => {
    const r = await tcp(ep.host, ep.port, to);
    return { id: `PC-NET-${n + 1}`, side: "both" as const, item: `네트워크 ${ep.name}`, verdict: (r.ok ? "PASS" : "FAIL") as Verdict,
      reason: r.ok ? `${ep.host}:${ep.port} TCP 연결 ${r.ms}ms` : `${ep.host}:${ep.port} 연결 안 됨 (${r.error})`,
      ...(r.ok ? {} : { fix: "방화벽·보안 그룹·터널(데모 relay) 확인" }) };
  }));
  if (!(i.endpoints ?? []).length)
    out.push({ id: "PC-NET-DB", side: "both", item: "네트워크 DB 주소", verdict: "WARN", reason: "DB 주소가 아직 없음 (도착 DB 는 apply 뒤에 생김) — 클라우드 API 도달성만 확인" });
  return out;
}

// ── 7. 디스크 여유 ──────────────────────────────────────────
async function diskCheck(c: Ctx, i: PrecheckInput): Promise<CloudCheck> {
  const id = "PC-DISK", side = "both" as const, item = "디스크 여유";
  const path = c.env.TF_WORK_DIR || tmpdir();
  const free = c.deps.diskFree ?? (async (p: string) => { const s = await statfs(p); return Number(s.bavail) * Number(s.bsize); });
  let bytes: number;
  try { bytes = await free(path); } catch (e) { return { id, side, item, verdict: "WARN", reason: `디스크 여유 못 읽음 (${short((e as Error).message, 80)})` }; }
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  const targetGb = Number(c.env.DB_STORAGE_GB ?? 20);   // 도착 DB 저장소 (aws/gcp app 모듈 기본 20GB)
  if (bytes < DISK_FAIL_BYTES) return { id, side, item, verdict: "FAIL", reason: `작업 디스크(${path}) 남은 ${gb(bytes)}GB < 0.5GB — terraform·로그를 못 씀`, fix: "빌드 산출물·캐시 정리" };
  if (i.sourceDbBytes != null && i.sourceDbBytes * 2 > targetGb * 1024 ** 3)
    return { id, side, item, verdict: "WARN", reason: `출발 DB ${gb(i.sourceDbBytes)}GB × 2 > 도착 저장소 ${targetGb}GB — 초기 복사 중 WAL 로 넘칠 수 있음`, fix: "DB_STORAGE_GB 를 올림" };
  return { id, side, item, verdict: bytes < DISK_WARN_BYTES ? "WARN" : "PASS",
    reason: `작업 디스크 남은 ${gb(bytes)}GB${i.sourceDbBytes != null ? `, 출발 DB ${gb(i.sourceDbBytes)}GB ≤ 도착 ${targetGb}GB 의 절반` : ""}` };
}

// ── 흉내 (시험 전용) ─────────────────────────────────────────
export const mockPrecheckEnabled = (env: NodeJS.ProcessEnv = process.env) => env.MOCK_PRECHECK === "1";
export function mockChecks(): CloudCheck[] {
  return [
    { id: "PC-CRED-S", side: "source", item: "출발 자격 증명", verdict: "PASS", reason: "MOCK_PRECHECK=1 — 시험용 흉내 (실조회 안 함)" },
    { id: "PC-CRED-T", side: "target", item: "도착 자격 증명", verdict: "PASS", reason: "MOCK_PRECHECK=1 — 시험용 흉내 (실조회 안 함)" },
  ];
}

/** 사전 점검 전체. 자격이 FAIL 인 쪽은 그 쪽 클라우드 조회를 건너뛴다(같은 "자격 없음"이 줄줄이 나오지 않게) */
export async function runCloudPrecheck(i: PrecheckInput, deps: PrecheckDeps): Promise<CloudCheck[]> {
  const env = deps.env ?? process.env;
  if (mockPrecheckEnabled(env)) return mockChecks();
  const projOf = (e: PrecheckEnvInfo) => e.provider === "gcp" ? (env.GCP_PROJECT || e.accountId || e.externalId || undefined) : undefined;
  const c: Ctx = { deps, env, region: awsRegion(env), gcpRegion: gcpRegion(env),
    gcpProject: projOf(i.target) ?? projOf(i.source), kubeCtx: onpremContext(env) };
  // L5c: 출발·도착 클라우드 조회는 그쪽 빌린 자격으로 (TCP·디스크는 워커 자신의 것이라 기본 env)
  // RV-27: 빌린 GCP 토큰 env 는 그쪽 프로젝트(CLOUDSDK_CORE_PROJECT)도 들고 온다 → 그쪽 조회의 --project 를 그것으로 (GCP_PROJECT 덮어쓰기보다 앞)
  const sideCtx = (side: "source" | "target"): Ctx => {
    const se = deps.sideEnv?.[side];
    if (!se) return c;
    return { ...c, env: se, ...(se.CLOUDSDK_AUTH_ACCESS_TOKEN && se.CLOUDSDK_CORE_PROJECT ? { gcpProject: se.CLOUDSDK_CORE_PROJECT } : {}) };
  };
  const cS = sideCtx("source"), cT = sideCtx("target");
  const t0 = Date.now();
  const [cs, ct] = await Promise.all([credCheck(cS, i.source), credCheck(cT, i.target)]);
  const out: CloudCheck[] = [cs, ct];
  const tasks: Promise<CloudCheck | CloudCheck[] | null>[] = [netChecks(c, i), diskCheck(c, i)];
  if (ct.verdict !== "FAIL") tasks.push(apiCheck(cT, i.target), billingCheck(cT, i.target, ct), quotaChecks(cT, i.target));
  else out.push({ id: "PC-SKIP", side: "target", item: "도착 클라우드 조회", verdict: "FAIL", reason: "도착 자격이 없어 API·결제·할당량 조회를 건너뜀" });
  tasks.push(dbVersionCheck(cT, i));   // 도착이 받는 버전 조회 (출발 버전은 REPL_SOURCE_URL 로 이미 앎)
  for (const r of await Promise.all(tasks)) { if (Array.isArray(r)) out.push(...r); else if (r) out.push(r); }
  out.push({ id: "PC-TIME", side: "both", item: "점검 시간", verdict: "PASS", reason: `실조회 ${out.length}항목 ${Date.now() - t0}ms` });
  return out;
}

/** 계약 PrecheckItem 모양으로 (FAIL→block, WARN→warn, PASS→info). message 첫머리에 판정과 항목 이름을 붙인다 */
export function toPrecheckItems(cs: CloudCheck[]): { id: string; level: "block" | "warn" | "info"; message: string; fix?: string }[] {
  return cs.map((x) => ({ id: x.id, level: x.verdict === "FAIL" ? "block" : x.verdict === "WARN" ? "warn" : "info",
    message: `${x.verdict} ${x.item} — ${x.reason}`, ...(x.fix ? { fix: x.fix } : {}) }));
}

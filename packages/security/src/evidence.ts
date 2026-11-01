import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Finding } from "@svc/contracts";
import { CONTROLS, sourcesFor, type EnvKind } from "./controls.js";
import { actionsOfPolicy, parseClusterRole, parseGcpCustomRole } from "./permissions.js";
import { summarizeCells, type Attestation, type Cell } from "./summarize.js";

// 통제 12개 증거 수집기 (작업 Z39). 레포의 코드·설정·권한 파일을 읽어 통제마다 Finding 을 만든다. 순수 함수 + 파일 읽기 1개.
//
// 무엇이 진짜이고 무엇이 아닌가 (화면에도 그대로 나온다)
//   - 정적 근거: Terraform 모듈, 최소 권한 파일, Helm 차트, 온프레 부트스트랩·데모 매니페스트를 실제로 읽어 판정한다.
//     "배포하면 이렇게 된다"이지 "지금 클라우드가 이렇다"가 아니다. Prowler·Trivy·GuardDuty 같은 실 스캐너를 돌린 게 아니다.
//   - 실 값: SEC-AUD-02 는 API 가 감사 체인을 처음부터 다시 계산한 결과를 받는다 (audit_verify).
//   - 근거가 없는 통제(MFA, 활성 위협, CVE)는 Finding 을 만들지 않는다 → 칸이 unknown, 이유에 "실 계정 스캔 필요"가 붙는다.
// Finding.tool 은 그 통제의 원래 도구 이름을 쓰고, toolCheckId 는 static_* 로, evidence 는 "정적:" 으로 시작한다 → STUB: 과 구분된다
// DRAFT(ai): 판정 규칙(아래 CHECKS)은 팀 검토 전. 어떤 줄이 바뀌면 시험(evidence.test.ts)이 같이 깨진다

// 읽는 파일 (레포 루트 기준). 권한·차트 폴더는 env 로 바꿀 수 있다 (API 와 같은 PERMISSIONS_DIR, CHART_DIR)
export const EVIDENCE_FILES = {
  awsEnvTf: "infra/modules/aws/env/main.tf",
  awsAppTf: "infra/modules/aws/app/main.tf",
  gcpEnvTf: "infra/modules/gcp/env/main.tf",
  gcpAppTf: "infra/modules/gcp/app/main.tf",
  onpremAppTf: "infra/modules/onprem/app/main.tf",
  onpremBootstrap: "infra/onprem/bootstrap.sh",
  onpremDbExpose: "deploy/onprem-demo/manifests/db-expose.yaml",
  awsCeiling: "infra/permissions/aws-operate-role-policy.json",
  awsBoundary: "infra/permissions/aws-app-role-boundary.json",
  awsSessPlan: "infra/permissions/aws-session-policy-plan.json",
  awsSessApply: "infra/permissions/aws-session-policy-apply.json",
  awsSessDestroy: "infra/permissions/aws-session-policy-destroy.json",
  gcpRole: "infra/permissions/gcp-operate-custom-role.yaml",
  gcpIamRole: "infra/permissions/gcp-operate-iam-custom-role.yaml",
  onpremRole: "infra/permissions/onprem-operate-clusterrole.yaml",
  onpremKyverno: "infra/permissions/onprem-kyverno-platform.yaml",
  chartDeploy: "gitops/charts/app/templates/deployment.yaml",
  chartSa: "gitops/charts/app/templates/serviceaccount.yaml",
  chartIngress: "gitops/charts/app/templates/ingress.yaml",
  chartValues: "gitops/charts/app/values.yaml",
} as const;
export type EvidenceKey = keyof typeof EVIDENCE_FILES;
// 키 → { 보여 줄 경로, 내용(없으면 null) }
export type EvidenceFiles = Record<EvidenceKey, { path: string; text: string | null }>;

export function readEvidenceFiles(root: string, o: { permissionsDir?: string; chartDir?: string } = {}): EvidenceFiles {
  const out = {} as EvidenceFiles;
  for (const [k, rel] of Object.entries(EVIDENCE_FILES) as [EvidenceKey, string][]) {
    let abs = join(root, rel);
    if (o.permissionsDir && rel.startsWith("infra/permissions/")) abs = join(o.permissionsDir, rel.slice("infra/permissions/".length));
    if (o.chartDir && rel.startsWith("gitops/charts/app/")) abs = join(o.chartDir, rel.slice("gitops/charts/app/".length));
    let text: string | null = null;
    try { text = readFileSync(abs, "utf8"); } catch { text = null; }
    out[k] = { path: rel, text };
  }
  return out;
}

// ───────── 판정 ─────────
type Verdict = { status: "pass" | "fail" | "unknown"; severity?: Finding["severity"]; evidence: string; files: EvidenceKey[] };
type Check = (f: EvidenceFiles, ctx: CheckCtx) => Verdict | null;   // null = 이 환경에서 근거 없음 (Finding 안 만듦)
interface CheckCtx { auditChain: { ok: boolean; checked: number; partial: boolean; brokenAtSeq: number | null } | null }

const t = (f: EvidenceFiles, k: EvidenceKey) => f[k].text;
const missing = (f: EvidenceFiles, ks: EvidenceKey[]) => ks.filter((k) => f[k].text === null);
const noFiles = (f: EvidenceFiles, ks: EvidenceKey[]): Verdict | null => {
  const m = missing(f, ks);
  return m.length ? { status: "unknown", evidence: `파일 없음: ${m.map((k) => f[k].path).join(", ")}`, files: ks } : null;
};

// Terraform 블록 하나 (resource "<type>" "<name>" { ... }) 를 중괄호 짝으로 잘라낸다. HCL 파서가 아니다
export function tfBlocks(tf: string, type: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`resource\\s+"${type}"\\s+"[^"]+"\\s*\\{`, "g");
  for (const m of tf.matchAll(re)) {
    let depth = 0, i = m.index! + m[0].length - 1;
    for (; i < tf.length; i++) { if (tf[i] === "{") depth++; else if (tf[i] === "}" && --depth === 0) break; }
    out.push(tf.slice(m.index!, i + 1));
  }
  return out;
}
const tfAttr = (block: string, name: string) => block.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim().replace(/\s*#.*$/, "") ?? null;

// 비밀값처럼 생긴 문자열 (api security/scan.ts 와 같은 모양, 파일용으로 줄임)
const FILE_SECRET = [
  { kind: "aws_access_key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "github_token", re: /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{20,}/ },
  { kind: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "tf_literal_password", re: /^\s*(password|master_password|admin_password)\s*=\s*"[^"$]{4,}"/m },
];
const ADMIN_DB_PORTS = [22, 3389, 5432, 3306, 6443];

const IAM02_FILES: Record<"aws" | "gcp" | "onprem", EvidenceKey[]> = {
  aws: ["awsCeiling", "awsBoundary", "awsSessPlan", "awsSessApply", "awsSessDestroy"],
  gcp: ["gcpRole", "gcpIamRole"],
  onprem: ["onpremRole"],
};

const CHECKS: Partial<Record<string, Partial<Record<"aws" | "gcp" | "onprem", Check>>>> = {
  // 관리자 전권(*:*) 0개 = 우리가 고객에게 달라는 역할·정책에 와일드카드 동작이 없다
  "SEC-IAM-02": Object.fromEntries((["aws", "gcp", "onprem"] as const).map((p) => [p, (f: EvidenceFiles): Verdict | null => {
    const ks = IAM02_FILES[p];
    const have = ks.filter((k) => f[k].text !== null);
    if (!have.length) return noFiles(f, ks);
    const acts = have.flatMap((k) => {
      const x = f[k].text!;
      if (p === "aws") return actionsOfPolicy(JSON.parse(x));
      if (p === "gcp") return parseGcpCustomRole(x);
      return parseClusterRole(x);
    });
    const wild = acts.filter((a) => a.includes("*"));
    return wild.length
      ? { status: "fail", severity: "critical", evidence: `와일드카드 동작 ${wild.length}개 (${wild.slice(0, 3).join(", ")})`, files: have }
      : { status: "pass", evidence: `파일 ${have.length}개 · 동작 ${acts.length}개 · 와일드카드 0`, files: have };
  }])),

  // DB 저장·전송 암호화
  "SEC-ENC-01": {
    aws: (f) => noFiles(f, ["awsAppTf"]) ?? (() => {
      const db = tfBlocks(t(f, "awsAppTf")!, "aws_db_instance")[0];
      if (!db) return { status: "unknown", evidence: "aws_db_instance 없음", files: ["awsAppTf"] };
      const enc = tfAttr(db, "storage_encrypted") === "true";
      // 【사실】 RDS for PostgreSQL 15 이상은 rds.force_ssl 기본 1 (모듈 변수 검사가 15·16·17 만 받는다)
      const pg15 = /contains\(\["15",\s*"16",\s*"17"\]/.test(t(f, "awsAppTf")!);
      const forceSslOff = /rds\.force_ssl"[\s\S]{0,40}value\s*=\s*"0"/.test(t(f, "awsAppTf")!);
      const ok = enc && pg15 && !forceSslOff;
      return { status: ok ? "pass" : "fail", severity: ok ? "info" : "high", files: ["awsAppTf"],
        evidence: `storage_encrypted ${enc} · 엔진 15+ (rds.force_ssl 기본 1) ${pg15} · force_ssl 끔 ${forceSslOff}` } as Verdict;
    })(),
    gcp: (f) => noFiles(f, ["gcpAppTf"]) ?? (() => {
      const ssl = /ssl_mode\s*=\s*"ENCRYPTED_ONLY"|ssl_mode\s*=\s*"TRUSTED_CLIENT_CERTIFICATE_REQUIRED"/.test(t(f, "gcpAppTf")!);
      // Cloud SQL 은 저장 암호화가 항상 켜져 있다 (끄는 칸이 없다)
      return { status: ssl ? "pass" : "fail", severity: ssl ? "info" : "high", files: ["gcpAppTf"],
        evidence: `ssl_mode ${ssl ? "ENCRYPTED_ONLY" : "설정 없음"} · 저장 암호화는 Cloud SQL 기본(끌 수 없음)` } as Verdict;
    })(),
    onprem: (f) => noFiles(f, ["onpremAppTf"]) ?? ({ status: "unknown", files: ["onpremAppTf"],
      evidence: "CNPG 전송 TLS 는 오퍼레이터 기본. 디스크 암호화는 호스트 설정이라 레포에서 확인 불가 (Agent 확인 필요)" }),
  },

  // 외부 노출은 TLS 만 = 들어오는 길이 cloudflared 터널(인바운드 0, 엣지 TLS)이거나 Ingress 에 tls 가 있다
  "SEC-ENC-02": Object.fromEntries((["aws", "gcp", "onprem"] as const).map((p) => [p, (f: EvidenceFiles): Verdict | null =>
    noFiles(f, ["chartValues", "chartIngress"]) ?? (() => {
      const mode = t(f, "chartValues")!.match(/ingress:\s*\{\s*mode:\s*(\w+)/)?.[1] ?? null;
      const lbTls = /tls:/.test(t(f, "chartIngress")!);
      const ok = mode === "cloudflared" || (mode === "lb" && lbTls);
      return { status: ok ? "pass" : "fail", severity: ok ? "info" : "high", files: ["chartValues", "chartIngress"],
        evidence: `기본 ingress.mode ${mode ?? "?"}${mode === "cloudflared" ? " (인바운드 0, Cloudflare 엣지 TLS)" : ""} · lb 모드 tls ${lbTls ? "있음" : "없음"}` } as Verdict;
    })()])),

  // 시크릿이 코드·환경 변수에 없음 (이미지 안은 Trivy 몫이라 범위 밖이라고 적는다)
  "SEC-ENC-03": Object.fromEntries((["aws", "gcp", "onprem"] as const).map((p) => [p, (f: EvidenceFiles): Verdict | null => {
    const ks = (Object.keys(EVIDENCE_FILES) as EvidenceKey[]).filter((k) => f[k].text !== null);
    if (!ks.length) return null;
    const hits: string[] = [];
    for (const k of ks) for (const s of FILE_SECRET) if (s.re.test(f[k].text!)) hits.push(`${s.kind}@${f[k].path}`);
    const dep = t(f, "chartDeploy") ?? "";
    const lit = [...dep.matchAll(/name:\s*"?([A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*)"?\s*,\s*value:/g)].map((m) => m[1]!);
    const bad = hits.length + lit.length;
    return { status: bad ? "fail" : "pass", severity: bad ? "critical" : "info", files: ks,
      evidence: bad ? `${hits.concat(lit.map((x) => `env ${x}`)).slice(0, 3).join(", ")}`
        : `파일 ${ks.length}개 · 비밀값 모양 0 · 차트 비밀 env 는 secretKeyRef 만 (이미지 안은 미검사)` };
  }])),

  // 클라우드·클러스터 감사 로그
  "SEC-AUD-01": {
    aws: (f) => noFiles(f, ["awsEnvTf"]) ?? (() => {
      const eks = tfBlocks(t(f, "awsEnvTf")!, "aws_eks_cluster")[0] ?? "";
      const logs = tfAttr(eks, "enabled_cluster_log_types");
      const audit = !!logs && /"audit"/.test(logs);
      return { status: audit ? "pass" : "fail", severity: audit ? "info" : "medium", files: ["awsEnvTf"],
        evidence: audit ? `EKS enabled_cluster_log_types ${logs}` : "EKS enabled_cluster_log_types 없음 → 쿠버네티스 감사 로그 꺼짐 (CloudTrail 은 계정 설정이라 미확인)" } as Verdict;
    })(),
    gcp: (f) => noFiles(f, ["gcpEnvTf"]) ?? (() => {
      const gke = tfBlocks(t(f, "gcpEnvTf")!, "google_container_cluster")[0] ?? "";
      const off = /logging_service\s*=\s*"none"/.test(gke);
      // 【사실】 GCP 관리 활동(Admin Activity) 감사 로그는 항상 기록되고 끌 수 없다 (Cloud Audit Logs 문서)
      return { status: off ? "fail" : "pass", severity: off ? "medium" : "info", files: ["gcpEnvTf"],
        evidence: off ? "GKE logging_service = none" : "GKE 로깅 끄기 없음 · 관리 활동 감사 로그는 GCP 기본(끌 수 없음)" } as Verdict;
    })(),
    onprem: (f) => noFiles(f, ["onpremBootstrap"]) ?? (() => {
      const audit = /audit-log-path|audit-policy-file/.test(t(f, "onpremBootstrap")!);
      return { status: audit ? "pass" : "fail", severity: audit ? "info" : "medium", files: ["onpremBootstrap"],
        evidence: audit ? "k3s audit-log-path 있음" : "k3s 설치 옵션에 audit-log-path 없음 → API 서버 감사 로그 꺼짐" } as Verdict;
    })(),
  },

  // 플랫폼 조작 기록 + 체인 무결 (실 값: API 가 다시 계산한 결과)
  "SEC-AUD-02": Object.fromEntries((["aws", "gcp", "onprem"] as const).map((p) => [p, (_f: EvidenceFiles, ctx: CheckCtx): Verdict | null => {
    const c = ctx.auditChain;
    if (!c) return null;
    return { status: c.ok ? "pass" : "fail", severity: c.ok ? "info" : "critical", files: [],
      evidence: c.ok ? `실측: 감사 체인 ${c.checked}줄 다시 계산 · 끊김 0${c.partial ? " · 앞부분 못 읽음" : ""}` : `실측: seq ${c.brokenAtSeq} 에서 끊김` };
  }])),

  // 0.0.0.0/0 관리·DB 포트 없음
  "SEC-VIO-01": {
    aws: (f) => noFiles(f, ["awsEnvTf", "awsAppTf"]) ?? (() => {
      const all = t(f, "awsEnvTf")! + "\n" + t(f, "awsAppTf")!;
      const openSg = tfBlocks(all, "aws_security_group").flatMap((b) => [...b.matchAll(/ingress\s*\{([\s\S]*?)\}/g)].map((m) => m[1]!))
        .filter((ing) => /0\.0\.0\.0\/0/.test(ing) && ADMIN_DB_PORTS.some((p) => new RegExp(`from_port\\s*=\\s*${p}\\b`).test(ing))).length;
      const dbPublic = tfBlocks(t(f, "awsAppTf")!, "aws_db_instance").some((b) => tfAttr(b, "publicly_accessible") === "true");
      const eks = tfBlocks(t(f, "awsEnvTf")!, "aws_eks_cluster")[0] ?? "";
      const apiOpen = /endpoint_public_access\s*=\s*true/.test(eks) && !/public_access_cidrs/.test(eks);
      const bad = openSg + (dbPublic ? 1 : 0) + (apiOpen ? 1 : 0);
      return { status: bad ? "fail" : "pass", severity: bad ? "high" : "info", files: ["awsEnvTf", "awsAppTf"],
        evidence: `보안 그룹 0.0.0.0/0 관리·DB 포트 ${openSg} · RDS 공개 ${dbPublic} · EKS API 공개(대역 제한 없음) ${apiOpen}` } as Verdict;
    })(),
    gcp: (f) => noFiles(f, ["gcpEnvTf", "gcpAppTf"]) ?? (() => {
      const fw = tfBlocks(t(f, "gcpEnvTf")!, "google_compute_firewall")
        .filter((b) => /0\.0\.0\.0\/0/.test(b) && ADMIN_DB_PORTS.some((p) => new RegExp(`"${p}"`).test(b))).length;
      const sqlPublic = !/ipv4_enabled\s*=\s*false/.test(t(f, "gcpAppTf")!);
      const gke = tfBlocks(t(f, "gcpEnvTf")!, "google_container_cluster")[0] ?? "";
      const apiOpen = /enable_private_endpoint\s*=\s*false/.test(gke) && !/master_authorized_networks_config/.test(gke);
      const bad = fw + (sqlPublic ? 1 : 0) + (apiOpen ? 1 : 0);
      return { status: bad ? "fail" : "pass", severity: bad ? "high" : "info", files: ["gcpEnvTf", "gcpAppTf"],
        evidence: `방화벽 0.0.0.0/0 관리·DB 포트 ${fw} · Cloud SQL 공개 IP ${sqlPublic} · GKE API 공개(허용 대역 없음) ${apiOpen}` } as Verdict;
    })(),
    onprem: (f) => noFiles(f, ["onpremAppTf"]) ?? (() => {
      const deny = /default-deny-ingress/.test(t(f, "onpremAppTf")!);
      const demo = t(f, "onpremDbExpose");
      const demoOpen = !!demo && /cidr:\s*0\.0\.0\.0\/0/.test(demo) && /5432/.test(demo);
      const ok = deny && !demoOpen;
      return { status: ok ? "pass" : "fail", severity: ok ? "info" : "high", files: ["onpremAppTf", "onpremDbExpose"],
        evidence: `기본 차단 네트워크 정책 ${deny}` + (demoOpen ? " · 데모 매니페스트 db-expose 가 5432 를 0.0.0.0/0 에 엶 (데모 전용)" : "") } as Verdict;
    })(),
  },

  // 이미지는 우리 레지스트리 + critical CVE 0 → CVE 는 Trivy 없이 모른다. 이미지 고정(digest)만 본다
  "SEC-VIO-02": Object.fromEntries((["aws", "gcp", "onprem"] as const).map((p) => [p, (f: EvidenceFiles): Verdict | null =>
    noFiles(f, ["chartValues"]) ?? (() => {
      const ref = t(f, "chartValues")!.match(/image:\s*\{\s*ref:\s*"([^"]+)"/)?.[1] ?? "";
      const digest = /@sha256:[0-9a-f]{64}$/.test(ref);
      return { status: "unknown", files: ["chartValues"],
        evidence: `앱 이미지 digest 고정 ${digest} · 레지스트리는 배포 때 어댑터가 채움 · critical CVE 는 Trivy 스캔 필요 (미실행)` } as Verdict;
    })()])),

  // root·privileged 컨테이너 0 (차트) — 온프레는 Kyverno 정책에 막는 규칙이 있는지도 본다
  "SEC-VIO-03": Object.fromEntries((["aws", "gcp", "onprem"] as const).map((p) => [p, (f: EvidenceFiles): Verdict | null =>
    noFiles(f, ["chartDeploy"]) ?? (() => {
      const d = t(f, "chartDeploy")!;
      const priv = /privileged:\s*true/.test(d);
      const nonRoot = /runAsNonRoot:\s*true/.test(d);
      const kyv = p === "onprem" && /runAsNonRoot|privileged/.test(t(f, "onpremKyverno") ?? "");
      const ok = !priv && nonRoot;
      return { status: ok ? "pass" : "fail", severity: priv ? "high" : ok ? "info" : "medium", files: p === "onprem" ? ["chartDeploy", "onpremKyverno"] : ["chartDeploy"],
        evidence: `차트 privileged ${priv} · runAsNonRoot ${nonRoot ? "true" : "없음 (root 실행 안 막음)"}` + (p === "onprem" ? ` · Kyverno 막는 규칙 ${kyv}` : "") } as Verdict;
    })()])),

  // 기본 서비스 계정 토큰 자동 마운트 끔
  "SEC-IAM-03": Object.fromEntries((["aws", "gcp", "onprem"] as const).map((p) => [p, (f: EvidenceFiles): Verdict | null =>
    noFiles(f, ["chartDeploy", "chartSa"]) ?? (() => {
      const off = /automountServiceAccountToken:\s*false/.test(t(f, "chartDeploy")! + "\n" + t(f, "chartSa")!);
      return { status: off ? "pass" : "fail", severity: off ? "info" : "medium", files: ["chartDeploy", "chartSa"],
        evidence: off ? "automountServiceAccountToken: false" : "automountServiceAccountToken 설정 없음 (토큰이 Pod 에 붙음)" } as Verdict;
    })()])),
};

// 근거가 없어 Finding 을 안 만드는 통제 → 화면 이유
export const EVIDENCE_GAPS: Record<string, string> = {
  "SEC-IAM-01": "관리자 MFA 는 고객 계정 설정. 레포에 근거 없음 (실 계정 스캔·사람 확인 필요)",
  "SEC-VIO-04": "활성 위협은 실행 중 탐지(GuardDuty·SCC·Falco) 결과. 레포에 근거 없음",
};

export interface EvidenceCell extends Cell {
  side: "source" | "target";
  envKind: EnvKind;
  evidence: string[];        // 이 칸 Finding 의 evidence (정적:… / 실측:…) 또는 근거 없음 이유
  files: string[];           // 읽은 파일 (레포 경로)
  basis: "static" | "measured" | "none" | "n_a";
}

// 환경 하나의 Finding (정적 근거 + 실측 감사 체인)
export function collectEvidence(f: EvidenceFiles, env: { envId: string; envKind: EnvKind }, now: Date, ctx: CheckCtx): Finding[] {
  if (env.envKind === "azure_mock") return [];
  const kind = env.envKind;
  const out: Finding[] = [];
  for (const c of CONTROLS) {
    const check = CHECKS[c.id]?.[kind];
    const tool = sourcesFor(c, kind).find((x) => x !== "attest");
    if (!check || !tool) continue;
    const v = check(f, ctx);
    if (!v) continue;
    out.push(Finding.parse({
      tool, toolCheckId: c.id === "SEC-AUD-02" ? "audit_chain_verify" : `static_${c.id.toLowerCase().replaceAll("-", "_")}`,
      controlId: c.id, resource: `${kind}/${env.envId.slice(0, 8)}`,
      status: v.status, severity: v.severity ?? (v.status === "fail" ? "medium" : "info"),
      kind: c.id === "SEC-VIO-04" ? "threat" : "posture", observedAt: now.toISOString(),
      evidence: `${c.id === "SEC-AUD-02" ? "" : "정적: "}${v.evidence}${v.files.length ? ` [${v.files.map((k) => f[k].path).join(", ")}]` : ""}`.slice(0, 2000),
    }));
  }
  return out;
}

// 매트릭스: 환경마다 통제 12칸. 칸 판정은 summarizeCells (가장 나쁜 것이 이김, 30분 지난 통과는 unknown) 그대로
export function controlMatrix(
  f: EvidenceFiles,
  envs: { side: "source" | "target"; envId: string; envKind: EnvKind }[],
  o: { now: Date; auditChain: CheckCtx["auditChain"]; attestations?: Attestation[] },
): EvidenceCell[] {
  return envs.flatMap((e) => {
    const fs = collectEvidence(f, e, o.now, { auditChain: o.auditChain });
    return summarizeCells(fs, { envId: e.envId, envKind: e.envKind, now: o.now, attestations: o.attestations }).map((cell): EvidenceCell => {
      const mine = fs.filter((x) => x.controlId === cell.controlId);
      const files = [...new Set(mine.flatMap((x) => x.evidence.match(/\[([^\]]+)\]$/)?.[1]?.split(", ") ?? []))];
      const gap = EVIDENCE_GAPS[cell.controlId];
      const basis = cell.state === "not_applicable" ? "n_a" : !mine.length ? "none"
        : mine.every((x) => x.toolCheckId === "audit_chain_verify") ? "measured" : "static";
      // 이유 = 우리 근거 문구 (summarize 의 "1건 통과"·"도구 오류만 있음" 대신). 30분 지난 통과처럼 summarize 가 바꾼 판정은 그 이유를 앞에 둔다
      const ev = mine.map((x) => x.evidence.replace(/ \[[^\]]+\]$/, ""));
      const stale = cell.state === "unknown" && mine.some((x) => x.status !== "unknown");
      const reason = cell.state === "not_applicable" || cell.state === "attested" ? cell.reason
        : stale ? `${cell.reason} · ${ev[0]}` : ev.length ? ev.join(" / ") : gap ?? cell.reason;
      return { ...cell, reason, side: e.side, envKind: e.envKind, basis, files,
        evidence: ev.length ? ev : gap ? [gap] : [] };
    });
  });
}

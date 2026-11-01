import type { MigrationStatus } from "@svc/contracts";
import { CONTROLS, controlById, controlMatrix, type EnvKind, type EvidenceFiles } from "@svc/security";
import { verifyAuditChain } from "../report/chain.js";
import type { AuditRow } from "../report/schema.js";
import type { AwsPermScan, ChartScan, GcpPermScan, OnpremPermScan, SecretScan } from "./scan.js";
import type { LedgerRow, MatrixRow, SecRow, SecState, SecurityView } from "./schema.js";

// 보안 표를 만드는 데 필요한 것 전부. DB·파일 읽기는 load.ts, 여기는 순수 함수다
export interface SecurityInput {
  migration: { id: string; status: MigrationStatus };
  envs: { side: "source" | "target"; provider: string; hasExternalId: boolean; envId?: string }[];
  events: AuditRow[];                 // 이 이전 대상 감사 줄
  chain: AuditRow[];                  // 회사 체인 (리포트와 같은 범위)
  chainFromGenesis: boolean;
  ledger: (Omit<LedgerRow, "ttlSec" | "expiredButActive" | "step"> & { step?: string | null })[] | null;   // null = temp_credentials 표 없음
  ledgerValueColumns: string[] | null;     // 장부 표에서 값처럼 보이는 칸 이름 (null = 표 없음)
  privileges: { auditUpdate: boolean; auditDelete: boolean; ledgerDelete: boolean | null };
  permissions: {
    dir: string;
    aws: AwsPermScan | null; gcp: GcpPermScan | null; onprem: OnpremPermScan | null;
    files: { aws: boolean; gcp: boolean; onprem: boolean };
    awsBoundaryFile: boolean;          // aws-app-role-boundary.json (G3) 이 있나
  };
  chart: ChartScan | null;            // null = 차트 파일 없음
  evidenceFiles?: EvidenceFiles | null;   // Z39: 통제 12개 증거 파일. 없으면 CT-MATRIX 는 미구현
  chartDir: string;
  secrets: SecretScan;
  config: {
    authMode: "dev_header" | "real";
    replConfigured: boolean;
    replPeerPassword: { source: boolean | null; target: boolean | null };
  };
  now?: () => Date;
}

const TERMINAL: MigrationStatus[] = ["completed", "rolled_back", "failed", "cancelled"];
const sideName = (s: "source" | "target") => (s === "source" ? "출발" : "도착");

export function buildSecurityView(inp: SecurityInput): SecurityView {
  const now = (inp.now ?? (() => new Date()))();
  const rows: SecRow[] = [];
  const row = (r: SecRow) => rows.push(r);
  const terminal = TERMINAL.includes(inp.migration.status);
  const providers = [...new Set(inp.envs.map((e) => e.provider))];
  const scopeOf = (p: string) => inp.envs.filter((e) => e.provider === p).map((e) => `${sideName(e.side)} ${p}`).join(", ");

  // ── 1. 임시 자격 ──
  const tempRoleAudit: Record<string, number> = {};
  for (const e of inp.events) if (e.action.startsWith("temp_role.")) tempRoleAudit[e.action] = (tempRoleAudit[e.action] ?? 0) + 1;
  const issuedN = tempRoleAudit["temp_role.issued"] ?? 0;
  const deniedN = tempRoleAudit["temp_role.denied"] ?? 0;

  const ledger: LedgerRow[] | null = inp.ledger?.map((l) => ({
    ...l, step: l.step ?? null,
    ttlSec: Math.round((Date.parse(l.expiresAt) - Date.parse(l.issuedAt)) / 1000),
    expiredButActive: (l.status === "active" || l.status === "revoke_requested") && Date.parse(l.expiresAt) <= now.getTime(),
  })) ?? null;

  if (!ledger) {
    row({ id: "TC-LEDGER", area: "temp_credentials", item: "임시 자격 장부 (발급·만료·회수)", scope: "전체",
      state: "not_implemented", value: "temp_credentials 표 없음 (장부 마이그레이션 0009 적용 전)",
      source: "DB temp_credentials", ref: "T-ROLE-8" });
  } else {
    const c = { active: 0, revoke_requested: 0, revoked: 0, expired: 0 };
    for (const l of ledger) c[l.status]++;
    const stale = ledger.filter((l) => l.expiredButActive).length;
    const liveOperate = ledger.filter((l) => l.purpose === "operate" && (l.status === "active" || l.status === "revoke_requested") && !l.expiredButActive).length;
    const steps = [...new Set(ledger.map((l) => l.step).filter((x): x is string => !!x))];
    const state: SecState = terminal && liveOperate > 0 ? "fail" : stale > 0 ? "warn" : "ok";
    row({ id: "TC-LEDGER", area: "temp_credentials", item: "임시 자격 장부 (발급·만료·회수)", scope: "이 이전",
      state, value: `${ledger.length}건 · 활성 ${c.active} · 회수 요청 ${c.revoke_requested} · 회수 ${c.revoked} · 만료 처리 ${c.expired} · 만료됐는데 미처리 ${stale}`
        + (steps.length ? ` · 단계 ${steps.join("·")}` : "")
        + (terminal && liveOperate > 0 ? ` · 끝난 이전에 살아 있는 실행 역할 ${liveOperate}` : ""),
      source: "DB temp_credentials", ref: "T-ROLE-8" });
    const op = ledger.filter((l) => l.purpose === "operate");
    const maxTtl = op.length ? Math.max(...op.map((l) => l.ttlSec)) : null;
    // J2: 실행 역할 세션은 15분(900초)이 상한 (STS 최소값)
    row({ id: "TC-TTL", area: "temp_credentials", item: "실행 역할 최대 수명", scope: "이 이전",
      state: maxTtl === null ? "n_a" : maxTtl <= 900 ? "ok" : "warn",
      value: maxTtl === null ? "실행 역할 발급 0건" : `최대 ${maxTtl}초 (기준 900초)`,
      source: "DB temp_credentials expires_at − issued_at", ref: "T-ROLE-9" });
  }

  row({ id: "TC-AUDIT", area: "temp_credentials", item: "감사에 남은 발급·거부·회수", scope: "이 이전",
    // Z39: 작업 단계(precheck·plan·apply·cleanup·rollback)가 빌린다. 0건 = 아직 첫 단계 전. 거부가 있으면 약점(권한 파일·요청 불일치)
    state: issuedN === 0 && deniedN === 0 ? (inp.ledger === null ? "not_implemented" : "n_a") : deniedN > 0 ? "warn" : "ok",
    value: issuedN === 0 && deniedN === 0
      ? (inp.ledger === null ? "발급 0 · 거부 0 (장부 표 없음)" : "발급 0 · 거부 0 (아직 임시 역할을 빌리는 단계 전)")
      : `발급 ${issuedN} · 거부 ${deniedN} · 회수 ${tempRoleAudit["temp_role.revoked"] ?? 0} · 만료 ${tempRoleAudit["temp_role.expired"] ?? 0}`
        + ` · 회수 요청 ${tempRoleAudit["temp_role.revoke_pending"] ?? 0} · 발급 실패 ${tempRoleAudit["temp_role.issue_failed"] ?? 0}`,
    source: "DB audit_events action temp_role.*", ref: null });

  // 정리(cleanup)·롤백 전이가 감사 detail.evidence 에 남긴 T27 증거
  const ev = inp.events.map((e) => (e.detail.evidence as { operateRoleRevoked?: unknown } | undefined)?.operateRoleRevoked)
    .filter((v): v is boolean => typeof v === "boolean");
  const revoked = ev.at(-1);
  row({ id: "TC-REVOKED", area: "temp_credentials", item: "끝난 뒤 실행 역할 전부 회수 (T27)", scope: "이 이전",
    state: revoked === true ? "ok" : revoked === false ? "fail" : terminal ? "warn" : "n_a",
    value: revoked === true ? "operateRoleRevoked = true" : revoked === false ? "operateRoleRevoked = false"
      : terminal ? "회수 증거 기록 없음" : "아직 정리 단계 전",
    source: "DB audit_events detail.evidence", ref: "T27" });

  // ── 2. 최소 권한 ──
  const P = inp.permissions;
  for (const p of providers) {
    const scope = scopeOf(p);
    if (p === "azure_mock") {
      row({ id: "LP-AZURE", area: "least_privilege", item: "실행 역할", scope, state: "n_a",
        value: "Azure 는 Mock 전용이라 실행 역할을 주지 않음 (ROLE_AZURE_MOCK)", source: "packages/security temp-role.ts", ref: null });
      continue;
    }
    if (p === "aws") {
      const a = P.aws;
      if (!a) { row({ id: "LP-AWS", area: "least_privilege", item: "AWS 실행 역할 천장", scope, state: "not_implemented",
        value: "권한 파일 없음", source: `${P.dir}/aws-operate-role-policy.json`, ref: null }); continue; }
      row({ id: "LP-AWS", area: "least_privilege", item: "AWS 실행 역할 천장 (와일드카드 0)", scope,
        state: a.wildcard.length ? "fail" : "ok",
        value: `동작 ${a.ceiling}개 · 와일드카드 ${a.wildcard.length}`, source: `${P.dir}/aws-operate-role-policy.json`, ref: "SEC-IAM-02" });
      row({ id: "LP-AWS-BOUNDARY", area: "least_privilege", item: "IAM 쓰기에 권한 경계 조건", scope,
        state: a.escalationWithoutBoundary.length ? "fail" : "ok",
        value: a.escalationWithoutBoundary.length
          ? `경계 조건 없는 IAM 쓰기 ${a.escalationWithoutBoundary.length}개 (${a.escalationWithoutBoundary.join(", ")})`
          : `경계 조건 없는 IAM 쓰기 0개${P.awsBoundaryFile ? " · 경계 정책 파일 있음" : ""}`,
        source: `${P.dir}/aws-operate-role-policy.json`, ref: "A-4" });
      row({ id: "LP-AWS-ANYRES", area: "least_privilege", item: "Resource \"*\" 쓰기 동작", scope,
        state: a.writesOnAnyResource ? "warn" : "ok",
        value: `${a.writesOnAnyResource}개 (리전 조건만, 태그·이름 조건 없음)`, source: `${P.dir}/aws-operate-role-policy.json`, ref: "A-1~A-3" });
      const bad = a.sessions.filter((s) => s.error);
      row({ id: "LP-AWS-SESSION", area: "least_privilege", item: "단계별 세션 정책 (plan·apply·destroy)", scope,
        state: a.sessions.length < 3 ? "not_implemented" : bad.length ? "fail" : "ok",
        value: a.sessions.map((s) => `${s.stage} ${s.actions}개 ${s.chars}/${s.limit}자${s.error ? ` ${s.error}` : ""}`).join(" · ") || "세션 정책 파일 없음",
        source: `${P.dir}/aws-session-policy-*.json`, ref: null });
    }
    if (p === "gcp") {
      const g = P.gcp;
      if (!g) { row({ id: "LP-GCP", area: "least_privilege", item: "GCP 테넌트 SA 커스텀 역할", scope, state: "not_implemented",
        value: "권한 파일 없음", source: `${P.dir}/gcp-operate-custom-role.yaml`, ref: null }); continue; }
      row({ id: "LP-GCP", area: "least_privilege", item: "GCP 테넌트 SA 커스텀 역할 (와일드카드 0)", scope,
        state: g.wildcard.length ? "fail" : "ok", value: `권한 ${g.permissions}개 · 와일드카드 ${g.wildcard.length}`,
        source: `${P.dir}/gcp-operate-custom-role.yaml`, ref: "SEC-IAM-02" });
      row({ id: "LP-GCP-IAM", area: "least_privilege", item: "주 역할에 setIamPolicy 없음", scope,
        state: g.setIamPolicy.length ? "fail" : "ok",
        value: g.setIamPolicy.length ? `${g.setIamPolicy.length}개 (${g.setIamPolicy.join(", ")})` : "0개",
        source: `${P.dir}/gcp-operate-custom-role.yaml`, ref: "G-1, G-2" });
    }
    if (p === "onprem") {
      const o = P.onprem;
      if (!o) { row({ id: "LP-ONPREM", area: "least_privilege", item: "온프레 실행 ClusterRole", scope, state: "not_implemented",
        value: "권한 파일 없음", source: `${P.dir}/onprem-operate-clusterrole.yaml`, ref: null }); continue; }
      row({ id: "LP-ONPREM", area: "least_privilege", item: "클러스터 전체 범위 앱 자원 쓰기 0", scope,
        state: o.clusterWideAppWrites ? "fail" : "ok",
        value: `규칙 ${o.rules}개 · 클러스터 전체 앱 자원 쓰기 ${o.clusterWideAppWrites}개`
          + (o.bindingInFile ? ` · 클러스터 전체 묶음 ${o.boundClusterWide.join(", ")}` : " · 파일에 바인딩 없음 → 전부 클러스터 전체로 봄"),
        source: `${P.dir}/onprem-operate-clusterrole.yaml`, ref: "K-1" });
    }
  }
  for (const e of inp.envs.filter((x) => x.provider === "aws")) {
    row({ id: `LP-EXTID-${e.side}`, area: "least_privilege", item: "역할 빌릴 때 ExternalId", scope: `${sideName(e.side)} aws`,
      state: e.hasExternalId ? "ok" : "warn", value: e.hasExternalId ? "환경에 저장됨 (값은 안 보여 줌)" : "환경에 ExternalId 없음",
      source: "DB environments.external_id", ref: "T-ROLE-2" });
  }

  // ── 3. 감사 ──
  const integrity = verifyAuditChain(inp.chain, inp.chainFromGenesis);
  row({ id: "AU-CHAIN", area: "audit", item: "감사 체인 무결", scope: "회사 전체",
    state: !integrity.ok ? "fail" : integrity.partial ? "warn" : "ok",
    value: integrity.ok
      ? `${integrity.checked}줄 다시 계산 · 끊김 0${integrity.partial ? " · 앞부분 못 읽음" : ""}`
      : `seq ${integrity.brokenAtSeq} 에서 끊김 (${integrity.reason})`,
    source: "DB audit_events hash·prev_hash", ref: "SEC-AUD-02" });
  const incidents = inp.events.filter((e) => e.result !== "ok").length;
  row({ id: "AU-EVENTS", area: "audit", item: "이 이전 조작 기록", scope: "이 이전", state: inp.events.length ? "ok" : "warn",
    value: `${inp.events.length}줄 · 거부·오류 ${incidents}`, source: "DB audit_events target", ref: null });
  const appendOnly = !inp.privileges.auditUpdate && !inp.privileges.auditDelete;
  row({ id: "AU-APPEND", area: "audit", item: "앱 계정은 감사 고치기·지우기 불가", scope: "DB",
    state: appendOnly ? "ok" : "fail",
    value: `UPDATE ${inp.privileges.auditUpdate ? "가능" : "불가"} · DELETE ${inp.privileges.auditDelete ? "가능" : "불가"}`,
    source: "has_table_privilege(current_user, audit_events)", ref: null });

  // ── 4. 비밀값 ──
  const S = inp.secrets;
  row({ id: "SE-PLAINTEXT", area: "secrets", item: "DB 기록에 평문 비밀값 0", scope: "이 이전",
    state: S.hits.length ? "fail" : "ok",
    value: S.hits.length
      ? `${S.hits.length}건 (${[...new Set(S.hits.map((h) => `${h.kind}@${h.where}`))].slice(0, 3).join(", ")})`
      : `0건 · 문서 ${S.scannedDocs}개 · 문자열 ${S.scannedStrings}개 검사`,
    source: "audit_events.detail · spec_versions.spec · plans.plan_doc", ref: "SEC-ENC-03" });
  row({ id: "SE-LEDGER", area: "secrets", item: "자격 장부에 값 칸 없음", scope: "DB",
    state: inp.ledgerValueColumns === null ? "not_implemented" : inp.ledgerValueColumns.length ? "fail" : "ok",
    value: inp.ledgerValueColumns === null ? "temp_credentials 표 없음"
      : inp.ledgerValueColumns.length ? `값처럼 보이는 칸: ${inp.ledgerValueColumns.join(", ")}` : "참조·만료·상태 칸만",
    source: "information_schema.columns temp_credentials", ref: "T-ROLE-8" });
  if (inp.ledgerValueColumns !== null) row({ id: "SE-LEDGER-DEL", area: "secrets", item: "앱 계정은 장부 지우기 불가", scope: "DB",
    state: inp.privileges.ledgerDelete ? "fail" : "ok", value: `DELETE ${inp.privileges.ledgerDelete ? "가능" : "불가"}`,
    source: "has_table_privilege(current_user, temp_credentials)", ref: null });
  if (inp.chart) {
    const c = inp.chart;
    row({ id: "SE-CHART-ENV", area: "secrets", item: "앱 비밀번호는 시크릿 참조로만", scope: "차트",
      state: c.literalSecretEnv.length ? "fail" : c.dbPasswordFromSecret === false ? "fail" : "ok",
      value: `DB_PASSWORD ${c.dbPasswordFromSecret === null ? "없음" : c.dbPasswordFromSecret ? "secretKeyRef" : "평문"} · 직접 쓴 비밀 env ${c.literalSecretEnv.length}`,
      source: `${inp.chartDir}/templates/deployment.yaml`, ref: null });
  }
  const pw = inp.config.replPeerPassword;
  row({ id: "SE-REPL", area: "secrets", item: "복제 구독 접속 문자열 비밀번호", scope: "DB 복제",
    state: !inp.config.replConfigured ? "n_a" : pw.source || pw.target ? "warn" : "ok",
    value: !inp.config.replConfigured ? "복제 STUB (REPL_* 비어 있음)"
      : pw.source || pw.target ? `비밀번호 포함 → pg_subscription 에 평문 저장 (출발 ${pw.source ? "있음" : "없음"} · 도착 ${pw.target ? "있음" : "없음"})`
      : "접속 문자열에 비밀번호 없음",
    source: "env REPL_*_PEER_URL (값은 안 읽어 보여 줌)", ref: "T-REP-1" });
  row({ id: "SE-AUTH", area: "secrets", item: "API 인증", scope: "API",
    state: inp.config.authMode === "real" ? "ok" : "warn",
    value: inp.config.authMode === "real" ? "로그인(JWT)만 받음 · 개발용 헤더 꺼짐" : "로그인(JWT) + 개발용 x-dev-tenant 헤더도 믿음 (DEV_AUTH=1, 시험 전용 · 외부 공개 금지)",
    source: "env DEV_AUTH · AUTH_MODE · NODE_ENV", ref: "T-API-1" });

  // ── 5. 런타임 ──
  // 앱 Pod 는 도착 쪽에 새로 배포된다 (출발 앱은 고객이 이미 돌리던 것)
  const target = inp.envs.find((e) => e.side === "target");
  const tScope = target ? `도착 ${target.provider}` : "-";
  if (!target || target.provider === "azure_mock") {
    row({ id: "RT-POD", area: "runtime", item: "앱 Pod root·privileged 막기", scope: tScope, state: "n_a",
      value: "도착이 Azure Mock (배포 안 함)", source: inp.chartDir, ref: "SEC-VIO-03" });
  } else if (inp.chart) {
    const c = inp.chart;
    row({ id: "RT-POD", area: "runtime", item: "앱 Pod root·privileged 막기", scope: tScope,
      state: c.privilegedTrue ? "fail" : c.securityContext && c.runAsNonRoot ? "ok" : "warn",
      value: c.privilegedTrue ? "privileged: true 있음"
        : c.securityContext ? `securityContext 있음 · runAsNonRoot ${c.runAsNonRoot ? "true" : "없음"}` : "securityContext 없음 (root 실행을 막지 않음)",
      source: `${inp.chartDir}/templates/deployment.yaml`, ref: "SEC-VIO-03" });
    row({ id: "RT-SATOKEN", area: "runtime", item: "기본 서비스 계정 토큰 자동 마운트 끔", scope: tScope,
      state: c.automountTokenOff ? "ok" : "warn", value: c.automountTokenOff ? "automountServiceAccountToken: false" : "설정 없음 (토큰이 Pod 에 붙음)",
      source: `${inp.chartDir}/templates/{deployment,serviceaccount}.yaml`, ref: "SEC-IAM-03" });
  } else {
    row({ id: "RT-POD", area: "runtime", item: "앱 Pod root·privileged 막기", scope: tScope, state: "not_implemented",
      value: "차트 파일 없음", source: inp.chartDir, ref: "SEC-VIO-03" });
  }
  // k3d 는 k3s 노드를 Docker privileged 컨테이너로 띄운다 (k3d 동작, 끄는 옵션 없음). 데모용 온프레에만 해당
  row({ id: "RT-K3D", area: "runtime", item: "온프레 데모 k3d 노드 privileged", scope: providers.includes("onprem") ? scopeOf("onprem") : "-",
    state: providers.includes("onprem") ? "warn" : "n_a",
    value: providers.includes("onprem")
      ? "k3d 노드 컨테이너는 privileged (데모 한정, 노트북 Docker 안). 실제 서버는 bootstrap.sh 로 호스트에 k3s"
      : "이 이전에 온프레 없음",
    source: "k3d 동작 (실행 중 클러스터는 확인 안 함)", ref: null });

  // ── 6. 통제 매트릭스 (Z39) ──
  // 통제 12개 × 출발·도착. 레포 파일(Terraform·권한·차트·온프레)로 정적 판정 + SEC-AUD-02 는 위 체인 실측. 근거 없는 칸은 모름
  let matrix: MatrixRow[] | null = null;
  if (!inp.evidenceFiles || inp.envs.some((e) => !e.envId)) {
    row({ id: "CT-MATRIX", area: "controls", item: `보안 통제 ${CONTROLS.length}개 매트릭스`, scope: "환경별",
      state: "not_implemented", value: "증거 파일을 읽지 않음 (Z39 재료 없음)", source: "packages/security evidence.ts", ref: null });
  } else {
    const cells = controlMatrix(inp.evidenceFiles,
      inp.envs.map((e) => ({ side: e.side, envId: e.envId!, envKind: e.provider as EnvKind })),
      { now, auditChain: integrity });
    matrix = cells.map((c) => {
      const ctl = controlById(c.controlId)!;
      return { side: c.side, envKind: c.envKind, controlId: c.controlId, area: ctl.area, title: ctl.title, state: c.state,
        topSeverity: c.topSeverity, basis: c.basis, reason: c.reason, files: c.files };
    });
    const per = inp.envs.map((e) => {
      const cs = matrix!.filter((m) => m.side === e.side);
      const n = (s: MatrixRow["state"]) => cs.filter((m) => m.state === s).length;
      return `${sideName(e.side)} ${e.provider} 통과 ${n("pass") + n("attested")} · 위반 ${n("fail")} · 모름 ${n("unknown")}${n("not_applicable") ? ` · 해당 없음 ${n("not_applicable")}` : ""}`;
    });
    const anyFail = matrix.some((m) => m.state === "fail");
    const anyUnknown = matrix.some((m) => m.state === "unknown");
    const applicable = matrix.filter((m) => m.state !== "not_applicable").length;
    const fails = [...new Set(matrix.filter((m) => m.state === "fail").map((m) => m.controlId))];
    row({ id: "CT-MATRIX", area: "controls", item: `보안 통제 ${CONTROLS.length}개 × 환경 매트릭스 (정적 근거 + 감사 체인 실측)`, scope: "출발·도착",
      state: applicable === 0 ? "n_a" : anyFail ? "fail" : anyUnknown ? "warn" : "ok",
      value: per.join(" / ") + (fails.length ? ` · 위반 통제 ${fails.join(", ")}` : ""),
      source: "infra/modules · infra/permissions · gitops/charts/app · infra/onprem (packages/security evidence.ts)", ref: "SEC-*" });
  }

  const count = (s: SecState) => rows.filter((r) => r.state === s).length;
  return {
    viewVersion: 1,
    generatedAt: now.toISOString(),
    migration: { ...inp.migration },
    summary: { ok: count("ok"), warn: count("warn"), fail: count("fail"), notImplemented: count("not_implemented"), na: count("n_a") },
    rows, ledger, auditChain: integrity, tempRoleAudit, controlMatrix: matrix,
  };
}

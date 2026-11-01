import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NotFound, type Tx } from "@svc/core";
import { readEvidenceFiles } from "@svc/security";
import { loadReportInput } from "../report/load.js";
import type { SecurityInput } from "./build.js";
import { scanAwsPermissions, scanChart, scanGcpPermissions, scanOnpremPermissions, scanSecrets, urlHasPassword } from "./scan.js";

// 레포 루트 (apps/api/src/security → ../../../../)
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// 워커와 같은 이름의 환경 변수. 비우면 레포 안 기본 경로
export const PERMISSIONS_DIR = process.env.PERMISSIONS_DIR ?? join(ROOT, "infra/permissions");
export const CHART_DIR = process.env.CHART_DIR ?? join(ROOT, "gitops/charts/app");
const shown = (p: string) => (p.startsWith(ROOT) ? relative(ROOT, p) : p);

const tryRead = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// 장부 칸 이름 중 값처럼 보이는 것 (credential_ref·role_ref 같은 "참조" 는 뺀다)
const VALUE_COL = /(secret|token|password|passwd|material|private|access_key|session_key)/i;

export interface FileInputs {
  permissions: SecurityInput["permissions"];
  chart: SecurityInput["chart"];
  chartDir: string;
  evidenceFiles: SecurityInput["evidenceFiles"];
}

// 권한 파일·차트는 요청마다 읽는다 (작은 파일 9개, 데모 중 파일을 고치면 바로 보이게)
export function loadFileInputs(dir = PERMISSIONS_DIR, chartDir = CHART_DIR): FileInputs {
  const f = (n: string) => tryRead(join(dir, n));
  const awsCeil = f("aws-operate-role-policy.json");
  const sessions = Object.fromEntries((["plan", "apply", "destroy"] as const)
    .map((s) => [s, f(`aws-session-policy-${s}.json`)]).filter(([, v]) => v !== null)) as Record<string, string>;
  const gcp = f("gcp-operate-custom-role.yaml");
  const onprem = f("onprem-operate-clusterrole.yaml");
  const dep = tryRead(join(chartDir, "templates/deployment.yaml"));
  const sa = tryRead(join(chartDir, "templates/serviceaccount.yaml")) ?? "";
  return {
    permissions: {
      dir: shown(dir),
      aws: awsCeil ? scanAwsPermissions(awsCeil, sessions) : null,
      gcp: gcp ? scanGcpPermissions(gcp) : null,
      onprem: onprem ? scanOnpremPermissions(onprem) : null,
      files: { aws: awsCeil !== null, gcp: gcp !== null, onprem: onprem !== null },
      awsBoundaryFile: f("aws-app-role-boundary.json") !== null,
    },
    chart: dep ? scanChart(dep, sa) : null,
    chartDir: shown(chartDir),
    // Z39: 통제 12개 증거 파일 (Terraform·권한·차트·온프레). 권한·차트 폴더는 위와 같은 env 를 따른다
    evidenceFiles: readEvidenceFiles(ROOT, { permissionsDir: dir, chartDir }),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SecurityInput["config"] {
  const src = env.REPL_SOURCE_PEER_URL ?? env.REPL_SOURCE_URL;
  const dst = env.REPL_TARGET_PEER_URL ?? env.REPL_TARGET_URL;
  return {
    // Z93: 진짜 로그인(JWT)은 늘 켜져 있다. 개발용 헤더(DEV_AUTH=1)가 같이 켜져 있으면 dev_header 로 보여 준다
    authMode: env.DEV_AUTH === "1" && env.NODE_ENV !== "production" && env.AUTH_MODE !== "real" ? "dev_header" : "real",
    replConfigured: !!(env.REPL_SOURCE_URL && env.REPL_TARGET_URL),
    // 도착 DB 가 출발에 구독을 걸 때 쓰는 문자열 = 출발 PEER_URL. 역방향(롤백)은 도착 PEER_URL
    replPeerPassword: { source: urlHasPassword(src), target: urlHasPassword(dst) },
  };
}

// DB 재료를 한 트랜잭션(withTenant 안)에서 읽는다. RLS 때문에 남의 회사 이전은 NotFound
export async function loadSecurityDb(tx: Tx, migrationId: string) {
  const m = await tx.query(
    `SELECT m.status, m.source_env_id AS "sId", m.target_env_id AS "tId", s.provider AS "sP", (s.external_id IS NOT NULL AND s.external_id <> '') AS "sX",
            t.provider AS "tP", (t.external_id IS NOT NULL AND t.external_id <> '') AS "tX"
       FROM migrations m JOIN environments s ON s.id = m.source_env_id JOIN environments t ON t.id = m.target_env_id
      WHERE m.id = $1`, [migrationId]);
  const row = m.rows[0];
  if (!row) throw new NotFound("migration", migrationId);
  // 감사 줄·체인은 증적 리포트와 같은 읽기를 쓴다 (같은 숫자가 나오게)
  const rep = await loadReportInput(tx, migrationId);

  const specs = await tx.query("SELECT version, spec FROM spec_versions WHERE migration_id = $1", [migrationId]);
  const plans = await tx.query("SELECT id, plan_doc FROM plans WHERE migration_id = $1", [migrationId]);
  const secrets = scanSecrets([
    ...rep.events.map((e) => ({ where: `audit#${e.seq}`, value: e.detail })),
    ...specs.rows.map((s) => ({ where: `spec v${s.version}`, value: s.spec })),
    ...plans.rows.map((p) => ({ where: `plan ${String(p.id).slice(0, 8)}`, value: p.plan_doc })),
  ]);

  const has = await tx.query(`SELECT to_regclass('public.temp_credentials') IS NOT NULL AS ok`);
  let ledger: SecurityInput["ledger"] = null;
  let ledgerValueColumns: string[] | null = null;
  let ledgerDelete: boolean | null = null;
  if (has.rows[0].ok) {
    const cols = await tx.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'temp_credentials'`);
    const colNames = cols.rows.map((c) => c.column_name as string);
    // 0013(Z39) 전 DB 에서도 돌게: step 칸이 없으면 null
    const stepCol = colNames.includes("step") ? "step" : "NULL::text AS step";
    const l = await tx.query(
      `SELECT credential_ref AS "credentialRef", provider, purpose, stage, status, ${stepCol},
              ${ISO("issued_at")} AS "issuedAt", ${ISO("expires_at")} AS "expiresAt",
              CASE WHEN revoked_at IS NULL THEN NULL ELSE ${ISO("revoked_at")} END AS "revokedAt"
         FROM temp_credentials WHERE migration_id = $1 ORDER BY issued_at`, [migrationId]);
    ledger = l.rows;
    ledgerValueColumns = colNames.filter((c) => VALUE_COL.test(c));
    const d = await tx.query(`SELECT has_table_privilege(current_user, 'temp_credentials', 'DELETE') AS d`);
    ledgerDelete = d.rows[0].d;
  }
  const pr = await tx.query(`SELECT has_table_privilege(current_user, 'audit_events', 'UPDATE') AS u,
                                    has_table_privilege(current_user, 'audit_events', 'DELETE') AS d`);

  return {
    migration: { id: migrationId, status: row.status },
    envs: [
      { side: "source" as const, provider: row.sP, hasExternalId: row.sX, envId: row.sId as string },
      { side: "target" as const, provider: row.tP, hasExternalId: row.tX, envId: row.tId as string },
    ],
    events: rep.events, chain: rep.chain, chainFromGenesis: rep.chainFromGenesis,
    ledger, ledgerValueColumns,
    privileges: { auditUpdate: pr.rows[0].u, auditDelete: pr.rows[0].d, ledgerDelete },
    secrets,
  };
}

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  EnvPermissions, envNumber, PermissionCheckAccepted, PermissionCheckJob, PermissionsQuery, QUEUES, StoredPermissionCheck,
  type PermissionFix, type PermissionGap, type Provider,
} from "@svc/contracts";
import { asBossDb, boss, DomainError, jobKey, withTenant, writeAudit, type Tx } from "@svc/core";
import { loadPermissionBundles } from "@svc/adapters";
import { errors } from "./responses.js";
import { IdParam, auditOk, found, isoUtc } from "./kit.js";
import { connectSettings, gcpConnectSettings } from "../connect/link.js";
import { awsPermissionFix, gcpPermissionFix } from "../connect/permission-fix.js";
import { PERMISSIONS_DIR } from "../security/load.js";

// PERM-GATE: 환경의 고객 권한 묶음 상태
//   GET  /environments/:id/permissions[?bundles=a,b]  마지막 확인 결과 + 묶음마다·전체 고치는 법(링크·명령). 클라우드를 부르지 않는다
//   POST /environments/:id/permission-check            [다시 확인] → permission-check 작업 (worker 가 관찰 역할로 읽고 저장). 202
// 확인 자체는 worker 가 한다 (api 는 클라우드 권한이 없다). 이전 사전 점검의 막힘(PC-PERM-*)도 화면이 ?bundles= 로 같은 링크를 받는다

// DRAFT(ai): 요청하고 2분이 지나도 결과가 안 오면 워커가 죽은 것으로 보고 다시 넣는다 (실자원 조회와 같은 값)
const inFlightSec = (env: NodeJS.ProcessEnv) => envNumber(env.PERMISSION_CHECK_INFLIGHT_SEC, 120);
const err = (status: number, code: string, message: string) => new DomainError(status, code, message);

interface EnvRow { id: string; provider: Provider; account_id: string | null; gcp_target_project: string | null; region: string | null; connection_status: string }
interface PermRow { result: unknown; checked_at: string | null; refreshing: boolean }

/** 묶음 → 고치는 법. 링크 설정(GCP_PLATFORM_PROJECT·CONNECT_TEMPLATE_URL)이 없으면 null (화면은 hint 글만 보여 준다) */
async function fixFor(tx: Tx, tenantId: string, env: EnvRow, bundles: string[]): Promise<PermissionFix | null> {
  if (!bundles.length) return null;
  if (env.provider === "gcp") {
    const g = gcpConnectSettings();
    if (!g) return null;
    const saId = (await tx.query<{ gcp_platform_sa: string | null }>("SELECT gcp_platform_sa FROM tenants WHERE id = $1", [tenantId])).rows[0]?.gcp_platform_sa;
    if (!saId) return null;
    return gcpPermissionFix({ platformSa: `${saId}@${g.platformProject}.iam.gserviceaccount.com`, projectId: env.account_id, targetProjectId: env.gcp_target_project,
      repoUrl: g.repoUrl, repoBranch: g.repoBranch, bundles });
  }
  if (env.provider === "aws") {
    const s = connectSettings();
    return s ? awsPermissionFix({ envId: env.id, region: env.region, templateUrl: s.templateUrl, bundles }) : null;
  }
  return null;
}
// 고객 링크로 고쳐지는 묶음 = 빠진 권한·API 가 있는 것 + 확인용 권한이 없어 확인 못 한 관찰 묶음 (권한표에 없는 것만 있는 묶음은 플랫폼이 고친다)
const fixable = (g: PermissionGap) => g.missing.length > 0 || g.missingApis.length > 0 || (!!g.unverified && g.stage === "observe");

export async function envPermissionRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/environments/:id/permissions", { schema: { params: IdParam, querystring: PermissionsQuery,
    response: { 200: EnvPermissions, ...errors(400, 401, 404, 500) } } }, async (req) => {
    const requiredVersion = loadPermissionBundles(PERMISSIONS_DIR)?.version ?? 1;
    return withTenant(req.tenantId, async (tx) => {
      const env = found((await tx.query<EnvRow>(`SELECT id, provider, account_id, gcp_target_project, region, connection_status FROM environments WHERE id = $1`,
        [req.params.id])).rows[0], "environment", req.params.id);
      const row = (await tx.query<PermRow>(`SELECT result, ${isoUtc("checked_at")} AS checked_at,
          (requested_at IS NOT NULL AND (checked_at IS NULL OR requested_at > checked_at) AND requested_at > now() - make_interval(secs => $2)) AS refreshing
         FROM environment_permissions WHERE environment_id = $1`, [env.id, inFlightSec(process.env)])).rows[0];
      const stored = row?.result ? StoredPermissionCheck.safeParse(row.result) : null;
      const s = stored?.success ? stored.data : null;
      const gaps: PermissionGap[] = [];
      for (const g of s?.gaps ?? []) {
        const f = fixable(g) ? await fixFor(tx, req.tenantId, env, [g.bundleId]) : null;
        gaps.push(f ? { ...g, fix: f } : g);
      }
      const asked = req.query.bundles?.split(",").filter(Boolean) ?? [];
      const all = await fixFor(tx, req.tenantId, env, asked.length ? asked : [...new Set((s?.gaps ?? []).filter(fixable).map((g) => g.bundleId))]);
      return EnvPermissions.parse({ envId: env.id, checkedAt: row?.checked_at ?? null, refreshing: row?.refreshing === true,
        requiredVersion: s?.requiredVersion ?? requiredVersion, grantedVersion: s?.grantedVersion ?? null, gaps,
        ...(s?.error ? { error: s.error } : stored && !stored.success ? { error: "저장된 확인 결과 모양이 틀림 — 다시 확인한다" } : {}),
        ...(all ? { fix: all } : {}) });
    });
  });

  r.post("/environments/:id/permission-check", { schema: { params: IdParam,
    response: { 202: PermissionCheckAccepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const queued = await withTenant(req.tenantId, async (tx) => {
      const env = found((await tx.query<EnvRow>(`SELECT id, provider, account_id, gcp_target_project, region, connection_status FROM environments WHERE id = $1 FOR UPDATE`,
        [req.params.id])).rows[0], "environment", req.params.id);
      if (env.provider !== "aws" && env.provider !== "gcp") throw err(400, "NOT_SUPPORTED", `${env.provider} has no customer IAM bundles`);
      if (env.connection_status !== "connected" && env.connection_status !== "unstable")
        throw err(409, "ENV_NOT_CONNECTED", `environment ${env.id} is ${env.connection_status}`);
      // 동시에 온 요청 중 하나만 작업을 넣는다 (확인 중이면 그대로 둔다)
      const q = await tx.query(
        `INSERT INTO environment_permissions AS p (environment_id, tenant_id, requested_at) VALUES ($1, $2, now())
         ON CONFLICT (environment_id) DO UPDATE SET requested_at = now()
          WHERE p.requested_at IS NULL OR p.requested_at <= p.checked_at OR p.requested_at < now() - make_interval(secs => $3)
         RETURNING environment_id`, [env.id, req.tenantId, inFlightSec(process.env)]);
      if (!q.rowCount) return false;
      const key = jobKey(QUEUES.permissionCheck, { envId: env.id });
      await boss.send(QUEUES.permissionCheck, PermissionCheckJob.parse({ tenantId: req.tenantId, requestId: req.id, envId: env.id }),
        { ...(key ? { singletonKey: key } : {}), db: asBossDb(tx) });
      await writeAudit(tx, req.tenantId, auditOk(req, "env.permission_check_requested", env.id));
      return true;
    });
    return reply.code(202).send({ envId: req.params.id, queued });
  });
}

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ApiError, ConnectionLink, ConnectionLinkQuery, ConnectionStatus, CreateEnvironmentBody, EnvironmentView, MetricTokenCreated, VerifyBody, checkAccountId, normalizeAccountId,
  type Provider,
} from "@svc/contracts";
import {
  withTenant, advanceConnection, writeAudit, DomainError, BadRequest, INACTIVE_STATES, staleMigrationsForEnvChange, type Tx,
} from "@svc/core";
import { chooseRunner, inventoryToStatus, stubStatus, EKS_CLUSTER_NAME_RE } from "@svc/adapters";
import { EnvironmentList, EnvironmentStatus, errors } from "./responses.js";
import { IdParam, auditOk, found, isoUtc } from "./kit.js";
import { storedInventory } from "./env-inventory.js";
import { awsQuickCreateUrl, connectSettings, externalIdHint, gcpCloudShellLink, gcpConnectSettings, newExternalId, shouldCreateBoundary } from "../connect/link.js";
import { hashMetricToken, newMetricToken } from "../auth/metric-token.js";

// PF01: AWS 리전 이름 모양 (ap-northeast-2, us-gov-west-1 …)
const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

// 입력층 L2: 환경 만들기 · 연결 링크 · 연결 확인 요청 · 해제. 상태 변경은 core advanceConnection() 하나로만 한다
// (environments.connection_status 를 여기서 직접 UPDATE 하지 않는다)

// DRAFT(ai): 24시간 지난 고객 대기 = 만료. DB 는 verify·link 때 바꾸고, 목록은 응답에서만 expired 로 보인다
const LINK_EXPIRED_SQL = `(connection_status = 'awaiting_customer' AND link_issued_at IS NOT NULL
                           AND link_issued_at < now() - interval '24 hours')`;
const VIEW_COLUMNS = `id, provider, name,
  CASE WHEN ${LINK_EXPIRED_SQL} THEN 'expired' ELSE connection_status END AS "connectionStatus",
  account_id AS "accountId",
  -- Z17: 응답 스키마(lastVerifiedAt: string|null)에 맞게 DB에서 문자열로. Date의 JSON 모양과 같은 글자
  ${isoUtc("last_verified_at")} AS "lastVerifiedAt",
  failure_reason AS "failureReason",
  verify_detail AS "verifyDetail",
  gcp_target_project AS "targetProjectId"`;

// VERIFYAPI: verify_detail(jsonb) 에서 화면에 줄 두 칸만 꺼낸다. 비었거나 문자열 목록이 아니면 칸을 안 붙인다 (clusters·checkedAt 은 안 내보냄)
// DRAFT(ai): 화면에 내보내는 목록은 100개·한 줄 300자까지만. 12자리 숫자(AWS 계정 ID, ARN 계정 칸 포함)는 끝 4자리만 남기고 가린다
export const VERIFY_LIST_MAX = 100, VERIFY_ITEM_MAX = 300;
const maskIds = (t: string) => t.replace(/(?<!\d)\d{12}(?!\d)/g, (m) => `••••${m.slice(-4)}`);
const strList = (x: unknown): string[] | null =>
  Array.isArray(x) && x.length > 0 && x.every((v) => typeof v === "string")
    ? (x as string[]).slice(0, VERIFY_LIST_MAX).map((v) => maskIds(v).slice(0, VERIFY_ITEM_MAX)) : null;
export function toEnvironmentView(row: Record<string, unknown>): EnvironmentView {
  const { verifyDetail, targetProjectId, ...rest } = row;
  const d = (verifyDetail && typeof verifyDetail === "object" ? verifyDetail : {}) as Record<string, unknown>;
  const missing = strList(d.missingPermissions), todo = strList(d.needsHuman);
  // RV-24: 흉내 자격으로 닫힌 연결(시험·로컬 REAL_STS=0)은 보기에 mock 표시 (예전엔 버려서 진짜 연결과 구별 못 함)
  return { ...rest, ...(typeof targetProjectId === "string" ? { targetProjectId } : {}),
    ...(missing ? { missingPermissions: missing } : {}), ...(todo ? { needsHuman: todo } : {}),
    ...(d.mock === true ? { mock: true as const } : {}) } as EnvironmentView;
}

// 202 확인 요청 응답
export const VerifyAccepted = z.object({
  envId: z.uuid(),
  status: z.literal("verifying"),
  queued: z.boolean(),           // false = 같은 환경 확인 작업이 이미 대기 중 (새로 안 넣음)
}).strict();

const err = (status: number, code: string, message: string) => new DomainError(status, code, message);

interface EnvRow {
  provider: Provider; connection_status: ConnectionStatus; external_id: string | null;
  cluster_name: string | null; region: string | null; link_expired: boolean; account_id: string | null;
}
async function lockEnv(tx: Tx, id: string): Promise<EnvRow> {
  const q = await tx.query<EnvRow>(
    `SELECT provider, connection_status, external_id, cluster_name, region, account_id, ${LINK_EXPIRED_SQL} AS link_expired
       FROM environments WHERE id = $1 FOR UPDATE`, [id]);
  return found(q.rows[0], "environment", id);
}

// ExternalId 를 적는다. 전역 유일 색인(0024)에 걸리면 한 번 다시 만든다 (세이브포인트로 트랜잭션은 살린다)
async function writeExternalId(tx: Tx, id: string): Promise<string> {
  for (let i = 0; ; i++) {
    const ext = newExternalId();
    await tx.query("SAVEPOINT ext_id");
    try {
      await tx.query("UPDATE environments SET external_id = $2 WHERE id = $1", [id, ext]);
      await tx.query("RELEASE SAVEPOINT ext_id");
      return ext;
    } catch (e) {
      await tx.query("ROLLBACK TO SAVEPOINT ext_id");
      if ((e as { code?: string }).code !== "23505" || i >= 1) throw e;
    }
  }
}

export async function environmentRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 환경 목록. 응답 모양은 contracts EnvironmentView
  r.get("/environments", { schema: { response: { 200: EnvironmentList, ...errors(401, 500) } } }, async (req) => {
    return withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(`SELECT ${VIEW_COLUMNS} FROM environments ORDER BY name`);
      return { items: q.rows.map(toEnvironmentView) };
    });
  });

  // 환경 만들기. 상태는 draft. 같은 회사 같은 이름은 409 (DB 유일 색인 없음: 기존 시험이 같은 이름을 두 번 넣는다)
  r.post("/environments", { schema: { body: CreateEnvironmentBody,
    response: { 201: EnvironmentView, ...errors(400, 401, 403, 409, 500) } } }, async (req, reply) => {
    return req.idempotent(reply, async (tx) => {
      const b = req.body;
      // PF01 FM-CLD-03: AWS 리전 모양 확인 (오타·빈칸이면 링크 주소·확인 CLI 가 다른 곳을 봄). 앞뒤 빈칸은 지운다
      const region = b.region?.trim() || undefined;
      if (b.provider === "aws" && region !== undefined && !AWS_REGION_RE.test(region))
        throw new BadRequest("BAD_REGION", "aws region shape (e.g. ap-northeast-2)");
      // PF02: 클러스터 이름은 연결 템플릿 파라미터·워커 CLI 인자로 들어간다 → AWS EKS 이름 규칙만 받음 ("--…" 같은 값 막기)
      const clusterName = b.clusterName?.trim() || undefined;
      if (b.provider === "aws" && clusterName !== undefined && !EKS_CLUSTER_NAME_RE.test(clusterName))
        throw new BadRequest("BAD_CLUSTER_NAME", "eks cluster name shape");
      // 같은 이름 두 요청이 동시에 와도 하나만 (회사·이름 단위 잠금, 트랜잭션 끝에 풀림)
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('env-name:' || $1 || ':' || $2))", [req.tenantId, b.name]);
      const dup = await tx.query("SELECT 1 FROM environments WHERE name = $1 LIMIT 1", [b.name]);
      if (dup.rowCount) throw err(409, "ENV_NAME_TAKEN", `environment name ${b.name}`);
      const ins = await tx.query(
        `INSERT INTO environments (tenant_id, provider, name, connection_status, region, cluster_name)
         VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING ${VIEW_COLUMNS}`,
        [req.tenantId, b.provider, b.name, region ?? null, clusterName ?? null]);
      const view = toEnvironmentView(ins.rows[0]);
      await writeAudit(tx, req.tenantId, { actor: req.actor, action: "env.create", target: view.id, result: "ok",
        detail: { provider: b.provider } });
      return { status: 201, body: view };
    });
  });

  // 연결 링크 발급 (설계 IA 6.1 1단계). draft·고객 대기·만료·실패 → 고객 대기
  r.post("/environments/:id/connection-link", { schema: { params: IdParam, querystring: ConnectionLinkQuery,
    response: { 200: ConnectionLink, ...errors(400, 401, 403, 404, 409, 500), 501: ApiError, 503: ApiError } } },
  async (req, reply) => {
    return req.idempotent(reply, async (tx) => {
      const id = req.params.id;
      const env = await lockEnv(tx, id);
      // L7: GCP = Cloud Shell 링크 + 명령 한 줄 (gcp-connect.sh). 플랫폼 SA 는 회사 번호로 DB 에서만 (요청 값 안 받음, 혼동된 대리인 방어)
      if (env.provider === "gcp") {
        const g = gcpConnectSettings();
        if (!g) throw err(503, "CONNECT_NOT_CONFIGURED", "GCP_PLATFORM_PROJECT");
        const saId = (await tx.query<{ gcp_platform_sa: string }>("SELECT gcp_platform_sa FROM tenants WHERE id = $1", [req.tenantId])).rows[0]?.gcp_platform_sa;
        if (!saId) throw err(503, "CONNECT_NOT_CONFIGURED", "tenant platform service account");
        const accts = (await tx.query<{ account_id: string | null; gcp_target_project: string | null }>(
          "SELECT account_id, gcp_target_project FROM environments WHERE id = $1", [id])).rows[0];
        const acct = accts?.account_id ?? null;
        await advanceConnection(tx, req.tenantId, id, "awaiting_customer", {
          from: ["draft", "awaiting_customer", "expired", "failed"], linkIssued: true, failureReason: null,
          audit: { actor: req.actor, action: "env.link_issued", detail: { kind: "gcp_cloud_shell" } },
        });
        const exp = await tx.query<{ expires_at: string }>(
          `SELECT ${isoUtc("(link_issued_at + interval '24 hours')")} AS expires_at FROM environments WHERE id = $1`, [id]);
        const l = gcpCloudShellLink({ platformSa: `${saId}@${g.platformProject}.iam.gserviceaccount.com`, projectId: acct, targetProjectId: accts?.gcp_target_project ?? null, repoUrl: g.repoUrl, repoBranch: g.repoBranch });
        return { status: 200, body: { kind: "gcp_cloud_shell", url: l.url, command: l.command, expiresAt: exp.rows[0]!.expires_at } as ConnectionLink };
      }
      if (env.provider === "onprem") throw new BadRequest("USE_AGENT_TOKEN", "onprem connects with an agent token");
      if (env.provider === "azure_mock") throw new BadRequest("NOT_SUPPORTED", "azure_mock has no connection link");
      const s = connectSettings();
      if (!s) throw err(503, "CONNECT_NOT_CONFIGURED", "CONNECT_TEMPLATE_URL / PLATFORM_PRINCIPAL_ARN");
      // DRAFT(ai): 데모는 EKS 먼저라 aws 링크엔 클러스터 이름이 꼭 있어야 한다 (템플릿이 EKS 접근 항목을 만든다)
      if (!env.cluster_name) throw new BadRequest("CLUSTER_NAME_REQUIRED", "aws environment needs clusterName");
      // DRAFT(ai): 고객 대기에서 다시 받으면 ExternalId 를 그대로 둔다. 고객이 이미 스택을 만들었으면 바뀐 문구로는 안 열린다.
      // PF01 FM-CLD-04 DRAFT(ai): 확인 실패(failed) 뒤 다시 받아도 그대로 둔다. 실패한 고객은 대개 스택을 이미 만들었고(svc-observe 등 이름 고정),
      //   새 문구로 바꾸면 그 스택은 옛 문구라 영영 못 빌리고, 새 링크로 스택을 또 만들면 같은 스택·역할 이름이라 AlreadyExists 로 실패한다
      // PF04 FM-CLD-04 (시간·순서) DRAFT(ai): 만료(24시간 지남)도 그대로 둔다. AWS 빠른 생성 링크 자체는 안 만료되어 고객이 하루 뒤에 스택을 만들 수 있고,
      //   그 뒤 링크를 다시 받으면 새 문구라 같은 함정(옛 스택 못 빌림·새 스택 AlreadyExists). 확인 문구는 비밀이 아니라 바꿔서 얻는 보안 이득이 없다.
      //   새로 만드는 때 = 아직 없을 때(draft)·해제(disconnected) 뒤 다시 연결
      const keep = env.external_id !== null && ["awaiting_customer", "failed", "expired"].includes(env.connection_status);
      const externalId = keep ? env.external_id! : await writeExternalId(tx, id);
      await advanceConnection(tx, req.tenantId, id, "awaiting_customer", {
        from: ["draft", "awaiting_customer", "expired", "failed"],
        linkIssued: true, failureReason: null,
        audit: { actor: req.actor, action: "env.link_issued",
          detail: { externalIdHint: externalIdHint(externalId), rotated: !keep } },
      });
      const exp = await tx.query<{ expires_at: string }>(
        `SELECT ${isoUtc("(link_issued_at + interval '24 hours')")} AS expires_at FROM environments WHERE id = $1`, [id]);
      // F17: 같은 계정에 경계 정책이 이미 있으면 템플릿이 만들지 않게 (이름 충돌로 스택 실패 방지)
      const createBoundaryPolicy = shouldCreateBoundary({ boundaryPolicyExists: req.query.boundaryPolicyExists === "true",
        envAccountId: env.account_id, principalArn: s.principalArn });
      const url = awsQuickCreateUrl({ envId: id, region: env.region, templateUrl: s.templateUrl,
        principalArn: s.principalArn, externalId, clusterName: env.cluster_name, createBoundaryPolicy,
        ...(s.argoHubRoleArn ? { argoHubRoleArn: s.argoHubRoleArn } : {}) });
      return { status: 200, body: { kind: "aws_quick_create" as const, url, externalId, createBoundaryPolicy,
        expiresAt: exp.rows[0]!.expires_at } as ConnectionLink };
    });
  });

  // 연결 확인 요청 (설계 IA 6.1 3~4단계). 고객이 계정 번호를 넣는다 → verifying + verify-connection 작업
  r.post("/environments/:id/verify", { schema: { params: IdParam, body: VerifyBody,
    response: { 202: VerifyAccepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    const env = found(await withTenant(req.tenantId, async (tx) => (await tx.query<{ provider: Provider; link_expired: boolean }>(
      `SELECT provider, ${LINK_EXPIRED_SQL} AS link_expired FROM environments WHERE id = $1`, [id])).rows[0]),
    "environment", id);
    const accountId = normalizeAccountId(env.provider, req.body.accountId);
    if (!checkAccountId(env.provider, accountId))
      throw new BadRequest("BAD_ACCOUNT_ID", `account id shape for ${env.provider}`);
    // 결정 3번 A안: GCP 이전 전용 프로젝트. GCP 만, 모양 같음, 원래 프로젝트와 달라야 함 (DB CHECK 도 같은 규칙)
    const target = req.body.targetProjectId;
    if (target !== undefined && (env.provider !== "gcp" || !checkAccountId("gcp", target) || target === accountId))
      throw new BadRequest("BAD_TARGET_PROJECT", "targetProjectId: gcp only, project id shape, must differ from accountId");
    // 만료 먼저. 따로 커밋해야 expired 가 남는다 (idempotent 안에서 던지면 같이 롤백)
    if (env.link_expired) {
      await withTenant(req.tenantId, (tx) => advanceConnection(tx, req.tenantId, id, "expired", {
        from: ["awaiting_customer"], failureReason: "LINK_EXPIRED",
        audit: { actor: req.actor, action: "env.link_expired" } }));
      throw new BadRequest("LINK_EXPIRED", "connection link expired, issue a new one");
    }
    return req.idempotent(reply, async (tx) => {
      const prevRow = (await tx.query<{ account_id: string | null; gcp_target_project: string | null }>(
        "SELECT account_id, gcp_target_project FROM environments WHERE id = $1", [id])).rows[0];
      const prev = prevRow?.account_id ?? null;
      // 전용 프로젝트를 안 보내면 있던 값을 그대로 둔다 (다시 확인할 때 매번 안 넣어도 됨). 바뀌면 번호 고정도 새로
      const nextTarget = target ?? prevRow?.gcp_target_project ?? null;
      await tx.query(`UPDATE environments SET account_id = $2, gcp_target_project = $3,
        gcp_target_project_number = CASE WHEN gcp_target_project IS DISTINCT FROM $3 THEN NULL ELSE gcp_target_project_number END
        WHERE id = $1`, [id, accountId, nextTarget]);
      const res = await advanceConnection(tx, req.tenantId, id, "verifying", {
        from: ["awaiting_customer", "failed"],
        verifyJob: { tenantId: req.tenantId, requestId: req.id, reason: "user" },
        audit: { actor: req.actor, action: "env.verify_requested" },
      });
      // G7-3: 다른 계정으로 다시 연결하면 이 환경을 쓰는 승인 대기·승인됨 이전은 사람이 본 계획과 실행할 곳이 달라진다 → stale(env_changed).
      //   처음 넣는 계정(prev 없음)·같은 계정이면 안 건드림. 연결 상태 전이가 409 면 위에서 던져 같이 롤백
      if ((prev !== null && prev !== accountId) || ((prevRow?.gcp_target_project ?? null) !== null && prevRow?.gcp_target_project !== nextTarget))
        await staleMigrationsForEnvChange(tx, req.tenantId, id, req.actor, { reason: "account_changed" });
      return { status: 202, body: { envId: id, status: "verifying" as const, queued: res.jobQueued === true } };
    });
  });

  // 지표 토큰 발급 (연결된 환경만). 환경마다 살아 있는 토큰은 하나라 다시 받으면 이전 토큰은 끊긴다
  // 원문은 이 응답 한 번뿐이다. req.idempotent 는 응답을 DB 에 남기므로 쓰지 않는다 (개인 토큰과 같다)
  r.post("/environments/:id/metric-token", { schema: { params: IdParam,
    response: { 201: MetricTokenCreated, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    const token = newMetricToken();
    await withTenant(req.tenantId, async (tx) => {
      const env = await lockEnv(tx, id);
      if (env.connection_status !== "connected" && env.connection_status !== "unstable")
        throw err(409, "ENV_NOT_CONNECTED", `environment ${id} is ${env.connection_status}`);
      await tx.query("UPDATE metric_tokens SET revoked_at = now() WHERE env_id = $1 AND revoked_at IS NULL", [id]);
      await tx.query("INSERT INTO metric_tokens (tenant_id, env_id, token_hash) VALUES ($1, $2, $3)",
        [req.tenantId, id, hashMetricToken(token)]);
      await writeAudit(tx, req.tenantId, auditOk(req, "env.metric_token_issued", id));
    });
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ envId: id, token });
  });

  // 해제 (설계 IA 6.4). 진행 중 이전이 있으면 409. Agent 키 끊고, 임시 자격은 회수 요청(워커 청소가 실제 회수)
  r.delete("/environments/:id", { schema: { params: IdParam,
    response: { 204: z.null(), ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    return req.idempotent(reply, async (tx) => {
      const id = req.params.id;
      await lockEnv(tx, id);   // 줄을 먼저 잠그고 나서 이전을 본다 (그 사이에 새 이전이 이 환경을 못 쥔다)
      const busy = await tx.query(
        `SELECT 1 FROM migrations WHERE (source_env_id = $1 OR target_env_id = $1) AND NOT (status = ANY($2::text[])) LIMIT 1`,
        [id, INACTIVE_STATES]);
      if (busy.rowCount) throw err(409, "ENV_IN_USE", `environment ${id} has an active migration`);
      await advanceConnection(tx, req.tenantId, id, "disconnected", {
        audit: { actor: req.actor, action: "env.disconnected" } });
      await tx.query("UPDATE agent_keys SET revoked_at = now() WHERE env_id = $1 AND revoked_at IS NULL", [id]);
      await tx.query("UPDATE metric_tokens SET revoked_at = now() WHERE env_id = $1 AND revoked_at IS NULL", [id]);
      await tx.query(`UPDATE temp_credentials SET status = 'revoke_requested', revoke_reason = 'env_disconnected'
                       WHERE env_id = $1 AND status = 'active'`, [id]);
      return { status: 204, body: null };
    });
  });

  // 환경 자체의 자원 상태 (리소스 그룹·클러스터 등). Azure 는 Mock 실행기가 답한다
  // Z100: aws/gcp/onprem 은 실자원 읽기 결과로 채운다. #242: worker 가 저장한 값(없거나 오래되면 조회 요청). 없으면 unknown + 빈 목록 (가짜 값 없음)
  r.get("/environments/:id/status", { schema: { params: IdParam,
    response: { 200: EnvironmentStatus, ...errors(400, 401, 404, 409, 500) } } }, async (req) => {
    const env = found(await withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(`SELECT id, provider FROM environments WHERE id=$1`, [req.params.id]);
      return q.rows[0] as { id: string; provider: Provider } | undefined;
    }), "environment", req.params.id);
    // 실행기 고르기·STUB 판단은 adapters chooseRunner 한 곳. 막힘(RunnerUnavailable)은 errors 플러그인이 409로 바꾼다
    const target = { envId: env.id, provider: env.provider, region: "default" };
    const c = chooseRunner(env.provider);
    if (c.kind === "unavailable") throw c.error;
    if (c.kind === "stub") {
      const { inventory } = await storedInventory({ tenantId: req.tenantId, envId: env.id, provider: env.provider, requestId: req.id, warn: (o, m) => req.log.warn(o, m) });
      return inventory ? inventoryToStatus(inventory, target) : stubStatus(target);
    }
    return c.runner.status(target);
  });
}

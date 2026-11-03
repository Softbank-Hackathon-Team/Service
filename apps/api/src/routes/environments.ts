import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ApiError, ConnectionLink, ConnectionLinkQuery, ConnectionStatus, CreateEnvironmentBody, EnvironmentView, VerifyBody, checkAccountId,
  type Provider,
} from "@svc/contracts";
import {
  withTenant, advanceConnection, writeAudit, DomainError, BadRequest, INACTIVE_STATES, type Tx,
} from "@svc/core";
import { cachedInventory, chooseRunner, inventoryToStatus } from "@svc/adapters";
import { EnvironmentList, EnvironmentStatus, errors } from "./responses.js";
import { IdParam, found, isoUtc } from "./kit.js";
import { awsQuickCreateUrl, connectSettings, externalIdHint, newExternalId, shouldCreateBoundary } from "../connect/link.js";

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
  verify_detail AS "verifyDetail"`;

// VERIFYAPI: verify_detail(jsonb) 에서 화면에 줄 두 칸만 꺼낸다. 비었거나 문자열 목록이 아니면 칸을 안 붙인다 (clusters·checkedAt 은 안 내보냄)
// DRAFT(ai): 화면에 내보내는 목록은 100개·한 줄 300자까지만. 12자리 숫자(AWS 계정 ID, ARN 계정 칸 포함)는 끝 4자리만 남기고 가린다
export const VERIFY_LIST_MAX = 100, VERIFY_ITEM_MAX = 300;
const maskIds = (t: string) => t.replace(/(?<!\d)\d{12}(?!\d)/g, (m) => `••••${m.slice(-4)}`);
const strList = (x: unknown): string[] | null =>
  Array.isArray(x) && x.length > 0 && x.every((v) => typeof v === "string")
    ? (x as string[]).slice(0, VERIFY_LIST_MAX).map((v) => maskIds(v).slice(0, VERIFY_ITEM_MAX)) : null;
export function toEnvironmentView(row: Record<string, unknown>): EnvironmentView {
  const { verifyDetail, ...rest } = row;
  const d = (verifyDetail && typeof verifyDetail === "object" ? verifyDetail : {}) as Record<string, unknown>;
  const missing = strList(d.missingPermissions), todo = strList(d.needsHuman);
  return { ...rest, ...(missing ? { missingPermissions: missing } : {}), ...(todo ? { needsHuman: todo } : {}) } as EnvironmentView;
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
      // 같은 이름 두 요청이 동시에 와도 하나만 (회사·이름 단위 잠금, 트랜잭션 끝에 풀림)
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('env-name:' || $1 || ':' || $2))", [req.tenantId, b.name]);
      const dup = await tx.query("SELECT 1 FROM environments WHERE name = $1 LIMIT 1", [b.name]);
      if (dup.rowCount) throw err(409, "ENV_NAME_TAKEN", `environment name ${b.name}`);
      const ins = await tx.query(
        `INSERT INTO environments (tenant_id, provider, name, connection_status, region, cluster_name)
         VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING ${VIEW_COLUMNS}`,
        [req.tenantId, b.provider, b.name, b.region ?? null, b.clusterName ?? null]);
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
      // STUB: GCP Cloud Shell 링크는 L7
      if (env.provider === "gcp") throw err(501, "NOT_IMPLEMENTED_YET", "gcp connection link");
      if (env.provider === "onprem") throw new BadRequest("USE_AGENT_TOKEN", "onprem connects with an agent token");
      if (env.provider === "azure_mock") throw new BadRequest("NOT_SUPPORTED", "azure_mock has no connection link");
      const s = connectSettings();
      if (!s) throw err(503, "CONNECT_NOT_CONFIGURED", "CONNECT_TEMPLATE_URL / PLATFORM_PRINCIPAL_ARN");
      // DRAFT(ai): 데모는 EKS 먼저라 aws 링크엔 클러스터 이름이 꼭 있어야 한다 (템플릿이 EKS 접근 항목을 만든다)
      if (!env.cluster_name) throw new BadRequest("CLUSTER_NAME_REQUIRED", "aws environment needs clusterName");
      // DRAFT(ai): 고객 대기(24시간 안)에서 다시 받으면 ExternalId 를 그대로 둔다. 고객이 이미 스택을 만들었으면 바뀐 문구로는 안 열린다.
      //   draft·만료·실패, 아직 없을 때, 24시간 지난 고객 대기에서는 새로 만든다
      const keep = env.connection_status === "awaiting_customer" && !env.link_expired && env.external_id !== null;
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
        expiresAt: exp.rows[0]!.expires_at } };
    });
  });

  // 연결 확인 요청 (설계 IA 6.1 3~4단계). 고객이 계정 번호를 넣는다 → verifying + verify-connection 작업
  r.post("/environments/:id/verify", { schema: { params: IdParam, body: VerifyBody,
    response: { 202: VerifyAccepted, ...errors(400, 401, 403, 404, 409, 500) } } }, async (req, reply) => {
    const id = req.params.id;
    const env = found(await withTenant(req.tenantId, async (tx) => (await tx.query<{ provider: Provider; link_expired: boolean }>(
      `SELECT provider, ${LINK_EXPIRED_SQL} AS link_expired FROM environments WHERE id = $1`, [id])).rows[0]),
    "environment", id);
    if (!checkAccountId(env.provider, req.body.accountId))
      throw new BadRequest("BAD_ACCOUNT_ID", `account id shape for ${env.provider}`);
    // 만료 먼저. 따로 커밋해야 expired 가 남는다 (idempotent 안에서 던지면 같이 롤백)
    if (env.link_expired) {
      await withTenant(req.tenantId, (tx) => advanceConnection(tx, req.tenantId, id, "expired", {
        from: ["awaiting_customer"], failureReason: "LINK_EXPIRED",
        audit: { actor: req.actor, action: "env.link_expired" } }));
      throw new BadRequest("LINK_EXPIRED", "connection link expired, issue a new one");
    }
    return req.idempotent(reply, async (tx) => {
      await tx.query("UPDATE environments SET account_id = $2 WHERE id = $1", [id, req.body.accountId]);
      const res = await advanceConnection(tx, req.tenantId, id, "verifying", {
        from: ["awaiting_customer", "failed"],
        verifyJob: { tenantId: req.tenantId, requestId: req.id, reason: "user" },
        audit: { actor: req.actor, action: "env.verify_requested" },
      });
      return { status: 202, body: { envId: id, status: "verifying" as const, queued: res.jobQueued === true } };
    });
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
      await tx.query(`UPDATE temp_credentials SET status = 'revoke_requested', revoke_reason = 'env_disconnected'
                       WHERE env_id = $1 AND status = 'active'`, [id]);
      return { status: 204, body: null };
    });
  });

  // 환경 자체의 자원 상태 (리소스 그룹·클러스터 등). Azure 는 Mock 실행기가 답한다
  // Z100: aws/gcp/onprem 은 실자원 읽기(adapters inventory.ts, CLI 읽기 명령만·30초 캐시)로 채운다. 못 읽으면 unknown + 빈 목록 (가짜 값 없음)
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
    if (c.kind === "stub") return inventoryToStatus(await cachedInventory(env.id, env.provider), target);
    return c.runner.status(target);
  });
}

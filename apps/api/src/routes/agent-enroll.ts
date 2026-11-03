import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiError, type ConnectionStatus, type Provider } from "@svc/contracts";
import { deriveAgentSecret, MIN_MASTER_KEY_LEN } from "@svc/contracts/agent-sig";
import { advanceConnection, BadRequest, DomainError, pool, withTenant, writeAudit } from "@svc/core";
import { errors } from "./responses.js";
import { IdParam, found, isoUtc } from "./kit.js";
import { AgentReportsDisabled } from "./agent-reports.js";

// 입력층 L6: 온프레 일회용 등록 토큰 → Agent 키 (설계 IA 3·6.3, AF 6 1~2)
//   POST /api/v1/environments/:id/agent-token  사람. 10분짜리 토큰 원문을 한 번만 돌려준다 (DB 엔 sha256)
//   POST /api/v1/agent/register                 Agent. 토큰을 한 번 써서 Agent 키(번호 + 비밀)를 받는다
// 등록 경로는 사람 인증을 건너뛰는 Agent 경로라 config.agentSignature + 토큰 검사 preHandler 를 단다 (auth.ts L10 규칙)

// DRAFT(ai): 등록 토큰 수명 10분 (설계 IA 6.3 "10분 일회용")
export const ENROLL_TTL_MIN = 10;
const TOKEN_RE = /^et_[A-Za-z0-9_-]{43}$/;
export const newEnrollToken = () => "et_" + randomBytes(32).toString("base64url");
export const hashEnrollToken = (t: string) => createHash("sha256").update(t).digest("hex");

// 설치 한 줄. 토큰은 argv 대신 환경변수로 (ps·셸 기록에 덜 남는다)
// TODO(human): H-L15 고객 쪽 설치 방식(npm 스크립트 / 컨테이너 이미지 / Helm). 지금은 레포 스크립트 한 줄
export function enrollCommand(token: string, apiBase: string): string {
  return `SVC_ENROLL_TOKEN=${token} AGENT_REPORT_URL=${apiBase} npm run agent:onprem -- --enroll`;
}

export const AgentEnrollToken = z.object({
  envId: z.uuid(),
  token: z.string(),              // 원문은 이 응답에만. 다시 못 본다
  expiresAt: z.string(),
  command: z.string(),
}).strict();
export const AgentRegisterBody = z.object({ enrollToken: z.string().max(100) }).strict();
export const AgentRegistered = z.object({
  envId: z.uuid(),
  keyId: z.string(),
  secret: z.string(),             // Agent 가 파일(권한 600)에만 둔다. 서버는 저장 안 함(마스터로 다시 만든다)
}).strict();

declare module "fastify" {
  interface FastifyRequest { enrolled?: { tokenId: string; tenantId: string; envId: string } }
}

function apiBase(req: FastifyRequest): string {
  return process.env.PUBLIC_API_URL?.trim() || `${req.protocol}://${req.host}`;
}
const masterKey = () => {
  const m = process.env.AGENT_REPORT_MASTER_KEY ?? "";
  if (m.length < MIN_MASTER_KEY_LEN) throw new AgentReportsDisabled();
  return m;
};
// DRAFT(ai): 토큰을 다시 받으면 고객 대기로 둔다 (설계 IA 6.4 "링크 발급 → 고객 대기"). 이미 connected·unstable 이면 상태는 그대로
const TO_AWAITING: readonly ConnectionStatus[] = ["draft", "awaiting_customer", "expired", "failed"];

export async function agentEnrollRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // DRAFT(ai): req.idempotent 를 안 쓴다. 쓰면 응답(토큰 원문)이 idempotency_keys 표에 저장된다. 다시 누르면 새 토큰
  r.post("/environments/:id/agent-token", { schema: { params: IdParam,
    response: { 201: AgentEnrollToken, ...errors(400, 401, 403, 404, 409, 500), 503: ApiError } } }, async (req, reply) => {
    const id = req.params.id;
    masterKey();   // 등록 때 키를 못 만들 서버면 토큰부터 안 준다
    const token = newEnrollToken();
    const out = await withTenant(req.tenantId, async (tx) => {
      const e = found((await tx.query<{ provider: Provider; connection_status: ConnectionStatus }>(
        "SELECT provider, connection_status FROM environments WHERE id = $1 FOR UPDATE", [id])).rows[0], "environment", id);
      if (e.provider !== "onprem") throw new BadRequest("NOT_ONPREM", "agent token is for onprem environments");
      if (e.connection_status === "disconnected") throw new DomainError(409, "ENV_DISCONNECTED", `environment ${id}`);
      // L6fix DRAFT(ai): 새 토큰을 받으면 이 환경의 쓰지 않은 옛 토큰은 바로 끝낸다 (한 환경에 살아 있는 토큰은 하나). 대안: 10분 만료까지 둠 → 키가 여러 개 생길 수 있음
      await tx.query("UPDATE agent_enroll_tokens SET expires_at = now() WHERE env_id = $1 AND used_at IS NULL AND expires_at > now()", [id]);
      const ins = await tx.query<{ expires_at: string }>(
        `INSERT INTO agent_enroll_tokens (tenant_id, env_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4))
         RETURNING ${isoUtc("expires_at")} AS expires_at`, [req.tenantId, id, hashEnrollToken(token), ENROLL_TTL_MIN]);
      const audit = { actor: req.actor, action: "env.agent_token_issued", detail: { ttlMin: ENROLL_TTL_MIN } };
      if (TO_AWAITING.includes(e.connection_status))
        await advanceConnection(tx, req.tenantId, id, "awaiting_customer", { from: [...TO_AWAITING], linkIssued: true,
          failureReason: null, audit });
      else
        await writeAudit(tx, req.tenantId, { ...audit, target: id, result: "ok" });
      return ins.rows[0]!.expires_at;
    });
    return reply.code(201).send({ envId: id, token, expiresAt: out, command: enrollCommand(token, apiBase(req)) });
  });

  r.post("/agent/register", {
    config: { agentSignature: true },
    // 토큰 검사 = 인증. 회사는 토큰이 정한다. 한 문장으로 쓰기(DB 함수) → 두 번째·10분 지난 토큰은 0줄 → 401
    preHandler: async (req) => {
      masterKey();
      const raw = (req.body as { enrollToken?: unknown } | undefined)?.enrollToken;
      if (typeof raw !== "string" || !TOKEN_RE.test(raw))
        throw new DomainError(401, "ENROLL_TOKEN_INVALID", "enroll token is invalid, used or expired");
      const q = await pool.query<{ token_id: string; tenant_id: string; env_id: string }>(
        "SELECT token_id, tenant_id, env_id FROM agent_enroll_consume($1)", [hashEnrollToken(raw)]);
      const row = q.rows[0];
      if (!row) throw new DomainError(401, "ENROLL_TOKEN_INVALID", "enroll token is invalid, used or expired");
      req.tenantId = row.tenant_id;
      req.actor = `agent-enroll:${row.token_id}`;
      req.enrolled = { tokenId: row.token_id, tenantId: row.tenant_id, envId: row.env_id };
    },
    schema: { body: AgentRegisterBody, response: { 201: AgentRegistered, ...errors(400, 401, 409, 500), 503: ApiError } },
  }, async (req, reply) => {
    // DRAFT(ai): 토큰은 위에서 이미 썼다. 아래가 실패하면(환경 해제 등) 새 토큰을 받아야 한다 (토큰을 되살리는 길은 안 만든다)
    const en = req.enrolled!;
    const keyId = "ak_" + randomBytes(12).toString("hex");
    const secret = deriveAgentSecret(masterKey(), keyId);
    await withTenant(en.tenantId, async (tx) => {
      const e = (await tx.query<{ connection_status: ConnectionStatus }>(
        "SELECT connection_status FROM environments WHERE id = $1 FOR UPDATE", [en.envId])).rows[0];
      if (!e || e.connection_status === "disconnected") throw new DomainError(409, "ENV_DISCONNECTED", `environment ${en.envId}`);
      await tx.query("INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1, $2, $3)", [keyId, en.tenantId, en.envId]);
      await tx.query("UPDATE agent_enroll_tokens SET key_id = $2 WHERE id = $1", [en.tokenId, keyId]);
      await writeAudit(tx, en.tenantId, { actor: req.actor, action: "env.agent_registered", target: en.envId, result: "ok",
        detail: { keyId } });
    });
    req.log.info({ agent_key: keyId, env_id: en.envId }, "agent registered");
    return reply.code(201).send({ envId: en.envId, keyId, secret });
  });
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentReportAccepted, AgentReportKinds, AgentReportList, ApiError, canTransition, envNumber,
  type AgentReport, type ConnectionStatus, type Provider,
} from "@svc/contracts";
import { advanceConnection, DomainError, pool, withTenant, type Tx } from "@svc/core";
import type { AgentInventory, InventoryDeps } from "@svc/adapters";
import {
  acceptAgentReport, AgentReportRejected, AGENT_HEADERS, deriveAgentSecret, MIN_MASTER_KEY_LEN,
  type AgentKeyRegistry,
} from "@svc/contracts/agent-sig";
import { errors } from "./responses.js";
import { IdParam, found, isoUtc } from "./kit.js";

// Z92: 온프레 Agent 보고 받기 (설계: agent-sandbox-v1 · 계약 문서 "온프레는 Agent 가 안에서 밖으로").
//   POST /api/v1/agent/reports              Agent 키 서명으로 인증 (사람 헤더 없음). 회사·환경은 키가 정한다
//   GET  /api/v1/environments/:id/agent-reports  사람이 보는 받은 보고 (회사 벽 안)
// 받는 순서: 키 찾기(DB 함수, 회사 모름) → 서명·시각·모양(acceptAgentReport) → 그 회사의 withTenant 안에서 넣기.
// 재전송은 DB 고유 색인(key_id, signature)이 막는다 → 409 AGENT_REPLAY
// heartbeat 가 오면 그 환경의 연결 상태를 connected + last_verified_at 지금으로 바꾼다 (온프레 "모름" 대신 실측). L6: advanceConnection 으로

declare module "fastify" {
  interface FastifyRequest { agentAccepted?: { tenantId: string; envId: string; keyId: string; signature: string; report: AgentReport } }
}

export interface AgentReportStore {
  keys: AgentKeyRegistry;
  save(a: { tenantId: string; envId: string; keyId: string; signature: string; report: AgentReport }):
    Promise<{ id: string; receivedAt: string } | "replay">;
  list(tenantId: string, envId: string, o: { limit: number; kind?: AgentReport["kind"] }): Promise<AgentReportList | null>;
}

export class AgentReportsDisabled extends DomainError {
  constructor() { super(503, "AGENT_REPORTS_DISABLED", `AGENT_REPORT_MASTER_KEY 가 없거나 ${MIN_MASTER_KEY_LEN}자보다 짧다 (.env)`); }
}

// 서버 쪽 키 목록: 키 번호 → DB 함수 agent_key_lookup(0018) → 회사·환경·폐기, 비밀은 .env 마스터로 다시 만든다
export function pgAgentKeyRegistry(env: NodeJS.ProcessEnv = process.env): AgentKeyRegistry {
  return {
    lookup: async (keyId) => {
      const master = env.AGENT_REPORT_MASTER_KEY ?? "";
      if (master.length < MIN_MASTER_KEY_LEN) throw new AgentReportsDisabled();
      if (!/^ak_[A-Za-z0-9]{16,40}$/.test(keyId)) return null;
      const r = await pool.query(`SELECT tenant_id AS "tenantId", env_id AS "envId", revoked FROM agent_key_lookup($1)`, [keyId]);
      const row = r.rows[0] as { tenantId: string; envId: string; revoked: boolean } | undefined;
      if (!row) return null;
      return { tenantId: row.tenantId, envId: row.envId, revoked: row.revoked, secret: deriveAgentSecret(master, keyId) };
    },
  };
}

// L6: heartbeat → 연결 상태. 상태 변경은 advanceConnection 으로만 (전이 표: draft·고객 대기 → connected 는 온프레 전용).
//   이미 connected 면 상태는 그대로 두고 확인 시각만 (DRAFT(ai): 30초마다 감사 줄을 쌓지 않으려고. 상태 칸은 안 건드린다)
//   표에 없는 길(disconnected·expired·failed → connected)이면 상태를 살리지 않는다. 보고 자체는 저장된다
async function heartbeatConnection(tx: Tx, a: { tenantId: string; envId: string; keyId: string }) {
  const e = (await tx.query<{ provider: Provider; connection_status: ConnectionStatus }>(
    "SELECT provider, connection_status FROM environments WHERE id = $1 FOR UPDATE", [a.envId])).rows[0];
  if (!e) return;
  if (e.connection_status === "connected") {
    await tx.query("UPDATE environments SET last_verified_at = now(), verify_failures = 0 WHERE id = $1", [a.envId]);
    return;
  }
  if (!canTransition(e.provider, e.connection_status, "connected")) return;
  await advanceConnection(tx, a.tenantId, a.envId, "connected", { touchVerified: true, failures: 0,
    audit: { actor: `agent:${a.keyId}`, action: "env.agent_heartbeat" } });
}

export const staleSec = (env: NodeJS.ProcessEnv = process.env) => Math.max(1, envNumber(env.AGENT_STALE_SEC, 120) || 120);

// 온프레 pull 모드 실자원 화면(GET /environments/:id/inventory·status)용 Agent 마지막 보고.
//   플랫폼은 고객 클러스터에 kubectl 로 붙을 길이 없다(들어오는 포트 0) → 하트비트(k3s·CNPG)와 facts(DB 목록)로 채운다.
//   폐기된 키의 보고는 세지 않는다. 키 수·하트비트 나이 기준은 연결 확인(worker verify-connection)·사전 점검과 같다
const AGENT_INVENTORY_SQL = `
  SELECT (SELECT count(*)::int FROM agent_keys WHERE env_id = $1 AND revoked_at IS NULL) AS keys, h.age, h.body AS hb, f.body AS facts
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT GREATEST(0, floor(extract(epoch FROM now() - r.received_at)))::int AS age, r.body
                         FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
                        WHERE r.env_id = $1 AND r.kind = 'heartbeat' ORDER BY r.received_at DESC LIMIT 1) h ON true
    LEFT JOIN LATERAL (SELECT r.body
                         FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
                        WHERE r.env_id = $1 AND r.kind = 'facts' ORDER BY r.received_at DESC LIMIT 1) f ON true`;
export function agentInventoryFor(tenantId: string, envId: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentInventory> {
  return withTenant(tenantId, async (tx) => {
    const r = (await tx.query<{ keys: number; age: number | null; hb: Record<string, unknown> | null; facts: Record<string, unknown> | null }>(AGENT_INVENTORY_SQL, [envId])).rows[0];
    // 본문은 받을 때 AgentReport 로 검사했다. 그래도 모양이 다르면 지어내지 않고 빈 값으로
    const hb = r?.hb ?? null, cnpg = hb?.cnpg as { cluster?: unknown; ready?: unknown } | null | undefined;
    const dbs = Array.isArray(r?.facts?.dbs) ? (r!.facts!.dbs as AgentInventory["dbs"]) : null;
    return { keys: r?.keys ?? 0, heartbeatAgeSec: r?.age ?? null, staleSec: staleSec(env),
      k3sVersion: typeof hb?.k3sVersion === "string" ? hb.k3sVersion : null,
      cnpg: cnpg && typeof cnpg.cluster === "string" ? { cluster: cnpg.cluster, ready: cnpg.ready === true } : null, dbs };
  });
}
/** 인벤토리 읽기 의존성. 온프레 pull 모드(ONPREM_FLOOR_VIA_GIT≠0, 워커 apply 와 같은 기준)면 Agent 보고, push 시연이면 지금처럼 kubectl */
export function onpremInventoryDeps(tenantId: string, envId: string, provider: string, env: NodeJS.ProcessEnv = process.env): Pick<InventoryDeps, "agent"> {
  return provider === "onprem" && env.ONPREM_FLOOR_VIA_GIT !== "0" ? { agent: () => agentInventoryFor(tenantId, envId, env) } : {};
}

export function pgAgentReportStore(env: NodeJS.ProcessEnv = process.env): AgentReportStore {
  return {
    keys: pgAgentKeyRegistry(env),
    save: (a) => withTenant(a.tenantId, async (tx) => {
      // 같은 서명이 이미 있으면 넣지 않는다 (ON CONFLICT 로 트랜잭션을 깨지 않고 판단)
      const ins = await tx.query(
        `INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, migration_id, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (key_id, signature) DO NOTHING
         RETURNING id, ${isoUtc("received_at")} AS "receivedAt"`,
        [a.tenantId, a.envId, a.keyId, a.report.kind, a.signature, a.report.sentAt,
         a.report.kind === "deploy" ? a.report.migrationId ?? null : null, JSON.stringify(a.report)]);
      if (ins.rowCount === 0) return "replay" as const;
      if (a.report.kind === "heartbeat") await heartbeatConnection(tx, a);
      return ins.rows[0] as { id: string; receivedAt: string };
    }),
    list: (tenantId, envId, o) => withTenant(tenantId, async (tx) => {
      const e = await tx.query(`SELECT id FROM environments WHERE id = $1`, [envId]);
      if (!e.rows[0]) return null;
      const items = await tx.query(
        `SELECT id, kind, key_id AS "keyId", ${isoUtc("sent_at")} AS "sentAt", ${isoUtc("received_at")} AS "receivedAt",
                migration_id AS "migrationId", body AS report
           FROM agent_reports WHERE env_id = $1 AND ($2::text IS NULL OR kind = $2)
          ORDER BY received_at DESC, id LIMIT $3`, [envId, o.kind ?? null, o.limit]);
      const hb = await tx.query(
        `SELECT ${isoUtc("max(received_at)")} AS at, max(received_at) < now() - make_interval(secs => $2) AS stale
           FROM agent_reports WHERE env_id = $1 AND kind = 'heartbeat'`, [envId, staleSec(env)]);
      const at = (hb.rows[0]?.at as string | null) ?? null;
      return { envId, lastHeartbeatAt: at, stale: at === null ? true : hb.rows[0].stale === true, items: items.rows };
    }),
  };
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};
const AgentErrors = { ...errors(400, 401, 404, 409, 500), 503: ApiError };

export function agentReportRoutesWith(store: AgentReportStore) {
  return async function agentReportRoutes(app: FastifyInstance) {
    // 서명은 받은 글자 그대로에 건다 → 이 경로만 JSON 을 문자열로 받는다 (Fastify 는 플러그인마다 파서가 따로라 다른 경로는 그대로)
    await app.register(async (inner) => {
      inner.removeContentTypeParser("application/json");
      inner.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 * 1024 },
        (_req, body, done) => done(null, body));
      const r = inner.withTypeProvider<ZodTypeProvider>();
      r.post("/agent/reports", {
        // L10(auth.ts): 사람 인증을 건너뛰는 Agent 경로는 이 표시 + 서명 검증 preHandler 가 있어야 등록된다
        config: { agentSignature: true },
        preHandler: async (req) => {
          const raw = typeof req.body === "string" ? req.body : "";
          const keyId = header(req, AGENT_HEADERS.keyId);
          const signature = header(req, AGENT_HEADERS.signature);
          try {
            const got = await acceptAgentReport({ keyId, signature, timestamp: header(req, AGENT_HEADERS.timestamp) },
              raw, store.keys, new Date());
            req.tenantId = got.tenantId;
            req.actor = `agent:${keyId}`;
            req.agentAccepted = { ...got, keyId: keyId!, signature: signature! };
          } catch (e) {
            if (e instanceof AgentReportRejected) throw new DomainError(e.status, e.code, e.message);
            throw e;
          }
        },
        schema: { response: { 201: AgentReportAccepted, ...AgentErrors } },
      }, async (req, reply) => {
        const a = req.agentAccepted!;
        const saved = await store.save(a);
        if (saved === "replay") throw new DomainError(409, "AGENT_REPLAY", "같은 보고(같은 서명)가 이미 들어왔다");
        req.log.info({ agent_key: a.keyId, kind: a.report.kind, env_id: a.envId }, "agent report accepted");
        return reply.code(201).send({ id: saved.id, kind: a.report.kind, envId: a.envId, receivedAt: saved.receivedAt });
      });
    });

    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get("/environments/:id/agent-reports", {
      schema: {
        params: IdParam,
        querystring: z.object({
          kind: AgentReportKinds.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
        response: { 200: AgentReportList, ...errors(400, 401, 404, 500) },
      },
    }, async (req) => found(await store.list(req.tenantId, req.params.id, req.query), "environment", req.params.id));
  };
}

export async function agentReportRoutes(app: FastifyInstance) { return agentReportRoutesWith(pgAgentReportStore())(app); }

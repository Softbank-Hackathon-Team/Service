import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { MigrationStatus, STATE_EXPORT_TOKEN_HEADER, stateExportPath, TERMINAL, TFSTATE_ERRORS, TfStateFile, TfStateQuery, type TfStateLayer } from "@svc/contracts";
import { DomainError, InvalidTransition, withTenant, writeAudit, type Tx } from "@svc/core";
import { errors } from "./responses.js";
import { auditOk, found, IdParam } from "./kit.js";

// GET /api/v1/migrations/:id/tfstate?layer=app|env — 끝난 이전의 고객 Terraform state 를 내려받는다.
// state 는 worker 디스크(PVC TF_WORK_DIR)에만 있다. api 는 클러스터 안 worker 창구(apps/worker/src/state-export-server.ts)에서
//   받아 그대로 흘려보낸다. 메모리에 다 올리지 않고, S3·DB·api 디스크 어디에도 복사하지 않는다. worker 원본은 지우지 않는다.
// 회사 벽: 이전을 withTenant(RLS)로 읽는다 → 남의 회사 이전은 404. worker 경로의 회사 폴더는 로그인한 회사에서 만든다
// 감사: 내려받기를 부를 때마다 migration.tfstate_download (누가 = actor, 어느 이전 = target, 어느 층 = detail.layer). 파일 내용은 안 넣는다
// 로그에 본문·토큰을 남기지 않는다 (요청 로그는 경로·상태 코드만)

// DRAFT(ai): worker 가 머리글을 돌려줄 때까지 10초. 본문 흘려보내기에는 걸지 않는다 (큰 state 가 중간에 잘리지 않게)
export const STATE_EXPORT_TIMEOUT_MS = 10_000;
export const TFSTATE_AUDIT_ACTION = "migration.tfstate_download";

export interface TfStateMigration { status: MigrationStatus; targetEnvId: string }
export interface TfStateRouteOpts {
  /** 이 회사의 이전 한 건 (없으면 null). 시험이 DB 없이 바꿔 끼운다 */
  load?: (tenantId: string, migrationId: string) => Promise<TfStateMigration | null>;
  /** 감사 한 줄 쓰기 */
  audit?: (tenantId: string, entry: ReturnType<typeof auditOk>) => Promise<void>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const defaultLoad = (tenantId: string, id: string) =>
  withTenant(tenantId, async (tx: Tx) => {
    const r = await tx.query("SELECT status, target_env_id FROM migrations WHERE id = $1", [id]);
    const row = r.rows[0] as { status: MigrationStatus; target_env_id: string } | undefined;
    return row ? { status: row.status, targetEnvId: row.target_env_id } : null;
  });
const defaultAudit: NonNullable<TfStateRouteOpts["audit"]> = (tenantId, entry) =>
  withTenant(tenantId, (tx: Tx) => writeAudit(tx, tenantId, entry));

const fail = (status: number, code: string, message: string) => new DomainError(status, code, message);

export async function tfstateRoutes(app: FastifyInstance, opts: TfStateRouteOpts = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = opts.load ?? defaultLoad;
  const audit = opts.audit ?? defaultAudit;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? STATE_EXPORT_TIMEOUT_MS;

  r.get("/migrations/:id/tfstate", {
    schema: {
      params: IdParam,
      querystring: TfStateQuery,
      // 200 은 state 파일 그대로 (application/json 내려받기). 흘려보내므로 TfStateFile 은 문서용이다 (Fastify 는 스트림을 직렬화하지 않는다)
      response: { 200: TfStateFile, ...errors(400, 401, 404, 409, 500, 503) },
    },
  }, async (req, reply) => {
    const id = req.params.id;
    const layer: TfStateLayer = req.query.layer;
    const env = opts.env ?? process.env;

    const m = found(await load(req.tenantId, id), "migration", id);
    // 끝난 이전만 (contracts TERMINAL = completed·rolled_back·cancelled). failed 는 재시도로 state 가 다시 바뀔 수 있어 뺀다
    if (!TERMINAL.includes(m.status)) throw new InvalidTransition(m.status, "tfstate_download");

    const base = env.WORKER_STATE_EXPORT_URL?.trim().replace(/\/+$/, "");
    const token = env.INTERNAL_STATE_TOKEN?.trim();
    if (!base || !token) throw fail(503, TFSTATE_ERRORS.notConfigured, "state export is not configured");

    const stateId = layer === "env" ? m.targetEnvId : id;
    await audit(req.tenantId, auditOk(req, TFSTATE_AUDIT_ACTION, id, { layer, ...(layer === "env" ? { envId: stateId } : {}) }));

    // 머리글이 올 때까지만 시간 제한 (본문은 이어서 흘려보낸다)
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(base + stateExportPath(req.tenantId, layer, stateId), {
        method: "GET", headers: { [STATE_EXPORT_TOKEN_HEADER]: token }, signal: ac.signal, redirect: "error",
      });
    } catch {
      throw fail(503, TFSTATE_ERRORS.unavailable, "state export is unavailable");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw fail(404, TFSTATE_ERRORS.notFound, `terraform state (${layer}) for migration ${id}`);
    }
    if (res.status !== 200 || !res.body) {
      // 401·400 도 여기: 우리 설정(토큰·경로) 문제라 사용자에게는 "지금 못 씀"으로 보인다. 상태 코드만 로그
      await res.body?.cancel();
      req.log.warn({ upstream_status: res.status, layer }, "tfstate: worker state export failed");
      throw fail(503, TFSTATE_ERRORS.unavailable, "state export is unavailable");
    }

    const out = reply as FastifyReply;
    out.header("content-type", "application/json");
    out.header("content-disposition", `attachment; filename="${id}-${layer}.tfstate"`);
    out.header("cache-control", "no-store");
    out.header("x-content-type-options", "nosniff");
    const len = res.headers.get("content-length");
    if (len && /^\d+$/.test(len)) out.header("content-length", len);
    return out.send(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>));
  });
}

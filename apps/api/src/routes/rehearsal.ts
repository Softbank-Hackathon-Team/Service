import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { FidelityMatrix, RehearsalResult, RehearsalView, redactAuditValue,
  type RehearsalFailureCode, type RehearsalSkip, type SandboxRunPhase, type SandboxRunStatus } from "@svc/contracts";
import { NotFound, withTenant, type Tx } from "@svc/core";
import { errors } from "./responses.js";
import { IdParam, isoUtc } from "./kit.js";

// GET /api/v1/migrations/:id/rehearsal — deploying 안 vCluster 리허설의 지금 줄 하나 (읽기 전용, 상태·감사 안 건드림)
// sandbox_runs (db 0046) 에서 그 이전의 가장 큰 epoch 줄을 읽어 contracts RehearsalView 로 돌려준다. 줄이 아직 없으면 run: null
// 회사 벽 밖 이전은 RLS 로 안 보여 404. 응답은 contracts 스키마(strict)를 지나므로 표의 다른 칸은 새지 않는다

// DB 에서 읽은 줄. input 은 큰 YAML 묶음이라 통째로 읽지 않고 충실도 표 칸만 뽑는다
export interface RehearsalRow {
  id: string; status: SandboxRunStatus; failure_code: RehearsalFailureCode | null; phase: SandboxRunPhase | null; skip_reason: RehearsalSkip | null;
  reused_from: string | null; sandbox_name: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; deadline_at: string | null;
  input_fidelity: unknown; result: unknown;
}
export interface RehearsalRead { migrationExists: boolean; row: RehearsalRow | null }

// 저장된 결과는 agent-worker 가 redactText 를 지나 쓴 것이다. 읽는 쪽도 한 번 더 가려 마지막 관문으로 둔다 (이미 가린 글에는 변화 없음)
// 멈춘 이유는 run.failureCode 로 나간다. 워커가 result 없이 끝낸 줄(예: error·REHEARSAL_TIMEOUT)도 failure_code 칸에서 읽어 화면이 이유를 보여 줄 수 있다
// 모양이 안 맞는 칸은 null (화면이 깨지지 않게, 가짜 값으로 채우지 않음). 줄의 상태·단계는 그대로 보인다
export function buildRehearsalView(migrationId: string, row: RehearsalRow | null): RehearsalView {
  if (!row) return { migrationId, run: null };
  const result = RehearsalResult.safeParse(redactAuditValue(row.result));
  // 결과가 오기 전(queued·running)에는 워커가 input 에 넣은 충실도 표(워커 몫)를 보여 준다
  const input = FidelityMatrix.safeParse(redactAuditValue(row.input_fidelity));
  return {
    migrationId,
    run: {
      id: row.id, status: row.status, failureCode: row.failure_code, phase: row.phase, skip: row.skip_reason,
      reusedFrom: row.reused_from, sandboxName: row.sandbox_name,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, deadlineAt: row.deadline_at,
      fidelity: result.success ? result.data.fidelity : input.success ? input.data : null,
      result: result.success ? result.data : null,
    },
  };
}

export async function loadRehearsalDb(tx: Tx, migrationId: string): Promise<RehearsalRead> {
  const m = await tx.query(`SELECT 1 FROM migrations WHERE id = $1`, [migrationId]);
  if (m.rowCount === 0) return { migrationExists: false, row: null };
  const row = (await tx.query(
    `SELECT id, status, failure_code, phase, skip_reason, reused_from, sandbox_name,
            ${isoUtc("created_at")} AS created_at, ${isoUtc("started_at")} AS started_at,
            ${isoUtc("finished_at")} AS finished_at, ${isoUtc("deadline_at")} AS deadline_at,
            input->'fidelity' AS input_fidelity, result
       FROM sandbox_runs WHERE migration_id = $1 AND purpose = 'rehearsal'
      ORDER BY epoch DESC LIMIT 1`, [migrationId])).rows[0] as RehearsalRow | undefined;
  return { migrationExists: true, row: row ?? null };
}

export interface RehearsalRouteOpts {
  // 시험에서 DB 없이 돌리려고 바꿔 끼운다. 기본은 회사 벽(withTenant) 안에서 DB 읽기
  load?: (tenantId: string, migrationId: string) => Promise<RehearsalRead>;
}

export async function rehearsalRoutes(app: FastifyInstance, opts: RehearsalRouteOpts = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = opts.load ?? ((t: string, id: string) => withTenant(t, (tx: Tx) => loadRehearsalDb(tx, id)));
  r.get("/migrations/:id/rehearsal", {
    schema: { params: IdParam, response: { 200: RehearsalView, ...errors(400, 401, 404, 500) } },
  }, async (req, reply) => {
    const input = await load(req.tenantId, req.params.id);
    if (!input.migrationExists) throw new NotFound("migration", req.params.id); // 남의 회사 번호도 404
    reply.header("cache-control", "no-store");
    return buildRehearsalView(req.params.id, input.row);
  });
}

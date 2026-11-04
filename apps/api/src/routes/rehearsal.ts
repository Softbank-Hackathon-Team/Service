import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { FidelityMatrix, MigrationStatus, RehearsalResult, RehearsalView, redactAuditValue,
  type RehearsalFailureCode, type RehearsalSkip, type SandboxRunPhase, type SandboxRunStatus } from "@svc/contracts";
import { NotFound, withTenant, type Tx } from "@svc/core";
import { errors } from "./responses.js";
import { IdParam, isoUtc } from "./kit.js";

// GET /api/v1/migrations/:id/rehearsal — deploying 안 vCluster 리허설의 가장 최근 줄 하나 (읽기 전용, 상태·감사 안 건드림)
// sandbox_runs (db 0046) 에서 그 이전의 가장 큰 epoch 줄을 읽어 contracts RehearsalView 로 돌려준다. 줄이 아직 없으면 run: null
// 그 줄이 지금 배포 시도의 것이 아니면 run.stale = true (재개한 시도가 리허설 문 앞에서 멈추면 새 줄이 없다)
// 회사 벽 밖 이전은 RLS 로 안 보여 404. 응답은 contracts 스키마(strict)를 지나므로 표의 다른 칸은 새지 않는다

// DB 에서 읽은 줄. input 은 큰 YAML 묶음이라 통째로 읽지 않고 충실도 표 칸만 뽑는다
export interface RehearsalRow {
  id: string; status: SandboxRunStatus; failure_code: RehearsalFailureCode | null; phase: SandboxRunPhase | null; skip_reason: RehearsalSkip | null;
  reused_from: string | null; sandbox_name: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; deadline_at: string | null;
  input_fidelity: unknown; result: unknown;
  stale: boolean;
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
      stale: row.stale,
    },
  };
}

// 지금 배포 시도의 차례 = 마지막으로 deploying 에 들어온 때의 migrations.version (워커 deploy.ts 가 sandbox_runs.epoch 에 쓰는 값).
//   advance() 는 전이마다 version 을 1 올리고, 같은 트랜잭션에 from·to 가 상태 이름인 감사 줄을 하나 쓴다 (target = 이전 번호).
//   그래서 그 진입 뒤에 쌓인 전이 수를 지금 version 에서 빼면 된다. version 만 보면(epoch < version) 끝난 줄이 전부 낡아 보인다.
//   진입 기록이 없으면 null (낡았다고 하지 않는다)
// DRAFT(ai): 시각 비교(진입 시각 > 줄 created_at)는 쓰지 않는다. 앞 시도의 배포 작업이 재개 뒤에 늦게 옛 epoch 줄을 쓰면 새 줄처럼 보인다
const DEPLOY_EPOCH_SQL = `
  WITH tr AS (
    SELECT seq, detail->>'to' AS dst FROM audit_events
     WHERE target = $1::text AND detail->>'from' = ANY($2::text[]) AND detail->>'to' = ANY($2::text[])),
  entry AS (SELECT max(seq) AS seq FROM tr WHERE dst = 'deploying')
  SELECT CASE WHEN entry.seq IS NULL THEN NULL
              ELSE m.version - (SELECT count(*) FROM tr WHERE tr.seq > entry.seq)::int END AS deploy_epoch
    FROM migrations m, entry WHERE m.id = $1::uuid`;

export async function loadRehearsalDb(tx: Tx, migrationId: string): Promise<RehearsalRead> {
  const m = await tx.query(DEPLOY_EPOCH_SQL, [migrationId, MigrationStatus.options]);
  if (m.rowCount === 0) return { migrationExists: false, row: null };
  const deployEpoch = (m.rows[0] as { deploy_epoch: number | null }).deploy_epoch;
  const row = (await tx.query(
    `SELECT id, status, failure_code, phase, skip_reason, reused_from, sandbox_name, epoch,
            ${isoUtc("created_at")} AS created_at, ${isoUtc("started_at")} AS started_at,
            ${isoUtc("finished_at")} AS finished_at, ${isoUtc("deadline_at")} AS deadline_at,
            input->'fidelity' AS input_fidelity, result
       FROM sandbox_runs WHERE migration_id = $1 AND purpose = 'rehearsal'
      ORDER BY epoch DESC LIMIT 1`, [migrationId])).rows[0] as (Omit<RehearsalRow, "stale"> & { epoch: number }) | undefined;
  if (!row) return { migrationExists: true, row: null };
  const { epoch, ...rest } = row;
  return { migrationExists: true, row: { ...rest, stale: deployEpoch !== null && epoch < deployEpoch } };
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

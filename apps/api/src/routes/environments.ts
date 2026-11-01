import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Provider } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { cachedInventory, chooseRunner, inventoryToStatus } from "@svc/adapters";
import { EnvironmentList, EnvironmentStatus, errors } from "./responses.js";
import { IdParam, found, isoUtc } from "./kit.js";

export async function environmentRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // 환경 목록. 응답 모양은 contracts EnvironmentView
  // STUB: 연결 링크 발급·연결 확인(verify-connection) 경로는 아직 없음
  r.get("/environments", { schema: { response: { 200: EnvironmentList, ...errors(401, 500) } } }, async (req) => {
    return withTenant(req.tenantId, async (tx) => {
      const q = await tx.query(
        `SELECT id, provider, name, connection_status AS "connectionStatus",
                account_id AS "accountId",
                -- Z17: 응답 스키마(lastVerifiedAt: string|null)에 맞게 DB에서 문자열로. Date의 JSON 모양과 같은 글자
                ${isoUtc("last_verified_at")} AS "lastVerifiedAt",
                NULL::text AS "failureReason"
           FROM environments ORDER BY name`);
      return { items: q.rows };
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

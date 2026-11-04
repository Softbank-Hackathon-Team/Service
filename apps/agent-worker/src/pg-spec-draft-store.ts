import type { Provider } from "@svc/contracts";
import { saveSpecRevision, withTenant, writeAudit } from "@svc/core";
import { llmCacheAuditDetail } from "@svc/agent";
import { adapterFor } from "@svc/adapters";
import { DRAFT_MARKER_KEY, SpecDraftInput, draftMarker } from "@svc/agent";
import type { SpecDraftStore } from "./handle-spec-draft.js";

// Postgres 저장소. agent_runs·agent_steps 표는 db/migrations/0006_agent_runs.sql (작업 K 제안)
// 모든 쿼리는 withTenant 를 지난다 (회사 벽 RLS)
export function pgSpecDraftStore(): SpecDraftStore {
  return {
    async load(tenantId, agentRunId) {
      // M10: DB 읽기(짧은 트랜잭션) → discover(트랜잭션 밖) → 입력 조립. 예전엔 discover를 트랜잭션 안에서 불러
      // 진짜 클라우드 API(수 초~수십 초)가 붙으면 풀 연결을 쥔 채 "idle in transaction"이 됐다
      const row = await withTenant(tenantId, async (tx) => {
        const r = (await tx.query(
          `SELECT status, migration_id FROM agent_runs WHERE id=$1 AND kind='spec_draft'`, [agentRunId])).rows[0];
        if (!r?.migration_id) return null;
        const m = (await tx.query(
          `SELECT s.provider AS sp, t.provider AS tp FROM migrations m
             JOIN environments s ON s.id = m.source_env_id
             JOIN environments t ON t.id = m.target_env_id WHERE m.id=$1`, [r.migration_id])).rows[0];
        // 기준은 사람·규칙이 만든 최신 판. AI 초안 판(_draft 표시)은 기준으로 쓰지 않는다
        // 명세 = spec_v2 칸 (가져오기 결과 한 벌). 명세가 없는 옛 판이면 초안을 만들 기준이 없다
        const v = (await tx.query(
          `SELECT version, spec_v2 FROM spec_versions
            WHERE migration_id=$1 AND NOT (field_meta ? $2) ORDER BY version DESC LIMIT 1`,
          [r.migration_id, DRAFT_MARKER_KEY])).rows[0];
        if (!m || !v?.spec_v2) return null;
        const p = (await tx.query(
          `SELECT plan_doc FROM plans WHERE migration_id=$1 ORDER BY created_at DESC LIMIT 1`, [r.migration_id])).rows[0];
        return { r, m, v, p };
      });
      if (!row) return null;
      const { r, m, v, p } = row;
      const src = adapterFor(m.sp as Provider), dst = adapterFor(m.tp as Provider);
      // STUB: discover 를 다시 부른다 (지금 어댑터 discover 는 데모 원본을 돌려주는 STUB 이라 네트워크를 안 쓴다).
      // TODO(human): 진짜 discover 가 되면 agent-worker 는 고객 계정에 닿으면 안 된다(운영 권한 없음).
      // import 작업이 가린(redact) 원본을 표(inventories 등)에 남기고 여기서는 그 표를 읽게 바꾼다
      const inventory = await src.discover({ accountId: "dev", expiresAt: "" }, { kind: "container", selector: "*" });
      const input = SpecDraftInput.parse({
        migrationId: r.migration_id,
        source: { provider: m.sp },
        // DRAFT(ai): environments 표에 리전 칸이 없어 "default"(어댑터 기본 리전)로 넘긴다
        target: { provider: m.tp, region: "default", capabilities: dst.capabilities() },
        inventory: { provider: inventory.provider, items: inventory.items, coverage: inventory.coverage },
        baseline: { version: v.version, spec: v.spec_v2.spec, fieldMeta: v.spec_v2.fieldMeta ?? {},
          ...(v.spec_v2.unmapped ? { unmapped: v.spec_v2.unmapped } : {}) },
        plan: p ? { steps: p.plan_doc.steps, precheck: p.plan_doc.precheck, rollbackCriteria: p.plan_doc.rollbackCriteria } : null,
      });
      return { status: r.status as string, migrationId: r.migration_id as string, input };
    },
    async claim(tenantId, agentRunId) {
      return withTenant(tenantId, async (tx) => (await tx.query(
        `UPDATE agent_runs SET status='running' WHERE id=$1 AND status='queued' RETURNING id`, [agentRunId])).rowCount === 1);
    },
    async step(tenantId, agentRunId, s) {
      await withTenant(tenantId, (tx) => tx.query(
        `INSERT INTO agent_steps (run_id, tenant_id, seq, tool, ok, note)
         SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5 FROM agent_steps WHERE run_id=$1`,
        [agentRunId, tenantId, s.tool, s.ok, s.note.slice(0, 200)]));
    },
    async saveDraft(tenantId, agentRunId, migrationId, r, baseVersion) {
      return withTenant(tenantId, async (tx) => {
        await tx.query(`SELECT 1 FROM migrations WHERE id=$1 FOR UPDATE`, [migrationId]); // 판 번호 경쟁 막기
        // 초안 판 = 기준 판의 가져오기 결과 한 벌(unmapped·ids·경계 밖 등)에 AI 가 고친 spec·fieldMeta 만 바꿔 끼운 것
        const base = (await tx.query(`SELECT spec_v2 FROM spec_versions WHERE migration_id=$1 AND version=$2`,
          [migrationId, baseVersion])).rows[0]?.spec_v2 as Record<string, unknown> | undefined;
        if (!base) throw new Error(`기준 판 ${baseVersion} 이 없음`);
        const { version } = await saveSpecRevision(tx, { tenantId, migrationId,
          specV2: { ...base, spec: r.spec, fieldMeta: r.fieldMeta }, draftMarker: draftMarker(r.model) });
        await tx.query(
          `UPDATE agent_runs SET status='finished', model=$2, usage=$3, finished_at=now(),
             result=$4 WHERE id=$1`,
          [agentRunId, r.model, r.usage, { version, risks: r.risks, planExplanation: r.planExplanation, rejectedChanges: r.rejectedChanges }]);
        await writeAudit(tx, tenantId, { actor: "ai_agent", action: "agent.spec_draft", target: migrationId, result: "ok",
          detail: { agentRunId, version, risks: r.risks.length, rejected: r.rejectedChanges.length, model: r.model, ...llmCacheAuditDetail() } });
        return { version };
      });
    },
    async fail(tenantId, agentRunId, reason, usage) {
      await withTenant(tenantId, async (tx) => {
        const m = (await tx.query(
          `UPDATE agent_runs SET status='failed', reason=$2, usage=$3, finished_at=now() WHERE id=$1 RETURNING migration_id`,
          [agentRunId, reason.slice(0, 500), usage])).rows[0];
        await writeAudit(tx, tenantId, { actor: "ai_agent", action: "agent.spec_draft", target: m?.migration_id ?? agentRunId,
          result: "error", detail: { agentRunId, reason, ...llmCacheAuditDetail() } });
      });
    },
  };
}

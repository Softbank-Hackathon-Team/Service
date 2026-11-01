import { AppSpec, MigrationJob, QUEUES, type Provider } from "@svc/contracts";
import { latestAcceptedSpec, withTenant, OBSERVE_MIN_SEC } from "@svc/core";
import { runShift, shiftTransition, MigrationMoved, SHARE_TOL_PCT, type ShiftProgress } from "@svc/traffic";
import { nextJob, readMigration, runStep, stubFailIfAsked } from "./_step.js";
import { loadLatestPlan } from "./plan-store.js";
import { configFromEnv, commitTrafficWeight, GitopsRepo, ENV_DIR, tenantSlug, type BundleRef } from "../gitops/index.js";
import { TRAFFIC_LB_ID, trafficMetrics, trafficTickMs, trafficSwitcher } from "../platform.js";

// 트래픽 가중치 전환. shifting → cutover (정상) | rolling_back (지표 나쁨, 긴급 되돌림 뒤) | paused (밖에서 멈춤)
export async function handleShift(raw: unknown) {
  const job = MigrationJob.parse(raw);
  return runStep(job, {
    name: "shift",
    expect: "shifting",
    load: async (tx, j, m) => {
      const plan = await loadLatestPlan(tx, j.migrationId);
      // gitops 기록용 묶음 위치 (설정이 없으면 안 읽는다)
      let bundle: BundleRef | null = null;
      if (configFromEnv()) {
        const spec = await latestAcceptedSpec(tx, m.id);
        const e = await tx.query("SELECT provider FROM environments WHERE id=$1", [m.targetEnvId]);
        if (spec && e.rows[0]) bundle = { tenant: tenantSlug(j.tenantId), app: AppSpec.parse(spec).app.name,
                                               env: ENV_DIR[e.rows[0].provider as Provider] };
      }
      // R3-3: 이 이전이 전에 shifting 을 떠난 적이 있나 (재개 paused → shifting, 컷오버 되돌림 cutover → shifting).
      //   advance() 가 감사 detail 에 from/to 를 남긴다. 처음 shift 면 false
      const back = await tx.query(
        `SELECT 1 FROM audit_events WHERE target = $1 AND detail->>'from' = 'shifting' LIMIT 1`, [m.id]);
      return { plan, bundle, reentered: (back.rowCount ?? 0) > 0 };
    },
    work: async (j, _m, { plan, bundle, reentered }, ctx) => {
      // 단계마다 gitops 레포 traffic.weightPct 기록 (Z14 제안). 순서: Cloudflare 바꾸고 확인(setAndVerify) → 그 뒤 Git.
      // Git 기록이 실패해도 트래픽은 되돌리지 않는다. 결과 detail 에 gitopsWeightLag 로 남긴다
      const cfg = configFromEnv();
      const repo = cfg && bundle ? new GitopsRepo(cfg) : null;
      const gitopsWeightLag: { pct: number; error: string }[] = [];
      const onWeight = repo && bundle ? async (pct: number) => {
        try { await commitTrafficWeight(repo, bundle, pct); }
        catch (e) { gitopsWeightLag.push({ pct, error: (e as Error).message.slice(0, 200) }); }
      } : undefined;
      await stubFailIfAsked(j, "shift");             // Z36 데모: 가중치를 바꾸기 전에 실패
      const steps = plan?.steps.find((s) => s.id === "shift")?.weights ?? [10, 50, 100];
      const lbId = TRAFFIC_LB_ID ?? j.migrationId;
      // R3-3: 다시 들어온 shift 는 지금 가중치부터 이어 간다 (runShift resumeFromPct). 예전엔 늘 10% 부터 다시 → 50% 에서 멈췄다 재개하면
      //   도착 트래픽이 10% 로 떨어졌다가 다시 올라갔다(컷오버 되돌림 뒤엔 100% → 10%). 처음 shift 는 LB 에 남은 값을 믿지 않고 0 부터
      const sw = trafficSwitcher();
      const now = reentered ? await sw.get(lbId).catch(() => null) : null;
      const resumeFromPct = now && now.target > 0 ? Math.round(now.target * 100) : undefined;
      // z75-38: 화면용 진행 한 줄 (traffic_progress). 단계·도달 여부가 바뀌면 바로, 아니면 최대 초당 1번. 실패해도 전환은 계속 (표시용)
      let lastWrite = 0, lastKey = "";
      const onProgress = async (p: ShiftProgress) => {
        const key = `${p.stepPct}:${p.reached}:${p.reobserve}`;
        if (key === lastKey && Date.now() - lastWrite < 1000) return;
        lastKey = key; lastWrite = Date.now();
        await withTenant(j.tenantId, (tx) => tx.query(
          `INSERT INTO traffic_progress (migration_id, tenant_id, target_pct, observed_pct, reached, tolerance_pct, reobserve, step_started_at, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (migration_id) DO UPDATE SET target_pct = EXCLUDED.target_pct, observed_pct = EXCLUDED.observed_pct,
             reached = EXCLUDED.reached, tolerance_pct = EXCLUDED.tolerance_pct, reobserve = EXCLUDED.reobserve,
             step_started_at = EXCLUDED.step_started_at, observed_at = EXCLUDED.observed_at`,
          [j.migrationId, j.tenantId, p.stepPct, p.observedPct, p.reached, SHARE_TOL_PCT, p.reobserve, p.stepStartedAt, p.at]))
          .catch(() => { /* 표시용. 쓰기 실패로 전환을 멈추지 않는다 */ });
      };
      const r = await runShift({
        migrationId: j.migrationId, lbId, switcher: sw, metrics: trafficMetrics(), steps, onWeight, resumeFromPct,
        sleep: () => new Promise((res) => setTimeout(res, trafficTickMs())),
        observeSec: OBSERVE_MIN_SEC,   // M7: 시계로 관찰. T22 전이 조건과 같은 값
        // z75-38: 단계마다 "최소 관찰(TRAFFIC_OBSERVE_SEC) 지남 + 실측 도착 몫이 목표 ±10%p" 라야 다음 단계. 못 미치면 2번 더 본 뒤 paused
        //   Z38 R8-43: TRAFFIC_SHARE_CHECK=0 이면 끈다 (예전 동작: 10%·50% 는 판정 3번만, 몫 확인·진행 기록 없음). 부를 때마다 읽는다
        ...(process.env.TRAFFIC_SHARE_CHECK?.trim() === "0" ? {} : { shareTolPct: SHARE_TOL_PCT, stepObserveSec: OBSERVE_MIN_SEC, onProgress }),
        // 다른 쪽(가드레일·사람)이 상태를 바꿨으면 그 자리에서 멈춘다. 가중치는 그대로
        // Z19 H3: 잠금을 잃었으면(롤백 시작이 잠금을 되찾음, Z1) 바로 멈춘다
        shouldPause: async () => ctx.signal?.aborted === true
          || (await withTenant(j.tenantId, (tx) => readMigration(tx, j.migrationId)))?.status !== "shifting",
        // Z19 H3: 도착 쪽으로 올리는 PATCH는 "이전 행 FOR SHARE + 아직 shifting" 트랜잭션 안에서만 한다.
        // API 롤백·일시정지의 advance는 같은 행을 FOR UPDATE로 잡으므로 PATCH(최대 약 3.5초)가 끝날 때까지 기다린다
        // → rollback 작업의 "출발 100%"는 항상 shift의 마지막 PATCH 뒤에 온다. 예전엔 그 반대 순서가 되면 rolled_back인데 도착 50%가 남았다
        guardSet: (apply) => withTenant(j.tenantId, async (tx) => {
          const q = await tx.query(`SELECT status FROM migrations WHERE id = $1 FOR SHARE`, [j.migrationId]);
          const status = q.rows[0]?.status as string | undefined;
          if (status !== "shifting" || ctx.signal?.aborted) throw new MigrationMoved(status);
          await apply();
        }),
      });
      // 상태가 이미 바뀌어 멈췄으면 상태는 건드리지 않는다 (롤백 쪽이 트래픽을 맡는다)
      if (r.outcome === "paused" && ctx.signal?.aborted !== true) {
        const now = (await withTenant(j.tenantId, (tx) => readMigration(tx, j.migrationId)))?.status;
        if (now !== "shifting") throw new MigrationMoved(now);
      }
      // STUB: 도착 로그 수신(MG-3-04)은 관측 영역이 붙으면. 지금은 판정에 도착 표본이 있었으면 true
      const targetLogsSeen = r.judgements.some((x) => x.stepPct === 100 && x.samples > 0);
      const t = shiftTransition(r, { targetLogsSeen });
      return {
        to: t.to, evidence: t.evidence,
        // Z43 F4: 트래픽 사유(TRAFFIC_ERROR_RATE 등)를 상태 칸 failure_code까지 보낸다. 예전엔 감사 detail에만 있어
        //   자동 롤백 뒤 화면 "사유"가 비었다. paused 결과도 T30 조건(failureCode 필요)을 이걸로 만족한다
        failureCode: t.failureCode ?? undefined,
        // M7: 30초보다 짧게 관찰했으면 화면·감사에 "압축"을 같이 남긴다 (심사에서 "30초 봤다"고 잘못 말하지 않게)
        detail: { ...t.detail, failureCode: t.failureCode, lbId, ...(resumeFromPct !== undefined ? { resumeFromPct } : {}), ...(repo ? { gitopsWeightLag } : {}),
                  observeRequiredSec: r.observeRequiredSec, ...(r.stepShares ? { stepShares: r.stepShares } : {}),
                  ...(r.observeRequiredSec < 30 ? { observeCompressed: true, stub: "관찰 시간 압축 (TRAFFIC_OBSERVE_SEC)" } : {}) },
        next: t.enqueue === "cutover" ? nextJob(QUEUES.cutover, j)
          : t.enqueue === "rollback" ? nextJob(QUEUES.rollback, j)
          : undefined,
      };
    },
  });
}

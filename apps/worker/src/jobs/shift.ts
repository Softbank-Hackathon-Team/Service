import { MigrationJob, QUEUES, envNumber, type Provider } from "@svc/contracts";
import { latestAcceptedAppName, withTenant, observeMinSec, takeTrafficLease, POLICY } from "@svc/core";
import { runShift, shiftTransition, MigrationMoved, MAX_REOBSERVE, SHARE_TOL_PCT, type ShiftProgress } from "@svc/traffic";
import { jobData, nextJob, readMigration, RetryLater, runStep, stubFailIfAsked } from "./_step.js";
import { loadLatestPlan } from "./plan-store.js";
import { configFromEnv, commitTrafficWeight, GitopsRepo, ENV_DIR, tenantSlug, type BundleRef } from "../gitops/index.js";
import { trafficFor, trafficMetrics, trafficTickMs } from "../platform.js";
import { restoredFromPct } from "../traffic-restore.js";

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
        const app = await latestAcceptedAppName(tx, m.id);
        const e = await tx.query("SELECT provider FROM environments WHERE id=$1", [m.targetEnvId]);
        if (app && e.rows[0]) bundle = { tenant: tenantSlug(j.tenantId), app,
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
      const obs = shiftObserveSec(plan?.steps.find((s) => s.id === "shift")?.holdSec, process.env);
      // pf-d hunt-traffic-ops-02: 관찰 초가 크면 최악(단계 수 × (1 + 재관찰) × 관찰 초)이 shift 큐 만료(expireInSeconds)를 넘어
      //   도는 중에 만료·재시도된다(가중치 반쯤인 채 두 번째 shift). 가중치를 건드리기 전에 paused + 숫자
      const budget = shiftBudget(steps.length, obs.sec, process.env.TRAFFIC_SHARE_CHECK?.trim() !== "0");
      if (budget.over) return { to: "paused", failureCode: "TRAFFIC_OBSERVE_TOO_LONG", detail: { shift: { error: "TRAFFIC_OBSERVE_TOO_LONG",
        reason: `관찰 ${obs.sec}초 × 단계 ${steps.length} × (1 + 재관찰 ${MAX_REOBSERVE}) = 최악 ${budget.worstSec}초 가 shift 작업 제한 ${budget.limitSec}초(만료 ${budget.expireSec}초의 90%)를 넘음 → 계획 holdSec·TRAFFIC_OBSERVE_SEC 를 줄이고 재개`,
        ...budget, observeSource: obs.source } } };
      const { lbId, switcher: sw, from: lbFrom } = await trafficFor(j.tenantId, j.migrationId);   // PF TRF-21: 이전별 LB 자리(DB) 먼저
      // PF FM-ORC-10: LB 는 워커 전역 하나 → 가중치를 바꾸기 전에 LB 주인이 된다. 다른 이전(다른 회사 포함)이 쥐고 있으면 기다렸다 다시
      //   DRAFT(ai): 30초 뒤 다시 (TRAFFIC_LEASE_WAIT_SEC). 주인이 끝 상태가 되면 advance 가 놓는다
      const lease = await withTenant(j.tenantId, (tx) => takeTrafficLease(tx, lbId, j.migrationId));
      // PF RV-20: 주인 이전이 paused·failed 로 멈추면 LB 를 영영 안 놓는다(끝 상태에서만 놓음) → 예전엔 30초마다 상한 없이 기다렸다.
      //   DRAFT(ai): TRAFFIC_LEASE_MAX_WAIT_SEC(기본 1800초) 넘게 기다렸으면 가중치를 안 건드린 채 paused(TRAFFIC_LB_BUSY) + 회수 명령.
      //   회수: npm run ops:lb-release -- <LB> (주인이 멈춘 이전일 때만 지움, 감사 남김) → 이 이전을 재개
      if (lease !== "mine") {
        const waitedSec = await lbWaitedSec(j.tenantId, j.migrationId);
        const maxWait = envNumber(process.env.TRAFFIC_LEASE_MAX_WAIT_SEC, 1800);
        if (waitedSec >= maxWait)
          return { to: "paused", failureCode: "TRAFFIC_LB_BUSY", detail: { shift: { error: "TRAFFIC_LB_BUSY", lease, waitedSec, maxWaitSec: maxWait,
            reason: `같은 LB 를 다른 이전이 ${waitedSec}초째 쥐고 있음 (그 이전이 멈췄을 수 있음). 가중치는 안 건드림`,
            hint: `npm run ops:lb-release -- ${lbId} 로 주인을 확인·회수한 뒤 이 이전을 재개` } } };
      }
      if (lease !== "mine")
        throw new RetryLater("shift", jobData(j), envNumber(process.env.TRAFFIC_LEASE_WAIT_SEC, 30),
          { error: `traffic LB busy (${lease}): another migration is shifting on the same load balancer` });
      // R3-3: 다시 들어온 shift 는 지금 가중치부터 이어 간다 (runShift resumeFromPct). 예전엔 늘 10% 부터 다시 → 50% 에서 멈췄다 재개하면
      //   도착 트래픽이 10% 로 떨어졌다가 다시 올라갔다(컷오버 되돌림 뒤엔 100% → 10%). 처음 shift 는 LB 에 남은 값을 믿지 않고 0 부터
      const now = reentered ? await sw.get(lbId).catch(() => null) : null;
      const resumeFromPct = now && now.target > 0 ? Math.round(now.target * 100) : undefined;
      // Jeong 결정 01:53Z: 실패 진입 때 restoreTrafficToSource 가 출발 100% 로 되돌렸으면(LB 도착 0) 재시도는 그때 단계부터 다시 오른다.
      //   DRAFT(ai): 마지막 traffic.restored 의 fromPct 보다 작은 단계는 건너뛰고 그 단계 가중치부터 PATCH (10% 부터 다시 안 함)
      const restored = reentered && now && now.target === 0 ? await restoredFromPct(j.tenantId, j.migrationId).catch(() => null) : null;
      const runSteps = restored ? steps.filter((p) => p >= restored) : steps;
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
        migrationId: j.migrationId, lbId, switcher: sw, metrics: trafficMetrics(j.tenantId), steps: runSteps.length ? runSteps : steps, onWeight, resumeFromPct,
        sleep: () => new Promise((res) => setTimeout(res, trafficTickMs())),
        observeSec: obs.sec,   // M7: 시계로 관찰. pf-d FM-TRF-15: 승인 계획 holdSec (T22 최소보다 짧지 않게)
        // z75-38: 단계마다 "최소 관찰(TRAFFIC_OBSERVE_SEC) 지남 + 실측 도착 몫이 목표 ±10%p" 라야 다음 단계. 못 미치면 2번 더 본 뒤 paused
        //   Z38 R8-43: TRAFFIC_SHARE_CHECK=0 이면 끈다 (예전 동작: 10%·50% 는 판정 3번만, 몫 확인·진행 기록 없음). 부를 때마다 읽는다
        ...(process.env.TRAFFIC_SHARE_CHECK?.trim() === "0" ? {} : { shareTolPct: SHARE_TOL_PCT, stepObserveSec: obs.sec, onProgress }),
        // 다른 쪽(가드레일·사람)이 상태를 바꿨으면 그 자리에서 멈춘다. 가중치는 그대로
        // Z19 H3: 잠금을 잃었으면(롤백 시작이 잠금을 되찾음, Z1) 바로 멈춘다
        shouldPause: async () => ctx.signal?.aborted === true
          || (await withTenant(j.tenantId, (tx) => readMigration(tx, j.migrationId)))?.status !== "shifting",
        // Z19 H3: 도착 쪽으로 올리는 PATCH는 "이전 행 FOR SHARE + 아직 shifting" 트랜잭션 안에서만 한다.
        // API 롤백·일시정지의 advance는 같은 행을 FOR UPDATE로 잡으므로 PATCH 가 끝날 때까지 기다린다
        // pf-d RV-11: apply 는 PATCH 한 번(요청 시간 제한 10초)만. 확인 GET·재시도 대기는 잠금 밖이라 API 가 오래 안 막힌다.
        //   이 트랜잭션이 DB 오류로 실패하면 runShift 가 한 번 더 해 보고, 그래도면 출발 100% 로 되돌린 뒤 paused(TRAFFIC_PLATFORM_ERROR)
        // → rollback 작업의 "출발 100%"는 항상 shift의 마지막 PATCH 뒤에 온다. 예전엔 그 반대 순서가 되면 rolled_back인데 도착 50%가 남았다
        guardSet: (apply) => withTenant(j.tenantId, async (tx) => {
          const q = await tx.query(`SELECT status FROM migrations WHERE id = $1 FOR SHARE`, [j.migrationId]);
          const status = q.rows[0]?.status as string | undefined;
          if (status !== "shifting" || ctx.signal?.aborted) throw new MigrationMoved(status);
          await apply();
        }),
      });
      // pf-d TRF-10: 가짜 지표면 cf-check --probe 가 이 이전에 남긴 분배 실측(감사 traffic.probe) 최신 한 줄을 결과에 붙인다. 없으면 null (실측 없음)
      const probe = r.metricsSource === "stub" ? await latestProbe(j.tenantId, j.migrationId).catch(() => null) : undefined;
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
        detail: { ...t.detail, failureCode: t.failureCode, lbId, ...(resumeFromPct !== undefined ? { resumeFromPct } : {}), ...(restored ? { restartFromPct: restored } : {}), ...(repo ? { gitopsWeightLag } : {}),
                  observeRequiredSec: r.observeRequiredSec, ...(r.stepShares ? { stepShares: r.stepShares } : {}),
                  // pf-d FM-TRF-10: 가짜 지표(PROM_URL 없음)면 몫은 실측이 아니다 → 화면·감사에서 "실측"으로 읽지 않게 표시
                  metricsSource: r.metricsSource,
                  // pf-d FM-TRF-21: 전환기가 mock 이면 진짜 LB 는 안 바뀌었다 (TRAFFIC_PROVIDER 비었음). 실회차에서 조용히 성공처럼 안 보이게
                  trafficProvider: sw.provider, trafficLbFrom: lbFrom,
                  ...(sw.provider === "mock" ? { trafficStub: "STUB: mock 전환기 (TRAFFIC_PROVIDER 없음) — Cloudflare LB 가중치는 안 바뀜" } : {}),
                  ...(r.metricsSource === "stub" ? { sharesStub: "STUB: 가짜 지표 (PROM_URL 없음) — stepShares 는 가중치로 계산한 값, 실측 아님. 실제 분배는 cf-check --probe",
                    probe: probe ?? null } : {}),
                  observeSource: obs.source, ...(obs.planHoldSec !== undefined ? { planHoldSec: obs.planHoldSec } : {}),
                  ...(r.observeRequiredSec < (obs.planHoldSec ?? 30) ? { observeCompressed: true, stub: "관찰 시간 압축 (TRAFFIC_OBSERVE_SEC)" } : {}) },
        next: t.enqueue === "cutover" ? nextJob(QUEUES.cutover, j)
          : t.enqueue === "rollback" ? nextJob(QUEUES.rollback, j)
          : undefined,
      };
    },
  });
}

// pf-d hunt-traffic-ops-02 DRAFT(ai): 한 shift 작업이 쓸 수 있는 최악 시간. 몫 확인을 켜면 단계마다 최소 관찰 + 재관찰 MAX_REOBSERVE 번,
//   끄면 100% 단계 관찰만. 만료의 90% 를 넘으면 막는다 (나머지 10% = 판정 틱·PATCH·DB 여유)
export function shiftBudget(steps: number, observeSec: number, shareCheck: boolean, expireSec = POLICY[QUEUES.shift]?.expireInSeconds ?? 900) {
  const worstSec = Math.ceil((shareCheck ? steps : 1) * (1 + (shareCheck ? MAX_REOBSERVE : 0)) * observeSec);
  const limitSec = Math.floor(expireSec * 0.9);
  return { worstSec, limitSec, expireSec, over: worstSec > limitSec };
}

// pf-d TRF-10: cf-check --probe --register 가 남긴 분배 실측 (감사 traffic.probe). 회사 벽 안에서만 읽는다
export async function latestProbe(tenantId: string, migrationId: string): Promise<{ result: string; detail: unknown; at: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const q = await tx.query<{ result: string; detail: unknown; at: Date }>(
      `SELECT result, detail, at FROM audit_events WHERE target = $1 AND action = 'traffic.probe' ORDER BY seq DESC LIMIT 1`, [migrationId]);
    const row = q.rows[0];
    return row ? { result: row.result, detail: row.detail, at: new Date(row.at).toISOString() } : null;
  });
}

// pf-d FM-TRF-15 DRAFT(ai) (지휘 결정 11/4 00:44Z, Jeong 위임): 단계마다 관찰 초 = 사람이 승인한 계획의 shift holdSec.
//   TRAFFIC_OBSERVE_SEC 를 명시했을 때만 그 값으로 덮어쓴다(데모 압축). 그때 계획보다 짧으면 결과에 observeCompressed 가 남는다.
//   계획 값이 T22 최소(OBSERVE_MIN_SEC, 기본 30·PROM_URL 이면 30 아래로 못 감)보다 짧으면 최소로 올린다: 짧게 보면 T22 가 cutover 를 막는다.
//   계획에 holdSec 이 없으면(옛 계획) 예전처럼 OBSERVE_MIN_SEC
export function shiftObserveSec(planHoldSec: number | undefined, env: NodeJS.ProcessEnv = process.env):
  { sec: number; source: "env" | "plan" | "default"; planHoldSec?: number } {
  const raw = env.TRAFFIC_OBSERVE_SEC?.trim();
  const explicit = !!raw && Number.isFinite(Number(raw)) && Number(raw) > 0;
  const floor = observeMinSec(env);
  const hold = planHoldSec !== undefined && Number.isFinite(planHoldSec) && planHoldSec > 0 ? planHoldSec : undefined;
  if (explicit) return { sec: floor, source: "env", ...(hold !== undefined ? { planHoldSec: hold } : {}) };
  if (hold !== undefined) return { sec: Math.max(hold, floor), source: "plan", planHoldSec: hold };
  return { sec: floor, source: "default" };
}

// PF RV-20: 이 shift 단계에 들어온 뒤(migrations.updated_at) 처음 "LB busy" 로 미룬 때부터 몇 초 지났나. 없으면 0
async function lbWaitedSec(tenantId: string, migrationId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => Number((await tx.query<{ s: string | null }>(
    `SELECT extract(epoch FROM now() - min(a.at)) AS s FROM audit_events a
      WHERE a.target = $1 AND a.action = 'shift.retry_scheduled' AND a.detail->>'error' LIKE 'traffic LB busy%'
        AND a.at >= (SELECT updated_at FROM migrations WHERE id = $2)`, [migrationId, migrationId])).rows[0]?.s ?? 0));
}

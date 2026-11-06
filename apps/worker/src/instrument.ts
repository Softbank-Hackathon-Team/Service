import { Registry, withLogContext, contextFromJob, createLogger, JOB_BUCKETS_SEC } from "@svc/core";

// 워커 작업 하나를 감싼다: 로그 문맥(job_id·queue·tenant_id·migration_id) + 작업 지표
// 처리 함수 안(runStep, advance 앞뒤)에서 log 로 찍는 줄에는 이 필드가 자동으로 붙는다

export const workerRegistry = new Registry();
const runs = workerRegistry.counter("svc_job_runs_total", "Jobs handled by this worker, by queue and result");
const took = workerRegistry.histogram("svc_job_duration_seconds", "Job handler duration by queue", JOB_BUCKETS_SEC);
const inflight = workerRegistry.gauge("svc_jobs_in_flight", "Jobs currently running in this worker");
// 이전 측정의 A-B 교차 그래프 (출발 = 100 - 값). LB 에 확인된 가중치만 넣는다.
// shift 와 rollback 이 다른 워커에서 돌 수 있어 바꾼 시각도 낸다. 대시보드는 가장 최근에 바꾼 워커의 값을 쓴다
// ponytail: 워커 메모리 값이라 값을 쥔 워커가 재시작하면 그 선이 끊긴다. 끊김까지 없애려면 DB 에서 읽는다
const trafficWeight = workerRegistry.gauge("svc_traffic_weight_pct", "Target traffic weight confirmed on the load balancer, percent");
const trafficWeightAt = workerRegistry.gauge("svc_traffic_weight_updated_seconds", "Unix time this worker last set svc_traffic_weight_pct");
export const setTrafficWeightMetric = (migrationId: string, pct: number) => {
  trafficWeight.set({ migration: migrationId }, pct);
  trafficWeightAt.set({ migration: migrationId }, Date.now() / 1000);
};

export const log = createLogger(process.env.SERVICE_NAME ?? "worker");

export interface JobLike { id?: string; data: unknown }

export function instrument<J extends JobLike>(queue: string, handle: (data: unknown) => Promise<unknown>) {
  let running = 0;
  return async (job: J) => withLogContext(contextFromJob(queue, job.id, job.data), async () => {
    const t0 = performance.now();
    inflight.set({ queue }, ++running);
    log.info("job started");
    try {
      const out = await handle(job.data);
      // runStep 은 "advanced" | "skipped" 를 돌려준다. 그 밖은 ok
      const result = out === "advanced" || out === "skipped" ? out : "ok";
      runs.inc({ queue, result });
      log.info({ result, duration_ms: Math.round(performance.now() - t0) }, "job finished");
      return out;
    } catch (e) {
      runs.inc({ queue, result: "error" });
      log.error({ err: e, duration_ms: Math.round(performance.now() - t0) }, "job failed");
      throw e;                                      // pg-boss 가 재시도·실패 처리를 하게 그대로 던진다
    } finally {
      took.observe({ queue }, (performance.now() - t0) / 1000);
      inflight.set({ queue }, --running);
    }
  });
}

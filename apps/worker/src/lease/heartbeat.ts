import { createDedicatedPool, renewEnvLocks, LEASE, FENCE_SLACK_SEC, createLogger } from "@svc/core";

const log = createLogger("worker").child({ component: "heartbeat" });

// 생존 신호: 오래 걸리는 작업(Terraform 등)이 도는 동안 30초마다 환경 잠금 기한을 90초 뒤로 민다.
// 일반 연결이 바빠도 늦지 않게 전용 연결을 쓴다. 각 연장은 1초짜리 짧은 트랜잭션이다.
// 스스로 멈춤(self-fencing) 규칙:
//   - 연장 결과가 기대한 줄 수보다 적다 = 내가 주인이 아니다 → 즉시 멈춘다 (NOT_OWNER)
//   - DB에 못 닿는다 → 마지막 성공 뒤 60초가 지나는 순간 멈춘다 (DB_UNREACHABLE)
// 멈추면 signal이 abort된다. 작업은 이 signal로 Terraform에 SIGINT를 보내고, 새 상태 이동을 시도하지 않는다.
// 기한 자체는 DB now()로 잰다. 60초 여유는 이 프로세스가 직접 잰 경과 시간이다 (시계가 달라도 상관없다)

const hbPool = createDedicatedPool(2);

export type LostReason = "NOT_OWNER" | "DB_UNREACHABLE";

export interface HeartbeatOpts {
  tenantId: string;
  migrationId: string;
  envIds: string[];
  holder: string;                 // worker:<pod 이름>
  intervalMs?: number;            // 기본 30초
  selfFenceMs?: number;           // 기본 60초
  onLost?: (reason: LostReason) => void;
}

export interface Heartbeat {
  signal: AbortSignal;
  beats: () => number;            // 성공한 연장 횟수
  stop: () => void;
}

export function startHeartbeat(o: HeartbeatOpts): Heartbeat {
  const intervalMs = o.intervalMs ?? LEASE.heartbeatSec * 1000;
  const selfFenceMs = o.selfFenceMs ?? LEASE.selfFenceSec * 1000;
  const ac = new AbortController();
  let lastOk = performance.now();
  let beats = 0;
  let inFlight = false;

  const lose = (reason: LostReason) => {
    if (ac.signal.aborted) return;
    // 스스로 멈춤은 장애 신호다. 지표(svc_lease_heartbeat_lag_seconds)와 같이 본다
    log.error({ tenant_id: o.tenantId, migration_id: o.migrationId, reason, beats,
      since_last_ok_ms: Math.round(performance.now() - lastOk) }, "heartbeat lost: self-fencing");
    stop();
    ac.abort(reason);
    o.onLost?.(reason);
  };

  const beat = async () => {
    if (inFlight || ac.signal.aborted) return;
    inFlight = true;
    const c = await hbPool.connect().catch(() => null);
    // L9: 이번 연장에서 오류가 났으면 그 연결은 버린다(release(err) = 풀이 닫고 새로 연다).
    // 그냥 release()하면 끊긴 연결이 풀로 돌아가 다음 연장도 같은 죽은 연결을 집는다
    let broken: Error | undefined;
    // 빌린 연결이 연장 도중 서버에서 끊기면 Client가 'error'를 낸다. 처리기가 없으면 워커 프로세스가 죽는다
    // (L9 시험에서 재현: uncaughtException "Connection terminated unexpectedly"). withTenant와 같은 방식
    const onErr = (e: Error) => { broken = e; };
    c?.on("error", onErr);
    try {
      if (!c) throw new Error("connect failed");
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout = '5s'");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [o.tenantId]);
      const renewed = await renewEnvLocks(c, o);
      // P-1: DB가 매달린 사이 스스로 멈췄으면(abort) 늦게 끝난 연장은 버린다. 멈춘 워커가 잠금을 늘리면 안 된다
      if (ac.signal.aborted) { await c.query("ROLLBACK"); return; }
      await c.query("COMMIT");
      if (renewed.length < new Set(o.envIds).size) return lose("NOT_OWNER");
      lastOk = performance.now();
      beats++;
    } catch (e) {
      broken = e instanceof Error ? e : new Error(String(e));
      await c?.query("ROLLBACK").catch(() => undefined);
      // 오류 하나로는 멈추지 않는다. 감시 타이머가 60초 규칙을 본다
    } finally {
      c?.off("error", onErr);
      c?.release(broken);
      inFlight = false;
    }
  };

  const timer = setInterval(beat, intervalMs);
  // 감시: 연장이 걸려 있어도(응답 없는 DB) 60초가 지나면 멈춘다
  const watchdog = setInterval(() => {
    if (performance.now() - lastOk > selfFenceMs) lose("DB_UNREACHABLE");
  }, Math.min(FENCE_SLACK_SEC * 1000, Math.max(50, Math.floor(selfFenceMs / 4))));

  function stop() { clearInterval(timer); clearInterval(watchdog); }
  return { signal: ac.signal, beats: () => beats, stop };
}

// 시험·종료용: 전용 연결 닫기
export async function closeHeartbeatPool() { await hbPool.end(); }

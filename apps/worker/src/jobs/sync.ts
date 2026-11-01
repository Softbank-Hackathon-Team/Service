import { Measurement, MigrationJob, QUEUES } from "@svc/contracts";
import { replicationFromEnv, SchemaCopyError, toMeasurements } from "@svc/replication";
import { withTenant } from "@svc/core";
import { MigrationMoved } from "@svc/traffic";
import { errorMessage, jobData, nextJob, runStep, stubWait, failedAttempts, recordAttemptFailure, readMigration, RetryLater, type StepOutcome } from "./_step.js";

// 결정(10/31 Jeong 기본값 승인): 복제가 재시도를 다 쓰면 syncing → paused(SYNC_FAILED). 사람이 원인을 보고 재개하거나 롤백한다.
// 대가: paused는 환경 잠금을 쥔 채라 같은 환경의 다음 이전이 409 ENV_BUSY로 막힌다 → 롤백 버튼(POST .../rollback)으로 풀린다.
// Z1의 자동 롤백(syncing → rolling_back, 잠금 해제)은 SYNC_EXHAUSTED_ACTION=rollback 으로 켠다 (컷오버 전이라 데이터 손실 없음)
// Z19 H4 (10/31 Jeong 기본값 승인): 재시도 3번, 대기 5초 → 15초 → 45초 (따라잡기 여유 약 1분). 그래도 안 되면 위 규칙(기본 paused).
// 예전(Z1): pg-boss 재시도 1번·대기 0초라 몇 초 안에 포기했다. 초기 복사가 수십 초 걸리는 Cloud SQL에서 너무 짧다.
// pg-boss 재시도 대기는 고정 또는 지터 섞인 2배라 5·15·45를 못 줘서, 처리기가 startAfter로 직접 다시 넣는다(RetryLater). 큐 retryLimit은 0
export const SYNC_RETRY_DELAYS_SEC = (process.env.SYNC_RETRY_DELAYS_SEC ?? "5,15,45")
  .split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0);
export const SYNC_MAX_ATTEMPTS = SYNC_RETRY_DELAYS_SEC.length + 1;
// 다 쓴 뒤 어디로: pause(기본, paused + SYNC_FAILED, 잠금 유지) | rollback(Z1 자동 롤백, 잠금 해제)
export const SYNC_EXHAUSTED_ACTION = process.env.SYNC_EXHAUSTED_ACTION === "rollback" ? "rollback" : "pause";
// 다시 해도 소용없는 실패 (설정·권한 문제) → 바로 롤백
class SyncPermanentError extends Error {
  constructor(msg: string, readonly code = "SYNC_FAILED") { super(msg); }
}
// Z38 REVIEW-5 (04): precheck 의 연결 전 TLS 실패(NET-TLS*)는 사유 코드를 따로 둔다 → 화면·감사에서 "설정 문제"가 바로 보인다
// Z77: 도착 표 없음(DB-T4)은 REPL_TARGET_SCHEMA_MISSING → "앱 마이그레이션 또는 REPL_COPY_SCHEMA=1" 이 바로 보인다 (TLS 가 먼저)
// Z77 (Z62 주제 60): 도착 DB 의 복제 권한·설정(wal_level DB-01, 슬롯·walsender DB-02, REPLICATION DB-04) 실패는 DEST_REPL_PRIVILEGE.
//   맥 실측(00:01Z): Cloud SQL app 에 REPLICATION 이 없어 전환 C5 뒤에 깨졌다 → 복제를 걸기 전 sync 첫 점검에서 paused 로 멈춘다
export const precheckFailureCode = (failed: { id: string; side?: string }[]) =>
  failed.some((c) => c.id.startsWith("NET-TLS")) ? "REPL_TLS_REQUIRED"
  : failed.some((c) => c.side === "target" && ["DB-01", "DB-02", "DB-04"].includes(c.id)) ? "DEST_REPL_PRIVILEGE"
  : failed.some((c) => c.id === "DB-T4") ? "REPL_TARGET_SCHEMA_MISSING" : "SYNC_FAILED";

// DB 논리 복제(CDC) 따라잡기. syncing → shifting
// 복제 지연이 기준 아래로 내려와야 트래픽을 옮긴다 (컷오버 전 관문 T21)
// REPL_SOURCE_URL이 있으면 @svc/replication으로 진짜 복제, 없으면 STUB (DB 하나로 도는 smoke 유지)
export async function handleSync(raw: unknown) {
  const job = MigrationJob.parse(raw);
  return runStep(job, {
    name: "sync",
    expect: "syncing",
    work: async (j) => {
      const next = nextJob(QUEUES.shift, j);
      const repl = replicationFromEnv(j.migrationId);
      if (!repl) {
        await stubWait();
        // 시험·데모용: 복제 실패를 흉내 낸다 (SYNC_STUB_FAIL=1). 진짜 복제 없이 자동 롤백 길을 보여 준다
        if (process.env.SYNC_STUB_FAIL === "1") return failed(new Error("STUB: replication not ready (SYNC_STUB_FAIL=1)"));
        const lag = Measurement.parse({ migrationId: j.migrationId, name: "replication_lag_ms",
          value: 120, unit: "ms", env: "target", at: new Date().toISOString() });
        return { to: "shifting", detail: { measurements: [lag], stub: true },
          evidence: { replicationLagBytes: 0, rowCountMatch: true, markerRoundTripMs: 120, snapshotDone: true },   // STUB: 진짜 지연·행 수 비교 결과
          next };
      }
      let r: Awaited<ReturnType<typeof repl.sync>>, ev: Awaited<ReturnType<typeof repl.catchUpEvidence>>;
      let schemaCopy: Awaited<ReturnType<typeof repl.prepareTarget>> = null;
      let replicationAttr: Awaited<ReturnType<typeof repl.prepareReplicationRoles>> | null = null;
      try {
        // 처음 온 작업이면 복제 가능한지 먼저 본다 (precheck 작업의 DB 점검은 아직 STUB이라 여기서 한 번 더)
        if ((await repl.phase()) === "idle") {
          // Z77: REPL_COPY_SCHEMA=1 이면 점검 전에 도착에 없는 표를 출발 모양대로 만든다 (실패하면 한 트랜잭션이라 남는 것 없음 → 재시도 무의미)
          try { schemaCopy = await repl.prepareTarget(); }
          catch (e) {
            // Z38 R8-34: DDL·지원 안 하는 모양(SchemaCopyError)만 재시도 없이 멈춘다. 연결 끊김 등은 보통 재시도로
            if (e instanceof SchemaCopyError) throw new SyncPermanentError(`schema copy failed: ${e.message}`, e.code);
            throw e;
          }
          // Z77: Cloud SQL 계정에 REPLICATION 을 먼저 준다 (못 주면 아래 precheck DB-04 가 멈춘다)
          replicationAttr = await repl.prepareReplicationRoles();
          const pc = await repl.precheck();
          if (!pc.ok) {
            const bad = pc.checks.filter((c) => !c.ok && c.level !== "warn");
            throw new SyncPermanentError(`replication precheck failed: ${bad.map((c) => `${c.id} ${c.detail}`).join("; ")}`, precheckFailureCode(bad));
          }
        }
        // 정방향 복제 만들기(없으면) → 초기 스냅샷 대기 → 지연 판정
        r = await repl.sync();
        // Z19 H3: 복제를 만드는 동안 롤백이 먼저 확정됐으면(롤백 작업의 teardown이 이미 지나갔을 수 있다) 방금 만든 것을 걷고 손 뗀다
        const now = (await withTenant(j.tenantId, (tx) => readMigration(tx, j.migrationId)))?.status;
        if (now !== "syncing") {
          if (r.created) await repl.teardown().catch(() => undefined);
          throw new MigrationMoved(now);
        }
        // 아직 못 따라왔으면 실패. 횟수가 남았으면 pg-boss 재시도, 다 썼으면 자동 롤백
        // Z52 (Q16): 슬롯이 이미 끊겼으면(SLOT_LOST) 기다려도 안 돌아온다 → 재시도 없이 바로 롤백
        if (!r.gate.ready && r.gate.fatal) throw new SyncPermanentError(`replication slot lost: ${r.gate.reasons.join(", ")}`);
        if (!r.gate.ready) throw new Error(`replication not ready: ${r.gate.reasons.join(", ")}`);
        ev = await repl.catchUpEvidence();
      } catch (e) {
        if (e instanceof MigrationMoved) throw e;
        return failed(e);
      }
      return {
        to: "shifting",
        detail: { measurements: toMeasurements(r.measures, j.migrationId, "target"), replication: {
          names: r.names, copy: r.copy, gate: r.gate, slotLagBytes: ev.replicationLagBytes, counts: ev.counts,
          ...(replicationAttr ? { replicationAttr: replicationAttr.filter((x) => x.result !== "skipped") } : {}),
          ...(schemaCopy ? { schemaCopy: { created: schemaCopy.created, types: schemaCopy.types, sequences: schemaCopy.sequences, indexes: schemaCopy.indexes,
            foreignKeys: schemaCopy.foreignKeys, skippedForeignKeys: schemaCopy.skippedForeignKeys, roleCreated: schemaCopy.roleCreated,
            grants: schemaCopy.grants, ms: Math.round(schemaCopy.ms) } } : {}) } },
        // T21 조건: 초기 스냅샷 끝 + 마커 왕복 500ms 이하. 바이트 지연·행 수는 기록만 (쓰기 부하 중엔 0·일치가 안 될 수 있다)
        // L5: 슬롯 지연을 못 읽었으면(null = 모름) 증거에서 뺀다. 감사 detail.replication.slotLagBytes에는 null로 남는다
        evidence: { replicationLagBytes: ev.replicationLagBytes ?? undefined, rowCountMatch: ev.rowCountMatch,
          markerRoundTripMs: r.measures.find((m) => m.name === "replication_lag_ms")?.value,
          snapshotDone: r.gate.ready },
        next,
      };

      // 예전: 예외만 던져 재시도가 끝나면 syncing에 멈추고 환경 잠금이 계획 만료(2시간)까지 남았다 → 같은 환경 409 ENV_BUSY
      async function failed(e: unknown): Promise<StepOutcome> {
        const msg = errorMessage(e, Infinity);   // 자르지 않은 원문 (아래 각 자리에서 예전처럼 자르거나 그대로 둔다)
        const attempts = (await failedAttempts(j, "sync")) + 1;
        const permanent = e instanceof SyncPermanentError;
        const failureCode = permanent ? (e as SyncPermanentError).code : "SYNC_FAILED";
        const exhausted = permanent || attempts >= SYNC_MAX_ATTEMPTS;
        if (exhausted && SYNC_EXHAUSTED_ACTION === "pause") {
          return { to: "paused", failureCode, detail: { error: msg, attempts, permanent } };
        }
        if (exhausted) {
          return { to: "rolling_back", failureCode,
            detail: { error: msg, attempts, permanent },
            evidence: { reason: `sync failed: ${msg}`.slice(0, 500) },
            next: nextJob(QUEUES.rollback, j) };
        }
        await recordAttemptFailure(j, "sync", { attempts, max: SYNC_MAX_ATTEMPTS, error: msg });
        throw new RetryLater("sync", jobData(j), SYNC_RETRY_DELAYS_SEC[attempts - 1] ?? 0, { attempts, max: SYNC_MAX_ATTEMPTS, error: msg.slice(0, 500) });
      }
    },
  });
}

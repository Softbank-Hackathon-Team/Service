import { envNumber, Measurement, MigrationJob, QUEUES } from "@svc/contracts";
import { replicationFor } from "./_repl.js";
import { ReplConfigError, SchemaCopyError, toMeasurements, endpointAddress, tcpReachProblem } from "@svc/replication";
import { withTenant } from "@svc/core";
import { MigrationMoved } from "@svc/traffic";
import { errorMessage, jobData, nextJob, runStep, stubWait, failedAttempts, recordAttemptFailure, readMigration, RetryLater, type StepOutcome } from "./_step.js";

// 결정(10/31 Jeong 기본값 승인): 복제가 재시도를 다 쓰면 syncing → paused(SYNC_FAILED). 사람이 원인을 보고 재개하거나 롤백한다.
// 대가: paused는 환경 잠금을 쥔 채라 같은 환경의 다음 이전이 409 ENV_BUSY로 막힌다 → 롤백 버튼(POST .../rollback)으로 풀린다.
// Z1의 자동 롤백(syncing → rolling_back, 잠금 해제)은 SYNC_EXHAUSTED_ACTION=rollback 으로 켠다 (컷오버 전이라 데이터 손실 없음)
// Z19 H4 (10/31 Jeong 기본값 승인): 재시도 3번, 대기 5초 → 15초 → 45초 (따라잡기 여유 약 1분). 그래도 안 되면 위 규칙(기본 paused).
// 예전(Z1): pg-boss 재시도 1번·대기 0초라 몇 초 안에 포기했다. 초기 복사가 수십 초 걸리는 Cloud SQL에서 너무 짧다.
// pg-boss 재시도 대기는 고정 또는 지터 섞인 2배라 5·15·45를 못 줘서, 처리기가 startAfter로 직접 다시 넣는다(RetryLater). 큐 retryLimit은 0
export const SYNC_RETRY_DELAYS_SEC = (process.env.SYNC_RETRY_DELAYS_SEC || "5,15,45")   // PF-E13: 빈 값 = 기본
  .split(",").map((x) => x.trim()).filter(Boolean).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
export const SYNC_MAX_ATTEMPTS = SYNC_RETRY_DELAYS_SEC.length + 1;
// 다 쓴 뒤 어디로: pause(기본, paused + SYNC_FAILED, 잠금 유지) | rollback(Z1 자동 롤백, 잠금 해제)
export const SYNC_EXHAUSTED_ACTION = process.env.SYNC_EXHAUSTED_ACTION === "rollback" ? "rollback" : "pause";
// PF-E3 DRAFT(ai): 초기 복사가 "도는 중"이면 위 시도 횟수를 깎지 않고 SYNC_COPY_RECHECK_SEC 마다 다시 본다. 전체 상한 SYNC_COPY_MAX_WAIT_SEC
//   (기본 2시간). 상한을 넘기면 그때부터는 보통 실패로 센다. 위 Jeong 결정(5·15·45초)은 진짜 실패(연결·지연·작업자 멈춤)에 그대로 쓴다
//   이유: 1분 여유로는 수 GB DB 의 첫 복사를 못 기다려 늘 paused 였다 (복사는 잘 되고 있는데)
// TODO(human): 상한 2시간이 맞는지(결선 데모는 작은 DB 라 영향 없음)
export const SYNC_COPY_RECHECK_SEC = envNumber(process.env.SYNC_COPY_RECHECK_SEC, 30);
export const SYNC_COPY_MAX_WAIT_SEC = envNumber(process.env.SYNC_COPY_MAX_WAIT_SEC, 7200);
export const SYNC_EVIDENCE_WAIT_MS = envNumber(process.env.SYNC_EVIDENCE_WAIT_MS, 3000);
class CopyInProgress extends Error {}
// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// 도착 끝점이 DB 줄(replication_endpoints)에서 왔으면 붙기 전에 host:port 로 TCP 연결만 먼저 해 본다 (REPL_REACH_TIMEOUT_MS, 기본 5초).
//   못 붙으면 오류 글자가 REPL_TARGET_UNREACHABLE 로 시작하고 host:port 를 적는다 → 화면·감사에서 "중계기·방화벽·주소" 문제가 바로 보인다
// DRAFT(ai): 접속 실패와 같은 꼴로 센다 (재시도 5·15·45초 뒤 paused). 중계기·터널이 막 뜨는 중일 수 있어 바로 멈추지 않는다.
//   다 쓰면 failureCode 도 REPL_TARGET_UNREACHABLE (SYNC_FAILED 대신)
export const REPL_REACH_TIMEOUT_MS = envNumber(process.env.REPL_REACH_TIMEOUT_MS, 5000);
class TargetUnreachable extends Error { readonly code = "REPL_TARGET_UNREACHABLE"; }
// PF-E4 (FM-APP-11): 다시 해도 안 바뀌는 접속·설정 오류(Postgres SQLSTATE). 예전엔 보통 실패로 세어 1분 넘게 헛돌고 paused SYNC_FAILED.
//   3D000 없는 DB · 28P01 비밀번호 틀림 · 28000 접속 허용 안 됨(pg_hba) · 42501 권한 없음 → 바로 멈춘다 (코드는 그대로 SYNC_FAILED, 원문은 detail.error)
export const PERMANENT_PG_CODES = new Set(["3D000", "28P01", "28000", "42501"]);
const pgCode = (e: unknown): string | undefined => { const c = (e as { code?: unknown } | null)?.code; return typeof c === "string" ? c : undefined; };
// 다시 해도 소용없는 실패 (설정·권한 문제) → 바로 롤백
class SyncPermanentError extends Error {
  constructor(msg: string, readonly code = "SYNC_FAILED", readonly checks?: { id: string; side?: string; detail: string; hint?: string }[]) { super(msg); }
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
      // FM-ORC-09(orch replicationFor: 명세에 postgres 없으면 null) + PF-E22({tf:} 못 채운 주소는 바로 paused) 둘 다
      let repl: Awaited<ReturnType<typeof replicationFor>>;
      try { repl = await replicationFor(j.tenantId, j.migrationId); }
      catch (e) {
        // PF-E22: {tf:} 를 못 채운 주소는 재시도해도 같다 → 바로 paused (사유·못 채운 키를 감사에)
        if (e instanceof ReplConfigError) return failed(new SyncPermanentError(e.message, e.code));
        throw e;
      }
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
      if (repl.cfg.target.origin === "db") {
        const { host, port } = endpointAddress(repl.cfg.target);
        const why = await tcpReachProblem(host, port, REPL_REACH_TIMEOUT_MS);
        if (why) return failed(new TargetUnreachable(`REPL_TARGET_UNREACHABLE ${host}:${port} (${repl.cfg.target.label}): ${why}`));
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
            // PF-E8 (FM-APP-17): 고칠 방법(hint)까지 감사 detail.checks 에 남긴다 (예전엔 id·detail 만 → 무엇을 바꿀지 안 보임)
            throw new SyncPermanentError(`replication precheck failed: ${bad.map((c) => `${c.id} ${c.detail}`).join("; ")}`, precheckFailureCode(bad),
              bad.map((c) => ({ id: c.id, side: c.side, detail: c.detail, ...(c.hint ? { hint: c.hint } : {}) })));
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
        if (!r.gate.ready && r.copying) throw new CopyInProgress(`initial copy in progress: ${r.copy.ready}/${r.copy.tables} tables ready (${JSON.stringify(r.copy.states)})`);
        if (!r.gate.ready) throw new Error(`replication not ready: ${r.gate.reasons.join(", ")}`);
        // PF-E14 (FM-APP-25): T21 은 바이트 지연을 안 본다(기록만). 쓰기 부하 중엔 0바이트가 안 와서 15초를 꽉 기다렸다 → SYNC_EVIDENCE_WAIT_MS (DRAFT(ai) 기본 3초)
        ev = await repl.catchUpEvidence({ waitMs: SYNC_EVIDENCE_WAIT_MS });
      } catch (e) {
        if (e instanceof MigrationMoved) throw e;
        return failed(e);
      }
      return {
        to: "shifting",
        detail: { measurements: toMeasurements(r.measures, j.migrationId, "target"), replication: {
          names: r.names, copy: r.copy, gate: r.gate, slotLagBytes: ev.replicationLagBytes, counts: ev.counts, ...(r.staleFences ? { staleFences: r.staleFences } : {}),
          ...(replicationAttr ? { replicationAttr: replicationAttr.filter((x) => x.result !== "skipped") } : {}),
          ...(schemaCopy ? { schemaCopy: { created: schemaCopy.created, types: schemaCopy.types, sequences: schemaCopy.sequences, indexes: schemaCopy.indexes,
            foreignKeys: schemaCopy.foreignKeys, skippedForeignKeys: schemaCopy.skippedForeignKeys, roleCreated: schemaCopy.roleCreated,
            grants: schemaCopy.grants, ms: Math.round(schemaCopy.ms), ...(schemaCopy.objects?.length ? { objects: schemaCopy.objects } : {}) } } : {}) } },
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
        if (e instanceof CopyInProgress) {
          // PF-E3: 복사 중은 시도로 안 센다. 기다린 횟수 × (복사 기다림 120초 + 다시 보기 간격) 가 상한을 넘으면 보통 실패로
          const waits = (await failedAttempts(j, "sync_copy")) + 1;
          if (waits * (120 + SYNC_COPY_RECHECK_SEC) <= SYNC_COPY_MAX_WAIT_SEC) {
            await recordAttemptFailure(j, "sync_copy", { attempts: waits, max: Math.floor(SYNC_COPY_MAX_WAIT_SEC / (120 + SYNC_COPY_RECHECK_SEC)), error: msg });
            throw new RetryLater("sync", jobData(j), SYNC_COPY_RECHECK_SEC, { copyWaits: waits, error: msg.slice(0, 500) });
          }
        }
        const attempts = (await failedAttempts(j, "sync")) + 1;
        const code = e instanceof SyncPermanentError ? undefined : pgCode(e);
        const checks = e instanceof SyncPermanentError && e.checks?.length ? { checks: e.checks } : {};
        // PF-E7: 상대 DB 에 못 붙음(구독이 출발로 못 감) = 중계기·터널·허용 주소 문제. 원인 찾는 곳을 같이 남긴다
        const peerHint = /could not connect to the publisher/.test(msg) ? { hint: "도착 DB 가 출발(REPL_SOURCE_PEER_URL)에 못 붙음 → 중계기·터널·DB_PEER_CIDRS·보안 그룹 확인" }
          : e instanceof TargetUnreachable ? { hint: "워커가 도착 DB 주소(replication_endpoints target host:port)에 못 붙음 → 주소·중계기·방화벽 확인 (npm run repl:endpoint -- show)" } : {};
        const permanent = e instanceof SyncPermanentError || (!!code && PERMANENT_PG_CODES.has(code));
        const failureCode = e instanceof SyncPermanentError || e instanceof TargetUnreachable ? e.code : "SYNC_FAILED";
        const exhausted = permanent || attempts >= SYNC_MAX_ATTEMPTS;
        if (exhausted && SYNC_EXHAUSTED_ACTION === "pause") {
          return { to: "paused", failureCode, detail: { error: msg, attempts, permanent, ...(code ? { pgCode: code } : {}), ...checks, ...peerHint } };
        }
        if (exhausted) {
          return { to: "rolling_back", failureCode,
            detail: { error: msg, attempts, permanent, ...(code ? { pgCode: code } : {}), ...checks, ...peerHint },
            evidence: { reason: `sync failed: ${msg}`.slice(0, 500) },
            next: nextJob(QUEUES.rollback, j) };
        }
        await recordAttemptFailure(j, "sync", { attempts, max: SYNC_MAX_ATTEMPTS, error: msg, ...peerHint });
        throw new RetryLater("sync", jobData(j), SYNC_RETRY_DELAYS_SEC[attempts - 1] ?? 0, { attempts, max: SYNC_MAX_ATTEMPTS, error: msg.slice(0, 500) });
      }
    },
  });
}

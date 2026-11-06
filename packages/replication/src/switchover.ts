import { connect, type Endpoint } from "./endpoint.js";
import { ensureApplyGrants, fence, parseUnfence, unfence, unfenceSql } from "./fence.js";
import { detachSubscriptionSql, disableSubscription, dropSlotIfIdle, ensurePublication, ensureSubscription, slotExists } from "./replicate.js";
import { ident, lit, now, sleep } from "./sql.js";
import { fq, markerRef, rowCountCols, rowCounts, rowCountsFrom, type TableRef } from "./tables.js";

// 쓰기 담당 바꾸기 (컷오버 C1~C6). 방향만 바꿔 롤백에도 같은 함수를 쓴다.
//   C1 붙잡기(트래픽 PAUSE) → C2 출발 울타리 → C3 마지막 따라잡기(마커) → C4 시퀀스 맞추기
//   → C5 정방향 구독 제거 + 역방향 발행·슬롯 먼저 만들기 → C5b 도착 울타리 걷기 → C6 대상 바꾸고 풀어 주기
//   C3가 시간 안에 안 끝나면 C6' 되돌림: 출발 울타리 걷고 출발 그대로 풀어 준다
//   C2 뒤에도 앱 계정이 쓸 수 있으면(다른 역할을 거친 권한, L4) 같은 C6' 되돌림 (FENCE_INEFFECTIVE)

/** 앱 연결을 붙잡고 푸는 쪽. 실제로는 PgBouncer PAUSE/RESUME이나 앱 설정 전환(트래픽 모듈). 테스트는 프로세스 안 라우터 */
export interface TrafficHooks {
  /** 진행 중 요청은 끝까지, 새 요청은 에러 없이 기다리게 */
  pause(): Promise<void>;
  /** 쓰기 대상을 writer로 바꾸고 기다리던 요청을 풀어 준다 */
  resume(writer: Endpoint): Promise<void>;
}
export const NO_TRAFFIC_HOOKS: TrafficHooks = { pause: async () => {}, resume: async () => {} };

export interface StepMeasure { name: string; value: number; unit: "ms" | "count" | "bytes" }

export interface SwitchoverInput {
  from: Endpoint; to: Endpoint;
  /** 지금 도는 from → to 복제 이름 (to 쪽 subscription) */
  current: string;
  /** 새로 만들 to → from 복제 이름 */
  reverse: string;
  tables: TableRef[];
  hooks?: TrafficHooks;
  /** C3 마지막 따라잡기 제한 시간. 넘기면 C6' */
  maxCatchupMs?: number;
  /** C3 뒤 표별 행 수가 정확히 같은지 확인 (울타리 뒤라 같아야 한다) */
  verifyCounts?: boolean;
  /** PF-E24: verifyCounts 를 안 주면 추정 행 수가 이 값 이하일 때만 비교 (기본 100만) */
  verifyCountsMaxRows?: number;
  /** PF-E26: C6 뒤 역방향 구독 붙이기를 다시 해 보는 횟수 (기본 4 = 1·2·4·8초) */
  reverseRetries?: number;
  /** PF-E23: 멈춤 전 구독 적용 일꾼을 기다리는 상한 (기본 15초) */
  workerWaitMs?: number;
  /** C4 시퀀스 여유분 */
  sequenceGap?: number;
  /** Z36: 워커가 환경 잠금을 잃으면 abort된다. C5(되돌릴 수 없는 지점) 직전에 보고 멈춘다 → catch가 출발 울타리를 걷는다.
   *  청소 작업이 "죽은 워커"로 보고 울타리를 걷는 동안, 살아 있던 워커가 C5로 넘어가 둘이 엇갈리는 것을 막는다 */
  signal?: AbortSignal;
  /** 단계 끝마다 불림 (진행 신호·감사 기록용) */
  onStep?: (step: string, ms: number) => void;
}

export type SwitchoverResult =
  | { ok: true; pauseMs: number; measures: StepMeasure[] }
  | { ok: false; reason: SwitchoverFailure; detail: string; pauseMs: number; measures: StepMeasure[] };
export type SwitchoverFailure = "CATCHUP_TIMEOUT" | "ROW_COUNT_MISMATCH" | "FENCE_INEFFECTIVE";

/** Z19 H2: C1~C6 도중 예외. pastNoReturn=false면 출발 울타리를 이미 걷었다(unfenced=true일 때). true면 C5(정방향 구독 삭제) 뒤라 사람이 봐야 한다 */
export class SwitchoverError extends Error {
  readonly code = "SWITCHOVER_ERROR";
  constructor(readonly step: string, readonly pastNoReturn: boolean, readonly unfenced: boolean, readonly original: unknown) {
    super(`switchover failed at ${step}${pastNoReturn ? (unfenced ? " (past C5 before C6: source unfenced, forward replication gone, re-sync needed)" : " (past C5: no automatic revert)") : unfenced ? " (source unfenced)" : " (UNFENCE FAILED: source may be read-only)"}: ${(original as Error)?.message ?? String(original)}`);
  }
}

export async function switchover(i: SwitchoverInput): Promise<SwitchoverResult> {
  const hooks = i.hooks ?? NO_TRAFFIC_HOOKS;
  const maxCatchupMs = i.maxCatchupMs ?? 10_000;
  const gap = i.sequenceGap ?? 1000;
  // 관리자 세션은 C1 전에 열어 둔다 (멈춤 시간에 연결 시간을 넣지 않으려고)
  const S = await connect(i.from), D = await connect(i.to);
  const measures: StepMeasure[] = [];
  const marks: [string, number][] = [];
  const mark = (step: string) => { const t = now(); const prev = marks.at(-1)?.[1] ?? t; marks.push([step, t]); i.onStep?.(step, t - prev); return t; };
  // Z19 H2: 예외가 났을 때 되돌릴 수 있나를 정하는 두 표시
  let fenced = false;        // C2 울타리를 치기 시작했다 (REVOKE만 되고 끊기에서 죽어도 true)
  let pastNoReturn = false;  // C5 정방향 구독을 지웠다 = 출발에 쓰기를 돌려주면 그 쓰기는 도착에 안 간다
  let switched = false;      // Z77: C6 쓰기 대상을 도착으로 바꿨다 (이 전이면 앱은 아직 출발을 쓴다)
  let resumeTried = false;   // Z38 R8-47: C6 resume(to) 를 불렀다 (프록시가 돌았는데 응답 전에 깨졌을 수 있다)
  let paused = false;        // C1 을 불렀다 (멈춤 전 준비에서 깨지면 풀어 줄 것이 없다)
  try {
    // z75-31: 멈춤 "전" 준비. 멈춤 구간 안에서 할 필요가 없는 두 가지를 앞으로 뺐다 (원격이면 왕복마다 ~20ms)
    //   ① C4 가 맞출 시퀀스 목록: 표 구조는 이전 중에 안 바뀐다 (DDL 은 이전 범위 밖). 값(setval)은 그대로 멈춤 안에서 맞춘다
    //   ② 역방향 발행: 이름과 표 목록뿐이고 슬롯이 없으면 아무것도 안 붙잡는다. 되돌림(C6')으로 끝나도 teardown 이 지운다
    const seqs = await sequencesOf(D, i.tables);
    await ensurePublication(D, i.reverse, i.tables);
    // Z38 R8-33 (b): 도착에 i.reverse 이름의 "쉬는" 슬롯이 남아 있으면(지난 컷오버의 정방향 슬롯을 못 지운 경우 등) 먼저 지운다.
    //   안 지우면 C5 의 "없을 때만 만든다" 가 옛 위치의 슬롯을 그대로 써서, 그 뒤 변경을 반대편에 다시 보내 중복 키로 멈출 수 있다.
    //   붙어 있는(active) 슬롯이면 누가 쓰는 중이라 손대지 않고 멈춘다(멈춤 전이라 아무것도 안 바뀐 상태)
    const stale = results(await D.query(`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots
         WHERE slot_name = ${lit(i.reverse)} AND database = current_database() AND NOT active;
      SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = ${lit(i.reverse)}) AS busy`));
    if (stale[0]?.rowCount) measures.push({ name: "stale_reverse_slot_dropped", value: stale[0].rowCount, unit: "count" });
    if (stale.at(-1)?.rows[0]?.busy) throw new Error(`slot ${i.reverse} already exists and is in use on ${i.to.label}; refusing to reuse it`);
    // Z77 (맥 실측 00:01Z): 역방향 슬롯은 C5 뒤에 만든다. 그때 권한이 없으면 자동 되돌림 없이 멈췄다(CUTOVER_HALFWAY).
    //   멈춤 전에 임시 슬롯을 만들었다 지워 권한을 미리 본다 (왕복 2번, 멈춤 시간 밖). 안 되면 아무것도 안 바뀐 채 멈춘다
    const slotProbe = `${i.reverse}_p`.slice(0, 63);
    try {
      await D.query(`SELECT pg_create_logical_replication_slot($1, 'pgoutput', true)`, [slotProbe]);
      await D.query(`SELECT pg_drop_replication_slot($1)`, [slotProbe]);
    } catch (x) {
      throw new Error(`reverse slot not allowed on ${i.to.label} (checked before pause, nothing changed): ${(x as Error).message}`);
    }
    // PF-E23 (FM-APP-30): 방금 만든 구독(컷오버 직후 롤백의 역방향)은 런처가 몇 초 뒤에 적용 일꾼을 띄운다. 그 전에 멈추면 C3 가 마커를 ~5초 기다렸다(쓰기 멈춤).
    //   멈춤 전에 일꾼이 뜰 때까지 기다린다 (쓰기 안 멈춤). 상한이 지나면 예전처럼 그냥 간다 (C3 의 따라잡기 상한이 그대로 지킨다)
    const tw = now();
    while (now() - tw < (i.workerWaitMs ?? 15_000)) {
      const w = await D.query(`SELECT 1 FROM pg_stat_subscription WHERE subname = $1 AND relid IS NULL AND pid IS NOT NULL`, [i.current]);
      if (w.rowCount) break;
      await sleep(50);
    }
    if (now() - tw >= 1) measures.push({ name: "apply_worker_wait_ms", value: Math.round(now() - tw), unit: "ms" });
    // PF-E24 (FM-APP-29) DRAFT(ai): C3 의 행 수 비교는 멈춤 안에서 출발·도착 전체를 훑어 표 크기에 비례해 멈춤이 늘었다(600만 행 0.5~1.1초).
    //   추정 행 수(pg_class.reltuples 합)가 한도(기본 100만, REPL_VERIFY_COUNTS_MAX_ROWS)를 넘으면 멈춤 안 행 수 비교를 뺀다.
    //   순서 보장은 마커(한 길로 순서대로 적용)가 하고, 행 수는 sync 증거(catchUpEvidence)에 남는다. TODO(human): 큰 DB 에서 행 수 대신 무엇으로 검증할지
    let verifyDefault = true;
    if (i.verifyCounts === undefined) {
      const est = await S.query<{ n: string | null }>(`SELECT sum(GREATEST(c.reltuples, 0))::bigint n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE (ns.nspname, c.relname) IN (SELECT * FROM unnest($1::text[], $2::text[]))`, [i.tables.map((t) => t.schema), i.tables.map((t) => t.name)]);
      const maxRows = i.verifyCountsMaxRows ?? 1_000_000;
      if (Number(est.rows[0]?.n ?? 0) > maxRows) { verifyDefault = false; measures.push({ name: "row_count_verify_skipped_est_rows", value: Number(est.rows[0]!.n), unit: "count" }); }
    }
    const T0 = now(); marks.push(["start", T0]);
    paused = true;
    await hooks.pause(); const t1 = mark("c1_pause");
    fenced = true;
    // L4: 울타리가 정말 쓰기를 막았나는 울타리와 같은 왕복 안에서 본다. 못 막았으면 C3로 가지 않고 바로 C6' 되돌림 (그대로 가면 갈라진 쓰기가 생긴다)
    // Z80: C3 표지도 같은 왕복 끝에 넣는다 (L4 검사가 깨끗할 때만 서버가 넣음. 새면 표지 없이 아래 C6')
    const token = `cut-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const f = await fence(S, i.from, { check: i.tables, marker: token }); mark("c2_fence");
    measures.push({ name: "fence_terminated_sessions", value: f.terminated, unit: "count" });
    const leaky = f.leaky;
    if (leaky.length) {
      await unfence(S, i.from);
      await hooks.resume(i.from); mark("c6_abort_resume");
      return { ok: false, reason: "FENCE_INEFFECTIVE", detail: `app role ${i.from.appRole} can still write: ${leaky.join(", ")}`,
        pauseMs: now() - t1, measures: [...measures, ...stepMeasures(marks)] };
    }

    if (!f.markerInserted) throw new Error("C2: marker was not inserted although the fence check was clean");
    const verify = i.verifyCounts ?? verifyDefault;
    // z75-31: 출발 행 수는 표지를 넣은 뒤 바로 센다 (울타리 뒤라 고정). 도착을 기다리는 동안 다른 연결에서 같이 돈다
    const srcCounts = verify ? rowCounts(S, i.tables) : Promise.resolve(null);
    srcCounts.catch(() => {});
    // 도착 행 수는 "표지가 왔나" 와 같은 문장에서 센다: 표지가 보이는 스냅샷이면 그 앞 변경도 전부 보인다 (한 길로 순서대로 적용)
    const probe = `SELECT EXISTS (SELECT 1 FROM ${fq(markerRef)} WHERE token=$1) AS arrived${verify ? `, ${rowCountCols(i.tables)}` : ""}`;
    let arrived = false;
    let dstRow: Record<string, unknown> | null = null;
    const tc = now();
    while (now() - tc <= maxCatchupMs) {
      const r = await D.query(probe, [token]);
      if (r.rows[0]?.arrived) { arrived = true; dstRow = r.rows[0]; break; }
      await sleep(5);
    }
    let failure: { reason: SwitchoverFailure; detail: string } | null =
      arrived ? null : { reason: "CATCHUP_TIMEOUT", detail: `marker not on target within ${maxCatchupMs}ms` };
    const a = await srcCounts;
    if (!failure && verify && a && dstRow) {
      const b = rowCountsFrom(dstRow, i.tables);
      const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
      if (diff.length) failure = { reason: "ROW_COUNT_MISMATCH", detail: diff.map((k) => `${k} ${a[k]}≠${b[k]}`).join(", ") };
    }
    mark("c3_catchup");
    if (failure) {
      // C6' 되돌림: 아무것도 안 바뀐 상태로 출발에 쓰기를 돌려준다
      await unfence(S, i.from);
      await hooks.resume(i.from); mark("c6_abort_resume");
      return { ok: false, ...failure, pauseMs: now() - t1, measures: [...measures, ...stepMeasures(marks)] };
    }

    // C4 시퀀스: 논리 복제가 안 옮기는 유일한 상태. 소유 칸 max + gap (목록은 멈춤 전에 읽어 둠)
    // z75-31: 시퀀스마다 왕복하던 setval 을 한 문장으로 (값은 같다: 각자 자기 표의 max + gap)
    if (seqs.rows.length) {
      await D.query(`SELECT ${seqs.rows.map((x) =>
        `setval(${lit(x.seq)}, COALESCE((SELECT max(${ident(x.col)}) FROM ${ident(x.sch)}.${ident(x.tbl)}), 0) + ${Number(gap)})`).join(",\n             ")}`);
    }
    measures.push({ name: "sequences_synced", value: seqs.rowCount ?? 0, unit: "count" });
    mark("c4_sequences");

    // C5 정방향 끊기(출발 슬롯은 RESUME 뒤에 지움, Z80 04) → 역방향 슬롯을 RESUME "전에" 만들어 RESUME 직후 쓰기도 붙잡는다
    if (i.signal?.aborted) throw new Error("env lock lost before C5 (another process may be recovering this migration)");
    pastNoReturn = true;   // 지우는 SQL이 도중에 죽어도 지워졌을 수 있으니 부르기 전에 표시
    // Z80 04: 정방향 구독을 "끄기"(커밋 → 적용 프로세스가 끝나기 시작) 한 번, 그다음 메시지 하나에
    //   [역방향 슬롯 만들기 → 구독을 slot_name=NONE 으로 떼고 지우기 → C5b 도착 울타리 걷기].
    //   예전 DROP SUBSCRIPTION 은 도착 DB 가 출발 DB 에 새로 접속해 슬롯을 지웠다(원격 실측 110~115ms, 맥 RDS c5 183ms 의 대부분【추정】).
    //   이제 출발의 정방향 슬롯은 RESUME 뒤 워커의 관리자 연결로 지운다(멈춤 밖). 출발은 울타리 안이라 그 슬롯이 잡는 새 변경이 없다.
    //   슬롯 만들기는 쓰기를 한 트랜잭션 안에서 못 하므로 첫 문장. 구독 지우기(NONE 뒤)는 트랜잭션 안에서 돈다.
    //   역방향 슬롯이 정방향 구독 삭제보다 먼저 생기지만, 구독은 이미 꺼졌고 표지까지 다 적용됐으며 출발은 울타리라 더 들어올 변경이 없다
    const hadForward = await disableSubscription(D, i.current);
    // (역방향 발행은 멈춤 전에 만들어 둠)
    // z75-31: "있나 보기 + 만들기" 를 한 문장으로 (없을 때만 만든다. 예전과 같은 조건)
    // Z80: C5b 도착 울타리 걷기(롤백이면 도착 = 전에 울타리 친 옛 출발)를 같은 왕복에 붙인다. 순서는 예전과 같다(슬롯 먼저).
    //   슬롯은 트랜잭션 밖 객체라 뒤 문장이 깨져도 남는다 = 예전(슬롯 만든 뒤 unfence 실패)과 같은 상태. 이때 c5_slots 표시는 안 찍힌다
    const c5 = await D.query(`SELECT pg_create_logical_replication_slot(${lit(i.reverse)}, 'pgoutput')
                    WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = ${lit(i.reverse)});
      ${hadForward ? `${detachSubscriptionSql(i.current)};` : ""}
      ${unfenceSql(i.to)}`);
    parseUnfence(c5);
    mark("c5_slots");
    mark("c5b_unfence");
    // C6 쓰기 대상 바꾸고 풀어 주기
    resumeTried = true;
    await hooks.resume(i.to);
    switched = true;
    const t6 = mark("c6_resume");
    const pauseMs = t6 - t1;

    // RESUME 뒤: 옛 출발은 읽기 전용 대기(권한 회수 유지), 역방향 구독을 붙인다 (슬롯이 이미 WAL을 잡고 있어 빠지는 쓰기 없음)
    // PF-E26 (RV-10): 여기는 멈춤 밖(앱은 이미 도착을 씀)이라 한 번의 일시 오류(연결 끊김·잠깐 못 닿음)로 CUTOVER_HALFWAY 가 되면
    //   역방향 구독이 없어 롤백을 못 하고, C5 의 역방향 슬롯이 도착 WAL 을 붙잡았다 → 연결을 새로 열어 몇 번 더 해 본다(1·2·4·8초).
    //   둘 다 있는 것은 건너뛰는 멱등 동작이라 다시 불러도 안전. 끝내 안 되면 예전처럼 던진다
    let S2 = S;
    for (let k = 0; ; k++) {
      try {
        await unfence(S2, i.from, { writable: false });
        // ADR-031 R2: 앱 계정이 표 주인이면 울타리가 관리자(구독 주인)의 물려받은 쓰기까지 걷었다 → 역방향 적용에 필요한 것만 관리자에게 직접 (fence.ts)
        const applyGrants = await ensureApplyGrants(S2, i.tables);
        if (applyGrants) measures.push({ name: "reverse_apply_grants", value: applyGrants, unit: "count" });
        await ensureSubscription(S2, i.to, i.reverse, { copyData: false, createSlot: false });
        break;
      } catch (x) {
        if (k >= (i.reverseRetries ?? 4) || i.signal?.aborted) throw x;
        measures.push({ name: "reverse_subscribe_retry", value: k + 1, unit: "count" });
        await sleep(1000 * 2 ** k);
        if (S2 !== S) await S2.end().catch(() => {});
        S2 = await connect(i.from).catch(() => S2);
      }
    }
    if (S2 !== S) await S2.end().catch(() => {});
    mark("reverse_subscribed");
    // Z80 04: 정방향 슬롯(출발)을 여기서 지운다. walsender 가 아직 붙어 있으면 dropSlotIfIdle 이 잠깐(최대 5초) 기다린다.
    //   못 지우면 L3 과 같은 측정값을 남기고(감사 detail.measurements) 컷오버는 성공으로 둔다. cleanup 의 teardown 이 다시 지운다
    if (hadForward) {
      let gone = await dropSlotIfIdle(S, i.current).catch(() => false);
      // Z38 R8-33 (a): 5초 넘게 walsender 가 붙어 있으면 그 세션을 끊고 한 번 더 (구독은 이미 지워져 쓰는 쪽이 없다)
      if (!gone && await slotExists(S, i.current).catch(() => false)) {
        await S.query(`SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots
                        WHERE slot_name = $1 AND active_pid IS NOT NULL`, [i.current]).catch(() => {});
        gone = await dropSlotIfIdle(S, i.current, { waitMs: 2_000 }).catch(() => false);
      }
      if (!gone && await slotExists(S, i.current).catch(() => true)) measures.push({ name: "forward_slot_left", value: 1, unit: "count" });
      mark("forward_slot_dropped");
    }
    return { ok: true, pauseMs, measures: [{ name: "cutover_pause_ms", value: round(pauseMs), unit: "ms" }, ...measures, ...stepMeasures(marks)] };
  } catch (e) {
    // Z19 H2: 예전엔 finally가 연결만 닫아서, C2~C4 사이 예외면 출발이 울타리 친 채(쓰기 금지) 남았다.
    // C5 전이면 아무것도 안 바뀐 것과 같다 → C6'처럼 출발에 쓰기를 돌려주고 다시 던진다. C5 뒤면 손대지 않는다(사람이 판단)
    const step = marks.at(-1)?.[0] ?? "start";
    let unfenced = false;
    if (fenced && !pastNoReturn) unfenced = await revertSource(S, i.from, hooks);
    // Z77 (Z62 주제 60, 맥 실측 00:01Z): C5 뒤라도 C6(쓰기 대상 바꾸기) 전이면 앱은 아직 출발만 쓴다 → 출발 울타리를 걷어 서비스를 살린다.
    //   정방향 구독은 이미 끊겼으니 이 이전은 실패로 끝나고 새로 sync 해야 한다(pastNoReturn=true 그대로). 도착은 앱 트래픽을 안 받아 갈라진 쓰기가 없다.
    //   예전엔 사람이 손으로 걷을 때까지 출발이 읽기 전용으로 남았다. C6 뒤 실패면 도착은 C5b 에서 이미 걷혔다(손대지 않음)
    else if (fenced && !switched) {
      // Z38 R8-47: resume(to) 도중 깨졌으면 프록시가 이미 도착으로 돌았을 수 있다. 도착은 C5b 에서 풀렸으니 두 쪽 다 쓰기 가능해진다
      //   → 출발을 풀기 전에 도착을 다시 울타리 친다 (resume 을 안 불렀으면 앱이 도착에 닿을 길이 없어 손대지 않는다)
      if (resumeTried) await fence(D, i.to).catch(() => undefined);
      // 이 이전은 끝났다: 도착에 만든 역방향 슬롯이 WAL 을 붙잡지 않게 지운다 (못 지우면 cleanup 의 teardown 이 다시)
      await dropSlotIfIdle(D, i.reverse, { waitMs: 1_000 }).catch(() => false);
      unfenced = await revertSource(S, i.from, hooks);
    }
    else if (!fenced && paused) await hooks.resume(i.from).catch(() => {});   // C1만 했으면 붙잡은 요청만 풀어 준다
    throw new SwitchoverError(step, pastNoReturn, unfenced || !fenced, e);
  } finally {
    await S.end().catch(() => {}); await D.end().catch(() => {});
  }
}

// 쓰던 관리자 연결이 끊겼을 수 있어서(예외 원인이 네트워크일 때) 실패하면 새 연결로 한 번 더
async function revertSource(S: Awaited<ReturnType<typeof connect>>, from: Endpoint, hooks: TrafficHooks): Promise<boolean> {
  let ok = await unfence(S, from).then(() => true, () => false);
  if (!ok) {
    const c = await connect(from).catch(() => null);
    if (c) { ok = await unfence(c, from).then(() => true, () => false); await c.end().catch(() => {}); }
  }
  await hooks.resume(from).catch(() => {});
  return ok;
}

// C4 가 맞출 시퀀스: 표의 칸이 소유한 것 (serial 은 'a', identity 는 'i')
async function sequencesOf(D: Awaited<ReturnType<typeof connect>>, tables: TableRef[]) {
  return D.query<{ seq: string; sch: string; tbl: string; col: string }>(
    `SELECT format('%I.%I', sn.nspname, s.relname) seq, tn.nspname sch, t.relname tbl, a.attname col
       FROM pg_class s JOIN pg_namespace sn ON sn.oid=s.relnamespace
       JOIN pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
       JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
       JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE s.relkind='S' AND t.relname = ANY($1) AND tn.nspname = ANY($2)`,
    [tables.map((t) => t.name), [...new Set(tables.map((t) => t.schema))]]);
}

/** 여러 문장 묶음이면 pg 는 결과 배열을, 한 문장이면 결과 하나를 돌려준다 → 늘 배열로 */
const results = (x: unknown) => (Array.isArray(x) ? x : [x]) as { rowCount: number | null; rows: Record<string, unknown>[] }[];
const round = (x: number) => Math.round(x * 10) / 10;
function stepMeasures(marks: [string, number][]): StepMeasure[] {
  return marks.slice(1).map(([s, t], k) => ({ name: `${s}_ms`, value: round(t - marks[k]![1]), unit: "ms" as const }));
}

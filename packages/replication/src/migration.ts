import type pg from "pg";
import { connect, type Endpoint, withClient } from "./endpoint.js";
import { appCanWrite, savedGrants, unfence } from "./fence.js";
import { DEFAULT_GATE, type GateOpts, type GateResult, judgeCutoverReady } from "./judge.js";
import { copyStatus, type CopyStatus, sampleLagOn, slotLag, waitInitialCopyOn } from "./lag.js";
import { MARKER_SCHEMA, namesFor, type Names } from "./names.js";
import { ensureReplicationAttr, precheck, type PrecheckResult } from "./precheck.js";
import { copySchema, type SchemaCopyResult } from "./schema.js";
import { dropSlotIfIdle, dropSubscription, startForwardOn, subscriptionExists } from "./replicate.js";
import { ident, lit } from "./sql.js";
import { dropReplUser, replUserOf } from "./repluser.js";
import { type StepMeasure, switchover, type SwitchoverResult, type TrafficHooks } from "./switchover.js";
import { listTables, rowCounts, type TableRef } from "./tables.js";

// 워커(sync·cutover·rollback·cleanup 작업)가 부르는 입구. 이전 한 건 = Migration 객체 하나.
// 상태는 DB 자체(구독이 어느 쪽에 있나)에서 읽으므로 워커가 죽었다 다시 떠도 같은 함수를 다시 부르면 된다.

export interface MigrationConfig {
  /** 이전 id 등. 복제 객체 이름의 꼬리 */
  key: string;
  source: Endpoint;
  target: Endpoint;
  /** 옮길 표 이름. 없으면 source.schema의 모든 표 */
  tables?: string[];
  gate?: Partial<GateOpts>;
  /** Z77: true 면 sync 가 복제를 걸기 전에 도착에 없는 표를 출발 모양대로 만든다 (REPL_COPY_SCHEMA=1, 데이터 없음) */
  copySchema?: boolean;
}

/** 지금 쓰기 담당이 어디인지: DB에 남은 구독 위치로 판단 */
export type Phase = "idle" | "forward" | "reverse";

export interface FenceRecovery {
  stage: "cutover" | "rolling_back"; phase: Phase;
  /** left_as_is = C5 뒤라 손 안 댐(또는 걷을 게 없음) */
  action: "unfenced_source" | "unfenced_target" | "left_as_is" | "unfence_failed";
  /** 앱 계정이 지금 쓸 수 있나 (표 하나 기준). 못 읽으면 null */
  sourceWritable: boolean | null; targetWritable: boolean | null;
  error?: string;
}

export interface SyncReport {
  phase: Phase; names: Names; created: boolean;
  copy: CopyStatus; gate: GateResult; measures: StepMeasure[];
  /** PF-E3: 초기 복사가 기다림 시간 안에 안 끝났지만 구독 작업자가 돌며 복사 중(i·d·f·s) = 실패가 아니라 "아직". 워커가 시도 횟수를 안 깎고 다시 본다 */
  copying?: boolean;
  /** PF-E18: 복제를 걸기 전에 걷은 지난 이전의 울타리 ("src"·"dst" 라벨) */
  staleFences?: string[];
}

/** PF-E18: 우리 울타리 흔적 = 이 DB 기본값 default_transaction_read_only=on (fence 가 ALTER DATABASE 로 건다). 흔적이 있고
 *  앱 계정이 첫 표에 못 쓰면(또는 표가 아직 없으면) 걷는다(저장본이 있으면 원래 권한, 없으면 읽기·쓰기). 고객이 일부러 건 읽기 전용과 구별이 안 되는 곳은 손대지 않는다 */
async function liftStaleFences(sides: [pg.Client, Endpoint][], tables: TableRef[]): Promise<string[]> {
  const out: string[] = [];
  for (const [c, e] of sides) {
    const ro = (await c.query(`SELECT 1 FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
       WHERE d.datname = current_database() AND s.setrole = 0 AND 'default_transaction_read_only=on' = ANY(s.setconfig)`)).rowCount === 1;
    // PF-E30 (hdd-09): 컷오버 C6 는 옛 출발의 read_only 는 풀고 권한 회수만 남긴다 → 저장본(fence_saved)이 있으면 그것도 우리 흔적
    const saved = ro ? null : await savedGrants(c, e);
    if (!ro && !saved) continue;
    const t = tables[0];
    const exists = t ? (await c.query(`SELECT to_regclass($1) r`, [`${ident(t.schema)}.${ident(t.name)}`])).rows[0]?.r : null;
    if (exists && (await appCanWrite(c, e, t!.name))) continue;
    await unfence(c, e);
    out.push(e.label);
  }
  return out;
}

export class Migration {
  readonly names: Names;
  constructor(readonly cfg: MigrationConfig) { this.names = namesFor(cfg.key); }

  async tables(): Promise<TableRef[]> {
    return withClient(this.cfg.source, (c) => this.tablesOn(c));
  }
  private async tablesOn(s: pg.Client): Promise<TableRef[]> {
    const all = await listTables(s, this.cfg.source.schema ?? "public");
    return this.cfg.tables ? all.filter((t) => this.cfg.tables!.includes(t.name)) : all;
  }

  /** Z80 06: 출발·도착 관리자 연결을 "동시에" 한 번씩 열어 함수 하나 동안 같이 쓴다.
   *  예전 sync 는 한 번에 연결을 10번(출발 4·도착 6) 새로 열었다. 원격(TLS + SCRAM)이면 연결마다 왕복 5~7번이라 이것이 sync 시간의 큰 몫 */
  private async pair<T>(fn: (s: pg.Client, d: pg.Client) => Promise<T>): Promise<T> {
    const [rs, rd] = await Promise.allSettled([connect(this.cfg.source), connect(this.cfg.target)]);
    if (rs.status === "rejected" || rd.status === "rejected") {
      if (rs.status === "fulfilled") await rs.value.end().catch(() => {});
      if (rd.status === "fulfilled") await rd.value.end().catch(() => {});
      throw (rs.status === "rejected" ? rs.reason : (rd as PromiseRejectedResult).reason);
    }
    try { return await fn(rs.value, rd.value); }
    finally { await rs.value.end().catch(() => {}); await rd.value.end().catch(() => {}); }
  }

  /** Z77: copySchema 가 켜져 있으면 도착에 없는 표·앱 계정을 만든다. 꺼져 있으면 null (예전 그대로: 앱 마이그레이션이 만든다) */
  async prepareTarget(): Promise<SchemaCopyResult | null> {
    if (!this.cfg.copySchema) return null;
    return copySchema(this.cfg.source, this.cfg.target, await this.tables());
  }

  /** Z77: Cloud SQL 쪽 계정에 REPLICATION 속성 (정방향 구독·역방향 슬롯 둘 다 필요). 그 밖 제공자는 skipped */
  async prepareReplicationRoles() {
    return Promise.all([ensureReplicationAttr(this.cfg.source), ensureReplicationAttr(this.cfg.target)]);
  }

  precheck(): Promise<PrecheckResult> { return precheck(this.cfg.source, this.cfg.target, { tables: this.cfg.tables, own: [this.names.fwd, this.names.rev] }); }

  async phase(): Promise<Phase> {
    const fwd = await withClient(this.cfg.target, (c) => subscriptionExists(c, this.names.fwd));
    if (fwd) return "forward";
    const rev = await withClient(this.cfg.source, (c) => subscriptionExists(c, this.names.rev));
    return rev ? "reverse" : "idle";
  }
  /** Z80 06: 이미 연 두 연결로 phase. 규칙 같음(정방향 있으면 forward). 두 구독을 동시에 본다.
   *  (Z38 R8-38: 바깥 phase() 는 예전처럼 도착 먼저, 정방향이 없을 때만 출발에 붙는다 = 출발이 죽어 있어도 forward 를 알려 준다) */
  private async phaseOn(s: pg.Client, d: pg.Client): Promise<Phase> {
    const [fwd, rev] = await Promise.all([subscriptionExists(d, this.names.fwd), subscriptionExists(s, this.names.rev)]);
    return fwd ? "forward" : rev ? "reverse" : "idle";
  }

  /** sync 작업: 정방향 복제를 (없으면) 만들고, 초기 스냅샷을 기다린 뒤 지연을 재서 전환 가능 여부를 판정 */
  async sync(opts: { waitCopyMs?: number; samples?: number } = {}): Promise<SyncReport> {
    // Z80 06: 연결 두 개(출발·도착)를 처음에 동시에 열어 끝까지 쓴다 (예전 10번 새로 열기). 단계·순서·판정은 그대로
    return this.pair(async (s, d) => {
    const gate = { ...DEFAULT_GATE, ...this.cfg.gate };
    const [tables, p0] = await Promise.all([this.tablesOn(s), this.phaseOn(s, d)]);
    let created = false;
    let copyMs: number | null = null;
    // PF-E18 (FM-APP-26·27): 같은 출발·도착을 다시 쓰면 지난 이전의 울타리(쓰기 회수 + DB read_only)가 남아 있다.
    //   출발이면 새 컷오버 뒤 롤백해도 되돌릴 권한이 없고, 도착이면 초기 복사가 permission denied(서버 로그만)로 조용히 멈췄다.
    //   복제를 새로 걸기 전(idle)에만, 우리 울타리 흔적(DB 기본 read_only)이 있을 때만 걷는다. 걷은 것은 staleFences 로 알린다
    let staleFences: string[] = [];
    if (p0 === "idle") staleFences = await liftStaleFences([[s, this.cfg.source], [d, this.cfg.target]], tables);
    if (p0 === "idle") created = await startForwardOn(s, d, this.cfg.source, this.names.fwd, tables);
    // PF-E3: 큰 DB 는 초기 복사가 기다림(기본 120초)보다 오래 걸린다. 예전엔 여기서 던져 시도 1번을 썼고, 4번이면 paused SYNC_FAILED
    //   (복사는 잘 되고 있는데). 이제 시간이 다 되면 던지지 않고 "복사 중"으로 돌려준다. 진짜로 멈춘 구독(작업자 없음)은 copying=false 라 예전처럼 실패
    let copyTimedOut = false;
    if (opts.waitCopyMs !== 0) {
      try { copyMs = await waitInitialCopyOn(d, this.names.fwd, opts.waitCopyMs ?? 120_000); }
      catch (e) { if (!/^timeout \d+ms waiting for initial copy/.test((e as Error).message)) throw e; copyTimedOut = true; }
    }
    const copy = await copyStatus(d, this.names.fwd);
    // PF-E12 (FM-APP-21): 적용 일꾼은 떴는데 표 복사 일꾼(relid 있는 줄)이 하나도 없고 표가 전부 i(init)면 일꾼 자리가 없어 복사가 안 시작된 것
    //   → copying 이 아니다 (예전 판정이면 2시간 동안 "복사 중"으로 기다렸다). 이유에 상태 분포·일꾼 수를 남긴다
    const w = copy.done ? null : (await d.query<{ apply: string; sync: string }>(
      `SELECT count(*) FILTER (WHERE pid IS NOT NULL AND relid IS NULL) apply, count(*) FILTER (WHERE pid IS NOT NULL AND relid IS NOT NULL) sync
         FROM pg_stat_subscription WHERE subname = $1`, [this.names.fwd])).rows[0]!;
    const stalled = !!w && copy.tables > 0 && Number(w.sync) === 0 && (copy.states["i"] ?? 0) === copy.tables - copy.ready;
    const copying = copyTimedOut && !copy.done && copy.tables > 0 && !!w && Number(w.apply) > 0 && !stalled;
    const samples = copy.done ? await sampleLagOn(s, d, this.names.fwd, opts.samples ?? gate.consecutive) : [];
    const verdict = judgeCutoverReady(copy, samples, gate);
    // PF-E19 (FM-APP-22) DRAFT(ai): 컷오버 전엔 도착 DB 에 앱이 쓰면 안 된다(그 행은 출발에 없음 → 롤백 때 사라지거나 복제가 키 충돌로 멈춤).
    //   복제 적용은 시퀀스를 안 건드리므로, 복제 표의 도착 시퀀스가 한 번이라도 불렸으면 도착에서 직접 쓴 것 → 준비 안 됨
    //   (serial·identity 키만 잡는다. uuid 키 쓰기는 못 잡음) TODO(human): 컷오버 전 도착 앱의 DB 주소를 출발로(APP_LINK) 또는 도착 앱 계정 분리
    if (copy.done) {
      const used = (await d.query<{ s: string }>(
        `SELECT DISTINCT seq.relname s FROM pg_depend dep JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
           JOIN pg_class t ON t.oid = dep.refobjid JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_sequences ps ON ps.schemaname = n.nspname AND ps.sequencename = seq.relname
          WHERE dep.deptype IN ('a','i') AND n.nspname = ANY($1) AND t.relname = ANY($2) AND ps.last_value IS NOT NULL`,
        [[...new Set(tables.map((t) => t.schema))], tables.map((t) => t.name)])).rows.map((r) => r.s);
      if (used.length) { verdict.ready = false; verdict.reasons.push(`TARGET_LOCAL_WRITES ${used.join(",")} (컷오버 전 도착에 직접 쓴 흔적: 시퀀스가 불림. 도착 앱이 도착 DB 를 쓰고 있다)`); }
    }
    if (w) verdict.reasons.push(`COPY_WORKERS apply=${w.apply} tablesync=${w.sync} states=${Object.entries(copy.states).map(([k, v]) => `${k}:${v}`).join(",") || "-"}`
      + (stalled && copyTimedOut ? " (표 복사 일꾼 0 → 도착 구독 일꾼 자리 부족? 도착 로그 'out of logical replication worker slots', 점검 DB-07)" : ""));
    const measures: StepMeasure[] = samples.map((s, k) => ({ name: `replication_lag_ms#${k + 1}`, value: Math.round(s.markerMs * 10) / 10, unit: "ms" }));
    if (samples.length) measures.unshift({ name: "replication_lag_ms", value: Math.max(...samples.map((s) => Math.round(s.markerMs * 10) / 10)), unit: "ms" });
    const bytes = samples.at(-1)?.slot.bytes;
    if (bytes != null) measures.push({ name: "replication_slot_lag_bytes", value: bytes, unit: "bytes" });
    const safe = samples.at(-1)?.slot.safeWalBytes;
    if (safe != null) measures.push({ name: "replication_slot_safe_wal_bytes", value: safe, unit: "bytes" });
    if (copyMs != null && created) measures.push({ name: "initial_copy_ms", value: Math.round(copyMs), unit: "ms" });
    return { phase: await this.phaseOn(s, d), names: this.names, created, copy, gate: verdict, measures, ...(copying ? { copying: true } : {}),
      ...(staleFences.length ? { staleFences } : {}) };
    });
  }

  /** 상태 전이 조건(T21)에 넘길 증거: 슬롯 바이트 지연이 0이 될 때까지 잠깐 기다리고, 표별 행 수를 비교한다.
   *  쓰기가 계속 들어오는 중이면 바이트 지연이 0이 안 될 수 있다 (그때는 실제 값을 그대로 돌려준다)
   *  L5: 슬롯 정보를 못 읽으면 replicationLagBytes = null ("모름"). 예전엔 Infinity였고 JSON(감사)에서 조용히 null이 됐다 */
  async catchUpEvidence(o: { waitMs?: number } = {}): Promise<{ replicationLagBytes: number | null; rowCountMatch: boolean; counts: { source: Record<string, number>; target: Record<string, number> } }> {
    const waitMs = o.waitMs ?? 15_000;
    const t0 = Date.now();
    let bytes: number | null = null;
    // Z80 06: 연결 5번(출발 3·도착 2) → 2번(동시). 행 수는 두 DB 에 동시에 묻는다. 기다리는 간격(250ms)·제한(15초)은 그대로
    const { source, target } = await this.pair(async (s, d) => {
      for (;;) {
        bytes = (await slotLag(s, d, this.names.fwd)).bytes ?? null;
        if (bytes === 0 || Date.now() - t0 > waitMs) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const tables = await this.tablesOn(s);
      const [source, target] = await Promise.all([rowCounts(s, tables), rowCounts(d, tables)]);
      return { source, target };
    });
    const rowCountMatch = Object.keys(source).every((k) => source[k] === target[k]);
    return { replicationLagBytes: bytes, rowCountMatch, counts: { source, target } };
  }

  /** cutover 작업: 출발 → 도착. 이미 reverse면 아무것도 안 하고 ok (재시도 안전) */
  async cutover(o: { hooks?: TrafficHooks; maxCatchupMs?: number; signal?: AbortSignal } = {}): Promise<SwitchoverResult> {
    const p = await this.phase();
    if (p === "reverse") return { ok: true, pauseMs: 0, measures: [{ name: "already_cut_over", value: 1, unit: "count" }] };
    if (p !== "forward") throw new Error(`cutover needs forward replication, phase=${p}`);
    return switchover({ from: this.cfg.source, to: this.cfg.target, current: this.names.fwd, reverse: this.names.rev,
      tables: await this.tables(), hooks: o.hooks, maxCatchupMs: o.maxCatchupMs, signal: o.signal });
  }

  /** rollback 작업. 컷오버 전이면 정방향 복제만 걷는다(출발은 그대로 주인). 컷오버 뒤면 역방향으로 다시 전환
   *  Z69: teardown=false면 컷오버 전이어도 걷지 않고 kind만 알려 준다. 워커는 걷기를 따로 하고, 걷기 실패를 롤백 실패로 바꾸지 않는다 */
  async rollback(o: { hooks?: TrafficHooks; maxCatchupMs?: number; signal?: AbortSignal; teardown?: boolean } = {}): Promise<{ kind: "before_cutover" | "after_cutover" | "noop"; result?: SwitchoverResult; targetUnreachable?: true }> {
    let p: Phase;
    try { p = await this.phase(); }
    catch (e) {
      // PF-E21 (FM-APP-14 남은 부분): 도착이 안 닿으면(down 으로 지워짐·망 끊김) phase() 가 먼저 던져 롤백이 ROLLBACK_FAILED 로 끝났고 정리도 안 돌았다.
      //   출발에 역방향 구독이 없으면 아직 컷오버 전 = 출발이 주인 → 도착 없이도 롤백은 끝난다 (출발 쪽 슬롯·발행은 걷을 수 있는 만큼 걷음).
      //   역방향 구독이 있으면(컷오버 뒤) 도착이 주인이라 도착 없이는 못 되돌린다 → 예전처럼 던진다. 출발도 안 닿으면 그 오류를 던진다
      const rev = await withClient(this.cfg.source, (c) => subscriptionExists(c, this.names.rev));
      if (rev) throw e;
      if (o.teardown !== false) await this.teardown().catch(() => undefined);
      return { kind: "before_cutover", targetUnreachable: true };
    }
    if (p === "forward") { if (o.teardown !== false) await this.teardown(); return { kind: "before_cutover" }; }
    if (p === "idle") return { kind: "noop" };
    const result = await switchover({ from: this.cfg.target, to: this.cfg.source, current: this.names.rev, reverse: this.names.fwd,
      tables: await this.tables(), hooks: o.hooks, maxCatchupMs: o.maxCatchupMs, signal: o.signal });
    return { kind: "after_cutover", result };
  }

  /** Z36 (Z42 Q17): 쓰기 담당 바꾸기 도중 워커가 죽었을 때(청소 작업이 부른다) 울타리를 걷는다.
   *  switchover의 catch(Z19 H2)는 같은 프로세스 예외만 잡는다. SIGKILL·전원 꺼짐이면 아무도 안 걷어 출발이 읽기 전용으로 남았다.
   *  어디까지 갔는지는 DB에 남은 구독 위치로 판단한다 (switchover의 pastNoReturn과 같은 기준):
   *   - stage=cutover, 정방향 구독이 도착에 아직 있음(forward) = C5 전 → 출발 울타리 걷기 (C6' 되돌림과 같은 결과)
   *   - stage=rolling_back(컷오버 뒤 롤백), 역방향 구독이 출발에 아직 있음(reverse) = 롤백의 C5 전 → 도착(지금 주인) 울타리 걷기
   *   - 그 밖 = C5 뒤 → 손대지 않는다 (어느 쪽에 쓰기를 돌려줘도 그 쓰기가 반대쪽에 안 간다. 사람이 판단)
   *  울타리를 안 쳤던 경우에 불려도 권한을 다시 주고 read_only를 끌 뿐이라 해가 없다 (TODO(human) fence.ts: 원래 권한 저장)
   *  앱 연결 붙잡기(hooks.pause)는 다른 프로세스라 여기서 못 푼다. 지금 hooks는 noop */
  async recoverInterruptedSwitch(stage: "cutover" | "rolling_back"): Promise<FenceRecovery> {
    const p = await this.phase();
    const table = (await this.tables())[0]?.name;
    const writable = async (e: Endpoint) => table ? withClient(e, (c) => appCanWrite(c, e, table)).catch(() => null) : null;
    let action: FenceRecovery["action"] = "left_as_is";
    let error: string | undefined;
    const lift = async (e: Endpoint, a: FenceRecovery["action"]) => {
      try { await withClient(e, (c) => unfence(c, e)); action = a; }
      catch (x) { action = "unfence_failed"; error = (x as Error).message.slice(0, 300); }
    };
    if (stage === "cutover" && p === "forward") await lift(this.cfg.source, "unfenced_source");
    if (stage === "rolling_back" && p === "reverse") await lift(this.cfg.target, "unfenced_target");
    return { stage, phase: p, action, sourceWritable: await writable(this.cfg.source), targetWritable: await writable(this.cfg.target),
      ...(error ? { error } : {}) };
  }

  /** cleanup 작업: 양쪽의 구독·슬롯·발행·마커 스키마를 지운다. 옛 출발의 쓰기 권한 회수는 그대로 둔다(폐기 전 읽기 전용) */
  async teardown(): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    // PF-E5 (FM-APP-14): 한쪽(보통 도착: down 으로 이미 지워짐·못 닿음)에서 예외가 나도 다른 쪽은 끝까지 걷는다.
    //   예전엔 도착 구독 지우기가 먼저 던지면 출발 슬롯·발행이 영원히 남아 출발 WAL 이 쌓였다(출발 디스크가 참).
    //   못 걷은 쪽이 있으면 다 돌고 나서 던진다 (걷은 것·못 걷은 이유를 같이) → 부르는 쪽(cleanup·롤백)은 예전처럼 실패로 안다
    const errors: string[] = [];
    const side = async (label: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) { errors.push(`${label}: ${(e as Error).message}`.slice(0, 300)); }
    };
    for (const [ep, sub] of [[this.cfg.target, this.names.fwd], [this.cfg.source, this.names.rev]] as const) {
      await side(`${ep.label} subscription`, async () => {
        const r = await withClient(ep, (c) => dropSubscription(c, sub));
        if (r.dropped) removed.push(`${ep.label}:subscription:${sub}`);
      });
    }
    for (const ep of [this.cfg.source, this.cfg.target]) {
      await side(`${ep.label} slot·publication`, () => withClient(ep, async (c) => {
        for (const n of [this.names.fwd, this.names.rev]) {
          if (await dropSlotIfIdle(c, n)) removed.push(`${ep.label}:slot:${n}`);
          const pub = await c.query(`SELECT 1 FROM pg_publication WHERE pubname=$1`, [n]);
          if (pub.rowCount) { await c.query(`DROP PUBLICATION ${ident(n)}`); removed.push(`${ep.label}:publication:${n}`); }
        }
        // PF-E30 (hdd-09): 울타리 저장본(_repl.fence_saved)이 있으면 남긴다 = "이 DB 는 우리가 쓰기를 걷었다"는 흔적.
        //   예전엔 스키마째 지워, 컷오버 마친 옛 출발로 다시 이전하면 흔적이 없어 sync 가 못 걷고 출발 앱이 계속 permission denied 였다
        await c.query(`DO $pfe30$ DECLARE n bigint := 0; BEGIN
          IF to_regclass(${lit(`${MARKER_SCHEMA}.fence_saved`)}) IS NOT NULL THEN EXECUTE ${lit(`SELECT count(*) FROM ${ident(MARKER_SCHEMA)}.fence_saved`)} INTO n; END IF;
          IF n = 0 THEN EXECUTE ${lit(`DROP SCHEMA IF EXISTS ${ident(MARKER_SCHEMA)} CASCADE`)};
          ELSE EXECUTE ${lit(`DROP TABLE IF EXISTS ${ident(MARKER_SCHEMA)}.marker`)}; END IF; END $pfe30$`);
        // Z52 (Q27): 복제 전용 계정이 있으면 지운다 (구독이 먼저 지워져 접속이 끝난 뒤)
        for (const n of [this.names.fwd, this.names.rev]) if (await dropReplUser(c, n)) removed.push(`${ep.label}:role:${replUserOf(n)}`);
        // PF-E29 (hdd-08): 상대 구독이 워커에선 안 닿지만 실제론 살아 있으면(맥 IP 바뀜 등) 슬롯이 active 라 위 dropSlotIfIdle 이 조용히 false 였다
        //   → 그 뒤 슬롯이 남아 WAL 이 쌓였다. 계정 지우기(전용 계정 walsender 끊김) 뒤 다시 보고, 그래도 붙어 있으면 그 walsender 를 끊고 한 번 더.
        //   끝내 남으면 errors 로 (teardown partial → 부르는 쪽이 실패로 안다). 정리는 "이 이전을 끝낸다"는 뜻이라 남은 구독 쪽 연결을 끊어도 된다
        for (const n of [this.names.fwd, this.names.rev]) {
          if (!(await c.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name=$1`, [n])).rowCount) continue;
          await c.query(`SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name=$1 AND active_pid IS NOT NULL`, [n]);
          if (await dropSlotIfIdle(c, n)) removed.push(`${ep.label}:slot:${n}`);
          else throw new Error(`slot ${n} still active after terminating its walsender (상대 구독이 다시 붙음? 상대 DB 에서 구독을 지울 것)`);
        }
      }));
    }
    if (errors.length) throw Object.assign(new Error(`teardown partial: ${errors.join("; ")} (removed: ${removed.join(", ") || "none"})`), { removed });
    return { removed };
  }

  /** 정리 확인: 이 이전이 남긴 복제 객체가 하나도 없나 */
  async leftovers(): Promise<string[]> {
    const out: string[] = [];
    const names = [this.names.fwd, this.names.rev];
    for (const ep of [this.cfg.source, this.cfg.target]) {
      await withClient(ep, async (c) => {
        const r = await c.query<{ k: string; n: string }>(
          `SELECT 'slot' k, slot_name::text n FROM pg_replication_slots WHERE slot_name = ANY($1)
           UNION ALL SELECT 'publication', pubname::text FROM pg_publication WHERE pubname = ANY($1)
           UNION ALL SELECT 'subscription', subname::text FROM pg_subscription WHERE subname = ANY($1)
           UNION ALL SELECT 'role', rolname::text FROM pg_roles WHERE rolname = ANY($2)`, [names, names.map(replUserOf)]);
        for (const x of r.rows) out.push(`${ep.label}:${x.k}:${x.n}`);
      });
    }
    return out;
  }
}

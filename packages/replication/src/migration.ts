import type pg from "pg";
import { connect, type Endpoint, withClient } from "./endpoint.js";
import { appCanWrite, unfence } from "./fence.js";
import { DEFAULT_GATE, type GateOpts, type GateResult, judgeCutoverReady } from "./judge.js";
import { copyStatus, type CopyStatus, sampleLagOn, slotLag, waitInitialCopyOn } from "./lag.js";
import { MARKER_SCHEMA, namesFor, type Names } from "./names.js";
import { ensureReplicationAttr, precheck, type PrecheckResult } from "./precheck.js";
import { copySchema, type SchemaCopyResult } from "./schema.js";
import { dropSlotIfIdle, dropSubscription, startForwardOn, subscriptionExists } from "./replicate.js";
import { ident } from "./sql.js";
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

  precheck(): Promise<PrecheckResult> { return precheck(this.cfg.source, this.cfg.target, { tables: this.cfg.tables }); }

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
    if (p0 === "idle") created = await startForwardOn(s, d, this.cfg.source, this.names.fwd, tables);
    if (opts.waitCopyMs !== 0) copyMs = await waitInitialCopyOn(d, this.names.fwd, opts.waitCopyMs ?? 120_000);
    const copy = await copyStatus(d, this.names.fwd);
    const samples = copy.done ? await sampleLagOn(s, d, this.names.fwd, opts.samples ?? gate.consecutive) : [];
    const verdict = judgeCutoverReady(copy, samples, gate);
    const measures: StepMeasure[] = samples.map((s, k) => ({ name: `replication_lag_ms#${k + 1}`, value: Math.round(s.markerMs * 10) / 10, unit: "ms" }));
    if (samples.length) measures.unshift({ name: "replication_lag_ms", value: Math.max(...samples.map((s) => Math.round(s.markerMs * 10) / 10)), unit: "ms" });
    const bytes = samples.at(-1)?.slot.bytes;
    if (bytes != null) measures.push({ name: "replication_slot_lag_bytes", value: bytes, unit: "bytes" });
    const safe = samples.at(-1)?.slot.safeWalBytes;
    if (safe != null) measures.push({ name: "replication_slot_safe_wal_bytes", value: safe, unit: "bytes" });
    if (copyMs != null && created) measures.push({ name: "initial_copy_ms", value: Math.round(copyMs), unit: "ms" });
    return { phase: await this.phaseOn(s, d), names: this.names, created, copy, gate: verdict, measures };
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
  async rollback(o: { hooks?: TrafficHooks; maxCatchupMs?: number; signal?: AbortSignal; teardown?: boolean } = {}): Promise<{ kind: "before_cutover" | "after_cutover" | "noop"; result?: SwitchoverResult }> {
    const p = await this.phase();
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
    for (const [ep, sub] of [[this.cfg.target, this.names.fwd], [this.cfg.source, this.names.rev]] as const) {
      const r = await withClient(ep, (c) => dropSubscription(c, sub));
      if (r.dropped) removed.push(`${ep.label}:subscription:${sub}`);
    }
    for (const ep of [this.cfg.source, this.cfg.target]) {
      await withClient(ep, async (c) => {
        for (const n of [this.names.fwd, this.names.rev]) {
          if (await dropSlotIfIdle(c, n)) removed.push(`${ep.label}:slot:${n}`);
          const pub = await c.query(`SELECT 1 FROM pg_publication WHERE pubname=$1`, [n]);
          if (pub.rowCount) { await c.query(`DROP PUBLICATION ${ident(n)}`); removed.push(`${ep.label}:publication:${n}`); }
        }
        await c.query(`DROP SCHEMA IF EXISTS ${ident(MARKER_SCHEMA)} CASCADE`);
        // Z52 (Q27): 복제 전용 계정이 있으면 지운다 (구독이 먼저 지워져 접속이 끝난 뒤)
        for (const n of [this.names.fwd, this.names.rev]) if (await dropReplUser(c, n)) removed.push(`${ep.label}:role:${replUserOf(n)}`);
      });
    }
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

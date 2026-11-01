// Z64 DRAFT(ai): 진짜 PgBouncer 앞에 다는 "제어 옆차(sidecar)".
// 워커 훅(hooks.ts)이 부르는 제어 계약은 Z31 흉내 프록시와 똑같다:
//   POST /pause  {drainTimeoutMs?} → { drainMs, closedIdle, drainedBusy, leftBusy }
//   POST /resume {upstream}        → { upstream, previous, released, holdMs, maxWaitMs }
//   GET  /status, GET /healthz
// 그래서 워커·상태기계·GitOps 값은 하나도 안 바뀐다. 실환경은 이 옆차 + PgBouncer, 데모는 proxy.ts.
//
// 하는 일 (PgBouncer 관리 콘솔 명령, 공식 문서 usage.html 순서 그대로):
//   pause : PAUSE <db>      트랜잭션 풀링이면 진행 중 트랜잭션이 끝나는 대로 서버 연결을 닫고 돌아온다.
//                           앱 → PgBouncer 연결은 그대로 둔다 (흉내 프록시와 달리 앱 연결을 닫지 않는다)
//   resume: 대상 줄 파일 다시 쓰기 → RELOAD → RESUME <db>
//           PAUSE 로 서버 연결이 0 이라 RELOAD 뒤 새 서버 연결은 전부 새 대상으로 간다
// 드레인 시간 초과: PAUSE 가 안 끝나도 leftBusy 를 세어 돌려준다 (흉내 프록시와 같은 뜻: C2 펜스가 끊는다).
// holdMax: resume 이 안 오면 지금 대상으로 RESUME (제어판이 죽었을 때 무한 대기 방지). PgBouncer 의 query_wait_timeout 이 그 뒤 안전망.
//
// 의존성: pg (워크스페이스에 이미 있음). 동적 import 라 @svc/dbproxy 의 나머지는 여전히 의존성 없음.
// 실행: node packages/dbproxy/src/pgbouncer-control.ts   (Node 22.18+, 환경 변수는 configFromEnv)
import http from "node:http";
import { writeFileSync, renameSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export interface Upstream { host: string; port: number }
/** DBPROXY_UPSTREAMS="source=db:5432,target=target:5432" (proxy.ts 와 같은 형식. node 가 .ts 를 바로 읽게 import 대신 복사) */
export function parseUpstreams(s: string): Record<string, Upstream> {
  const out: Record<string, Upstream> = {};
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z0-9_-]+)=([^:]+):(\d+)$/i);
    if (!m) throw new Error(`bad DBPROXY_UPSTREAMS entry: ${part}`);
    out[m[1]!] = { host: m[2]!, port: Number(m[3]) };
  }
  return out;
}

export interface PgbControlOptions {
  /** 관리 콘솔 접속. 예: postgres://pgb_admin:***@127.0.0.1:6432/pgbouncer */
  adminUrl: string;
  /** 앱이 붙는 PgBouncer 데이터베이스 이름 (= [databases] 의 키) */
  db: string;
  /** 서버 쪽 실제 DB 이름 */
  serverDb: string;
  /** [databases] 줄만 담는 파일. pgbouncer.ini 가 %include 로 읽는다 */
  dbFile: string;
  /** 줄 끝에 붙일 추가 설정. 예: "pool_size=20" */
  extra?: string;
  upstreams: Record<string, Upstream>;
  active: string;
  drainTimeoutMs: number;
  holdMaxMs: number;
  log?: (o: Record<string, unknown>) => void;
}

type Q = (sql: string) => Promise<Record<string, unknown>[]>;
const now = () => performance.now();
const round = (x: number) => Math.round(x * 10) / 10;
const ident = (s: string) => { if (!/^[a-z0-9_]+$/i.test(s)) throw new Error(`bad name: ${s}`); return s; };

/** 관리 콘솔은 단순 질의(simple query)만 받는다. pg 의 문자열 질의가 그 방식이다. 명령마다 새 연결 (PAUSE 가 오래 걸려도 다른 명령이 막히지 않게) */
export function adminQuery(url: string): Q {
  return async (sql) => {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: url, statement_timeout: undefined });
    await c.connect();
    try { return (await c.query(sql)).rows; } finally { await c.end().catch(() => {}); }
  };
}

export function dbLine(o: Pick<PgbControlOptions, "db" | "serverDb" | "extra">, u: Upstream) {
  return `[databases]\n${ident(o.db)} = host=${u.host} port=${u.port} dbname=${ident(o.serverDb)}${o.extra ? " " + o.extra : ""}\n`;
}

export class PgbControl {
  active: string;
  paused = false;
  private pausedAt = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  private pausing: Promise<unknown> | null = null;
  stats = { pauses: 0, resumes: 0, autoReleases: 0, maxHeldMs: 0, lastPause: null as unknown, lastResume: null as unknown };
  readonly o: PgbControlOptions;
  private q: Q;
  constructor(o: PgbControlOptions, q: Q) { this.o = o; this.q = q; this.active = o.active; }
  get upstreamNames() { return Object.keys(this.o.upstreams); }
  private log(x: Record<string, unknown>) { (this.o.log ?? ((v) => console.log(JSON.stringify(v))))(x); }

  /** 파일을 통째로 바꿔 쓴다 (반쯤 쓴 파일을 RELOAD 가 읽지 않게 rename) */
  writeTarget(name: string) {
    const u = this.o.upstreams[name];
    if (!u) throw new Error(`unknown upstream "${name}"`);
    const tmp = `${this.o.dbFile}.tmp`;
    writeFileSync(tmp, dbLine(this.o, u));
    renameSync(tmp, this.o.dbFile);
  }

  async pools() {
    const rows = await this.q("SHOW POOLS");
    return rows.filter((r) => r.database === this.o.db);
  }
  private sum(rows: Record<string, unknown>[], k: string) { return rows.reduce((a, r) => a + Number(r[k] ?? 0), 0); }

  /** 시작할 때: 파일을 GitOps 값(active)에 맞추고 RELOAD. 재시작해도 컷오버 뒤 대상이 유지된다 */
  async init() { this.writeTarget(this.active); await this.q("RELOAD"); }

  async pause(drainTimeoutMs = this.o.drainTimeoutMs) {
    const t0 = now();
    const before = await this.pools();
    const busyBefore = this.sum(before, "sv_active");
    if (!this.paused) {
      this.paused = true; this.pausedAt = t0; this.stats.pauses++;
      this.holdTimer = setTimeout(() => {
        this.stats.autoReleases++;
        this.log({ level: "warn", msg: "hold timeout: resuming current upstream", upstream: this.active, holdMaxMs: this.o.holdMaxMs });
        void this.resume(this.active).catch((e) => this.log({ level: "error", msg: "auto resume failed", err: String(e) }));
      }, this.o.holdMaxMs);
      this.pausing = this.q(`PAUSE ${ident(this.o.db)}`).catch((e) => ({ error: String(e) }));
    }
    const done = await Promise.race([this.pausing!.then(() => true), new Promise((r) => setTimeout(() => r(false), drainTimeoutMs))]);
    // Z38 REVIEW-4 P-2: PAUSE 자체가 실패(관리 계정 비번·연결 거부 등)면 "다 비웠다"로 돌려주면 안 된다.
    //   예전엔 {error} 로 끝난 것도 done=true → leftBusy 0 으로 보고 → 워커가 붙잡기가 된 줄 알고 C2 울타리로 감 (앱 요청이 그대로 실패).
    //   던지면 hooks.pause() 가 실패 → switchover 가 울타리 치기 전에 C6' 되돌림 (switchover.ts:72)
    if (done) {
      const res = await this.pausing!;
      if (res && typeof res === "object" && "error" in (res as object)) {
        this.paused = false; this.pausing = null;
        if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
        throw new Error(`PAUSE ${this.o.db} failed: ${(res as { error: string }).error}`);
      }
    }
    const after = done ? [] : await this.pools();
    const leftBusy = this.sum(after, "sv_active");
    const r = { drainMs: round(now() - t0), closedIdle: 0, drainedBusy: Math.max(0, busyBefore - leftBusy), leftBusy, keptClients: this.sum(before, "cl_active") + this.sum(before, "cl_waiting") };
    this.stats.lastPause = r;
    this.log({ msg: "paused", ...r });
    return r;
  }

  async resume(upstream: string) {
    if (!this.o.upstreams[upstream]) throw new Error(`unknown upstream "${upstream}"`);
    const t = now();
    const previous = this.active;
    let released = 0, maxWaitMs = 0;
    try {
      const p = await this.pools();
      released = this.sum(p, "cl_waiting");
      maxWaitMs = Math.max(0, ...p.map((r) => Number(r.maxwait ?? 0) * 1000 + Number(r.maxwait_us ?? 0) / 1000));
    } catch { /* 숫자는 못 얻어도 전환은 한다 */ }
    if (previous !== upstream) { this.writeTarget(upstream); await this.q("RELOAD"); }
    // 드레인 시간 초과로 PAUSE 가 아직 안 끝났어도 RESUME 은 다른 연결로 보낸다
    if (this.paused) await this.q(`RESUME ${ident(this.o.db)}`);
    this.active = upstream;
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    const holdMs = this.paused ? t - this.pausedAt : 0;
    this.paused = false; this.pausing = null;
    this.stats.resumes++;
    this.stats.maxHeldMs = Math.max(this.stats.maxHeldMs, round(maxWaitMs));
    const r = { upstream, previous, released, holdMs: round(holdMs), maxWaitMs: round(maxWaitMs), switchMs: round(now() - t) };
    this.stats.lastResume = r;
    this.log({ msg: "resumed", ...r });
    return r;
  }

  async status() {
    let pools: unknown = null;
    try { pools = await this.pools(); } catch (e) { pools = { error: String(e) }; }
    return { backend: "pgbouncer", active: this.active, paused: this.paused, upstreams: this.upstreamNames, pools, stats: this.stats };
  }
}

export function controlServer(p: PgbControl, token?: string) {
  const authOk = (h: string | undefined) => {
    if (!token) return true;
    const want = Buffer.from(`Bearer ${token}`), got = Buffer.from(h ?? "");
    return want.length === got.length && timingSafeEqual(want, got);
  };
  return http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/healthz") return send(200, { ok: true });
    if (!authOk(req.headers.authorization)) return send(401, { error: "unauthorized" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { return send(400, { error: "bad json" }); }
    try {
      if (req.method === "GET" && req.url === "/status") return send(200, await p.status());
      if (req.method === "POST" && req.url === "/pause") return send(200, await p.pause(typeof body.drainTimeoutMs === "number" ? body.drainTimeoutMs : undefined));
      if (req.method === "POST" && req.url === "/resume") {
        const u = String(body.upstream ?? "");
        if (!p.upstreamNames.includes(u)) return send(400, { error: `unknown upstream "${u}"`, upstreams: p.upstreamNames });
        return send(200, await p.resume(u));
      }
      return send(404, { error: "not found" });
    } catch (e) { return send(500, { error: (e as Error).message }); }
  });
}

// Z38 REVIEW-4 P-1: 제어 포트(PAUSE·RESUME·쓰기 대상 바꾸기)를 127.0.0.1 밖에 열면서 토큰이 없으면 시작하지 않는다.
//   이유: 같은 망의 아무 컨테이너(앱 포함)가 인증 없이 쓰기 대상 DB 를 바꿀 수 있다.
//   이 파일은 compose 에서 `node <파일>.ts` 하나로 돌므로 다른 로컬 파일을 import 하지 않는다 (proxy.ts·pgbouncer-control.ts 에 같은 함수)
// DRAFT(ai): 데모 compose 처럼 일부러 열어 두려면 DBPROXY_INSECURE_NO_TOKEN=1 (경고 로그가 남음)
export type ControlAuthVerdict = { ok: true; warn?: string } | { ok: false; error: string };
export function checkControlAuth(host: string, token: string | undefined, env: NodeJS.ProcessEnv = process.env): ControlAuthVerdict {
  const h = host.trim().toLowerCase();
  if (token || h === "localhost" || h === "::1" || /^127\./.test(h)) return { ok: true };
  if (env.DBPROXY_INSECURE_NO_TOKEN === "1")
    return { ok: true, warn: `control port open on ${host} without DBPROXY_TOKEN (DBPROXY_INSECURE_NO_TOKEN=1): anyone on this network can switch the writer` };
  return { ok: false, error: `refusing to open control port on ${host} without DBPROXY_TOKEN (set DBPROXY_TOKEN, bind 127.0.0.1, or DBPROXY_INSECURE_NO_TOKEN=1 for a local demo)` };
}
function enforceControlAuth(host: string, token: string | undefined): void {
  const v = checkControlAuth(host, token);
  if (!v.ok) { console.error(JSON.stringify({ level: "error", msg: v.error })); process.exit(2); }
  if (v.warn) console.warn(JSON.stringify({ level: "warn", msg: v.warn }));
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    controlPort: Number(env.DBPROXY_CONTROL_PORT ?? 6480),
    controlHost: env.DBPROXY_CONTROL_HOST ?? "127.0.0.1",
    token: env.DBPROXY_TOKEN || undefined,
    opts: {
      adminUrl: env.PGB_ADMIN_URL ?? "postgres://pgb_admin@127.0.0.1:6432/pgbouncer",
      db: env.PGB_DB ?? "shop",
      serverDb: env.PGB_SERVER_DB ?? env.PGB_DB ?? "shop",
      dbFile: env.PGB_DB_FILE ?? "/etc/pgbouncer/databases.ini",
      extra: env.PGB_DB_EXTRA || undefined,
      upstreams: parseUpstreams(env.DBPROXY_UPSTREAMS ?? "source=localhost:55432,target=localhost:55433"),
      // GitOps 값 database.activeWriter 가 들어오는 칸 (Z31 과 같은 이름)
      active: env.DBPROXY_ACTIVE ?? "source",
      drainTimeoutMs: Number(env.DBPROXY_DRAIN_MS ?? 2000),
      // Z38 P-3: 기본 25초 (이유는 proxy.ts DEFAULT_HOLD_MAX_MS). 이 파일도 import 없이 혼자 돌아서 숫자로 둠
      holdMaxMs: Number(env.DBPROXY_HOLD_MAX_MS ?? 25_000),
    } satisfies PgbControlOptions,
  };
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const c = configFromEnv();
  enforceControlAuth(c.controlHost, c.token);
  const p = new PgbControl(c.opts, adminQuery(c.opts.adminUrl));
  await p.init();
  const ctl = controlServer(p, c.token);
  ctl.listen(c.controlPort, c.controlHost);
  console.log(JSON.stringify({ msg: "pgbouncer-control up", control: `${c.controlHost}:${c.controlPort}`, db: c.opts.db, active: p.active, upstreams: c.opts.upstreams, auth: c.token ? "bearer" : "none" }));
  const stop = () => { console.log(JSON.stringify({ msg: "pgbouncer-control stop", stats: p.stats })); ctl.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

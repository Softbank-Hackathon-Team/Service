// Z31 DRAFT(ai): 앱 ↔ DB 사이 "붙잡기 프록시" (PgBouncer PAUSE/RESUME 흉내).
// 앱의 DB 주소는 이 프록시다. 컷오버 동안
//   pause()  : 진행 중인 트랜잭션은 끝까지 두고, 끝난(쉬는) 연결은 닫는다. 새 연결은 에러 없이 기다리게 한다
//   resume(n): 쓰기 대상(upstream)을 n 으로 바꾸고 기다리던 연결을 n 으로 흘려보낸다
// 앱은 DB 주소를 바꾸지 않는다. 그래서 컷오버 때 앱을 다시 배포하지 않는다 (설계 결정 "앱 DB 주소 = PgBouncer 주소").
//
// 왜 TCP 를 그냥 잇지 않고 Postgres 메시지 머리만 읽나:
//   "쉬는 연결"(트랜잭션 밖, 보낸 질의에 답이 다 옴)을 알아야 진행 중 트랜잭션을 안 끊고 닫을 수 있다.
//   서버의 ReadyForQuery('Z') 끝 바이트가 I(쉼) / T(트랜잭션 중) / E(실패한 트랜잭션) 를 알려 준다.
//   인증(SCRAM 등)은 그대로 통과시킨다. 그래서 비밀번호를 프록시가 몰라도 된다.
// 못 하는 것 (진짜 PgBouncer 와 차이):
//   - 쉬는 연결을 "옮기지" 못하고 닫는다 (서버 쪽 인증을 프록시가 못 하므로). 앱 연결 묶음(pool)이 새로 연다
//   - TLS 를 못 푼다. SSLRequest 에는 'N'(TLS 없음)으로 답한다. 앱 ↔ 프록시는 같은 파드/네트워크 안 평문 전제
//
// 외부 의존성 없음 (node: 모듈만). Node 22.18+ 는 이 파일을 그대로 실행한다 (타입만 지우는 문법만 씀):
//   node packages/dbproxy/src/proxy.ts
// 환경 변수는 아래 configFromEnv 참고.
import net from "node:net";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

// Z38 REVIEW-4 P-3: 기본 붙잡기 최대 25초 = 드레인 2 + 따라잡기 최대 10(REPL_MAX_CATCHUP_MS) + 울타리·마커·재개 여유 13.
//   예전 15초는 최악 컷오버(약 13초)와 2초 차이라, 따라잡기가 끝날 즈음 프록시가 먼저 풀려 출발 DB(울타리 쳐짐)로 쓰기가 갔다.
//   REPL_MAX_CATCHUP_MS 를 올리면 DBPROXY_HOLD_MAX_MS 도 같이 올린다 (PgBouncer query_wait_timeout 은 그보다 5초 길게)
export const DEFAULT_HOLD_MAX_MS = 25_000;

export interface Upstream { host: string; port: number }
export interface ProxyOptions {
  upstreams: Record<string, Upstream>;
  active: string;
  /** pause() 가 진행 중 트랜잭션을 기다리는 최대 시간. 지나면 그대로 둔다 (C2 펜스가 끊는다) */
  drainTimeoutMs?: number;
  /** 붙잡은 채 resume 이 안 오면 이 시간 뒤 지금 대상으로 저절로 푼다 (제어판이 죽었을 때 무한 대기 방지) */
  holdMaxMs?: number;
  log?: (o: Record<string, unknown>) => void;
}

export interface PauseResult { drainMs: number; closedIdle: number; drainedBusy: number; leftBusy: number }
export interface ResumeResult { upstream: string; previous: string; released: number; holdMs: number; maxWaitMs: number }

const SSL_REQUEST = 80877103, GSS_REQUEST = 80877104, CANCEL_REQUEST = 80877102;
const now = () => performance.now();

/** 메시지 경계만 세는 작은 해석기. 바이트는 손대지 않고 그대로 넘긴다 */
export class Framer {
  private head = Buffer.alloc(5);
  private headLen = 0;
  private bodyLeft = 0;
  private pendingType: string | null = null;
  private onType: (type: string, firstBodyByte: number | null) => void;
  constructor(onType: (type: string, firstBodyByte: number | null) => void) { this.onType = onType; }
  push(chunk: Buffer) {
    let i = 0;
    while (i < chunk.length) {
      if (this.bodyLeft > 0) {
        if (this.pendingType) { const t = this.pendingType; this.pendingType = null; this.onType(t, chunk[i]!); }
        const take = Math.min(this.bodyLeft, chunk.length - i);
        this.bodyLeft -= take; i += take; continue;
      }
      this.head[this.headLen++] = chunk[i++]!;
      if (this.headLen === 5) {
        const type = String.fromCharCode(this.head[0]!);
        const len = this.head.readInt32BE(1) - 4;
        this.headLen = 0;
        if (len <= 0) this.onType(type, null);
        else { this.bodyLeft = len; this.pendingType = type; }
      }
    }
  }
}

type Phase = "startup" | "linked" | "closed";
let seq = 0;

class Conn {
  readonly id = ++seq;
  server: net.Socket | null = null;
  upstream: string | null = null;
  phase: Phase = "startup";
  pending = 0;            // 보낸 Query('Q')+Sync('S') 수 - 받은 ReadyForQuery 수
  ready = false;          // 인증이 끝나 ReadyForQuery 를 한 번이라도 받았나
  tx = "I";
  isCancel = false;
  drainOnIdle = false;
  acceptedAt = now();
  heldAt: number | null = null;
  private startBuf: Buffer = Buffer.alloc(0);
  private cframer = new Framer((t) => { if (t === "Q" || t === "S") this.pending++; });
  private sframer = new Framer((t, b) => {
    if (t !== "Z") return;
    this.ready = true; this.pending = Math.max(0, this.pending - 1); this.tx = b === null ? "I" : String.fromCharCode(b);
    if (this.drainOnIdle && this.idle()) this.p.closeConn(this, "drained");
  });
  readonly client: net.Socket;
  private p: HoldProxy;
  constructor(client: net.Socket, p: HoldProxy) { this.client = client; this.p = p; }
  idle() { return this.ready && this.pending === 0 && this.tx === "I"; }

  /** 연결을 위로 잇기 시작. startup 메시지(첫 메시지)를 다 받을 때까지 모은다 */
  start() {
    this.client.on("data", (d: Buffer) => this.fromClient(d));
    this.client.resume();
  }
  private fromClient(d: Buffer) {
    if (this.phase === "linked") { this.cframer.push(d); this.server?.write(d); return; }
    if (this.phase === "closed") return;
    this.startBuf = Buffer.concat([this.startBuf, d]);
    while (this.phase === "startup" && this.startBuf.length >= 8) {
      const len = this.startBuf.readInt32BE(0);
      if (this.startBuf.length < len) return;
      const code = this.startBuf.readInt32BE(4);
      if (code === SSL_REQUEST || code === GSS_REQUEST) {
        // TLS 는 못 푼다 → 'N' (클라이언트가 평문으로 이어 간다. sslmode=require 면 클라이언트가 끊는다)
        this.client.write("N");
        this.startBuf = this.startBuf.subarray(len);
        continue;
      }
      this.isCancel = code === CANCEL_REQUEST;
      const first = this.startBuf;
      this.startBuf = Buffer.alloc(0);
      this.link(first, len);
    }
  }
  private link(first: Buffer, startupLen: number) {
    this.phase = "linked";
    const name = this.p.active;
    const u = this.p.upstreamOf(name);
    this.upstream = name;
    const s = net.connect({ host: u.host, port: u.port });
    this.server = s;
    s.setNoDelay(true);
    // 먼저 앱에 넘기고 그다음 센다 (드레인 닫기가 마지막 답(COMMIT 결과)보다 먼저 나가면 안 된다)
    s.on("data", (d: Buffer) => { this.client.write(d); this.sframer.push(d); });
    s.on("error", () => this.p.closeConn(this, "server_error"));
    s.on("close", () => this.p.closeConn(this, "server_closed"));
    // startup 뒤에 붙어 온 바이트(드묾)는 타입 메시지로 센다
    if (first.length > startupLen) this.cframer.push(first.subarray(startupLen));
    s.write(first);
    this.p.onLinked(this);
  }
  close() {
    if (this.phase === "closed") return;
    this.phase = "closed";
    // 서버에는 Terminate('X')를 보내 백엔드가 깨끗이 끝나게 한다 (쉬는 연결일 때만 안전)
    if (this.server && !this.server.destroyed) {
      if (this.idle()) this.server.end(Buffer.from([0x58, 0, 0, 0, 4])); else this.server.destroy();
    }
    if (!this.client.destroyed) this.client.end();
  }
}

export class HoldProxy {
  active: string;
  paused = false;
  private conns = new Set<Conn>();
  private held: Conn[] = [];
  private pausedAt = 0;
  private holdTimer: NodeJS.Timeout | null = null;
  private drainWaiters: (() => void)[] = [];
  private server: net.Server | null = null;
  readonly stats = { accepted: 0, held: 0, maxHeldMs: 0, closedIdle: 0, drainedBusy: 0, autoReleases: 0, pauses: 0, resumes: 0, lastPause: null as PauseResult | null, lastResume: null as ResumeResult | null };
  private log: (o: Record<string, unknown>) => void;

  private o: ProxyOptions;
  constructor(o: ProxyOptions) {
    this.o = o;
    if (!o.upstreams[o.active]) throw new Error(`active upstream "${o.active}" is not in upstreams`);
    this.active = o.active;
    this.log = o.log ?? ((x) => console.log(JSON.stringify({ at: new Date().toISOString(), ...x })));
  }
  upstreamOf(name: string): Upstream {
    const u = this.o.upstreams[name];
    if (!u) throw new Error(`unknown upstream ${name}`);
    return u;
  }
  get upstreamNames() { return Object.keys(this.o.upstreams); }
  /** Z70 DRAFT(ai): 지금 쓰기 대상이 아닌 upstream 의 주소를 바꾼다 (진짜 apply 가 만든 도착 DB 주소를 컷오버 전에 넣는 길).
   *  지금 대상(active)이나 붙잡는 중에는 거절한다: 앱 연결이 컷오버 없이 다른 DB 로 가면 안 된다. 새 연결부터 새 주소를 쓴다 */
  setUpstream(name: string, u: Upstream): { name: string; previous: Upstream | null; next: Upstream } {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`bad upstream name ${name}`);
    if (name === this.active) throw new Error(`upstream "${name}" is active; change it only through pause/resume`);
    if (this.paused) throw new Error("proxy is paused (cutover in progress)");
    if (!u.host || !Number.isInteger(u.port) || u.port < 1 || u.port > 65535) throw new Error("bad host/port");
    const previous = this.o.upstreams[name] ?? null;
    this.o.upstreams = { ...this.o.upstreams, [name]: { host: u.host, port: u.port } };
    this.log({ level: "info", msg: "upstream set", name, host: u.host, port: u.port });
    return { name, previous, next: { host: u.host, port: u.port } };
  }

  listen(port: number, host = "0.0.0.0"): Promise<net.AddressInfo> {
    this.server = net.createServer({ pauseOnConnect: true }, (sock) => this.accept(sock));
    return new Promise((res) => this.server!.listen(port, host, () => res(this.server!.address() as net.AddressInfo)));
  }
  async close() {
    for (const c of [...this.conns, ...this.held]) c.close();
    if (this.holdTimer) clearTimeout(this.holdTimer);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private accept(sock: net.Socket) {
    this.stats.accepted++;
    sock.setNoDelay(true);
    const c = new Conn(sock, this);
    sock.on("error", () => this.closeConn(c, "client_error"));
    sock.on("close", () => this.closeConn(c, "client_closed"));
    if (this.paused) {
      // 붙잡기: 소켓을 읽지 않는다. 앱 쪽은 "연결 중"으로 보고 기다린다 (에러 없음)
      c.heldAt = now(); this.held.push(c); this.stats.held++;
      return;
    }
    c.start();
  }
  onLinked(c: Conn) { this.conns.add(c); }
  closeConn(c: Conn, why: string) {
    const wasLinked = this.conns.delete(c);
    const hi = this.held.indexOf(c); if (hi >= 0) this.held.splice(hi, 1);
    if (why === "drained") this.stats.drainedBusy++;
    c.close();
    if (wasLinked && this.paused) this.checkDrained();
    void why;
  }
  private busyOnOld() { return [...this.conns].filter((c) => !c.isCancel).length; }
  private checkDrained() {
    if (this.busyOnOld() === 0) { const w = this.drainWaiters.splice(0); w.forEach((f) => f()); }
  }

  /** C1: 붙잡기. 쉬는 연결은 바로 닫고, 트랜잭션 중인 연결은 끝나는 순간 닫는다. 새 연결은 기다리게 한다 */
  async pause(drainTimeoutMs = this.o.drainTimeoutMs ?? 2000): Promise<PauseResult> {
    const t0 = now();
    if (!this.paused) {
      this.paused = true; this.pausedAt = t0; this.stats.pauses++;
      const holdMax = this.o.holdMaxMs ?? DEFAULT_HOLD_MAX_MS;
      this.holdTimer = setTimeout(() => {
        this.stats.autoReleases++;
        this.log({ level: "warn", msg: "hold timeout: releasing to current upstream", upstream: this.active, holdMaxMs: holdMax });
        this.resume(this.active);
      }, holdMax);
    }
    let closedIdle = 0;
    for (const c of [...this.conns]) {
      if (c.isCancel) continue;
      if (c.idle()) { this.closeConn(c, "idle"); closedIdle++; } else c.drainOnIdle = true;
    }
    this.stats.closedIdle += closedIdle;
    const before = this.stats.drainedBusy;
    if (this.busyOnOld() > 0) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, drainTimeoutMs);
        this.drainWaiters.push(() => { clearTimeout(t); res(); });
      });
    }
    const r: PauseResult = { drainMs: round(now() - t0), closedIdle, drainedBusy: this.stats.drainedBusy - before, leftBusy: this.busyOnOld() };
    this.stats.lastPause = r;
    this.log({ msg: "paused", ...r });
    return r;
  }

  /** C6 / C6': 대상 바꾸고 풀어 주기. 같은 이름이면 대상은 그대로 두고 풀어 주기만 한다 */
  resume(upstream: string): ResumeResult {
    this.upstreamOf(upstream);
    const previous = this.active;
    this.active = upstream;
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    const t = now();
    const holdMs = this.paused ? t - this.pausedAt : 0;
    this.paused = false;
    // 대상이 바뀌었으면 옛 대상에 남은 연결(드레인 시간 초과분)은 닫는다. 펜스로 이미 끊겼을 것이다
    if (previous !== upstream) for (const c of [...this.conns]) if (c.upstream !== upstream && !c.isCancel) this.closeConn(c, "stale_upstream");
    const held = this.held.splice(0);
    let maxWait = 0;
    for (const c of held) { if (c.heldAt !== null) maxWait = Math.max(maxWait, t - c.heldAt); c.start(); }
    this.stats.maxHeldMs = Math.max(this.stats.maxHeldMs, round(maxWait));
    this.stats.resumes++;
    const r: ResumeResult = { upstream, previous, released: held.length, holdMs: round(holdMs), maxWaitMs: round(maxWait) };
    this.stats.lastResume = r;
    this.log({ msg: "resumed", ...r });
    return r;
  }

  status() {
    const per: Record<string, number> = {};
    for (const c of this.conns) per[c.upstream ?? "?"] = (per[c.upstream ?? "?"] ?? 0) + 1;
    return { active: this.active, paused: this.paused, upstreams: this.upstreamNames, connections: per, waiting: this.held.length, stats: this.stats };
  }
}

const round = (x: number) => Math.round(x * 10) / 10;

// ---- 제어 HTTP (워커의 훅이 부른다) ----
//   POST /pause  {drainTimeoutMs?}   → PauseResult
//   POST /resume {upstream}          → ResumeResult
//   POST /upstream {name, host, port} → 쓰기 대상이 아닌 upstream 주소 바꾸기 (Z70)
//   GET  /status, GET /healthz
// DBPROXY_TOKEN 이 있으면 Authorization: Bearer <token> 필요. 기본은 127.0.0.1 에만 연다
export function controlServer(p: HoldProxy, token?: string) {
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
      if (req.method === "GET" && req.url === "/status") return send(200, p.status());
      if (req.method === "POST" && req.url === "/pause") {
        const d = typeof body.drainTimeoutMs === "number" ? body.drainTimeoutMs : undefined;
        return send(200, await p.pause(d));
      }
      if (req.method === "POST" && req.url === "/resume") {
        const u = String(body.upstream ?? "");
        if (!p.upstreamNames.includes(u)) return send(400, { error: `unknown upstream "${u}"`, upstreams: p.upstreamNames });
        return send(200, p.resume(u));
      }
      if (req.method === "POST" && req.url === "/upstream") {
        try { return send(200, p.setUpstream(String(body.name ?? ""), { host: String(body.host ?? ""), port: Number(body.port) })); }
        catch (e) { return send(409, { error: (e as Error).message }); }
      }
      return send(404, { error: "not found" });
    } catch (e) { return send(500, { error: (e as Error).message }); }
  });
}

/** DBPROXY_UPSTREAMS="source=db:5432,target=target:5432" */
export function parseUpstreams(s: string): Record<string, Upstream> {
  const out: Record<string, Upstream> = {};
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z0-9_-]+)=([^:]+):(\d+)$/i);
    if (!m) throw new Error(`bad DBPROXY_UPSTREAMS entry: ${part}`);
    out[m[1]!] = { host: m[2]!, port: Number(m[3]) };
  }
  return out;
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
  const upstreams = parseUpstreams(env.DBPROXY_UPSTREAMS ?? "source=localhost:55432,target=localhost:55433");
  return {
    listenPort: Number(env.DBPROXY_PORT ?? 6432),
    listenHost: env.DBPROXY_HOST ?? "0.0.0.0",
    controlPort: Number(env.DBPROXY_CONTROL_PORT ?? 6480),
    controlHost: env.DBPROXY_CONTROL_HOST ?? "127.0.0.1",
    token: env.DBPROXY_TOKEN || undefined,
    opts: {
      upstreams,
      // GitOps 값(database.activeWriter)이 이 칸으로 들어온다. 재시작해도 컷오버 뒤 대상이 유지된다
      active: env.DBPROXY_ACTIVE ?? "source",
      drainTimeoutMs: Number(env.DBPROXY_DRAIN_MS ?? 2000),
      holdMaxMs: Number(env.DBPROXY_HOLD_MAX_MS ?? DEFAULT_HOLD_MAX_MS),
    } satisfies ProxyOptions,
  };
}

// 직접 실행했을 때만 서버를 띄운다 (테스트·워커는 import 만)
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const c = configFromEnv();
  enforceControlAuth(c.controlHost, c.token);
  const p = new HoldProxy(c.opts);
  const a = await p.listen(c.listenPort, c.listenHost);
  const ctl = controlServer(p, c.token);
  ctl.listen(c.controlPort, c.controlHost);
  console.log(JSON.stringify({ msg: "dbproxy up", listen: `${c.listenHost}:${a.port}`, control: `${c.controlHost}:${c.controlPort}`, active: p.active, upstreams: c.opts.upstreams, auth: c.token ? "bearer" : "none" }));
  const stop = async () => { console.log(JSON.stringify({ msg: "dbproxy stop", stats: p.stats })); ctl.close(); await p.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

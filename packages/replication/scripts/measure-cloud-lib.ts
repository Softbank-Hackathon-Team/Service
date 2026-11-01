// 클라우드 DB 한 쌍(예: RDS → Cloud SQL) 실측 도구의 부품 (작업 Z35 = Z15 제안 4, DRAFT(ai))
// 스크립트 본체는 measure-cloud.ts. 여기는 시험할 수 있는 순수 함수 + 작은 DB 도우미만 둔다.
//
// 안전 규칙 (이 도구는 자원을 만들지 않는다. 이미 있는 DB 두 대에 접속만 한다)
//  - 전용 DB 만: 컷오버 울타리(fence)가 "DB 전체" read_only + 앱 계정 세션 끊기를 하므로, DB 이름에 "measure" 가 들어가거나
//    MC_DEDICATED_DB=<DB 이름> 으로 확인해 줘야 run 한다 (실수로 운영 DB 에 돌리는 것 방지)
//  - 전용 스키마(svc_measure) 와 전용 앱 계정(svc_measure_app) 만 만든다·지운다. public 은 손대지 않는다
//  - 비밀번호는 환경변수에서만 읽고, 출력·JSON 에는 접속 문자열 대신 호스트 이름만 남긴다
import pg from "pg";
import type { Endpoint, Provider } from "../src/index.js";
import type { TrafficHooks } from "../src/index.js";

export const MC_SCHEMA_DEFAULT = "svc_measure";
export const MC_APP_ROLE_DEFAULT = "svc_measure_app";
export const MC_TABLES = ["customers", "orders"];
const PROVIDERS: Provider[] = ["postgres", "rds", "cloudsql", "cnpg", "azure"];

export type Mode = "check" | "prepare" | "run" | "clean";
export interface McConfig {
  mode: Mode;
  source: Endpoint; target: Endpoint;
  appPassword: string | null;
  schema: string;
  rows: number; reps: number; workers: number;
  dedicatedDb: string | null;
  out: string | null;
}

// 환경변수 → 설정. 틀리면 무엇을 고치라는 문장 목록을 준다 (비밀값은 문장에 안 넣음)
export function configFromEnv(argv: string[], env: NodeJS.ProcessEnv): { cfg?: McConfig; errors: string[] } {
  const errors: string[] = [];
  const mode = (argv[0] ?? "check") as Mode;
  if (!["check", "prepare", "run", "clean"].includes(mode)) errors.push(`모르는 모드 ${JSON.stringify(argv[0])}: check | prepare | run | clean`);
  const schema = env.MC_SCHEMA ?? MC_SCHEMA_DEFAULT;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema === "public") errors.push("MC_SCHEMA 는 소문자·숫자·_ 이고 public 이 아니어야 한다");
  const appRole = env.MC_APP_ROLE ?? MC_APP_ROLE_DEFAULT;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appRole)) errors.push("MC_APP_ROLE 은 소문자·숫자·_");
  const ep = (side: "SOURCE" | "TARGET", defProvider: Provider): Endpoint | null => {
    const url = env[`MC_${side}_URL`];
    if (!url) { errors.push(`MC_${side}_URL 이 없다 (관리자 접속 문자열)`); return null; }
    try { new URL(url); } catch { errors.push(`MC_${side}_URL 이 URL 모양이 아니다`); return null; }
    const provider = (env[`MC_${side}_PROVIDER`] ?? defProvider) as Provider;
    if (!PROVIDERS.includes(provider)) errors.push(`MC_${side}_PROVIDER 는 ${PROVIDERS.join("|")}`);
    return { label: env[`MC_${side}_LABEL`] ?? `${provider}-${side.toLowerCase()}`, provider, adminUrl: url,
      peerUrl: env[`MC_${side}_PEER_URL`] || undefined, appRole, schema };
  };
  const source = ep("SOURCE", "rds"), target = ep("TARGET", "cloudsql");
  const num = (k: string, d: number, min: number, max: number) => {
    const v = Number(env[k] ?? d);
    if (!Number.isInteger(v) || v < min || v > max) { errors.push(`${k} 는 ${min}~${max} 정수`); return d; }
    return v;
  };
  const rows = num("MC_ROWS", 10_000, 1, 5_000_000), reps = num("MC_REPS", 5, 1, 50), workers = num("MC_WORKERS", 4, 1, 64);
  const appPassword = env.MC_APP_PASSWORD ?? null;
  if ((mode === "prepare" || mode === "run") && !appPassword) errors.push("MC_APP_PASSWORD 가 없다 (prepare·run 은 측정 전용 앱 계정으로 쓰기 부하를 건다)");
  if (errors.length || !source || !target) return { errors };
  return { errors, cfg: { mode, source, target, appPassword, schema, rows, reps, workers,
    dedicatedDb: env.MC_DEDICATED_DB ?? null, out: env.MC_OUT ?? null } };
}

// 사람이 볼 이름: 호스트·DB 만 (계정·비밀번호·쿼리 문자열 제거)
export function redact(url: string): string {
  try { const u = new URL(url); return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`; } catch { return "(bad url)"; }
}

export function appUrl(e: Endpoint, password: string): string {
  const u = new URL(e.adminUrl); u.username = e.appRole; u.password = password; return u.toString();
}

// 관리형 DB 전용 추가 점검 (packages/replication precheck 에 없는 것). 실패해도 고칠 방법을 준다
export interface McCheck { id: string; side: "source" | "target" | "both"; ok: boolean; detail: string; hint?: string }
export function staticChecks(cfg: McConfig, dbNames: { source: string; target: string }): McCheck[] {
  const out: McCheck[] = [];
  for (const side of ["source", "target"] as const) {
    const e = cfg[side];
    const managed = e.provider === "rds" || e.provider === "cloudsql" || e.provider === "azure";
    const ssl = (u: string) => { try { return new URL(u).searchParams.get("sslmode"); } catch { return null; } };
    if (managed) {
      const s = ssl(e.adminUrl);
      out.push({ id: "MC-SSL", side, ok: !!s && s !== "disable", detail: `sslmode=${s ?? "(없음)"}`,
        hint: "관리형 DB 는 인터넷 너머라 ?sslmode=require 를 붙인다" });
    }
    const db = dbNames[side];
    const dedicated = db.includes("measure") || cfg.dedicatedDb === db;
    out.push({ id: "MC-DB", side, ok: dedicated, detail: `database=${db}`,
      hint: "컷오버 울타리가 DB 전체를 read_only 로 만든다. 측정 전용 DB(이름에 measure)를 쓰거나 MC_DEDICATED_DB=<이름> 으로 확인" });
  }
  // 도착이 출발에 복제 연결을 건다: 출발 peerUrl 이 도착 쪽에서 닿아야 한다. 이 도구는 도착 안에서 접속 시험을 못 하므로 모양만 본다
  const peer = cfg.source.peerUrl ?? cfg.source.adminUrl;
  let host = ""; try { host = new URL(peer).hostname; } catch { /* 위에서 잡힘 */ }
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  out.push({ id: "MC-PEER", side: "both", ok: !local || cfg.target.provider === "postgres",
    detail: `도착이 접속할 출발 주소 = ${redact(peer)}`,
    hint: "Cloud SQL 이 RDS 에 붙으려면 RDS 공개 엔드포인트(보안 그룹에 Cloud SQL 나가는 IP 허용) 또는 VPN 주소를 MC_SOURCE_PEER_URL 로" });
  return out;
}

// 측정 스키마: 표 2개 (harness 와 같은 모양, 스키마만 다름). 출발에만 행을 넣는다
export function schemaSql(schema: string, role: string, password: string, seedRows: number | null): string {
  const s = pg.escapeIdentifier(schema), r = pg.escapeIdentifier(role), pw = pg.escapeLiteral(password);
  return `
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${pg.escapeLiteral(role)}) THEN
      CREATE ROLE ${r} LOGIN PASSWORD ${pw}; ELSE ALTER ROLE ${r} LOGIN PASSWORD ${pw}; END IF; END $$;
    DROP SCHEMA IF EXISTS ${s} CASCADE;
    CREATE SCHEMA ${s};
    CREATE TABLE ${s}.customers (id bigserial PRIMARY KEY, name text NOT NULL, visits int NOT NULL DEFAULT 0);
    CREATE TABLE ${s}.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES ${s}.customers(id),
                              amount int NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now());
    GRANT USAGE ON SCHEMA ${s} TO ${r};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${r};
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${s} TO ${r};
    ALTER ROLE ${r} SET search_path = ${s};
  ` + (seedRows === null ? "" : `
    INSERT INTO ${s}.customers(name) SELECT 'c' || g FROM generate_series(1, 100) g;
    INSERT INTO ${s}.orders(customer_id, amount, note) SELECT 1 + g % 100, g, 'seed' FROM generate_series(1, ${Math.floor(seedRows)}) g;`);
}

// 앱 쓰기 라우터 (harness Router 와 같은 일, 앱 접속 문자열만 바깥에서 받음). PgBouncer PAUSE/RESUME 대역
export class AppRouter implements TrafficHooks {
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  private inflight = 0;
  private drained: (() => void) | null = null;
  constructor(public writer: Endpoint, private urlOf: (e: Endpoint) => string) {}
  async run<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    while (this.gate) await this.gate;
    this.inflight++;
    const c = new pg.Client({ connectionString: this.urlOf(this.writer), application_name: "svc-measure-load" });
    c.on("error", () => {});
    try { await c.connect(); return await fn(c); }
    finally { await c.end().catch(() => {}); if (--this.inflight === 0) this.drained?.(); }
  }
  async pause() {
    this.gate = new Promise((r) => (this.open = r));
    if (this.inflight > 0) await new Promise<void>((r) => (this.drained = r));
    this.drained = null;
  }
  async resume(w: Endpoint) { this.writer = w; const o = this.open; this.gate = null; this.open = null; o?.(); }
}

export interface LoadStats { ok: number; fail: number; errors: Record<string, number>; lat: number[]; stop(): Promise<void> }
export function startLoad(router: AppRouter, schema: string, workers: number): LoadStats {
  let stopping = false;
  const st: LoadStats = { ok: 0, fail: 0, errors: {}, lat: [], stop: async () => { stopping = true; await done; } };
  const s = pg.escapeIdentifier(schema);
  const one = async () => {
    let i = 0;
    while (!stopping) {
      const t0 = performance.now();
      try {
        await router.run(async (c) => {
          await c.query(`INSERT INTO ${s}.orders(customer_id, amount, note) VALUES ($1, $2, 'measure')`, [1 + (i % 100), i]);
          if (i % 5 === 0) await c.query(`UPDATE ${s}.customers SET visits = visits + 1 WHERE id = $1`, [1 + (i % 100)]);
        });
        st.ok++;
      } catch (e) {
        st.fail++; const m = (e as Error).message.split("\n")[0]!.slice(0, 120); st.errors[m] = (st.errors[m] ?? 0) + 1;
        await new Promise((r) => setTimeout(r, 20));
      }
      st.lat.push(performance.now() - t0); i++;
    }
  };
  const done = Promise.all(Array.from({ length: workers }, () => one()));
  return st;
}

export interface Stat { n: number; min: number; median: number; p95: number; max: number }
export function stat(a: number[]): Stat | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, min: r(s[0]!), median: r(at(0.5)), p95: r(at(0.95)), max: r(s.at(-1)!) };
}

export interface McResult {
  at: string; mode: "run";
  source: { label: string; provider: Provider; host: string };
  target: { label: string; provider: Provider; host: string };
  rows: number; reps: number; workers: number;
  rttMs: { source: Stat | null; target: Stat | null };
  initialCopyMs: number | null;
  gateLagsMs: number[];
  cutoverPauseMs: number[]; rollbackPauseMs: number[];
  appWrites: { ok: number; fail: number; p50Ms: number | null; p99Ms: number | null; maxMs: number | null; errors: Record<string, number> };
  leftovers: string[];
}

// 설계 문서·발표에 붙일 표. 숫자는 전부 【실측】 (이 도구가 잰 것)
export function renderMarkdown(r: McResult): string {
  const f = (s: Stat | null) => s ? `${s.median} (min ${s.min} / max ${s.max}, n=${s.n})` : "—";
  const cs = stat(r.cutoverPauseMs), rs = stat(r.rollbackPauseMs);
  return [
    `### DB 컷오버 실측 ${r.source.provider} → ${r.target.provider} 【실측, ${r.at}】`,
    "",
    `- 출발 ${r.source.label} (${r.source.host}) → 도착 ${r.target.label} (${r.target.host})`,
    `- 주문 ${r.rows.toLocaleString("en-US")}행, 쓰기 부하 ${r.workers}개 동시, 전환·롤백 ${r.reps}회 반복`,
    "",
    "| 항목 | 중앙값 ms (최소 / 최대, 횟수) |",
    "|---|---|",
    `| 측정 PC → 출발 왕복 | ${f(r.rttMs.source)} |`,
    `| 측정 PC → 도착 왕복 | ${f(r.rttMs.target)} |`,
    `| 초기 복사 | ${r.initialCopyMs === null ? "—" : Math.round(r.initialCopyMs)} |`,
    `| 컷오버 쓰기 멈춤 | ${f(cs)} |`,
    `| 롤백 쓰기 멈춤 | ${f(rs)} |`,
    "",
    `- 앱 쓰기: 성공 ${r.appWrites.ok} · 실패 ${r.appWrites.fail} · p50 ${r.appWrites.p50Ms ?? "—"} ms · p99 ${r.appWrites.p99Ms ?? "—"} ms · 최대 ${r.appWrites.maxMs ?? "—"} ms`,
    `- 실패 이유: ${Object.keys(r.appWrites.errors).length ? JSON.stringify(r.appWrites.errors) : "없음"}`,
    `- 남은 복제 객체: ${r.leftovers.length ? r.leftovers.join(", ") : "없음"}`,
    "",
    "주의: 측정 PC 가 부하기 겸 제어판이라, 앱 쓰기 지연에는 측정 PC ↔ DB 왕복이 들어 있다. 같은 클라우드 안 앱이면 더 짧다 【추정】.",
  ].join("\n");
}

export async function dbName(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { return (await c.query<{ d: string }>("SELECT current_database() d")).rows[0]!.d; } finally { await c.end().catch(() => {}); }
}

export async function rtt(url: string, n = 5): Promise<number[]> {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try {
    const out: number[] = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); await c.query("SELECT 1"); out.push(performance.now() - t0); }
    return out;
  } finally { await c.end().catch(() => {}); }
}

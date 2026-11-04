// 데모 직전 점검 (z75-22). 조회만 한다: 아무것도 만들거나 바꾸지 않는다. 비밀값·계정 번호는 찍지 않는다.
// 실행 (레포 맨 위에서): npm run demo:preflight   또는   sh tools/demo-preflight.sh
// 결과: 항목마다 OK / FAIL / SKIP 한 줄, 끝에 "FAIL n개". FAIL 이 하나라도 있으면 종료 코드 1.
// SKIP = 그 항목에 필요한 설정이 .env 에 없음 (예: 온프레만 쓰는 날의 Cloudflare)
//
// 바꿀 수 있는 값 (비우면 기본)
//   PREFLIGHT_API_URL      기본 http://localhost:3000
//   PREFLIGHT_WORKER_URL   기본 http://localhost:9465/metrics (워커 지표 주소)
//   PREFLIGHT_HOST         도메인 풀기·x-served-by 를 볼 주소. 기본 CF_CHECK_LB_HOSTNAME
//   PREFLIGHT_TIMEOUT_MS   항목 하나의 기한. 기본 5000
//   PREFLIGHT_LLM_CALL=0   anthropic 1토큰 호출을 건너뜀
//   PREFLIGHT_DEMO_TENANT  OWNER_DATABASE_URL 이 없을 때 이전 표를 볼 회사 (기본 데모 회사 1111…). 있으면 모든 회사
// z75-44 (Z78): 일 고리 2항목. cleanup 잡 수(최근 10분) ≤ 활성 이전 × 3, 창이 10초 넘게 지난 rollback_window 이전 0건
import { execFile } from "node:child_process";
import { promises as dns, lookup } from "node:dns";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { cfRequest, cfZoneByName } from "@svc/traffic";
import { agentLlmStatusFromEnv, testSwitchesOn } from "@svc/contracts";

type Result = { name: string; status: "OK" | "FAIL" | "SKIP"; detail: string };
const env = process.env;
const TIMEOUT = Number(env.PREFLIGHT_TIMEOUT_MS ?? 5000) || 5000;
const API = (env.PREFLIGHT_API_URL || "http://localhost:3000").replace(/\/$/, "");
const WORKER = env.PREFLIGHT_WORKER_URL || "http://localhost:9465/metrics";
const HOST = env.PREFLIGHT_HOST || env.CF_CHECK_LB_HOSTNAME || "";
// Z38 R8-1: 워커(platform.ts)·cf-check 처럼 CF_API_TOKEN 도 받는다. 예전엔 CLOUDFLARE_API_TOKEN 만 봐서 별칭만 쓰는 .env 면 Cloudflare 3항목이 SKIP(= 문제없어 보임)
const CF_TOKEN = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || "";

class Skip extends Error {}

// z75-44: 이전 표는 RLS(FORCE)가 걸려 있어 소유자도 회사 번호 없이는 0행이다. 그래서 읽기 전용 svc_metrics 역할(0010, 모든 회사 읽기)로
//   바꿔 읽고, 바꿀 수 없으면(app_user 등) 데모 회사 하나만 본다. pgboss.job 은 역할을 바꾸기 전에 읽는다
const ENDED = "'completed','rolled_back','cancelled','failed','rejected','stale','paused'";
const FIX = "치우기: 워커를 다시 띄운다(개발 npm run dev:worker, 운영 docker compose -f docker-compose.prod.yml restart worker). "
  + "그래도 남으면 Z32 의 ops:force-fail <이전 번호> (리뷰 뒤 들어오면 쓴다, 지금은 안내만)";
async function withDb<T>(fn: (c: pg.Client, readAll: () => Promise<string>) => Promise<T>): Promise<T> {
  const url = env.OWNER_DATABASE_URL || env.DATABASE_URL;
  if (!url) skip("DATABASE_URL 없음");
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: TIMEOUT });
  const readAll = async () => {
    try { await c.query("SET ROLE svc_metrics"); return "모든 회사"; } catch {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [env.PREFLIGHT_DEMO_TENANT || "11111111-1111-4111-8111-111111111111"]);
      return "데모 회사만";
    }
  };
  try { await c.connect(); return await fn(c, readAll); } finally { await c.end().catch(() => {}); }
}
const skip = (why: string): never => { throw new Skip(why); };

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${ms}ms 안에 답 없음`)), ms).unref())]);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: TIMEOUT }, (err, out, errOut) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return rej(new Skip(`${cmd} 없음`));
      if (err) return rej(new Error((errOut || err.message).trim().split("\n")[0] ?? "실패"));
      res(out);
    });
  });
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
}

// ---------- 항목 ----------
const checks: Array<[string, () => Promise<string>]> = [
  // z75-68: 시험 전용 스위치가 .env 에 켜져 있으면 데모가 흉내로 돈다 (이름만 찍음)
  ["시험 전용 스위치 꺼짐", async () => {
    const on = testSwitchesOn(env);
    if (on.length) throw new Error(`켜져 있음: ${on.join(", ")} → .env 에서 지우거나 0`);
    return "MOCK_SEED·MOCK_IAC·MOCK_ARGO·MOCK_PRECHECK·FAKE_LLM·DEV_AUTH·MOCK_CREDS·MOCK_REPL·MOCK_TRAFFIC 모두 꺼짐";
  }],
  ["API /healthz", async () => {
    const r = await get(`${API}/healthz`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  }],
  ["워커 살아 있음 (지표 응답)", async () => {
    const r = await get(WORKER);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.text();
    const up = /^process_start_time_seconds\s+(\d+(\.\d+)?)/m.exec(body);
    return up ? `응답함, 띄운 지 ${Math.round(Date.now() / 1000 - Number(up[1]))}초` : "응답함";
  }],
  ["DB 접속", async () => {
    if (!env.DATABASE_URL) skip("DATABASE_URL 없음");
    const c = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: TIMEOUT });
    try {
      await c.connect();
      const r = await c.query("SELECT current_setting('server_version') AS v, (SELECT count(*) FROM pgboss.job WHERE state = 'active')::int AS active");
      return `Postgres ${r.rows[0].v}, 실행 중 작업 ${r.rows[0].active}`;
    } finally { await c.end().catch(() => {}); }
  }],
  // z75-44: 22:19Z 맥 실측의 cleanup 반복(창이 끝난 옛 이전이 잠금을 못 쥐면 1.5초마다 재예약) 같은 일 고리를 데모 전에 잡는다
  ["cleanup 잡 반복 없음 (최근 10분)", async () => {
    const r = await withDb(async (c, readAll) => {
      const jobs = (await c.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'cleanup' AND created_on > now() - interval '10 minutes'`)).rows[0].n as number;
      const scope = await readAll();
      const active = (await c.query(`SELECT count(*)::int AS n FROM migrations WHERE status NOT IN (${ENDED})`)).rows[0].n as number;
      return { jobs, active, scope };
    });
    const limit = Math.max(r.active, 1) * 3;
    const msg = `cleanup 잡 ${r.jobs}개, 활성 이전 ${r.active}건 ${r.scope} (한도 ${limit} = max(활성,1)×3)`;
    if (r.jobs > limit) throw new Error(`${msg} → 반복 의심. ${FIX}`);
    return msg;
  }],
  ["창 끝난 rollback_window 없음", async () => {
    let scope = "";
    const rows = await withDb(async (c, readAll) => { scope = await readAll(); return (await c.query(
      `SELECT left(id::text, 8) AS id, extract(epoch FROM now() - rollback_window_ends_at)::int AS over
         FROM migrations WHERE status = 'rollback_window' AND rollback_window_ends_at < now() - interval '10 seconds'
        ORDER BY rollback_window_ends_at LIMIT 5`)).rows as Array<{ id: string; over: number }>; });
    if (rows.length) throw new Error(`${rows.length}건 이상 (${scope}): ${rows.map((x) => `${x.id}… 창 끝난 지 ${x.over}초`).join(", ")}. ${FIX}`);
    return `0건 (${scope})`;
  }],
  ["k3d 노드 Ready", async () => {
    const out = await run("kubectl", ["get", "nodes", "--no-headers"]);
    const rows = out.trim().split("\n").filter(Boolean);
    if (rows.length === 0) throw new Error("노드 0개");
    const notReady = rows.filter((l) => l.split(/\s+/)[1] !== "Ready");
    if (notReady.length) throw new Error(`Ready 아님 ${notReady.length}/${rows.length}`);
    return `${rows.length}/${rows.length} Ready`;
  }],
  ["cloudflared 터널", async () => {
    const out = await run("pgrep", ["-x", "cloudflared"]).catch((e) => {
      if (e instanceof Skip) throw e;
      if (!CF_TOKEN) skip("cloudflared 프로세스 없음, Cloudflare 설정도 없음 (터널 안 쓰는 날)");
      throw new Error("cloudflared 프로세스 없음");
    });
    const n = out.trim().split("\n").filter(Boolean).length;
    if (!CF_TOKEN || !env.CLOUDFLARE_ZONE_NAME) return `프로세스 ${n}개 (토큰 없어 연결 상태는 안 봄)`;
    const z = await cfZoneByName(cf, env.CLOUDFLARE_ZONE_NAME);
    if (!z.accountId) return `프로세스 ${n}개 (계정 번호를 못 얻어 연결 상태는 안 봄)`;
    addSecret(z.accountId);
    const ts = await cfRequest<Array<{ name: string; status?: string }>>(cf, "GET", `/accounts/${z.accountId}/cfd_tunnel?is_deleted=false`);
    const healthy = ts.filter((t) => t.status === "healthy").length;
    if (healthy === 0) throw new Error(`프로세스 ${n}개, 건강한 터널 0/${ts.length}`);
    return `프로세스 ${n}개, 건강한 터널 ${healthy}/${ts.length}`;
  }],
  ["Cloudflare LB 풀 health", async () => {
    if (!CF_TOKEN || !env.CLOUDFLARE_ZONE_NAME) skip("CLOUDFLARE_API_TOKEN(또는 CF_API_TOKEN)·ZONE_NAME 없음");
    // pf-d FM-TRF-11: 워커(switcherFromEnv)처럼 옛 이름 CF_*_POOL_ID 도 받는다. 예전엔 CLOUDFLARE_* 만 봐서 cf-check --keep 출력(CF_*)을 넣으면 SKIP
    const ids = [env.CLOUDFLARE_SOURCE_POOL_ID || env.CF_SOURCE_POOL_ID, env.CLOUDFLARE_TARGET_POOL_ID || env.CF_TARGET_POOL_ID].filter((x): x is string => !!x);
    if (ids.length === 0) skip("CLOUDFLARE_SOURCE_POOL_ID·TARGET_POOL_ID (옛 이름 CF_*) 없음");
    const z = await cfZoneByName(cf, env.CLOUDFLARE_ZONE_NAME!);
    if (!z.accountId) throw new Error("계정 번호를 못 얻음");
    addSecret(z.accountId);
    const parts: string[] = []; let bad = 0;
    // 풀 객체에는 health 가 없다 → 풀 이름·켜짐은 Pool Details, 건강은 Pool Health Details 로 따로 읽는다
    for (const [i, id] of ids.entries()) {
      const base = `/accounts/${z.accountId}/load_balancers/pools/${id}`;
      const p = await cfRequest<{ name?: string; enabled?: boolean }>(cf, "GET", base);
      const h = await cfRequest<{ pop_health?: Record<string, unknown> }>(cf, "GET", `${base}/health`);
      const regions = regionHealth(h.pop_health);
      const up = regions.filter((r) => r.healthy).length;
      // 모든 확인 지역이 healthy 여야 OK (엄격). 하나라도 아니면 그 지역 이름을 같이 찍어 사람이 판단 (Z38 R8-3)
      const okNow = p.enabled !== false && regions.length > 0 && up === regions.length;
      if (!okNow) bad++;
      const down = regions.filter((r) => !r.healthy).map((r) => r.region);
      const label = p.enabled === false ? "꺼짐" : regions.length === 0 ? "health 정보 없음"
        : `지역 ${up}/${regions.length} healthy${down.length ? ` (아님: ${down.slice(0, 3).join(", ")}${down.length > 3 ? " …" : ""})` : ""}`;
      parts.push(`${i === 0 ? "출발" : "도착"} ${p.name ?? "?"} ${label}`);
    }
    if (bad) throw new Error(parts.join(", "));
    return parts.join(", ");
  }],
  ["도메인 풀기 1.1.1.1", async () => {
    if (!HOST) skip("PREFLIGHT_HOST·CF_CHECK_LB_HOSTNAME 없음");
    const r = new dns.Resolver({ timeout: TIMEOUT, tries: 1 });
    r.setServers(["1.1.1.1"]);
    const a = await r.resolve4(HOST);
    return `${HOST} → 주소 ${a.length}개`;
  }],
  ["도메인 풀기 시스템 리졸버", async () => {
    if (!HOST) skip("PREFLIGHT_HOST·CF_CHECK_LB_HOSTNAME 없음");
    const a = await new Promise<string[]>((res, rej) => lookup(HOST, { all: true }, (e, xs) => (e ? rej(e) : res(xs.map((x) => x.address)))));
    return `${HOST} → 주소 ${a.length}개`;
  }],
  ["x-served-by", async () => {
    if (!HOST) skip("PREFLIGHT_HOST·CF_CHECK_LB_HOSTNAME 없음");
    const r = await get(`https://${HOST}/healthz`);
    const by = r.headers.get("x-served-by");
    if (!by) throw new Error(`HTTP ${r.status}, x-served-by 헤더 없음`);
    return `HTTP ${r.status}, ${by}`;
  }],
  ["에이전트 LLM", async () => {
    // 작업 Z90: 기본 = 실제 Claude API. FAKE_LLM=1 은 시험 전용이라 데모 사전점검에서는 실패로 본다
    const st = agentLlmStatusFromEnv(env, { keyFlag: false });
    if (st.state === "fake") throw new Error("FAKE_LLM=1 (시험용 가짜 LLM 켜짐, 데모 전에 지우기)");
    if (st.state === "key_missing") throw new Error("ANTHROPIC_API_KEY 없음 (.env 에 넣기)");
    const provider = "anthropic";
    if (env.PREFLIGHT_LLM_CALL === "0") return `${provider}, 키 있음 (호출은 건너뜀)`;
    const model = st.model;
    const r = await get("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
    });
    if (!r.ok) {
      const t = ((await r.json().catch(() => ({}))) as { error?: { type?: string } }).error?.type ?? "";
      throw new Error(`${provider}, 키 있음, 1토큰 호출 HTTP ${r.status} ${t}`.trim());
    }
    return `${provider}, 키 있음, 1토큰 호출 됨 (${model})`;
  }],
  ["가격 캐시 날짜", async () => {
    const out: string[] = []; let oldest = Infinity;
    for (const v of ["aws", "gcp", "onprem"]) {
      const raw = await readFile(new URL(`../packages/cost/prices/${v}.json`, import.meta.url), "utf8").catch(() => null);
      if (!raw) { out.push(`${v} 없음`); continue; }
      const at = (JSON.parse(raw) as { fetchedAt?: string }).fetchedAt;
      out.push(`${v} ${at?.slice(0, 10) ?? "?"}`);
      if (at) oldest = Math.min(oldest, Date.parse(at));
    }
    const days = Number.isFinite(oldest) ? (Date.now() - oldest) / 86400_000 : Infinity;
    if (days > 7) throw new Error(`${out.join(", ")} (7일 넘음 → npm -w packages/cost run prices:fetch)`);
    return out.join(", ");
  }],
  ["시연 시간 설정", async () => {
    const obs = env.TRAFFIC_OBSERVE_SEC ?? "(비움)";
    const win = env.ROLLBACK_WINDOW_SEC ?? "(비움 = 3)";
    return `TRAFFIC_OBSERVE_SEC=${obs}, ROLLBACK_WINDOW_SEC=${win}`;
  }],
];

// CF_CHECK_API_BASE 는 가짜 서버 시험용 (실제 실행에선 비워 둔다, cf-check 와 같은 이름)
// pop_health 모양: 문서는 { healthy, origins } 로 적지만 실제는 지역별 묶음일 수 있어 둘 다 읽는다【미확인】
export function regionHealth(pop: Record<string, unknown> | undefined): Array<{ region: string; healthy: boolean }> {
  if (!pop) return [];
  if (typeof pop.healthy === "boolean") return [{ region: "(전체)", healthy: pop.healthy }];
  return Object.entries(pop).flatMap(([region, v]) => (v && typeof v === "object" && typeof (v as { healthy?: unknown }).healthy === "boolean"
    ? [{ region, healthy: (v as { healthy: boolean }).healthy }] : []));
}

const cf = { token: async () => CF_TOKEN!, timeoutMs: TIMEOUT, baseUrl: env.CF_CHECK_API_BASE || undefined };

// 비밀값이 오류 문장에 섞여 나오지 않게
// Z38 R8-2: 별칭 토큰(CF_API_TOKEN)·OWNER_DATABASE_URL·DB URL 안의 비밀번호 조각·API 로 얻은 계정 번호도 가린다.
//           긴 것부터 바꿔야 URL 통째가 비밀번호 조각보다 먼저 가려진다
export function secretsFrom(e: NodeJS.ProcessEnv): string[] {
  const urls = [e.DATABASE_URL, e.OWNER_DATABASE_URL].filter((u): u is string => !!u);
  const pw = urls.flatMap((u) => {
    try { const p = new URL(u).password; return p ? [p, decodeURIComponent(p)] : []; } catch { return []; }
  });
  return [e.ANTHROPIC_API_KEY, e.CLOUDFLARE_API_TOKEN, e.CF_API_TOKEN, ...urls, ...pw, e.CF_ACCOUNT_ID, e.CLOUDFLARE_ZONE_ID]
    .filter((s): s is string => !!s && s.length >= 6);
}
export function makeScrub(list: string[]): (s: string) => string {
  return (s) => [...new Set(list)].sort((a, b) => b.length - a.length).reduce((acc, x) => acc.split(x).join("***"), s);
}
const SECRETS = secretsFrom(env);
function addSecret(x: string | undefined) { if (x && x.length >= 6 && !SECRETS.includes(x)) SECRETS.push(x); }
const scrub = (s: string) => makeScrub(SECRETS)(s);

async function main() {
  const t0 = performance.now();
  const results: Result[] = await Promise.all(checks.map(async ([name, fn]) => {
    try { return { name, status: "OK", detail: await withTimeout(fn()) } as Result; }
    catch (e) {
      if (e instanceof Skip) return { name, status: "SKIP", detail: e.message } as Result;
      return { name, status: "FAIL", detail: (e as Error).message || String(e) } as Result;
    }
  }));
  // 한글은 화면 폭이 달라 칸을 맞추지 않는다: "상태  항목: 내용"
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}: ${scrub(r.detail)}`);
  const fails = results.filter((r) => r.status === "FAIL").length;
  const skips = results.filter((r) => r.status === "SKIP").length;
  console.log(`\nFAIL ${fails}개, SKIP ${skips}개, ${((performance.now() - t0) / 1000).toFixed(1)}초`);
  process.exit(fails ? 1 : 0);
}

// 시험이 위 함수만 가져다 쓸 수 있게: 직접 실행할 때만 main
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(scrub((e as Error).message)); process.exit(2); });
}

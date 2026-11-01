// Cloudflare 트래픽 전환 실연결 검증 (Z14)
// 기본은 dry-run: 읽기(GET)만 하고, 만들/바꿀/지울 요청은 화면에 "할 일"로만 찍는다.
// 실제로 만들려면 --apply. 만든 것은 끝에 지운다(--keep 이면 남긴다). 남은 것만 지우려면 --cleanup.
//
// 실행 (레포 맨 위에서, .env 에 CLOUDFLARE_API_TOKEN·CLOUDFLARE_ZONE_NAME 이 있어야 한다):
//   npm run cf:check
//   npm run cf:check -- --apply
//   npm run cf:check -- --cleanup --apply
//
// 이 스크립트가 만드는 자원 이름은 전부 cf-check 로 시작한다. 그 밖의 자원은 읽기만 하고 절대 바꾸거나 지우지 않는다.
// 비밀값(토큰)과 계정·zone ID 는 화면에 앞 4자리만 찍는다.
import {
  cfRequest, cfZoneByName, cloudflareLb, cloudflarePatchBody, cloudflarePreflight, cloudflareWeightsOf,
  setAndVerify, ProviderError, type CfLoadBalancer, type Weights,
} from "@svc/traffic";
import { authServers, directResolve4, dnsServersFromEnv, pinnedLookup, probeOnce, waitResolvable, withSystemFallback, judgeShare, zoneOf, poolHealthOf, isErrorKey, inCloudflareV4, originCheck, type PreflightFail } from "./cf-probe.js";

// ---------- 설정 ----------
const argv = new Set(process.argv.slice(2));
const argVal = (k: string) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : undefined; };
const APPLY = argv.has("--apply");
const CLEANUP_ONLY = argv.has("--cleanup");
const KEEP = argv.has("--keep");
const HOLD_SEC = Number(argVal("hold-sec") ?? 5);              // 단계마다 기다리는 시간 (모니터·엣지 반영 관찰용)
const PROBES = Number(argVal("probe") ?? 0);                  // 단계마다 LB 주소로 보낼 요청 수 (0 이면 안 보냄)
const PROBE_HEADER = (argVal("probe-header") || process.env.CF_CHECK_PROBE_HEADER || "x-served-by").toLowerCase();
const REPEAT = Math.max(1, Number(argVal("repeat") ?? 3));   // PATCH·GET 시간 재기 반복 수
const PROBE_TARGET = argVal("probe-target") || process.env.CF_CHECK_PROBE_TARGET || "";   // Z70-2: 도착 오리진의 x-served-by 이름 (주면 ±10%p 판정)
const probeFails: string[] = [];
// Z70-2: 첫 probe 전 LB 이름이 풀릴 때까지 기다리는 최대 시간. Z38 R7-7: 숫자가 아니면 기본값 (NaN 이면 기다림이 안 끝났다)
const DNS_WAIT_SEC = Number.isFinite(Number(argVal("dns-wait-sec"))) && argVal("dns-wait-sec") ? Number(argVal("dns-wait-sec")) : 120;

// Z70-3: 첫 probe 전 pool 건강 확인을 기다리는 최대 초 (모니터 간격 60초 + 재시도 1번 + 여유). 0 이면 안 기다림
const HEALTH_WAIT_SEC = Number.isFinite(Number(argVal("health-wait-sec"))) && argVal("health-wait-sec") ? Number(argVal("health-wait-sec")) : 150;
// z75-38: 가중치를 바꾼 뒤 엣지에 퍼질 때까지 기다리는 최대 초. 작은 예비 probe(SETTLE_PROBE 번)를 되풀이해 도착 몫이 기대 폭 안에 들면 본 probe 를 시작한다.
//   맥 int5-6 1회차: LB 를 만든 직후 90/10 이 40% 로 재졌다 (첫 PATCH 가 엣지에 퍼지기 전). 0 이면 안 기다림 (예전 동작). 예비 결과는 판정에 안 넣는다
const SETTLE_SEC = Number.isFinite(Number(argVal("settle-sec"))) && argVal("settle-sec") ? Number(argVal("settle-sec")) : 90;
const SETTLE_PROBE = Math.max(1, Number(argVal("settle-probe") ?? 10));
// 예비 판정: 기대 폭 안 + "바뀌기 전 몫"보다 새 기대 몫에 더 가까움, 이것이 연속 2회. 예비 10번이면 50% 의 폭이 ±40%p 라 폭만 보면 옛 몫(10%)도 통과한다 (VM 재현)
const SETTLE_CONFIRM = 2;
// Z70-3: 단계 처음 N번이 전부 오류면 그 단계 probe 를 멈춘다 (맥 C 1회차: 50번 × 10초 = 단계당 515초)
const PROBE_EARLY_STOP = 5;

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME || undefined;
const PREFIX = "cf-check";
// DRAFT(ai): 기본 LB 주소는 cf-check.<zone>. 이미 쓰는 이름(앱 주소)과 겹치지 않게
const LB_HOST = process.env.CF_CHECK_LB_HOSTNAME || (ZONE_NAME ? `${PREFIX}.${ZONE_NAME}` : "");
// 출발·도착 오리진 주소. 터널이면 <터널 UUID>.cfargotunnel.com, 아니면 공개 호스트 이름이나 IP
const SRC_ORIGIN = process.env.CF_CHECK_SOURCE_ORIGIN || undefined;
const TGT_ORIGIN = process.env.CF_CHECK_TARGET_ORIGIN || undefined;
// 오리진에 보낼 Host 헤더 (터널 공개 호스트 이름과 같아야 터널이 받는다 【추정】). 없으면 안 붙인다
const SRC_HOST = process.env.CF_CHECK_SOURCE_HOST_HEADER || undefined;
const TGT_HOST = process.env.CF_CHECK_TARGET_HOST_HEADER || undefined;
const MONITOR_PATH = process.env.CF_CHECK_MONITOR_PATH || "/healthz";
// 단계: 출발/도착 비율. 마지막에 100/0 으로 되돌려 롤백 시간도 잰다
const STEPS: Weights[] = (argVal("steps") ?? "90/10,50/50,0/100,100/0").split(",").map((s) => {
  const [a, b] = s.split("/").map(Number);
  return { source: a! / 100, target: b! / 100 };
});

const mask = (id: string | null | undefined) => (id ? `${id.slice(0, 4)}…` : "(없음)");
const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
let calls = 0;
// CF_CHECK_API_BASE 는 가짜 서버 시험용 (실제 실행에선 비워 둔다)
const req = { token: async () => TOKEN!, fetch: countingFetch(), baseUrl: process.env.CF_CHECK_API_BASE || undefined };
function countingFetch() {
  return (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    calls++;
    return fetch(url, init) as unknown as { status: number; json(): Promise<unknown>; headers: { get(n: string): string | null } };
  });
}
const cf = <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => cfRequest<T>(req, method, path, body);

function step(n: string, msg: string) { console.log(`\n[${n}] ${msg}`); }
function ok(msg: string) { console.log(`  OK   ${msg}`); }
function plan(msg: string, body?: unknown) {
  console.log(`  할일 ${msg}${APPLY ? "" : " (dry-run: 안 보냄)"}`);
  if (body !== undefined && !APPLY) console.log(`       본문 ${JSON.stringify(body)}`);
}
function fail(msg: string): never { console.error(`  실패 ${msg}`); process.exit(1); }

interface Named { id: string; name?: string; description?: string }
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? NaN; };

async function main() {
  console.log(`cf-check 모드: ${APPLY ? (CLEANUP_ONLY ? "정리(실제 삭제)" : "실제 생성·전환") : "dry-run (읽기만)"}`);
  if (!TOKEN) fail("CLOUDFLARE_API_TOKEN 이 비어 있다 (.env 확인)");
  if (!ZONE_NAME) fail("CLOUDFLARE_ZONE_NAME 이 비어 있다 (.env 확인)");

  // 1. 토큰이 살아 있나
  step("1/7", "토큰 확인");
  try {
    const v = await cf<{ status: string; expires_on?: string }>("GET", "/user/tokens/verify");
    if (v.status !== "active") fail(`토큰 상태 ${v.status}`);
    ok(`토큰 active${v.expires_on ? `, 만료 ${v.expires_on}` : ", 만료 없음"}`);
  } catch (e) {
    // 【추정】 계정 소유 토큰이면 /user/tokens/verify 가 실패한다. 그럴 땐 다음 단계(zone 조회)가 되면 통과로 본다
    console.log(`  주의 /user/tokens/verify 실패 (${(e as Error).message}). 계정 소유 토큰일 수 있다 → zone 조회로 확인`);
  }

  // 2. zone id, 계정 id
  step("2/7", `zone 조회 (${ZONE_NAME})`);
  const zone = await cfZoneByName(req, ZONE_NAME).catch((e) => fail((e as Error).message));
  const accountId = zone.accountId || process.env.CF_ACCOUNT_ID || null;
  ok(`zone ${mask(zone.id)}, 계정 ${mask(accountId)}, 요금제 ${zone.plan ?? "?"}`);
  // Z70-3: 구역 SSL 모드 읽기만 (바꾸지 않는다). Full 이면 Cloudflare 가 오리진 443 으로 붙는다 → 오리진이 80 만 열면 522
  try {
    const ssl = await cf<{ value?: string }>("GET", `/zones/${zone.id}/settings/ssl`);
    const mode = ssl?.value ?? "?";
    const note: Record<string, string> = {
      off: "오리진 80 (https 방문 불가)", flexible: "오리진 80 으로 붙음",
      full: "오리진 443 으로 붙음, 자체 서명 인증서 됨 → served-by 는 443 필요 (apply-served-by.sh up 이 만든다)",
      strict: "오리진 443 + 공인/Origin CA 인증서 필요. 자체 서명이면 526 → 이 검사는 실패한다",
    };
    ok(`구역 SSL 모드 ${mode}: ${note[mode] ?? "?"}`);
  } catch (e) { console.log(`  주의 구역 SSL 모드를 못 읽음 (${(e as ProviderError).status ?? "?"}, 토큰에 Zone Settings Read 없음일 수 있다). Full 이면 오리진 443 이 열려 있어야 한다`); }
  if (!accountId) fail("계정 id 를 못 얻었다. .env 에 CF_ACCOUNT_ID 를 넣고 다시 (채팅에 붙이지 말 것)");
  const A = `/accounts/${accountId}/load_balancers`;
  const Z = `/zones/${zone.id}/load_balancers`;

  // 3. 권한 확인 = 목록 읽기 3개
  step("3/7", "권한 확인 (모니터·pool·LB 목록 읽기)");
  const read = async <T>(label: string, path: string) => {
    try { const r = await cf<T>("GET", path); ok(`${label} 읽기 됨`); return r; }
    catch (e) { const pe = e as ProviderError; fail(`${label} 읽기 실패 HTTP ${pe.status}: ${pe.message} → 토큰 권한 확인`); }
  };
  const monitors = await read<Named[]>("모니터 (Account · Load Balancing: Monitors and Pools)", `${A}/monitors`);
  const pools = await read<Named[]>("pool (Account · Load Balancing: Monitors and Pools)", `${A}/pools`);
  const lbs = await read<Array<CfLoadBalancer & Named>>("LB (Zone · Load Balancers)", Z);
  console.log(`  지금 있는 것: 모니터 ${monitors.length}, pool ${pools.length}, LB ${lbs.length}`);
  // 터널 목록은 오리진 주소를 고르는 데 쓴다 (Account · Cloudflare Tunnel 권한). 실패해도 계속
  try {
    const tunnels = await cf<Array<{ id: string; name: string; status?: string }>>("GET", `/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
    for (const t of tunnels) console.log(`  터널 ${t.name} (${t.status ?? "?"}) → 오리진 주소 후보 ${t.id}.cfargotunnel.com`);
  } catch (e) { console.log(`  터널 목록 못 읽음 (${(e as ProviderError).status}). 오리진 주소는 직접 넣는다`); }

  const mine = {
    monitor: monitors.find((m) => m.description === `${PREFIX}-monitor`),
    src: pools.find((p) => p.name === `${PREFIX}-src`),
    tgt: pools.find((p) => p.name === `${PREFIX}-tgt`),
    lb: lbs.find((l) => l.name === LB_HOST),
  };

  if (CLEANUP_ONLY) return cleanup(A, Z, mine);

  if (!SRC_ORIGIN || !TGT_ORIGIN) {
    console.log("\n  CF_CHECK_SOURCE_ORIGIN / CF_CHECK_TARGET_ORIGIN 이 비어 있어 4단계부터는 할 일만 보여 준다");
  }

  // z75-32 ① 오리진 직접 (자원 만들기 전, 수 초). 하나라도 안 되면 원인 부류 ORIGIN 으로 exit 2
  if (APPLY && PROBES > 0 && PREFLIGHT && SRC_ORIGIN && TGT_ORIGIN) {
    const f = await preflightOrigins({ 출발: [SRC_ORIGIN, SRC_HOST], 도착: [TGT_ORIGIN, TGT_HOST] });
    if (f.length) preflightExit(f);
  }

  // 4. 모니터 → pool 2개 → LB (이 순서여야 한다: pool 은 모니터 id, LB 는 pool id 를 가리킨다)
  step("4/7", "모니터·pool·LB 준비 (이름이 같은 게 있으면 다시 만들지 않는다)");
  const monitorBody = {
    type: "https", method: "GET", path: MONITOR_PATH, expected_codes: "200", follow_redirects: false,
    // Z70-3 DRAFT(ai): 시험 오리진(served-by)은 자체 서명 인증서라 기본 allow_insecure true. 예전 false 면 모니터가 오리진을 늘 "나쁨"으로 봤다.
    //   진짜 인증서 오리진이면 CF_CHECK_MONITOR_STRICT_TLS=1. 이미 만든 모니터는 안 고친다 → 먼저 --cleanup --apply
    allow_insecure: process.env.CF_CHECK_MONITOR_STRICT_TLS !== "1",
    // 【사실】 모니터 최소 간격은 요금제별 60초(Pro)/15초(Business)/10초(Enterprise) (Load Balancing 빠른 시작 문서)
    interval: 60, timeout: 5, retries: 1, description: `${PREFIX}-monitor`,
  };
  const monitorId = mine.monitor?.id ?? await create("모니터", `${A}/monitors`, monitorBody);
  const poolBody = (name: string, address: string | undefined, host: string | undefined) => ({
    name, monitor: monitorId, enabled: true, minimum_origins: 1, description: `${PREFIX} pool`,
    origins: [{ name: `${name}-o1`, address: address ?? "(CF_CHECK_*_ORIGIN 필요)", enabled: true, weight: 1,
      ...(host ? { header: { Host: [host] } } : {}) }],
  });
  const srcId = mine.src?.id ?? await create("출발 pool", `${A}/pools`, poolBody(`${PREFIX}-src`, SRC_ORIGIN, SRC_HOST));
  const tgtId = mine.tgt?.id ?? await create("도착 pool", `${A}/pools`, poolBody(`${PREFIX}-tgt`, TGT_ORIGIN, TGT_HOST));
  const C = { sourcePoolId: srcId, targetPoolId: tgtId };
  const lbBody = {
    name: LB_HOST, description: `${PREFIX} lb`, enabled: true, proxied: true,
    default_pools: [srcId, tgtId], fallback_pool: srcId, session_affinity: "none",
    ...cloudflarePatchBody(C, { source: 1, target: 0 }),
  };
  const lbId = mine.lb?.id ?? await create("LB", Z, lbBody);
  if (mine.monitor) ok(`모니터 이미 있음 ${mask(monitorId)}`);
  if (mine.src) ok(`출발 pool 이미 있음 ${mask(srcId)}`);
  if (mine.tgt) ok(`도착 pool 이미 있음 ${mask(tgtId)}`);
  if (mine.lb) ok(`LB 이미 있음 ${mask(lbId)}`);

  if (!APPLY) {
    step("5/7", "전환 단계 (dry-run: 본문만)");
    for (const w of STEPS) plan(`PATCH LB → 출발 ${w.source * 100}% / 도착 ${w.target * 100}%`, cloudflarePatchBody(C, w));
    step("6/7", "정리 (dry-run)");
    plan("DELETE LB → pool 2개 → 모니터 (만든 순서의 반대)");
    console.log(`\n끝 (dry-run). API 호출 ${calls}번, 전부 GET. 실제로 하려면: npm run cf:check -- --apply`);
    return;
  }

  // 5. 어댑터로 전환 (워커와 똑같은 코드 경로: cloudflareLb + setAndVerify)
  step("5/7", "설계 조건 점검 + 가중치 전환 (어댑터 그대로)");
  const sw = cloudflareLb({ zoneId: zone.id, ...C, token: req.token, fetch: req.fetch, baseUrl: req.baseUrl });
  const lb = await sw.describe(lbId);
  const issues = cloudflarePreflight(C, lb);
  if (issues.length) console.log(`  주의 설계 조건 위반: ${issues.join(", ")}`); else ok("preflight 통과 (enabled, proxied, 쿠키 고정 없음, fallback=출발)");
  // z75-32 ②③ pool 건강 API + LB 이름이 Cloudflare 대역으로 풀리나. 실패면 만든 것 지우고 exit 2
  if (PROBES > 0 && PREFLIGHT) {
    const f = await preflightEdge(A, { 출발: srcId, 도착: tgtId });
    if (f.length) {
      if (!KEEP) await cleanup(A, Z, { monitor: { id: monitorId }, src: { id: srcId }, tgt: { id: tgtId }, lb: { id: lbId } });
      preflightExit(f);
    }
  }
  const timings: Array<{ step: string; patchGetMs: number[]; settleMs?: number; settled?: boolean }> = [];
  // 엣지가 아직 보고 있을 수 있는 "옛 몫" 후보. 처음엔 LB 를 만들 때의 0 (100/0) 과, 만든 직후 엣지에 안 퍼졌을 때 맥에서 본 반반 (int5-6 1회차 90/10 → 40%)
  let prevShares: number[] = [0, 0.5];
  for (const w of STEPS) {
    const label = `${w.source * 100}/${w.target * 100}`;
    const t: number[] = [];
    for (let i = 0; i < REPEAT; i++) {
      // 같은 값으로 반복 PATCH 해도 결과가 같은지(멱등) + 시간
      const t0 = process.hrtime.bigint();
      const r = await setAndVerify(sw, lbId, w);
      t.push(Math.round(ms(t0)));
      if (r.attempts > 1) console.log(`  주의 ${label} ${r.attempts}번째에 확인됨`);
    }
    const got = cloudflareWeightsOf(C, await sw.describe(lbId));
    ok(`${label} 확인 (GET ${got.source}/${got.target}), PATCH+GET ${t.join(", ")}ms (중앙값 ${median(t)}ms)`);
    const row: (typeof timings)[number] = { step: label, patchGetMs: t };
    timings.push(row);
    if (PROBES > 0) {
      if (!PREFLIGHT) await waitPoolsHealthy(A, { 출발: srcId, 도착: tgtId });
      if (PROBE_TARGET && SETTLE_SEC > 0) Object.assign(row, await settle(label, w.target, prevShares));
      await probe(label, w.target);
    }
    prevShares = [w.target];
    if (HOLD_SEC > 0) await new Promise((r) => setTimeout(r, HOLD_SEC * 1000));
  }

  // 6. 정리
  step("6/7", KEEP ? "정리 건너뜀 (--keep)" : "정리");
  if (!KEEP) await cleanup(A, Z, { monitor: { id: monitorId }, src: { id: srcId }, tgt: { id: tgtId }, lb: { id: lbId } });
  else {
    console.log("  남긴 자원을 워커에 쓰려면 .env 에 아래 4줄 (채팅·공유 폴더에 붙이지 말 것):");
    console.log(`  TRAFFIC_PROVIDER=cloudflare\n  TRAFFIC_LB_ID=${lbId}\n  CF_SOURCE_POOL_ID=${srcId}\n  CF_TARGET_POOL_ID=${tgtId}`);
  }

  step("7/7", "측정 요약 (decisions 에 옮길 숫자)");
  for (const x of timings) console.log(`  ${x.step.padEnd(7)} PATCH+GET 중앙값 ${median(x.patchGetMs)}ms, 범위 ${Math.min(...x.patchGetMs)}~${Math.max(...x.patchGetMs)}ms (${x.patchGetMs.length}회)${x.settleMs === undefined ? "" : `, 엣지 반영 ${x.settled ? "" : "안 됨 "}${(x.settleMs / 1000).toFixed(1)}초`}`);
  console.log(`  API 호출 ${calls}번 (한도 5분 1,200번)`);
  // Z70-2: 분배 판정이 하나라도 틀리면 종료 코드 1 (연속 2회 같은 결과를 셸에서 바로 비교할 수 있게)
  if (probeFails.length) { console.error(`  분배 실패: ${probeFails.join(", ")}`); process.exitCode = 1; }
  else if (PROBES > 0 && PROBE_TARGET) ok(`분배 ${timings.length}단계 모두 기대 허용 폭 안 (±10%p 또는 표본 오차 2.58σ 중 큰 것)`);
}

async function create(label: string, path: string, body: unknown): Promise<string> {
  plan(`POST ${label}`, body);
  if (!APPLY) return `(새 ${label})`;
  if ((!SRC_ORIGIN || !TGT_ORIGIN) && path.endsWith("/pools")) fail("CF_CHECK_SOURCE_ORIGIN / CF_CHECK_TARGET_ORIGIN 이 있어야 pool 을 만든다");
  const r = await cf<{ id: string }>("POST", path, body);
  ok(`${label} 만듦 ${mask(r.id)}`);
  return r.id;
}

// 지우는 순서: LB → pool → 모니터 (쓰는 쪽부터. 반대로 하면 "사용 중" 오류)
// 이름이 cf-check 로 시작하는 것만 지운다 (main 에서 이름으로 찾은 것 또는 이번에 만든 것)
async function cleanup(A: string, Z: string, m: { monitor?: { id: string }; src?: { id: string }; tgt?: { id: string }; lb?: { id: string } }) {
  const items: Array<[string, string | undefined]> = [
    ["LB", m.lb && `${Z}/${m.lb.id}`], ["출발 pool", m.src && `${A}/pools/${m.src.id}`],
    ["도착 pool", m.tgt && `${A}/pools/${m.tgt.id}`], ["모니터", m.monitor && `${A}/monitors/${m.monitor.id}`],
  ];
  for (const [label, path] of items) {
    if (!path) { console.log(`  없음 ${label} (지울 것 없음)`); continue; }
    plan(`DELETE ${label}`);
    if (!APPLY) continue;
    try { await cf("DELETE", path); ok(`${label} 지움`); }
    catch (e) {
      const pe = e as ProviderError;
      if (pe.status === 404) ok(`${label} 이미 없음 (다시 돌려도 안전)`);
      else console.error(`  실패 ${label} 지우기 HTTP ${pe.status}: ${pe.message} → 대시보드에서 직접 지운다 (docs/CLOUDFLARE-CHECK.md 6장)`);
    }
  }
}

// LB 주소로 요청을 보내 실제로 어느 오리진이 받았는지 센다 (오리진이 PROBE_HEADER 로 자기 이름을 돌려줘야 한다)
// Z70-2: 시스템 리졸버(getaddrinfo)를 안 탄다. 첫 probe 때 공개 DNS 에 직접 물어 주소를 받아 두고, 그 주소로만 붙는다 (cf-probe.ts)
let probeLookup: ReturnType<typeof pinnedLookup> | null = null;
let probeAddrs: string[] = [];
// Z70-3: 리허설용 (가짜 엣지). 주면 DNS 를 안 묻고 이 주소·포트·방식으로 붙는다. 실제 실행에선 비워 둔다
const PROBE_ADDR = process.env.CF_CHECK_PROBE_ADDR || "";
const PROBE_PORT = process.env.CF_CHECK_PROBE_PORT ? Number(process.env.CF_CHECK_PROBE_PORT) : undefined;
const PROBE_TLS = process.env.CF_CHECK_PROBE_SCHEME !== "http";
async function ensureProbeAddr(): Promise<boolean> {
  if (probeLookup) return true;
  if (PROBE_ADDR) { probeLookup = pinnedLookup([PROBE_ADDR]); ok(`${LB_HOST} → ${PROBE_ADDR} (CF_CHECK_PROBE_ADDR, 리허설)`); return true; }
  // Z38 R7-5: CF_CHECK_DNS_SERVERS 를 안 줬으면 구역 권한 서버에 직접 묻는다 (공개 리졸버의 "없음" 캐시도 안 탄다). 못 찾으면 공개 DNS
  const pub = dnsServersFromEnv();
  const auth = process.env.CF_CHECK_DNS_SERVERS ? [] : await authServers(ZONE_NAME ?? zoneOf(LB_HOST), pub);
  const servers = auth.length ? auth : pub;
  const w = await waitResolvable(LB_HOST, { resolve4: process.env.CF_CHECK_DNS_FALLBACK === "system" ? withSystemFallback(directResolve4(servers)) : directResolve4(servers), timeoutMs: DNS_WAIT_SEC * 1000 });
  if (!w.addrs.length) {
    console.error(`  실패 ${LB_HOST} 가 ${DNS_WAIT_SEC}초 안에 안 풀림 (DNS ${servers.join(",")}, ${w.tries}번, 마지막 ${w.lastError}) → probe 건너뜀`);
    return false;
  }
  ok(`${LB_HOST} → ${w.addrs.join(", ")} (DNS ${servers[0]} 직접${auth.length ? "·권한 서버" : ""}, 시스템 캐시 안 씀, ${w.waitedMs}ms, ${w.tries}번째)`);
  probeLookup = pinnedLookup(w.addrs);
  probeAddrs = w.addrs;
  return true;
}

// Z70-3: 첫 probe 전에 한 번, 두 pool 이 모니터 기준 건강한지 기다린다 (읽기만). 나쁘면 이유(예: TCP connection failed)를 찍는다
let healthChecked = false;
async function waitPoolsHealthy(A: string, pools: Record<string, string>): Promise<Record<string, ReturnType<typeof poolHealthOf>>> {
  if (healthChecked || HEALTH_WAIT_SEC <= 0) return {};
  healthChecked = true;
  const t0 = performance.now();
  const last: Record<string, ReturnType<typeof poolHealthOf>> = {};
  for (;;) {
    for (const [name, id] of Object.entries(pools)) {
      try { last[name] = poolHealthOf(await cf<unknown>("GET", `${A}/pools/${id}/health`)); }
      catch (e) { last[name] = { state: "unknown", pops: [], reason: `health 읽기 실패 HTTP ${(e as ProviderError).status ?? "?"}` }; }
    }
    const states = Object.values(last).map((x) => x.state);
    if (states.every((x) => x === "healthy")) break;
    // 모양을 모르는(unknown) 응답만 남았으면 20초 뒤 그냥 간다 (모르는 것 때문에 probe 를 막지 않는다)
    if (!states.includes("unhealthy") && performance.now() - t0 > 20_000) break;
    if (performance.now() - t0 > HEALTH_WAIT_SEC * 1000) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  const secs = Math.round((performance.now() - t0) / 1000);
  for (const [name, h] of Object.entries(last)) {
    const line = `${name} pool ${h.state} (PoP ${h.pops.join(",") || "?"}, ${secs}초)${h.reason ? ` — ${h.reason}` : ""}`;
    if (h.state === "unhealthy") console.error(`  주의 ${line} → 이 오리진으로는 522·fallback 이 난다 (오리진 포트·인증서·방화벽 확인)`); else ok(line);
  }
  return last;
}

// ---- z75-32: probe 전 선행 점검 (CF_CHECK_PREFLIGHT=0 이면 끔) ----
// 실패하면 "원인 부류 + 오리진" 을 찍고 종료 코드 2 (분배 판정 실패 1 과 구분). 50번 probe 를 다 기다리지 않는다
const PREFLIGHT = process.env.CF_CHECK_PREFLIGHT !== "0";
const ORIGIN_TLS = process.env.CF_CHECK_ORIGIN_SCHEME !== "http";   // 구역 Full 이면 Cloudflare 가 쓰는 길(443)과 같게. 리허설만 http
const CLASS_HINT: Record<string, string> = {
  ORIGIN: "오리진 자체 (served-by 내려감·443 안 열림·방화벽) → apply-served-by.sh up / curl -k https://<오리진>/healthz",
  POOL: "Cloudflare 가 오리진을 나쁘게 봄 (모니터 포트·TLS·경로) → 모니터 설정, --cleanup --apply 뒤 다시",
  DNS: "LB 이름이 Cloudflare 로 안 풀림 (proxied 아님·다른 레코드·전파 전) → 대시보드 DNS 확인",
};
async function preflightOrigins(origins: Record<string, [string, string | undefined]>): Promise<PreflightFail[]> {
  const rs = await Promise.all(Object.entries(origins).map(async ([who, [addr, host]]) =>
    ({ who: `${who} ${addr}`, r: await originCheck(addr, MONITOR_PATH, PROBE_HEADER, { tls: ORIGIN_TLS, hostHeader: host }) })));
  for (const x of rs) if (x.r.ok) ok(`선행 ① 오리진 직접 ${x.who} ${x.r.detail} (${x.r.ms}ms)`);
  return rs.filter((x) => !x.r.ok).map((x) => ({ cls: "ORIGIN" as const, who: x.who, detail: `${x.r.detail} (${x.r.ms}ms)` }));
}
async function preflightEdge(A: string, pools: Record<string, string>): Promise<PreflightFail[]> {
  const out: PreflightFail[] = [];
  const h = await waitPoolsHealthy(A, pools);
  for (const [who, x] of Object.entries(h)) if (x.state === "unhealthy") out.push({ cls: "POOL", who: `${who} pool`, detail: x.reason ?? "unhealthy" });
  if (!PROBE_ADDR) {
    if (!(await ensureProbeAddr())) out.push({ cls: "DNS", who: LB_HOST, detail: "이름이 안 풀림" });
    else {
      const bad = probeAddrs.filter((a) => !inCloudflareV4(a));
      if (bad.length) out.push({ cls: "DNS", who: LB_HOST, detail: `Cloudflare 대역 밖 주소 ${bad.join(",")}` });
      else ok(`선행 ③ ${LB_HOST} → ${probeAddrs.join(",")} Cloudflare 대역 안`);
    }
  }
  return out;
}
function preflightExit(f: PreflightFail[]): never {
  for (const x of f) console.error(`  선행 점검 실패 [${x.cls}] ${x.who}: ${x.detail}\n       → ${CLASS_HINT[x.cls]}`);
  console.error(`  probe 안 함. 종료 코드 2 (원인 부류: ${[...new Set(f.map((x) => x.cls))].join(",")})`);
  process.exit(2);
}

// LB 주소로 n 번 보내 x-served-by(없으면 HTTP 코드, 실패면 오류 코드)별로 센다. 처음 PROBE_EARLY_STOP 번이 전부 오류면 멈춘다
async function sample(label: string, n: number): Promise<{ count: Map<string, number>; sent: number }> {
  const count = new Map<string, number>();
  let sent = 0;
  for (let i = 0; i < n; i++) {
    // Z70-3: 처음 PROBE_EARLY_STOP 번이 전부 오류면 이 단계는 그만 (원인은 오류 열쇠에 남는다)
    if (i === PROBE_EARLY_STOP && [...count.keys()].every(isErrorKey)) {
      console.error(`  주의 ${label} 처음 ${PROBE_EARLY_STOP}번이 전부 오류 → 이 단계 probe 중단`);
      break;
    }
    sent++;
    try {
      const r = await probeOnce(LB_HOST, MONITOR_PATH, PROBE_HEADER, { lookup: probeLookup!, port: PROBE_PORT, tls: PROBE_TLS });
      const k = r.header ?? `HTTP ${r.status}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    } catch (e) {
      const k = `오류 ${(e as NodeJS.ErrnoException).code ?? "?"}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return { count, sent };
}

// 잰 몫이 옛 몫 후보 어느 것보다 새 기대 몫에 더 가까운가 (옛 몫과 새 몫이 같으면 그 후보는 안 본다)
export function settledShare(got: number, want: number, prev: number[]): boolean {
  return prev.filter((p) => Math.abs(p - want) > 1e-9).every((p) => Math.abs(got - want) < Math.abs(got - p));
}

// z75-38: 예비 probe 를 되풀이해 도착 몫이 기대 폭 안에 들 때까지 (최대 SETTLE_SEC). 판정 실패로 치지 않고, 걸린 시간만 남긴다
async function settle(label: string, expectedTarget: number, prevShares: number[]): Promise<{ settleMs: number; settled: boolean }> {
  if (!(await ensureProbeAddr())) return { settleMs: 0, settled: false };
  const t0 = performance.now();
  let streak = 0;
  for (let round = 1; ; round++) {
    const { count, sent } = await sample(label, SETTLE_PROBE);
    const v = judgeShare(count, PROBE_TARGET, expectedTarget);
    const el = performance.now() - t0;
    streak = v.ok && settledShare(v.gotPct / 100, expectedTarget, prevShares) ? streak + 1 : 0;
    if (streak >= SETTLE_CONFIRM) {
      ok(`${label} 엣지 반영 확인 ${(el / 1000).toFixed(1)}초 (예비 ${round}회 × ${SETTLE_PROBE}번, 마지막 도착 ${v.gotPct}%)`);
      return { settleMs: el, settled: true };
    }
    // 전부 오류면 기다려도 소용없다 → 본 probe 가 오류를 그대로 보고하게 넘긴다
    if (sent && v.errors === v.total) { console.error(`  주의 ${label} 예비 probe 전부 오류 → 반영 기다리기 그만`); return { settleMs: el, settled: false }; }
    if (el >= SETTLE_SEC * 1000) {
      console.error(`  주의 ${label} ${SETTLE_SEC}초 안에 엣지 반영 안 보임 (마지막 예비 도착 ${v.gotPct}% / 기대 ${v.wantPct}%) → 그대로 본 probe`);
      return { settleMs: el, settled: false };
    }
    console.log(`  기다림 ${label} 예비 ${round}회 도착 ${v.gotPct}% / 기대 ${v.wantPct}% ±${v.tolPct}%p (${(el / 1000).toFixed(1)}초)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function probe(label: string, expectedTarget: number) {
  if (!(await ensureProbeAddr())) { probeFails.push(`${label} DNS`); return; }
  const t0 = performance.now();
  const { count, sent } = await sample(label, PROBES);
  // Z70: 개수와 비율을 같이 (오리진 이름 = x-served-by, 예: aws-app-demo=46(92%))
  console.log(`  실측 ${label}: ${[...count].sort().map(([k, v]) => `${k}=${v}(${Math.round((v / sent) * 100)}%)`).join(", ")} (요청 ${sent}번)`);
  if (PROBE_TARGET) {
    const v = judgeShare(count, PROBE_TARGET, expectedTarget);
    const line = `${label} 도착(${PROBE_TARGET}) ${v.gotPct}% / 기대 ${v.wantPct}% ±${v.tolPct}%p, 오류 ${v.errors}/${v.total}, ${Math.round(performance.now() - t0)}ms${v.reason ? ` — ${v.reason}` : ""}`;
    if (v.ok) ok(line); else { console.error(`  실패 ${line}`); probeFails.push(label); }
  }
}

main().catch((e) => {
  const pe = e as ProviderError;
  console.error(`\n중단: ${pe.message}`);
  if (pe.status === 429) console.error("속도 제한에 걸렸다. 5분 기다린 뒤 다시 돌린다 (이름으로 찾아 이어서 하므로 처음부터 다시 만들지 않는다)");
  console.error("만든 자원이 남았을 수 있다 → npm run cf:check -- --cleanup --apply");
  process.exit(1);
});

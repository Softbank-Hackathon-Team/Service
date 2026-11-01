// 클라우드 DB 한 쌍 실측 (작업 Z35 = Z15 제안 4, DRAFT(ai)). 예: AWS RDS(출발) → GCP Cloud SQL(도착)
// measure.ts 와 같은 측정(초기 복사, 쓰기 부하 중 전환·롤백 쓰기 멈춤)을 "이미 있는" 관리형 DB 두 대에 돈다.
// 이 도구는 클라우드 자원을 만들지 않는다. DB 생성·파라미터 그룹·방화벽은 승인 뒤 맥 세션에서 Terraform 으로.
//
// 순서 (한 줄씩)
//   npx tsx scripts/measure-cloud.ts check      접속·왕복 시간·사전 점검만 (쓰기 없음)
//   npx tsx scripts/measure-cloud.ts prepare    두 DB 에 측정 스키마(svc_measure)·앱 계정 만들기, 출발에 행 넣기
//   npx tsx scripts/measure-cloud.ts run        점검 통과 시 복제 → 전환·롤백 MC_REPS 회 → 결과 JSON·표
//   npx tsx scripts/measure-cloud.ts clean      복제 객체·측정 스키마 지우기 (앱 계정은 남김)
// 환경변수 (비밀은 .env 에만)
//   MC_SOURCE_URL / MC_TARGET_URL        관리자 접속 문자열 (?sslmode=require)
//   MC_SOURCE_PEER_URL                   도착이 출발에 붙을 주소 (없으면 MC_SOURCE_URL)
//   MC_SOURCE_PROVIDER(rds) MC_TARGET_PROVIDER(cloudsql)  점검 안내 문구용
//   MC_APP_PASSWORD                      측정 전용 앱 계정(svc_measure_app) 비밀번호
//   MC_ROWS(10000) MC_REPS(5) MC_WORKERS(4) MC_SCHEMA(svc_measure) MC_DEDICATED_DB MC_OUT(결과 JSON 경로)
import { writeFileSync } from "node:fs";
import pg from "pg";
import { Migration, precheck } from "../src/index.js";
import {
  AppRouter, MC_TABLES, appUrl, configFromEnv, dbName, redact, renderMarkdown, rtt, schemaSql, startLoad, stat, staticChecks,
  type McConfig, type McResult,
} from "./measure-cloud-lib.js";

const { cfg, errors } = configFromEnv(process.argv.slice(2), process.env);
if (!cfg) { for (const e of errors) console.error(`설정 오류: ${e}`); process.exit(2); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exec = async (url: string, sql: string) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { await c.query(sql); } finally { await c.end().catch(() => {}); } };
const migration = (c: McConfig) => new Migration({ key: "measure_cloud", source: c.source, target: c.target, tables: MC_TABLES,
  gate: { maxLagMs: Number(process.env.MC_MAX_LAG_MS ?? 1000), consecutive: 3 } });

async function check(c: McConfig): Promise<boolean> {
  console.log(`출발 ${c.source.label} ${redact(c.source.adminUrl)}  →  도착 ${c.target.label} ${redact(c.target.adminUrl)}`);
  const names = { source: await dbName(c.source.adminUrl), target: await dbName(c.target.adminUrl) };
  const [rs, rt] = [stat(await rtt(c.source.adminUrl)), stat(await rtt(c.target.adminUrl))];
  console.log(`왕복 ms  출발 ${rs?.median} · 도착 ${rt?.median}`);
  const mc = staticChecks(c, names);
  const pre = await precheck(c.source, c.target, { tables: MC_TABLES });
  const rows = [...mc, ...pre.checks];
  for (const x of rows) console.log(`${x.ok ? "OK  " : "FAIL"} ${x.id.padEnd(7)} ${x.side.padEnd(6)} ${x.detail}${x.ok || !x.hint ? "" : `  → ${x.hint}`}`);
  const ok = rows.every((x) => x.ok);
  if (!ok && pre.checks.some((x) => x.id === "DB-T1" && !x.ok)) console.log("표가 없다면 먼저: measure-cloud.ts prepare");
  console.log(ok ? "점검 통과" : "점검 실패 (위 FAIL 줄)");
  return ok;
}

async function prepare(c: McConfig) {
  for (const side of ["source", "target"] as const) {
    const name = await dbName(c[side].adminUrl);
    const mc = staticChecks(c, { source: name, target: name }).find((x) => x.id === "MC-DB" && x.side === side)!;
    if (!mc.ok) throw new Error(`${side} DB ${name} 는 측정 전용으로 확인 안 됨. ${mc.hint}`);
  }
  // 남은 복제가 있으면 스키마를 지우기 전에 먼저 걷는다
  await migration(c).teardown().catch(() => {});
  await exec(c.source.adminUrl, schemaSql(c.schema, c.source.appRole, c.appPassword!, c.rows));
  await exec(c.target.adminUrl, schemaSql(c.schema, c.target.appRole, c.appPassword!, null));
  console.log(`준비 끝: 스키마 ${c.schema}, 출발에 주문 ${c.rows}행. 다음: measure-cloud.ts check → run`);
}

async function run(c: McConfig) {
  if (!(await check(c))) throw new Error("점검 실패라 run 안 함");
  const m = migration(c);
  await m.teardown().catch(() => {});
  const router = new AppRouter(c.source, (e) => appUrl(e, c.appPassword!));
  const load = startLoad(router, c.schema, c.workers);
  const rttS = await rtt(c.source.adminUrl), rttT = await rtt(c.target.adminUrl);
  const s = await m.sync({ waitCopyMs: Number(process.env.MC_COPY_TIMEOUT_MS ?? 600_000) });
  console.log(`복제 게이트 ready=${s.gate.ready} lags=${s.gate.lastLags.join(",")}ms`);
  if (!s.gate.ready) { await load.stop(); throw new Error("복제 지연이 게이트를 못 넘음 (MC_MAX_LAG_MS 확인)"); }
  const cut: number[] = [], back: number[] = [];
  try {
    for (let i = 0; i < c.reps; i++) {
      const a = await m.cutover({ hooks: router }); if (!a.ok) throw new Error(`cutover ${i + 1}: ${JSON.stringify(a)}`);
      cut.push(a.pauseMs); console.log(`cutover ${i + 1}/${c.reps}: ${a.pauseMs.toFixed(0)} ms`); await sleep(1000);
      const b = await m.rollback({ hooks: router }); if (!b.result?.ok) throw new Error(`rollback ${i + 1}: ${JSON.stringify(b)}`);
      back.push(b.result.pauseMs); console.log(`rollback ${i + 1}/${c.reps}: ${b.result.pauseMs.toFixed(0)} ms`); await sleep(1000);
    }
  } finally { await load.stop(); }
  await m.teardown();
  const st = stat(load.lat);
  const copyMs = s.measures.find((x) => x.name === "initial_copy_ms")?.value ?? null;
  const r: McResult = {
    at: new Date().toISOString(), mode: "run",
    source: { label: c.source.label, provider: c.source.provider, host: redact(c.source.adminUrl) },
    target: { label: c.target.label, provider: c.target.provider, host: redact(c.target.adminUrl) },
    rows: c.rows, reps: c.reps, workers: c.workers,
    rttMs: { source: stat(rttS), target: stat(rttT) },
    initialCopyMs: copyMs, gateLagsMs: s.gate.lastLags,
    cutoverPauseMs: cut.map((x) => Math.round(x * 10) / 10), rollbackPauseMs: back.map((x) => Math.round(x * 10) / 10),
    appWrites: { ok: load.ok, fail: load.fail, p50Ms: st?.median ?? null,
      p99Ms: load.lat.length ? Math.round([...load.lat].sort((x, y) => x - y)[Math.floor(0.99 * (load.lat.length - 1))]! * 10) / 10 : null,
      maxMs: st?.max ?? null, errors: load.errors },
    leftovers: await m.leftovers(),
  };
  const out = c.out ?? `measure-cloud-${r.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(r, null, 2));
  console.log("\n" + renderMarkdown(r));
  console.log(`\n결과 JSON: ${out}`);
}

async function clean(c: McConfig) {
  const m = migration(c);
  const t = await m.teardown().catch((e) => ({ removed: [`(teardown 실패: ${(e as Error).message.split("\n")[0]})`] }));
  for (const e of [c.source, c.target]) {
    const name = await dbName(e.adminUrl);
    await exec(e.adminUrl, `ALTER DATABASE ${pg.escapeIdentifier(name)} RESET default_transaction_read_only;
                            DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(c.schema)} CASCADE`);
  }
  console.log(`지움: 복제 ${t.removed.join(", ") || "없음"}, 스키마 ${c.schema} (양쪽). 남은 것: ${JSON.stringify(await m.leftovers())}`);
}

try {
  if (cfg.mode === "check") process.exitCode = (await check(cfg)) ? 0 : 1;
  else if (cfg.mode === "prepare") await prepare(cfg);
  else if (cfg.mode === "run") await run(cfg);
  else await clean(cfg);
} catch (e) {
  console.error(`실패: ${(e as Error).message.split("\n")[0]}`);
  process.exitCode = 1;
}

// 작업 Z35 (Z15 제안 4): 클라우드 DB 쌍 실측 도구의 순수 부분 (DB 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { appUrl, configFromEnv, redact, renderMarkdown, schemaSql, stat, staticChecks, type McResult } from "../scripts/measure-cloud-lib.js";

const ENV = {
  MC_SOURCE_URL: "postgres://admin:s3cret@db-src.abc.ap-northeast-2.rds.amazonaws.com:5432/shop_measure?sslmode=require",
  MC_TARGET_URL: "postgres://postgres:s3cret2@34.64.1.2:5432/shop_measure?sslmode=require",
  MC_APP_PASSWORD: "apppw",
};

test("설정: 기본 제공자 rds → cloudsql, 기본 스키마 svc_measure, 모드 기본 check", () => {
  const { cfg, errors } = configFromEnv([], ENV);
  assert.deepEqual(errors, []);
  assert.equal(cfg!.mode, "check");
  assert.equal(cfg!.source.provider, "rds"); assert.equal(cfg!.target.provider, "cloudsql");
  assert.equal(cfg!.source.schema, "svc_measure"); assert.equal(cfg!.source.appRole, "svc_measure_app");
  assert.equal(cfg!.reps, 5);
});

test("설정 오류: URL 없음·모르는 모드·public 스키마·run 인데 앱 비밀번호 없음·범위 밖 숫자", () => {
  const e1 = configFromEnv(["boom"], {}).errors.join("\n");
  assert.match(e1, /모르는 모드/); assert.match(e1, /MC_SOURCE_URL/); assert.match(e1, /MC_TARGET_URL/);
  const e2 = configFromEnv(["run"], { ...ENV, MC_APP_PASSWORD: undefined, MC_SCHEMA: "public", MC_REPS: "0" }).errors.join("\n");
  assert.match(e2, /MC_APP_PASSWORD/); assert.match(e2, /public/); assert.match(e2, /MC_REPS/);
  // 오류 문장에 비밀번호가 안 들어간다
  assert.doesNotMatch(e2, /s3cret/);
});

test("redact: 계정·비밀번호·쿼리를 지운다 / appUrl: 앱 계정으로 바꾼다", () => {
  assert.equal(redact(ENV.MC_SOURCE_URL), "db-src.abc.ap-northeast-2.rds.amazonaws.com:5432/shop_measure");
  const { cfg } = configFromEnv([], ENV);
  const u = new URL(appUrl(cfg!.source, "apppw"));
  assert.equal(u.username, "svc_measure_app"); assert.equal(u.password, "apppw"); assert.equal(u.searchParams.get("sslmode"), "require");
});

test("관리형 점검: sslmode 없음·전용 DB 아님·도착이 출발 localhost 에 붙으려 함 → 실패", () => {
  const { cfg } = configFromEnv([], { ...ENV, MC_SOURCE_URL: "postgres://a:b@localhost:5432/shop" });
  const c = staticChecks(cfg!, { source: "shop", target: "shop_measure" });
  const by = (id: string, side: string) => c.find((x) => x.id === id && x.side === side)!;
  assert.equal(by("MC-SSL", "source").ok, false);
  assert.equal(by("MC-SSL", "target").ok, true);
  assert.equal(by("MC-DB", "source").ok, false);
  assert.equal(by("MC-DB", "target").ok, true);
  assert.equal(by("MC-PEER", "both").ok, false);
  // MC_DEDICATED_DB 로 확인하면 이름에 measure 가 없어도 통과
  const { cfg: cfg2 } = configFromEnv([], { ...ENV, MC_DEDICATED_DB: "shop" });
  assert.equal(staticChecks(cfg2!, { source: "shop", target: "shop" }).filter((x) => x.id === "MC-DB").every((x) => x.ok), true);
});

test("schemaSql: 식별자·비밀번호를 따옴표로 감싸고, 도착(seed null)에는 행을 안 넣는다", () => {
  const src = schemaSql("svc_measure", "svc_measure_app", "p'w", 1000);
  assert.match(src, /PASSWORD 'p''w'/); assert.match(src, /generate_series\(1, 1000\)/);
  assert.doesNotMatch(schemaSql("svc_measure", "svc_measure_app", "x", null), /INSERT INTO/);
  assert.doesNotMatch(src, /DROP SCHEMA IF EXISTS "public"/);
});

test("stat·renderMarkdown: 중앙값 표와 【실측】 표시", () => {
  assert.deepEqual(stat([5, 1, 3]), { n: 3, min: 1, median: 3, p95: 5, max: 5 });
  assert.equal(stat([]), null);
  const r: McResult = { at: "2026-11-05T00:00:00Z", mode: "run",
    source: { label: "aws-rds", provider: "rds", host: "h1" }, target: { label: "gcp-sql", provider: "cloudsql", host: "h2" },
    rows: 10000, reps: 3, workers: 4, rttMs: { source: stat([10, 11, 12]), target: stat([30, 31, 32]) }, initialCopyMs: 812.4,
    gateLagsMs: [20, 18, 19], cutoverPauseMs: [120, 140, 130], rollbackPauseMs: [150, 160, 155],
    appWrites: { ok: 900, fail: 0, p50Ms: 40, p99Ms: 300, maxMs: 410, errors: {} }, leftovers: [] };
  const md = renderMarkdown(r);
  assert.match(md, /rds → cloudsql 【실측/);
  assert.match(md, /\| 컷오버 쓰기 멈춤 \| 130 \(min 120 \/ max 140, n=3\) \|/);
  assert.match(md, /실패 0/);
});

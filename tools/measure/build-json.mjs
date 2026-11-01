// collect.sh 가 받아 둔 원본(raw-<이전번호>/)을 측정 JSON 1개로 정리한다 (작업 Z40, DRAFT(ai))
// 의존성 없음(node 22 기본만). 직접 부를 일은 거의 없다
//   node tools/measure/build-json.mjs --raw <폴더> [--label 설명] [--set=이름=값 ...]   → 표준 출력에 JSON
//   node tools/measure/build-json.mjs --summary <measure.json>                          → 사람이 읽는 요약 몇 줄
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { missing: true });

// KST 날짜 (문서 표기 【사실, 실측 2026-11-07】 에 쓴다)
const kstDate = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

if (opt("--summary")) {
  const m = read(opt("--summary"));
  const f = (v, u = "") => (v == null ? "없음" : `${v}${u}`);
  const lines = [
    `이전 ${m.migration.id.slice(0, 8)} ${m.migration.source.provider}→${m.migration.target.provider} 상태=${m.migration.status}`,
    `STUB 단계: ${m.stub.any ? m.stub.steps.join(", ") || "있음(gaps)" : "없음"} (판단 근거 ${m.stub.basis})`,
    `전체 ${f(m.summary.totalMs, "ms")}, 컷오버 멈춤 ${f(m.cutoverPauseMs, "ms")}, 롤백 멈춤 ${f(m.rollbackPauseMs, "ms")}, 복제 지연 최대 ${f(m.replicationLagMs, "ms")}`,
    `비용 AWS ${f(m.cost?.envs?.aws?.monthlyUsd)} / GCP ${f(m.cost?.envs?.gcp?.monthlyUsd)} / 절약 ${f(m.cost?.savings?.monthlyUsd)} (GCP 단가 ${m.cost?.priceOrigin?.gcp ?? "?"})`,
    `보안 표: ${m.security.available ? `ok ${m.security.ok} · warn ${m.security.warn} · fail ${m.security.fail} · 미구현 ${m.security.notImplemented}` : "API 없음(Z18 통합 전)"}`,
  ];
  console.error(lines.join("\n"));
  process.exit(0);
}

const raw = opt("--raw");
if (!raw) { console.error("--raw <폴더> 가 필요"); process.exit(2); }
const report = read(join(raw, "report.json"));
const mcost = read(join(raw, "migration-cost.json"));
const est = read(join(raw, "cost-estimate.json"));
const sec = read(join(raw, "security.json"));
const audit = read(join(raw, "audit-stub.json"));
if (report.missing) { console.error("report.json 없음"); process.exit(1); }

// 1. STUB 판단: 감사 detail.stub 이 1순위, 없으면 리포트 gaps 문구
let stub;
if (Array.isArray(audit)) {
  const steps = audit.filter((a) => a.stub).map((a) => a.action);
  stub = { any: steps.length > 0, steps, basis: "audit_events.detail.stub" };
} else {
  const any = (report.gaps ?? []).some((g) => g.includes("STUB"));
  stub = { any, steps: [], basis: `report.gaps (감사 못 읽음: ${audit?.why ?? "이유 모름"})` };
}
const stubAt = (prefix) => stub.steps.some((s) => s.startsWith(prefix));

// 2. 측정값. 같은 이름이 여러 개면 env 로 가른다
//    cutover_pause_ms env=target → 정방향 컷오버, env=source → 컷오버 뒤 롤백(역방향 전환)
const ms = report.measurements ?? [];
const one = (name, env) => {
  const xs = ms.filter((x) => x.name === name && (env ? x.env === env : true));
  return xs.length ? xs.at(-1).value : null;
};
const lags = ms.filter((x) => x.name === "replication_lag_ms").map((x) => x.value);

// 3. 비용 (데모 요청 = 무대 숫자 출처)
let cost = null;
if (!est.missing) {
  const envs = Object.fromEntries((est.envs ?? []).map((e) => [e.provider, {
    monthlyUsd: e.monthlyUsd, monthlyUsdNoCredit: e.monthlyUsdNoCredit, creditUsd: e.creditUsd,
    nodeSku: e.nodeSku, nodes: e.nodes, unverified: e.unverified ?? [],
  }]));
  const origins = Object.fromEntries((mcost.priceSources ?? []).map((p) => [p.vendor, p.origin]));
  const fromP = est.savings?.from, toP = est.savings?.to;
  const noCreditSavings = fromP && toP && envs[fromP] && envs[toP]
    ? Math.round((envs[fromP].monthlyUsdNoCredit - envs[toP].monthlyUsdNoCredit) * 10) / 10 : null;
  const onpremBp = (est.breakpoints ?? []).find((b) => b.cheapest === "onprem");
  cost = {
    request: "docs/demo/cost-request.json (10 rps)",
    priceAsOf: est.priceAsOf, priceStale: est.priceStale,
    priceOrigin: origins,                     // aws: live|cache|sample, gcp: seed|live ...
    envs, cheapest: est.cheapest,
    savings: est.savings ? { ...est.savings, noCreditUsd: noCreditSavings } : null,
    onpremFromRps: onpremBp?.fromRps ?? null,
    breakpoints: est.breakpoints ?? [],
  };
}

// 4. 보안 표 (Z18). 통합 전이면 available=false
const security = sec.missing || !sec.summary
  ? { available: false }
  : { available: true, ...sec.summary, rows: (sec.rows ?? []).length,
      ledgerRows: Array.isArray(sec.ledger) ? sec.ledger.length : null,
      auditChainOk: sec.auditChain?.ok ?? null };

// 5. 손으로 넣은 값 (--set=이름=값). 화면 새로고침 체감, 부하 도구의 쓰기 건수 등 API로 못 읽는 것
const manual = {};
for (const a of argv.filter((x) => x.startsWith("--set="))) {
  const [k, ...v] = a.slice(6).split("=");
  const s = v.join("=");
  manual[k] = s !== "" && !Number.isNaN(Number(s)) ? Number(s) : s;
}

const now = new Date();
const out = {
  measureVersion: 1,
  collectedAt: now.toISOString(),
  dateKst: kstDate(new Date(report.summary?.endedAt ?? now)),
  label: opt("--label") || `${report.migration.source.provider} → ${report.migration.target.provider}`,
  api: opt("--api") ?? null,
  migration: {
    id: report.migration.id, status: report.migration.status,
    source: { provider: report.migration.source.provider, name: report.migration.source.name },
    target: { provider: report.migration.target.provider, name: report.migration.target.name },
  },
  stub,
  // 값별 STUB 여부: apply-numbers 가 이게 true 인 값은 【사실】로 바꾸지 않는다 (--allow-stub 이면 바꿈)
  stubByValue: {
    cutoverPauseMs: stubAt("cutover."),
    rollbackPauseMs: stubAt("rollback."),
    replicationLagMs: stubAt("sync."),
    totalMs: stub.any,
  },
  summary: {
    startedAt: report.summary?.startedAt ?? null, endedAt: report.summary?.endedAt ?? null,
    totalMs: report.summary?.totalMs ?? null, transitions: report.summary?.transitions ?? 0,
    reachedCutover: report.summary?.reachedCutover ?? false, rolledBack: report.summary?.rolledBack ?? false,
    deniedOrError: report.summary?.deniedOrError ?? 0,
  },
  // 단계별 소요: from 상태에 머문 시간
  steps: (report.timeline ?? []).filter((t) => t.durationMs != null).map((t) => ({ state: t.from, ms: t.durationMs })),
  cutoverPauseMs: one("cutover_pause_ms", "target"),
  rollbackPauseMs: one("cutover_pause_ms", "source"),
  replicationLagMs: lags.length ? Math.max(...lags) : null,
  initialCopyMs: one("initial_copy_ms"),
  measurements: ms.map(({ name, value, unit, env }) => ({ name, value, unit, env })),
  traffic: report.traffic ?? null,
  cost,
  security,
  integrity: { ok: report.integrity?.ok ?? null, checked: report.integrity?.checked ?? 0 },
  gaps: report.gaps ?? [],
  reportHash: report.reportHash,
  manual,
};
process.stdout.write(JSON.stringify(out, null, 2) + "\n");

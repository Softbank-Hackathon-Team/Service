// 측정 JSON(collect.sh 출력)을 읽어 문서 속 수치를 바꾸고 출처 표시를 【사실, 실측 날짜】로 고친다 (작업 Z40, DRAFT(ai))
// 의존성 없음(node 22 기본만). 기본은 dry-run: 무엇이 어떻게 바뀌는지 줄 단위로 보여 주기만 하고 파일은 안 건드린다
//
// 사용
//   node tools/measure/apply-numbers.mjs <measure.json ...> --docs <문서.md ...>
//   node tools/measure/apply-numbers.mjs <measure.json ...> --parallel <parallel 폴더>     Z26·Z29·Z28·Z16·Z33(없으면 Z8) 최신본
//   ... --write [--out <폴더>]      바꾼 사본을 out 폴더에 쓴다 (기본 tools/measure/out/docs/). 원본은 그대로
//   ... --in-place                  원본을 직접 고친다 (원본 옆에 .bak 하나 남김)
//   ... --headline cloud            무대 대표 숫자(컷오버 41ms·롤백 44ms·조건 "같은 호스트 Postgres 두 대")까지 실측으로 바꾼다
//   ... --allow-stub                STUB 단계에서 나온 값도 바꾼다 (도구 시험용. 표시는 【추정, STUB 시험】)
//
// 측정 JSON 여러 개를 주면(3~5회 반복) 값마다 중앙값·최소·최대·횟수를 계산해 "중앙값 Xms (a~bms, n회)"로 쓴다
//
// 왜 기본이 headline 을 안 바꾸나 (DRAFT(ai)):
//   41ms·44ms는 STUB가 아니라 "같은 호스트 Postgres 두 대, 쓰기 8개 계속" 조건의 실측이다(W 2-2). 클라우드 1건은 조건이 다르다.
//   그래서 기본은 (1) 비용 숫자 (2) "클라우드 사이는 안 쟀다【미확인】" 자리 (3) 보안 표 건수 (4) 손으로 넣은 값만 바꾸고,
//   무대 대표 숫자를 클라우드 값으로 갈아끼우는 것은 --headline cloud 로 사람이 고른다.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const listAfter = (k) => {
  const i = argv.indexOf(k); if (i < 0) return [];
  const out = []; for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]);
  return out;
};
const optAfter = (k) => listAfter(k)[0];

// ---------- 1. 입력 ----------
const optionValues = new Set(["--docs", "--parallel", "--out", "--headline"].flatMap(listAfter));
const measureFiles = argv.filter((a) => a.endsWith(".json") && !optionValues.has(a));
if (!measureFiles.length) { console.error("측정 JSON(collect.sh 출력)을 하나 이상 주세요"); process.exit(2); }
const runs = measureFiles.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, "utf8")) }));
for (const r of runs) if (r.measureVersion !== 1) { console.error(`모르는 measureVersion: ${r.file}`); process.exit(2); }
const allowStub = flag("--allow-stub");
const headline = optAfter("--headline") === "cloud";

const labels = [...new Set(runs.map((r) => r.label))];
if (labels.length > 1) console.error(`주의: 측정 조건(label)이 섞여 있음: ${labels.join(" / ")}. 같은 조건끼리만 묶는 것이 맞다`);
const label = labels[0];
const date = runs.map((r) => r.dateKst).sort().at(-1);

// 값 하나를 여러 번 잰 것 → 중앙값·범위. STUB에서 나온 값은 빼고(allowStub 이면 넣고)
function agg(key) {
  const vals = [], stubbed = [];
  for (const r of runs) {
    const v = r[key];
    if (v == null) continue;
    (r.stubByValue?.[key] ? stubbed : vals).push(v);
  }
  const use = allowStub ? [...vals, ...stubbed] : vals;
  if (!use.length) return null;
  const s = [...use].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { median: mid, min: s[0], max: s.at(-1), n: s.length, stub: vals.length === 0 };
}
const fmt = (v) => (Math.abs(v) >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
const money = (v) => (Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toFixed(1));
const comma = (n) => Number(n).toLocaleString("en-US");

const cut = agg("cutoverPauseMs");
const rb = agg("rollbackPauseMs");
const lag = agg("replicationLagMs");
const last = runs.at(-1);
const cost = last.cost;
const sec = last.security;
const manual = Object.assign({}, ...runs.map((r) => r.manual ?? {}));

const tagOf = (a) => (a?.stub ? "【추정, STUB 시험 " + date + "】" : `【사실, 실측 ${date} ${label}】`);
// "중앙값 Xms (a~bms, n회)" 또는 1회면 "Xms (1회)"
const msPhrase = (a, withMs = true) => a.n === 1
  ? `${fmt(a.median)}ms (1회)`
  : `중앙값 ${fmt(a.median)}ms (${fmt(a.min)}~${fmt(a.max)}${withMs ? "ms" : ""}, ${a.n}회)`;

// ---------- 2. 규칙 ----------
// rule = { id, when: () => bool, re: RegExp(g), to: (m...) => string, retag?: RegExp (이 줄의 이 표시를 바꾼다), tag: () => string }
// 옛 출처 표시: 【사실】 W 2-2(…), Z16 4절 / 【사실: W 2-2, Z16 4절】 / 【사실】 W 2-2
const OLD_TAG = /【사실[^】]*(W 2-2|Z16 4절|Z16 표)[^】]*】|【사실】 ?W 2-2(\([^)]*\))?(, Z16 4절)?/g;
const OLD = { cut: 41, cutMin: 39, cutMax: 46, rb: 44, rbMin: 41, rbMax: 52, writes: "4,338" };
const rules = [];
let costSentenceCheck = false;

// 2-1. 비용 (항상). 값이 바뀐 것만 치환. GCP 단가가 seed 이거나 unverified 가 남아 있으면 표시는 그대로 둔다
if (cost) {
  const aws = cost.envs.aws, gcp = cost.envs.gcp, onp = cost.envs.onprem;
  const gcpVerified = cost.priceOrigin?.gcp && !["seed", "sample"].includes(cost.priceOrigin.gcp) && !(gcp?.unverified?.length);
  const pairs = [
    ["233.3", aws?.monthlyUsd], ["146.9", gcp?.monthlyUsd], ["219.9", gcp?.monthlyUsdNoCredit],
    ["86.4", cost.savings?.monthlyUsd], ["73", cost.savings?.creditPortionUsd], ["13.4", cost.savings?.noCreditUsd],
    ["250", onp?.monthlyUsd],
  ];
  for (const [old, now] of pairs) {
    if (now == null || money(now) === old) continue;
    const esc = old.replace(".", "\\.");
    rules.push({
      id: `cost:$${old}`,
      re: new RegExp(`(\\$|월 )${esc}(?![0-9]|\\.[0-9])|${esc}(?=달러)`, "g"),
      to: (m, pre) => (pre ? pre + money(now) : money(now)),
      money: true,
    });
  }
  // 크레딧 비율 "$73(84%)" : 절약이 바뀌면 다시 계산
  const sv = cost.savings?.monthlyUsd, cr = cost.savings?.creditPortionUsd;
  if (sv && cr != null && (money(sv) !== "86.4" || money(cr) !== "73")) {
    rules.push({ id: "cost:credit-pct", re: /\$73\((\d+)%\)/g, to: () => `$${money(cr)}(${Math.round((cr / sv) * 100)}%)` });
  }
  // 비용 문장 속 "샘플·seed·미확인" 표시는 뜻이 얽혀 있어 자동으로 안 바꾼다. 가격이 다 확인됐으면 사람이 볼 줄을 따로 뽑는다
  costSentenceCheck = gcpVerified;
  if (cost.onpremFromRps != null && cost.onpremFromRps !== 190) {
    rules.push({ id: "cost:190rps", re: /190 rps/g, to: () => `${cost.onpremFromRps} rps` });
  }
  const gcpBack = cost.breakpoints.filter((b) => b.cheapest === "gcp").at(1)?.fromRps;
  if (gcpBack != null && gcpBack !== 911) rules.push({ id: "cost:911rps", re: /911( rps)/g, to: (m, s) => `${gcpBack}${s}` });
}

// 2-2. "클라우드 사이는 안 쟀다" 자리 (항상, 실측이 있을 때)
if (cut) {
  const rbTxt = rb ? `, 롤백 ${msPhrase(rb)}` : "";
  rules.push({
    id: "cloud:unmeasured",
    re: /클라우드 사이는 (아직 )?안 쟀다【미확인】/g,
    to: () => `클라우드 사이(${label})는 컷오버 ${msPhrase(cut)}${rbTxt}${tagOf(cut)}`,
  });
  rules.push({
    id: "cloud:unmeasured-qa",
    re: /【미확인】 실제 RDS → Cloud SQL\(리전 간 네트워크\)에서는 아직 안 쟀다\. 네트워크 왕복만큼 늘어난다고 본다\(【추정】\)\./g,
    to: () => `${tagOf(cut)} 실제 클라우드(${label})에서 잰 컷오버 쓰기 멈춤은 ${msPhrase(cut)}${rbTxt}${lag ? `, 복제 지연 최대 ${fmt(lag.max)}ms` : ""}.`,
  });
}

// 2-3. 무대 대표 숫자 (--headline cloud 일 때만)
if (headline && cut) {
  const t = tagOf(cut);
  const range = (a, oMin, oMax) => new RegExp(`(중앙값 )?${a}ms ?\\((${oMin})~(${oMax})(ms)?, 5회`, "g");
  const sub = (a) => (m, med, lo, hi, unit) => {
    const p = msPhrase(a, Boolean(unit));
    return p.endsWith(")") ? p.slice(0, -1) : p;   // 원문 뒤에 이어지는 ", 쓰기 8개 계속)" 를 살린다
  };
  rules.push({ id: "headline:cutover-range", factual: true, re: range(OLD.cut, OLD.cutMin, OLD.cutMax), to: sub(cut), retag: OLD_TAG, tag: () => t });
  rules.push({ id: "headline:cutover-range2", factual: true, re: /중앙값 41ms, 39~46ms/g, to: () => cut.n === 1 ? `${fmt(cut.median)}ms(1회)` : `중앙값 ${fmt(cut.median)}ms, ${fmt(cut.min)}~${fmt(cut.max)}ms`, retag: OLD_TAG, tag: () => t });
  rules.push({ id: "headline:cutover", re: /(?<![0-9.])41ms(?!\(\d)/g, to: () => `${fmt(cut.median)}ms`, retag: OLD_TAG, tag: () => t });
  if (rb) {
    const tr = tagOf(rb);
    rules.push({ id: "headline:rollback-range", factual: true, re: range(OLD.rb, OLD.rbMin, OLD.rbMax), to: sub(rb), retag: OLD_TAG, tag: () => tr });
    rules.push({ id: "headline:rollback-range2", factual: true, re: /중앙값 44ms, 41~52ms/g, to: () => rb.n === 1 ? `${fmt(rb.median)}ms(1회)` : `중앙값 ${fmt(rb.median)}ms, ${fmt(rb.min)}~${fmt(rb.max)}ms`, retag: OLD_TAG, tag: () => tr });
    rules.push({ id: "headline:rollback", re: /(?<![0-9.])44ms(?!\(\d)/g, to: () => `${fmt(rb.median)}ms`, retag: OLD_TAG, tag: () => tr });
    rules.push({ id: "headline:rollback-short", re: /44ms\(41~52\)/g, to: () => rb.n === 1 ? `${fmt(rb.median)}ms(1회)` : `${fmt(rb.median)}ms(${fmt(rb.min)}~${fmt(rb.max)})` });
  }
  rules.push({ id: "headline:cutover-short", re: /41ms\(39~46, 5회\)/g, to: () => cut.n === 1 ? `${fmt(cut.median)}ms(1회)` : `${fmt(cut.median)}ms(${fmt(cut.min)}~${fmt(cut.max)}, ${cut.n}회)` });
  rules.push({ id: "headline:condition", re: /같은 호스트 Postgres( 16)? 두 대/g, to: () => label, retag: OLD_TAG, tag: () => t });
}

// 2-4. 손으로 넣은 값 (--set). 부하 도구 쓰기 건수, 화면 새로고침 체감
if (manual.writes_total != null && headline) {   // 4,338건은 41ms와 같은 부하 시험의 숫자라 headline 과 같이 움직인다
  const tot = comma(manual.writes_total), fail = manual.writes_failed ?? 0;
  const wt = { retag: OLD_TAG, tag: () => `【사실, 실측 ${date} ${label}】` };
  rules.push({ id: "manual:writes", re: /0 \/ 4,338/g, to: () => `${fail} / ${tot}`, ...wt });
  rules.push({ id: "manual:writes2", re: /4,338건/g, to: () => `${tot}건`, ...wt });
}
if (manual.writers != null && headline) {
  rules.push({ id: "manual:writers", re: /쓰기 8개 계속/g, to: () => `쓰기 ${manual.writers}개 계속` });
}
if (manual.refresh_s != null && String(manual.refresh_s) !== "0.7") {
  rules.push({ id: "manual:refresh", re: /(새로고침[^|]{0,20}?)0\.7(초|\/)/g, to: (m, pre, u) => `${pre}${manual.refresh_s}${u}` });
}

// 2-5. 보안 표 건수 "ok 13 · warn 6 · fail 0" 꼴
// 보안 표는 도착 환경에 따라 값이 달라진다: STUB 환경에서 잰 표로 문서를 바꾸지 않는다
if (sec?.available && (!last.stub?.any || allowStub)) {
  rules.push({
    id: "security:counts",
    re: /ok \d+ · warn \d+ · fail \d+( · 미구현 \d+)?/g,
    to: (m, tail) => `ok ${sec.ok} · warn ${sec.warn} · fail ${sec.fail}${tail != null ? ` · 미구현 ${sec.notImplemented}` : ""}`,
  });
  // 한국어 꼴 "지켜짐 13 · 약점 5 · 위반 0 · 미구현 2", "위반 0, 약점 5, 미구현 2". 이름이 두 개 이상 같이 나오는 줄만(엉뚱한 "위반 23503" 방지)
  const KO = { 지켜짐: sec.ok, 약점: sec.warn, 위반: sec.fail, 미구현: sec.notImplemented };
  rules.push({
    id: "security:counts-ko",
    lineFilter: (l) => (l.match(/(지켜짐|약점|위반|미구현) \d+(?!\d)/g) ?? []).length >= 2,
    re: /(지켜짐|약점|위반|미구현) (\d+)(?!\d)/g,
    to: (m, k) => `${k} ${KO[k]}`,
    tag: () => `【사실, 실측 ${date} ${label}】`,
  });
}

// 숫자를 한국어로 읽을 때 끝 글자에 받침이 있나 (영·일·삼·육·칠·팔·십·백·만 = 받침, 이·사·오·구·천 = 없음)
function josa(text, j) {
  const t = text.replace(/[^0-9.]+$/, "");
  if (t.length !== text.length || !/[0-9]$/.test(text)) return j;    // ms·달러·rps 등 단위로 끝나면 그대로
  const d = t.replace(".", "");
  let bat;
  if (t.includes(".") || !/0$/.test(d)) bat = "013678".includes(d.at(-1));
  else { const z = d.match(/0+$/)[0].length; bat = z !== 3; }        // 십·백·만 받침, 천 없음
  const pair = { 을: ["을", "를"], 를: ["을", "를"], 은: ["은", "는"], 는: ["은", "는"], 이: ["이", "가"], 가: ["이", "가"], 과: ["과", "와"], 와: ["과", "와"], 라는: ["이라는", "라는"], 이라는: ["이라는", "라는"] }[j];
  return bat ? pair[0] : pair[1];
}

// ---------- 3. 대상 문서 ----------
function parallelDocs(dir) {
  const pick = (z, f) => join(dir, z, "docs", f);
  const list = [pick("Z26", "TALK-SCRIPT.md"), pick("Z29", "JUDGE-QA.md"), pick("Z28", "DEMO-STORYBOARD-5MIN.md"), pick("Z16", "GLOSSARY.md"),
    pick("Z37", "DESIGN-FINALS.md"), pick("Z42", "MOCK-QA-50.md")];
  const z33 = join(dir, "Z33", "docs");
  if (existsSync(z33)) {
    for (const f of readdirSync(z33)) if (f.endsWith(".md")) list.push(join(z33, f));
  }
  // Z33 이 런북을 아직 안 냈으면 Z8 판을 쓴다
  if (!list.some((p) => basename(p) === "RUNBOOK-FINALS.md")) list.push(pick("Z8", "RUNBOOK-FINALS.md"));
  // Z33 이 같은 이름 문서를 냈으면 그쪽이 최신 (Z26·Z28 등보다 뒤)
  const byName = new Map();
  for (const p of list) if (existsSync(p)) byName.set(basename(p), p);
  return [...byName.values()];
}
let docs = listAfter("--docs");
if (optAfter("--parallel")) docs = docs.concat(parallelDocs(optAfter("--parallel")));
if (!docs.length) {
  const repoDocs = resolve(HERE, "../../docs");
  docs = ["TALK-SCRIPT.md", "JUDGE-QA.md", "DEMO-STORYBOARD-5MIN.md", "DEMO-STORYBOARD.md", "GLOSSARY.md", "RUNBOOK-FINALS.md"]
    .map((f) => join(repoDocs, f)).filter(existsSync);
}
if (!docs.length) { console.error("대상 문서가 없음 (--docs 또는 --parallel)"); process.exit(2); }

// ---------- 4. 적용 ----------
const STALE = /(?<![0-9.])(41ms|44ms|39~46|41~52|4,338|\$233\.3|\$146\.9|\$86\.4|\$219\.9|\$13\.4|\$84\.1|86\.4달러)/;
let total = 0;
const report = [];
const outDir = optAfter("--out") ?? join(HERE, "out", "docs");

for (const path of docs) {
  const src = readFileSync(path, "utf8").split("\n");
  const dst = [];
  const changes = [];
  const stale = [];
  src.forEach((line, i) => {
    let next = line;
    const hit = [];
    // 바꾼 값은 잠시 자리표시로 숨긴다: 컷오버 새 값이 우연히 44ms면 롤백 규칙이 또 바꾸는 일을 막는다
    const stash = [];
    const hide = (s) => `\u0001${stash.push(s) - 1}\u0002`;
    for (const r of rules) {
      if (r.lineFilter && !r.lineFilter(next)) continue;
      r.re.lastIndex = 0;
      if (!r.re.test(next)) continue;
      r.re.lastIndex = 0;
      next = next.replace(r.re, (...a) => hide(r.to(...a)));
      hit.push(r);
    }
    // 숫자 뒤 조사 맞추기: $86.4를 → $82.1을 (끝 글자 받침)
    next = next.replace(/\u0001(\d+)\u0002(을|를|은|는|이|가|과|와|라는|이라는)?/g, (m, k, j) => stash[Number(k)] + (j ? josa(stash[Number(k)], j) : ""));
    if (hit.length) {
      // 출처 표시: 규칙이 가리킨 옛 표시를 새 표시로. 없고 산문 줄이면 끝에 붙인다(표·제목 줄은 안 붙임)
      const tagRules = hit.filter((r) => r.tag);
      let retagged = false;
      for (const r of tagRules) {
        if (r.retag) {
          r.retag.lastIndex = 0;
          if (r.retag.test(next)) { r.retag.lastIndex = 0; next = next.replace(r.retag, r.tag()); retagged = true; }
        }
      }
      const prose = !/^\s*(\||#)/.test(next);
      // 범위까지 적힌 문장(사실 진술)만 표시를 붙인다. "41ms" 한 단어만 바뀐 줄은 예시·용어 설명일 때가 많다
      const needsTag = tagRules.some((r) => r.factual);
      if (needsTag && !retagged && prose && !/【사실, 실측/.test(next)) next = `${next} ${tagRules[0].tag()}`;
    }
    if (next !== line) changes.push({ line: i + 1, before: line, after: next, rules: hit.map((r) => r.id) });
    if (costSentenceCheck && hit.some((r) => r.money) && /샘플|seed|미확인|아이오와|추정/.test(next)) {
      stale.push({ line: i + 1, text: "[가격 확인됨: 이 줄의 '샘플·미확인' 표현을 손으로 고칠 것] " + next.trim().slice(0, 100) });
    } else if (STALE.test(next)) stale.push({ line: i + 1, text: next.trim().slice(0, 140) });
    dst.push(next);
  });
  total += changes.length;
  report.push({ path, changes, stale });

  if (changes.length && (flag("--write") || flag("--in-place"))) {
    if (flag("--in-place")) {
      copyFileSync(path, `${path}.bak`);
      writeFileSync(path, dst.join("\n"));
    } else {
      const parent = basename(dirname(dirname(path)));           // 예: Z26
      const target = join(outDir, /^Z\d+$/.test(parent) ? parent : "", basename(path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, dst.join("\n"));
    }
  }
}

// ---------- 5. 출력 (dry-run 차이) ----------
const fmtAgg = (n, a) => (a ? `${n} ${fmt(a.median)}ms (n=${a.n}${a.n > 1 ? `, ${fmt(a.min)}~${fmt(a.max)}` : ""}${a.stub ? ", STUB" : ""})` : `${n} 없음`);
console.log(`측정 ${runs.length}개, 조건 "${label}", 날짜 ${date}, 모드 ${headline ? "headline cloud" : "기본"}${allowStub ? " + allow-stub" : ""}`);
console.log(`값: ${fmtAgg("컷오버", cut)} · ${fmtAgg("롤백", rb)} · ${fmtAgg("복제 지연", lag)}`);
if (cost) console.log(`비용: AWS $${cost.envs.aws?.monthlyUsd} / GCP $${cost.envs.gcp?.monthlyUsd} / 절약 $${cost.savings?.monthlyUsd} (GCP 단가 ${cost.priceOrigin?.gcp ?? "?"}, 미확인 항목 ${(cost.envs.gcp?.unverified ?? []).join(",") || "없음"})`);
const skipped = runs.filter((r) => r.stub?.any).length;
if (skipped && !allowStub) console.log(`STUB 단계가 섞인 측정 ${skipped}개: 그 단계의 값은 쓰지 않음 (--allow-stub 이면 씀)`);
console.log(`적용 규칙 ${rules.length}개: ${rules.map((r) => r.id).join(", ") || "없음"}`);
console.log("");
for (const r of report) {
  console.log(`=== ${r.path}  (바뀌는 줄 ${r.changes.length})`);
  for (const c of r.changes) {
    console.log(`@@ ${c.line}줄  [${c.rules.join(", ")}]`);
    console.log(`- ${c.before}`);
    console.log(`+ ${c.after}`);
  }
  if (r.stale.length) {
    console.log(`-- 아직 옛 수치가 남은 줄 ${r.stale.length}개 (조건이 다른 실측이거나 규칙 밖. 사람이 본다)`);
    for (const s of r.stale.slice(0, 12)) console.log(`   ${s.line}: ${s.text}`);
    if (r.stale.length > 12) console.log(`   … ${r.stale.length - 12}개 더`);
  }
}
console.log("");
console.log(`합계: 바뀌는 줄 ${total}개. ${flag("--write") ? `사본 → ${outDir}` : flag("--in-place") ? "원본 수정(.bak 남김)" : "dry-run: 파일은 안 건드림 (--write 로 사본, --in-place 로 원본)"}`);

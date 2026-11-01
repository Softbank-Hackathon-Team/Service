import type { EvidenceReport } from "./schema.js";

// 같은 리포트를 Markdown(문서·Slack 붙여넣기용)과 HTML(심사 화면용)로 그린다. 둘 다 순수 함수

const n = (v: number | null | undefined, unit = "") => (v == null ? "-" : `${v}${unit}`);
const usd = (v: number | null) => (v == null ? "-" : `$${v.toFixed(2)}`);
// 표 칸 안의 | 와 줄바꿈이 표를 깨지 않게
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function integrityLine(r: EvidenceReport): string {
  const c = r.integrity;
  if (c.ok) return `통과 (감사 ${c.checked}줄의 지문을 다시 계산해 모두 일치${c.partial ? ", 앞부분 일부만 확인" : ""})`;
  return `실패 (seq ${c.brokenAtSeq}에서 ${c.reason}, 그 앞 ${c.checked}줄은 일치)`;
}

export function renderMarkdown(r: EvidenceReport): string {
  const m = r.migration, s = r.summary;
  const L: string[] = [];
  L.push(`# 이전 증적 리포트`, "");
  L.push(`상태: 자동 생성 | 리포트 지문 \`${r.reportHash.slice(0, 16)}\` | 생성 ${r.generatedAt}`, "");
  L.push(`- 이전: \`${m.id}\``);
  L.push(`- 경로: ${m.source.provider}(${m.source.name}) → ${m.target.provider}(${m.target.name})`);
  L.push(`- 현재 상태: **${m.status}**${m.failureCode ? ` (사유 ${m.failureCode})` : ""}`);
  L.push(`- 총 소요: ${s.totalMs == null ? "-" : `${(s.totalMs / 1000).toFixed(2)}초`}, 상태 전이 ${s.transitions}번, 컷오버 도달 ${s.reachedCutover ? "예" : "아니오"}, 롤백 ${s.rolledBack ? "있음" : "없음"}`);
  L.push(`- 감사 기록 무결성: ${integrityLine(r)}`, "");

  L.push(`## 1. 측정값`, "");
  if (r.measurements.length) {
    L.push(`| 이름 | 값 | 단위 | 환경 | 시각 |`, `|---|---:|---|---|---|`);
    for (const x of r.measurements) L.push(`| ${cell(x.name)} | ${x.value} | ${x.unit} | ${cell(x.env)} | ${x.at} |`);
  } else L.push(`측정값 없음.`);
  if (r.traffic) {
    const t = r.traffic;
    L.push("", `트래픽 판정 ${t.judgements}번, 지나간 가중치 ${t.steps.join("→")}%, 나쁨 판정 ${t.bad}번, 도착 쪽 최대 오류율 ${n(t.maxTargetErrorRatePct, "%")}, 최대 p95 ${n(t.maxTargetP95Ms, "ms")}.`);
  }
  L.push("");

  L.push(`## 2. 상태 전이 시간표`, "");
  if (r.timeline.length) {
    L.push(`| seq | 시각 | 전이 | 누가 | 앞 상태 머문 ms |`, `|---:|---|---|---|---:|`);
    for (const t of r.timeline) L.push(`| ${t.seq} | ${t.at} | ${t.from} → ${t.to} | ${cell(t.actor)} | ${n(t.durationMs)} |`);
  } else L.push(`전이 기록 없음.`);
  L.push("");

  L.push(`## 3. 승인`, "");
  if (r.approvals.length) {
    L.push(`| 계획 | 결정 | 누가 | 시각 | 본 지문 = 저장 지문 |`, `|---|---|---|---|---|`);
    for (const a of r.approvals)
      L.push(`| \`${a.planId.slice(0, 8)}\` | ${a.decision} | ${cell(a.approvedBy)} | ${a.at} | ${a.hashMatches ? "일치" : "불일치"} |`);
  } else L.push(`승인 기록 없음.`);
  L.push("");

  L.push(`## 4. 사전 점검`, "");
  if (r.precheck.length) for (const p of r.precheck) L.push(`- [${p.level}] ${p.id}: ${p.message}`);
  else L.push(`점검 결과 없음.`);
  L.push("");

  L.push(`## 5. 비용 비교 (월, USD)`, "");
  if (r.cost) {
    L.push(`가격 기준 ${r.cost.priceAsOf}${r.cost.priceStale ? " (7일 넘음)" : ""}, 가장 싼 곳 ${r.cost.cheapest ?? "-"}, 절약 ${usd(r.cost.savingsMonthlyUsd)}`, "");
    L.push(`| 환경 | 가능 | 월 비용 | 근거 미확인 |`, `|---|---|---:|---|`);
    for (const e of r.cost.envs)
      L.push(`| ${e.provider} | ${e.feasible ? "예" : "아니오"} | ${usd(e.monthlyUsd)} | ${cell(e.unverified.join(", ") || "-")} |`);
  } else L.push(`비용 추정 없음.`);
  L.push("");

  L.push(`## 6. 거부·오류 기록`, "");
  if (r.incidents.length) for (const i of r.incidents) L.push(`- seq ${i.seq} ${i.at} ${i.actor} ${i.action} → ${i.result}${i.note ? ` (${i.note})` : ""}`);
  else L.push(`없음.`);
  L.push("");

  L.push(`## 7. 비어 있는 것`, "");
  if (r.gaps.length) for (const g of r.gaps) L.push(`- ${g}`);
  else L.push(`없음.`);
  L.push("");
  L.push(`## 검증 방법`, "");
  L.push(`감사 줄마다 sha256(정렬한 JSON(actor, action, target, result, detail, tenantId, prevHash))를 다시 계산해 저장된 hash와 비교하고, 다음 줄의 prevHash가 앞 줄 hash와 같은지 본다. 첫 줄의 prevHash는 "genesis"다.`);
  return L.join("\n") + "\n";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function table(head: string[], rows: (string | number)[][]): string {
  if (!rows.length) return `<p class="muted">없음</p>`;
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function renderHtml(r: EvidenceReport): string {
  const m = r.migration, s = r.summary;
  const pause = r.measurements.find((x) => x.name === "cutover_pause_ms");
  const lag = r.measurements.find((x) => x.name === "replication_lag_ms");
  const tile = (label: string, value: string, ok?: boolean) =>
    `<div class="tile${ok === false ? " bad" : ""}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>이전 증적 리포트</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--ok:#1a7f37;--bad:#cf222e;--tile:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#999;--line:#333;--ok:#3fb950;--bad:#f85149;--tile:#1f1f1f}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.muted{color:var(--muted)}code{font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:16px 0}
.tile{background:var(--tile);border-radius:8px;padding:12px}.tile .v{font-size:22px;font-weight:600}.tile .l{color:var(--muted);font-size:13px}
.tile.bad .v{color:var(--bad)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;white-space:nowrap}
</style></head><body>
<h1>이전 증적 리포트</h1>
<div class="muted">${esc(m.source.provider)}(${esc(m.source.name)}) → ${esc(m.target.provider)}(${esc(m.target.name)}) · <code>${esc(m.id)}</code> · 지문 <code>${esc(r.reportHash.slice(0, 16))}</code></div>
<div class="tiles">
${tile("현재 상태", m.status, m.status !== "failed")}
${tile("컷오버 멈춤", pause ? `${pause.value} ms` : "-")}
${tile("최대 복제 지연", lag ? `${lag.value} ms` : "-")}
${tile("총 소요", s.totalMs == null ? "-" : `${(s.totalMs / 1000).toFixed(2)} 초`)}
${tile("감사 체인", r.integrity.ok ? `일치 ${r.integrity.checked}줄` : `seq ${r.integrity.brokenAtSeq} 깨짐`, r.integrity.ok)}
</div>
<p class="${r.integrity.ok ? "ok" : "bad"}">${esc(integrityLine(r))}</p>
<h2>측정값</h2><div class="scroll">${table(["이름", "값", "단위", "환경", "시각"], r.measurements.map((x) => [x.name, x.value, x.unit, x.env, x.at]))}</div>
${r.traffic ? `<p>트래픽 판정 ${r.traffic.judgements}번 · 가중치 ${esc(r.traffic.steps.join("→"))}% · 나쁨 ${r.traffic.bad}번 · 최대 오류율 ${n(r.traffic.maxTargetErrorRatePct, "%")} · 최대 p95 ${n(r.traffic.maxTargetP95Ms, "ms")}</p>` : ""}
<h2>상태 전이</h2><div class="scroll">${table(["seq", "시각", "전이", "누가", "앞 상태 머문 ms"], r.timeline.map((t) => [t.seq, t.at, `${t.from} → ${t.to}`, t.actor, n(t.durationMs)]))}</div>
<h2>승인</h2><div class="scroll">${table(["계획", "결정", "누가", "시각", "지문"], r.approvals.map((a) => [a.planId.slice(0, 8), a.decision, a.approvedBy, a.at, a.hashMatches ? "일치" : "불일치"]))}</div>
<h2>사전 점검</h2><div class="scroll">${table(["id", "수준", "내용"], r.precheck.map((p) => [p.id, p.level, p.message]))}</div>
<h2>비용 비교 (월, USD)</h2>${r.cost ? `<p class="muted">가격 기준 ${esc(r.cost.priceAsOf)} · 가장 싼 곳 ${esc(r.cost.cheapest ?? "-")} · 절약 ${usd(r.cost.savingsMonthlyUsd)}</p><div class="scroll">${table(["환경", "가능", "월 비용", "근거 미확인"], r.cost.envs.map((e) => [e.provider, e.feasible ? "예" : "아니오", usd(e.monthlyUsd), e.unverified.join(", ") || "-"]))}</div>` : `<p class="muted">없음</p>`}
<h2>거부·오류</h2><div class="scroll">${table(["seq", "시각", "누가", "동작", "결과", "메모"], r.incidents.map((i) => [i.seq, i.at, i.actor, i.action, i.result, i.note]))}</div>
<h2>비어 있는 것</h2>${r.gaps.length ? `<ul>${r.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : `<p class="muted">없음</p>`}
<p class="muted">생성 ${esc(r.generatedAt)}</p>
</body></html>
`;
}

import { useState } from "react";
import { api, HttpError } from "../../api";
import { usePoll } from "../../usePoll";
import type { EnvironmentView, MigrationStatus, MigrationView } from "../../types";
import { readEnvHealth, type EnvHealthView, type Health } from "../../envHealth";
import { CONN_LABEL, isTerminal, LABEL, PROVIDER_LABEL, TONE_MARK, toneOf, type Tone } from "../../status";
import { splitEnvs } from "../../envs";
import { StatusChip } from "../../components/StatusChip";
import { LiveTraffic } from "../../components/LiveTraffic";
import { hrefOf } from "../../router";
import { ago, isTestMigration, pageApi, shortId } from "../common";
import "./page.css";

// Z85: 모니터링 페이지. 사용자가 묻는 순서대로
//   1) 지금 서비스가 살아 있나 (API /healthz, DB /readyz)
//   2) 이전들은 어디에 몰려 있고, 사람이 볼 건 뭔가 (GET /migrations)
//   3) 환경(클라우드 계정)은 괜찮나 (GET /environments, /environments/:id/status)
//   4) 고른 이전의 앱이 지금 요청을 잘 받나 (GET /live-traffic, 기존 LiveTraffic)
//   5) 시간 흐름 그래프는 Grafana·Prometheus (맥 docker-compose.observability.yml, 포트 3001·9090)
// AI 장애 점검 실행은 "AI 점검 돌리기" 페이지(Z83 AgentPage)에 있다. 여기서는 걸린 이전 줄에서 그쪽으로 보낸다
// Grafana 주소·임베드는 빌드 환경값: VITE_GRAFANA_URL(기본 http://localhost:3001), VITE_GRAFANA_EMBED=1 이면 iframe.
// iframe 은 Grafana 쪽 GF_SECURITY_ALLOW_EMBEDDING=true 가 있어야 보인다(없으면 링크만 쓴다)

const ENV = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const GRAFANA = (ENV.VITE_GRAFANA_URL ?? "http://localhost:3001").replace(/\/$/, "");
const EMBED = ENV.VITE_GRAFANA_EMBED === "1";
const PROM = (ENV.VITE_PROMETHEUS_URL ?? "http://localhost:9090").replace(/\/$/, "");
const DASH = "svc-migrations"; // deploy/observability/grafana/dashboards/migrations.json uid

// 대시보드 패널 번호 (migrations.json). 사용자 질문 기준으로 묶었다
const PANELS: { group: string; items: { id: number; title: string }[] }[] = [
  { group: "이전이 잘 흐르나", items: [
    { id: 1, title: "진행 중 이전" }, { id: 2, title: "실패·일시정지" }, { id: 7, title: "상태별 이전 수" },
    { id: 8, title: "상태별 평균 머문 시간" }, { id: 9, title: "상태 이동 (5분)" }, { id: 3, title: "마지막 컷오버 멈춤" } ] },
  { group: "워커가 밀리지 않나", items: [
    { id: 4, title: "생존 신호 지연(최대)" }, { id: 5, title: "큐 대기" }, { id: 6, title: "큐 실패(보관 중)" },
    { id: 10, title: "큐 대기·가장 오래 기다린 작업" }, { id: 11, title: "워커 작업 시간 p95" }, { id: 12, title: "워커 작업 결과 (5분)" } ] },
  { group: "API 가 느리지 않나", items: [ { id: 13, title: "API 응답 p95" }, { id: 14, title: "API 5xx (5분)" } ] },
];
const EMBED_PANELS = [2, 9, 10, 13];

const panelUrl = (id: number) => `${GRAFANA}/d/${DASH}/?viewPanel=${id}&from=now-1h&to=now`;
const soloUrl = (id: number) => `${GRAFANA}/d-solo/${DASH}/?panelId=${id}&from=now-1h&to=now&refresh=10s`;

const TONE_LABEL: Record<Tone, string> = { run: "워커 진행 중", wait: "사람 차례·멈춤", bad: "실패·되돌림", done: "완료", ok: "완료" };
const ATTENTION: MigrationStatus[] = ["failed", "paused", "stale", "rolling_back", "rolled_back"];

export function MonitoringPage(p: { migrationId?: string; status?: MigrationStatus }) {
  return (
    <div className="page pg-mon">
      <Health />
      <Flow />
      <Live migrationId={p.migrationId} status={p.status} />
      <EnvHealth />
      <Grafana />
    </div>
  );
}

// ---- 1) 살아 있나 ----
function Health() {
  const api1 = usePoll(async () => { const t = performance.now(); await api.health(); return Math.round(performance.now() - t); }, 5000, [], { keepOnError: false });
  const db = usePoll(async () => { const t = performance.now(); await pageApi.readyz(); return Math.round(performance.now() - t); }, 10000, [], { keepOnError: false });
  const cell = (name: string, what: string, q: { data: number | null; error: unknown; loading: boolean }) => {
    const up = q.data !== null && !q.error;
    return (
      <div className={`pg-health ${q.loading ? "" : up ? "up" : "down"}`}>
        <span className="mk" aria-hidden="true">{q.loading ? "○" : up ? "●" : "✕"}</span>
        <span className="name">{name}</span>
        <span className="small muted">{q.loading ? "확인 중…" : up ? `응답 ${q.data}ms` : "응답 없음"}</span>
        <span className="small muted">{what}</span>
      </div>
    );
  };
  return (
    <section className="card" id="mon-health">
      <div className="card-head"><h2>서비스 상태</h2><span className="small muted">5~10초마다 확인</span></div>
      <div className="pg-health-row">
        {cell("API 서버", "GET /healthz", api1)}
        {cell("DB 연결", "GET /readyz (SELECT 1)", db)}
        <div className="pg-health"><span className="mk" aria-hidden="true">◐</span><span className="name">워커</span>
          <span className="small muted">생존 신호는 Grafana</span>
          <a className="small" href={panelUrl(4)} target="_blank" rel="noreferrer">생존 신호 지연 보기</a></div>
      </div>
    </section>
  );
}

// ---- 2) 이전 흐름 ----
function Flow() {
  const [showTest, setShowTest] = useState(false);
  const q = usePoll(async () => {
    const [ms, envs] = await Promise.all([pageApi.listMigrations(), pageApi.listEnvironments().catch(() => [] as EnvironmentView[])]);
    return { ms, envs };
  }, 3000, []);
  const envs = q.data?.envs ?? [];
  const all = q.data?.ms ?? [];
  const ms = showTest ? all : all.filter((m) => !isTestMigration(m, envs));
  const byTone = new Map<Tone, number>();
  for (const m of ms) { const t = toneOf(m.status); byTone.set(t, (byTone.get(t) ?? 0) + 1); }
  const byStatus = new Map<MigrationStatus, number>();
  for (const m of ms) byStatus.set(m.status, (byStatus.get(m.status) ?? 0) + 1);
  const statusRows = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
  const maxN = Math.max(1, ...statusRows.map(([, n]) => n));
  const attention = ms.filter((m) => ATTENTION.includes(m.status))
    .sort((a, b) => Date.parse(b.updatedAt ?? "0") - Date.parse(a.updatedAt ?? "0")).slice(0, 8);
  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? shortId(id);

  return (
    <section className="card" id="mon-flow">
      <div className="card-head"><h2>이전 현황</h2>
        <label className="small muted chk"><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> 시험용 이전도 세기
          {!showTest && all.length > ms.length && ` (${all.length - ms.length}건 숨김)`}</label></div>
      {q.error ? <p className="muted small">목록을 못 읽었어 ({q.error instanceof HttpError ? q.error.status : "연결"}).</p> : null}
      <div className="pg-kpis">
        {(["run", "wait", "bad", "done"] as Tone[]).map((t) => (
          <div key={t} className={`k-${t}`}><span className="k">{TONE_MARK[t]} {TONE_LABEL[t]}</span><span className="v num">{byTone.get(t) ?? 0}</span></div>
        ))}
      </div>
      {statusRows.length > 0 && (
        <div className="pg-dist" aria-label="상태별 이전 수">
          {statusRows.map(([s, n]) => (
            <div key={s} className="row"><span className="name">{LABEL[s]}</span>
              <span className="track"><span className={`fill tone-${toneOf(s)}`} style={{ width: `${(n / maxN) * 100}%` }} /></span>
              <span className="num">{n}</span></div>
          ))}
        </div>
      )}
      <h3>사람이 봐야 할 이전 <span className="small muted">실패·일시정지·되돌림</span></h3>
      {attention.length === 0
        ? <p className="muted small">✓ 지금 걸린 이전 없음.</p>
        : <table className="tbl"><thead><tr><th>이전</th><th>상태</th><th>경로</th><th>멈춘 칸</th><th>실패 코드</th><th>갱신</th></tr></thead>
            <tbody>{attention.map((m: MigrationView) => (
              <tr key={m.id}><td><code>{shortId(m.id)}</code></td><td><StatusChip status={m.status} /></td>
                <td className="small">{envName(m.sourceEnvId)} → {envName(m.targetEnvId)}</td>
                <td className="small">{m.failedAtStatus ? LABEL[m.failedAtStatus] : m.pausedFrom ? LABEL[m.pausedFrom] : "—"}</td>
                <td><code className="small">{m.failureCode ?? "—"}</code></td><td className="small muted">{ago(m.updatedAt)}</td></tr>
            ))}</tbody></table>}
      <p className="small muted">원인을 찾으려면 위 "이전 고르기"에서 그 번호를 고른 뒤 <a href={hrefOf("agent")}>AI 점검 돌리기</a>로.</p>
    </section>
  );
}

// ---- 3) 환경 ----
function EnvHealth() {
  const q = usePoll(async () => {
    const envs = await pageApi.listEnvironments();
    const { real } = splitEnvs(envs);
    const st = await Promise.all(real.map((e) => readEnvHealth(e).then((s) => s as EnvHealthView | null).catch(() => null)));
    return { real, st, testCount: envs.length - real.length };
  }, 15000, []);
  const real = q.data?.real ?? [];
  const H: Record<Health, { mk: string; cls: string; text: string }> = {
    healthy: { mk: "●", cls: "ok", text: "정상" }, degraded: { mk: "◐", cls: "wait", text: "저하" }, unknown: { mk: "○", cls: "muted", text: "모름" },
  };
  return (
    <section className="card" id="mon-envs">
      <div className="card-head"><h2>환경 상태</h2>
        <span className="small muted">{q.data?.testCount ? `시험용 ${q.data.testCount}개 제외 · ` : ""}15초마다</span></div>
      {q.loading && <p className="muted">불러오는 중…</p>}
      {real.length > 0 && (
        <table className="tbl"><thead><tr><th>환경</th><th>클라우드</th><th>연결</th><th>자원 상태</th><th className="r">자원 수</th><th>마지막 확인</th><th>문제</th></tr></thead>
          <tbody>{real.map((e, i) => {
            const s = q.data?.st[i] ?? null;
            const h = s ? H[s.health] : null;
            const connOk = e.connectionStatus === "connected";
            return (
              <tr key={e.id}><td>{e.name}</td><td>{PROVIDER_LABEL[e.provider]}</td>
                <td className={connOk ? "" : "bad"}>{connOk ? "● " : "✕ "}{CONN_LABEL[e.connectionStatus]}</td>
                <td className={h?.cls}>{h ? `${h.mk} ${h.text}` : "—"}{s?.mock ? <span className="muted small"> (Mock)</span> : null}
                  {s?.note ? <div className="muted small">{s.note}</div> : null}</td>
                <td className="r num">{s ? s.count : "—"}</td>
                <td className="small muted">{ago(e.lastVerifiedAt ?? s?.checkedAt)}</td>
                <td className="small bad">{e.failureReason ?? ""}</td></tr>
            );
          })}</tbody></table>
      )}
    </section>
  );
}

// ---- 4) 고른 이전의 앱 ----
function Live(p: { migrationId?: string; status?: MigrationStatus }) {
  return (
    <section className="card" id="mon-live">
      <div className="card-head"><h2>가동 중 앱</h2><span className="small muted">고른 이전 동안 들어온 요청 수·실패·p95 (1초마다)</span></div>
      {p.migrationId
        ? <LiveTraffic id={p.migrationId} done={p.status ? isTerminal(p.status) : false} status={p.status} />
        : <p className="muted">위 "이전 고르기"에서 하나를 고르면 그 이전의 앱 요청 숫자가 여기 나와.</p>}
      {p.migrationId && <Measured id={p.migrationId} live={p.status ? !isTerminal(p.status) : true} />}
    </section>
  );
}

// 워커가 남긴 측정값 (복제 지연·컷오버 멈춤·초기 복사 등). GET /report 의 measurements 칸
const MEASURE_LABEL: Record<string, string> = {
  // 워커가 쓰는 이름 3개 (apps/worker·packages/replication). 모르는 이름은 그대로 보인다
  cutover_pause_ms: "컷오버 멈춤", replication_lag_ms: "복제 지연", initial_copy_ms: "초기 복사",
};
function Measured(p: { id: string; live: boolean }) {
  const q = usePoll(() => pageApi.report(p.id), p.live ? 5000 : null, [p.id], { keepOnError: false });
  const ms = q.data?.measurements ?? [];
  if (q.loading) return null;
  return (
    <>
      <h3>워커 측정값 <span className="small muted">복제 지연·컷오버 멈춤 같은 실측 숫자 (감사 기록에서)</span></h3>
      {ms.length === 0
        ? <p className="small muted">{q.error ? "리포트를 못 읽었어." : "아직 측정값 없음 (동기화·컷오버 단계에서 생겨)."}</p>
        : <table className="tbl"><thead><tr><th>무엇</th><th className="r">값</th><th>환경</th><th>언제</th></tr></thead>
            <tbody>{ms.map((m, i) => (
              <tr key={`${m.name}-${m.at}-${i}`}><td>{MEASURE_LABEL[m.name] ?? m.name} <code className="small muted">{m.name}</code></td>
                <td className="r num">{m.value.toLocaleString()} {m.unit}</td><td className="small">{m.env}</td><td className="small muted">{ago(m.at)}</td></tr>
            ))}</tbody></table>}
    </>
  );
}

// ---- 5) Grafana ----
function Grafana() {
  return (
    <section className="card" id="mon-grafana">
      <div className="card-head"><h2>시간 흐름 그래프 (Grafana)</h2>
        <span className="small"><a href={`${GRAFANA}/d/${DASH}/`} target="_blank" rel="noreferrer">대시보드 전체 열기</a> · <a href={PROM} target="_blank" rel="noreferrer">Prometheus</a></span></div>
      {EMBED && (
        <div className="pg-embed">
          {EMBED_PANELS.map((id) => <iframe key={id} title={`Grafana 패널 ${id}`} src={soloUrl(id)} loading="lazy" />)}
        </div>
      )}
      <div className="pg-panels">
        {PANELS.map((g) => (
          <div key={g.group}><h3>{g.group}</h3>
            <ul>{g.items.map((it) => <li key={it.id}><a href={panelUrl(it.id)} target="_blank" rel="noreferrer">{it.title}</a></li>)}</ul></div>
        ))}
      </div>
      <p className="small muted">
        Grafana 는 맥에서 <code>docker compose -f docker-compose.observability.yml up -d</code> 로 띄운 것({GRAFANA}). 안 떠 있으면 링크가 안 열려.
        {!EMBED && " 화면 안에 그래프를 넣으려면 VITE_GRAFANA_EMBED=1 + Grafana GF_SECURITY_ALLOW_EMBEDDING=true."}
      </p>
    </section>
  );
}

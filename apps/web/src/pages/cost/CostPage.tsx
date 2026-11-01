import { useEffect, useMemo, useState } from "react";
import { api, isApiDown, specOf } from "../../api";
import { errText } from "../../components/ErrorBox";
import { usePoll } from "../../usePoll";
import type { EnvEstimate, MigrationCostView, MigrationView, Provider } from "../../types";
import { PROVIDER_LABEL } from "../../status";
import { CostCompare, segValues } from "../../components/CostCompare";
import { StatusChip } from "../../components/StatusChip";
import { DEMO_SPEC, isTestMigration, pageApi, shortId, usd, type DemoSpec, type FullEstimate } from "../common";
import "./page.css";

// Z85: 비용 페이지. 사용자가 하는 일 세 가지
//   1) 우리 이전들이 한 달에 얼마를 아끼나 (이전별 출발 vs 도착, GET /migrations/:id/cost)
//   2) 골라 둔 이전 하나의 자세한 비교 (기존 CostCompare 그대로)
//   3) 조건을 바꿔 보며 어디가 가장 싼지 (POST /cost/estimate, DB 쓰기 없음)
// 숫자는 공개 가격표 + 가정으로 낸 【추정】이다. 청구서가 아니다

const PROVIDERS: Provider[] = ["aws", "gcp", "onprem", "azure_mock"];
const SEG = [
  { key: "compute" as const, label: "컴퓨트", cls: "s1" },
  { key: "db" as const, label: "DB", cls: "s2" },
  { key: "fixed" as const, label: "고정비", cls: "s3" },
];
const MAX_ROWS = 12; // 이전별 표에서 읽는 최대 건수 (요청 하나에 CPU 40ms 남짓, 60초 캐시)

export function CostPage(p: { migrationId?: string }) {
  return (
    <div className="page pg-cost">
      <Savings selected={p.migrationId} />
      {p.migrationId
        ? <section className="card" id="cost-detail"><div className="card-head"><h2>고른 이전 자세히</h2>
            <span className="muted small"><code>{shortId(p.migrationId)}</code></span></div>
            <CostCompare id={p.migrationId} /></section>
        : <section className="card"><h2>고른 이전 자세히</h2>
            <p className="muted">위 "이전 고르기"에서 하나를 고르면 출발·도착 비용을 덩어리별로 보여 줘.</p></section>}
      <Simulator migrationId={p.migrationId} />
    </div>
  );
}

// ---- 1) 이전별 절감 ----
function Savings(p: { selected?: string }) {
  const [showTest, setShowTest] = useState(false);
  const data = usePoll(async () => {
    const [ms, envs] = await Promise.all([pageApi.listMigrations(), pageApi.listEnvironments().catch(() => [])]);
    const all = ms.filter((m) => showTest || !isTestMigration(m, envs));
    const hidden = ms.length - all.length;
    const rows = await Promise.all(all.slice(0, MAX_ROWS).map(async (m) => {
      try { return { m, v: await api.migrationCost(m.id) as MigrationCostView | null, err: null as string | null }; }
      catch (e) { return { m, v: null, err: e instanceof Error ? e.message : String(e) }; }
    }));
    return { rows, hidden, more: Math.max(0, all.length - MAX_ROWS) };
  }, 30000, [showTest]);

  const rows = data.data?.rows ?? [];
  const priced = rows.filter((r) => r.v?.pair.monthlyUsd !== null && r.v?.pair.monthlyUsd !== undefined);
  const total = priced.reduce((a, r) => a + (r.v!.pair.monthlyUsd ?? 0), 0);
  const credit = priced.reduce((a, r) => a + (r.v!.pair.creditPortionUsd ?? 0), 0);
  const max = Math.max(1, ...priced.map((r) => Math.abs(r.v!.pair.monthlyUsd ?? 0)));

  return (
    <section className="card" id="cost-savings">
      <div className="card-head">
        <h2>이전별 월 비용 차이</h2>
        <label className="small muted chk">
          <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> 시험용 이전도 보기
        </label>
      </div>
      <div className="pg-kpis">
        <div><span className="k">합계 (한 달)</span>
          <span className={`v num ${total > 0 ? "ok" : total < 0 ? "bad" : ""}`}>{total >= 0 ? "아낌 " : "더 듦 "}{usd(Math.abs(total))}</span></div>
        <div><span className="k" title="도착 크레딧 − 출발 크레딧. 크레딧이 끝나면 이만큼 차이가 줄어든다">그중 크레딧 차이</span><span className="v num">{usd(credit)}</span></div>
        <div><span className="k">계산된 이전</span><span className="v num">{priced.length} / {rows.length}</span></div>
      </div>
      {data.loading && <p className="muted">불러오는 중…</p>}
      {!data.loading && rows.length === 0 && <p className="muted">아직 이전이 없어. "이전" 메뉴에서 하나 만들면 여기 줄이 생겨.</p>}
      {rows.length > 0 && (
        <table className="tbl">
          <thead><tr><th>이전</th><th>상태</th><th>출발 → 도착</th><th className="r">출발/월</th><th className="r">도착/월</th>
            <th>차이</th><th>근거</th></tr></thead>
          <tbody>
            {rows.map(({ m, v, err }) => {
              const d = v?.pair.monthlyUsd ?? null;
              return (
                <tr key={m.id} className={m.id === p.selected ? "sel" : ""}>
                  <td><code>{shortId(m.id)}</code></td>
                  <td><StatusChip status={m.status} /></td>
                  <td>{v ? `${v.source.name} → ${v.target.name}` : "—"}</td>
                  <td className="r num">{usd(v?.pair.sourceMonthlyUsd)}</td>
                  <td className="r num">{usd(v?.pair.targetMonthlyUsd)}</td>
                  <td className="pg-delta">
                    {d === null ? <span className="muted small">{err ? "읽기 실패" : "한쪽 계산 불가"}</span> : <>
                      <span className={`bar1 ${d >= 0 ? "ok" : "bad"}`} style={{ width: `${Math.round((Math.abs(d) / max) * 100)}%` }} />
                      <span className={`num ${d >= 0 ? "ok" : "bad"}`}>{d >= 0 ? "−" : "+"}{usd(Math.abs(d))}</span>
                    </>}
                  </td>
                  <td className="small muted">{v ? (v.origin === "stored" ? "승인 때 저장한 추정" : "지금 계산(미리보기)") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="small muted">
        −는 도착이 더 싸다는 뜻(아낌). 공개 가격표 + 피크 트래픽 가정으로 낸 【추정】이고 청구서가 아니야.
        {data.data?.more ? ` 최근 ${MAX_ROWS}건만 계산했어(나머지 ${data.data.more}건).` : ""}
        {data.data?.hidden && !showTest ? ` 시험용 이전 ${data.data.hidden}건 숨김.` : ""}
      </p>
    </section>
  );
}

// ---- 3) 시뮬레이터 ----
// Z101: 고른 이전이 있으면 그 이전의 실제 명세(GET /migrations/:id/spec)와 출발 클라우드에서 시작한다.
// 명세를 못 읽으면(아직 명세 확정 전 404, 서버 경로 없음 등) 이유를 그대로 보이고, 예시 명세(demo-shop)라고 분명히 쓴다
function useBaseSpec(migrationId?: string) {
  return usePoll(async (): Promise<{ spec: DemoSpec; from: Provider | null; label: string; real: boolean; why: string | null }> => {
    if (!migrationId) return { spec: DEMO_SPEC, from: null, label: "예시 명세 (demo-shop) — 위에서 이전을 고르면 그 이전의 명세로 바뀌어", real: false, why: null };
    const [m, envs] = await Promise.all([api.getMigration(migrationId) as Promise<MigrationView>, pageApi.listEnvironments().catch(() => [])]);
    const from = envs.find((e) => e.id === m.sourceEnvId)?.provider ?? null;
    try {
      const v = await api.migrationSpec(migrationId);
      const { spec, filled } = specOf(v, DEMO_SPEC);
      const kind = v.source === "ai_draft" ? "AI 초안" : "확정";
      return { spec, from, label: `이전 ${shortId(migrationId)} 의 명세 v${v.version} ${kind} (${spec.app.name})`, real: true,
        why: filled ? `일부 칸만 있음 → 빈 칸은 예시값${v.needsReview.length ? ` · 검토 필요 ${v.needsReview.length}개` : ""}` : null };
    } catch (e) {
      if (isApiDown(e)) throw e;
      return { spec: DEMO_SPEC, from, label: "예시 명세 (demo-shop)", real: false, why: `이 이전의 명세를 못 읽음: ${errText(e)}` };
    }
  }, null, [migrationId ?? ""]);
}

function Simulator(p: { migrationId?: string }) {
  const base = useBaseSpec(p.migrationId);
  const baseSpec = base.data?.spec ?? DEMO_SPEC;
  const [rps, setRps] = useState(10);
  const [from, setFrom] = useState<Provider>("aws");
  const [profile, setProfile] = useState<"startup" | "finance">("startup");
  const [credits, setCredits] = useState(true);
  const [replicas, setReplicas] = useState(1);
  const [cpu, setCpu] = useState<"250m" | "500m" | "1">("250m");
  const [dbGb, setDbGb] = useState(20);
  const [res, setRes] = useState<FullEstimate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 명세가 바뀌면(이전을 고름) 입력칸을 그 명세 값으로 맞춘다
  useEffect(() => {
    const s = base.data?.spec; if (!s) return;
    setReplicas(s.service.replicas); setCpu(s.service.cpu);
    if (s.database) setDbGb(s.database.storageGb);
    if (base.data?.from) setFrom(base.data.from);
  }, [base.data]);

  const body = useMemo(() => ({
    spec: { ...baseSpec, service: { ...baseSpec.service, replicas, cpu },
      database: { engine: "postgres" as const, majorVersion: baseSpec.database?.majorVersion ?? ("16" as const), storageGb: dbGb } },
    from, targets: PROVIDERS, traffic: { peakRps: rps }, profile, applyCredits: credits,
  }), [baseSpec, rps, from, profile, credits, replicas, cpu, dbGb]);

  // 입력이 멈추고 0.4초 뒤 계산 (서버가 같은 입력은 60초 기억한다)
  useEffect(() => {
    let gone = false;
    const t = setTimeout(async () => {
      setBusy(true);
      try { const r = await pageApi.estimate(body); if (!gone) { setRes(r); setErr(null); } }
      catch (e) { if (!gone) setErr(e instanceof Error ? e.message : String(e)); }
      finally { if (!gone) setBusy(false); }
    }, 400);
    return () => { gone = true; clearTimeout(t); };
  }, [body]);

  const envs = res?.envs ?? [];
  const max = Math.max(1, ...envs.map((e) => e.monthlyUsd ?? 0));

  return (
    <section className="card" id="cost-sim">
      <div className="card-head"><h2>조건 바꿔 보기</h2>
        <span className="small muted">{busy ? "계산 중…" : res ? `가격표 기준 ${res.priceAsOf.slice(0, 10)}` : ""}</span></div>
      <p className="small" data-testid="sim-spec" data-real={base.data?.real ? "yes" : "no"}>
        명세: <b>{base.data?.label ?? "읽는 중…"}</b>
        {base.data?.why && <span className="bad"> · {base.data.why}</span>}
      </p>
      <div className="pg-form">
        <label>피크 요청 (초당)
          <span className="row"><input type="range" min={1} max={2000} value={rps} onChange={(e) => setRps(Number(e.target.value))} />
            <input type="number" min={0} max={100000} value={rps} onChange={(e) => setRps(Math.max(0, Number(e.target.value) || 0))} className="num w80" /></span>
        </label>
        <label>지금 환경
          <select value={from} onChange={(e) => setFrom(e.target.value as Provider)}>
            {PROVIDERS.map((x) => <option key={x} value={x}>{PROVIDER_LABEL[x]}</option>)}
          </select></label>
        <label>보안 수준
          <select value={profile} onChange={(e) => setProfile(e.target.value as "startup" | "finance")}>
            <option value="startup">스타트업 (기본)</option><option value="finance">금융 (강화)</option>
          </select></label>
        <label>복제본 수
          <input type="number" min={1} max={10} value={replicas} className="num w80"
            onChange={(e) => setReplicas(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} /></label>
        <label>CPU (복제본당)
          <select value={cpu} onChange={(e) => setCpu(e.target.value as "250m" | "500m" | "1")}>
            <option value="250m">0.25</option><option value="500m">0.5</option><option value="1">1</option>
          </select></label>
        <label>DB 저장 공간 (GB)
          <input type="number" min={1} max={100} value={dbGb} className="num w80"
            onChange={(e) => setDbGb(Math.min(100, Math.max(1, Number(e.target.value) || 1)))} /></label>
        <label className="chk"><input type="checkbox" checked={credits} onChange={(e) => setCredits(e.target.checked)} /> 크레딧 반영</label>
      </div>
      {err && <p className="bad small" role="alert">계산 실패: {err}</p>}
      {res?.priceStale && <p className="small" style={{ color: "var(--color-wait)" }}>◐ 가격표가 7일 넘게 안 바뀌었어. 결선 전날 <code>npm run prices:fetch -w @svc/cost</code>.</p>}
      {res && <>
        <div className="pg-kpis">
          <div><span className="k">필요 vCPU</span><span className="v num">{res.requiredVcpu.toFixed(2)}</span></div>
          <div><span className="k">가장 싼 곳</span><span className="v">{res.cheapest ? PROVIDER_LABEL[res.cheapest] : "—"}</span></div>
          <div><span className="k">{PROVIDER_LABEL[from]}에서 옮기면</span>
            <span className={`v num ${res.savings && res.savings.monthlyUsd > 0 ? "ok" : ""}`}>
              {res.savings ? `${res.savings.monthlyUsd >= 0 ? "아낌" : "더 듦"} ${usd(Math.abs(res.savings.monthlyUsd))}/월` : "이미 가장 쌈"}</span></div>
        </div>
        <div className="pg-bars" role="table" aria-label="환경별 월 비용">
          {envs.map((e) => <EnvBar key={e.provider} e={e} max={max} cheapest={res.cheapest} from={from} />)}
          <div className="legend small muted">{SEG.map((s) => <span key={s.key}><i className={s.cls} />{s.label}</span>)}</div>
        </div>
        {res.recommendations.length > 0 && <>
          <h3>추천 순위 <span className="small muted">점수 = 비용 + 위험 + 이전 시간 (낮을수록 좋음)</span></h3>
          <table className="tbl">
            <thead><tr><th>순위</th><th>환경</th><th>보안</th><th className="r">월 비용</th><th className="r">점수</th><th className="r">비용·위험·시간</th></tr></thead>
            <tbody>{res.recommendations.map((r) => (
              <tr key={`${r.provider}-${r.security}`}><td className="num">{r.rank}</td><td>{PROVIDER_LABEL[r.provider]}</td>
                <td>{r.security === "hardened" ? "강화" : "기본"}</td><td className="r num">{usd(r.monthlyUsd)}</td>
                <td className="r num">{r.score.toFixed(2)}</td>
                <td className="r num small">{r.scoreParts.cost.toFixed(2)} · {r.scoreParts.risk.toFixed(2)} · {r.scoreParts.time.toFixed(2)}</td></tr>
            ))}</tbody>
          </table>
        </>}
        {res.breakpoints.length > 0 && <>
          <h3>트래픽이 늘면 가장 싼 곳이 바뀌는 지점</h3>
          <ol className="pg-bp">{res.breakpoints.map((b) => (
            <li key={b.fromRps}><span className="num">초당 {b.fromRps.toLocaleString()}</span>부터 <b>{PROVIDER_LABEL[b.cheapest]}</b>
              <span className="muted small"> (노드 {b.nodes}대)</span>
              <button className="link small" onClick={() => setRps(b.fromRps)}>이 값으로</button></li>
          ))}</ol>
        </>}
      </>}
      <p className="small muted">서버 POST /cost/estimate 로 계산하고 저장하지 않아. 명세는 위 "명세:" 줄 기준.</p>
    </section>
  );
}

function EnvBar(p: { e: EnvEstimate; max: number; cheapest: Provider | null; from: Provider }) {
  const { e } = p;
  const seg = segValues(e);
  const total = e.monthlyUsd;
  return (
    <div className={`pg-bar ${e.provider === p.cheapest ? "best" : ""}`} role="row">
      <span className="name" role="cell">{PROVIDER_LABEL[e.provider]}{e.provider === p.from && <span className="muted small"> · 지금</span>}</span>
      <span className="track" role="cell">
        {e.feasible && total !== null
          ? SEG.map((s) => seg[s.key] > 0 &&
              <span key={s.key} className={`seg ${s.cls}`} style={{ width: `${(seg[s.key] / p.max) * 100}%` }}
                title={`${s.label} ${usd(seg[s.key])}`} />)
          : <span className="muted small">불가 ({e.reason ?? "?"})</span>}
      </span>
      <span className="v num" role="cell">{e.provider === p.cheapest ? "✓ " : ""}{usd(total)}
        {e.unverified.length > 0 && <span className="muted small" title={`근거 미확인: ${e.unverified.join(", ")}`}> 추정</span>}</span>
    </div>
  );
}

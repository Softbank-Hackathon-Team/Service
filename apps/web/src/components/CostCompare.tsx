import { useRef, useState } from "react";
import { api } from "../api";
import type { EnvEstimate, MigrationCostView, PriceSourceSummary, Provider } from "../types";
import { PROVIDER_LABEL } from "../status";
import { ErrorBox } from "./ErrorBox";
import { NotYet, usePoll404 } from "./Optional";

// 작업 Z2: 이전 한 건의 출발 vs 도착 월 비용 비교 (GET /migrations/:id/cost).
// 숫자는 전부 공개 가격표 + 가정(피크 rps, 노드 활용률)으로 낸 【추정】이다. 청구서가 아니다.

// 클라우드 이름표는 status.ts 한 곳으로 옮겼다. 예전 경로로 가져오는 곳을 위해 다시 내보낸다
export { PROVIDER_LABEL };

// 막대 세 덩어리. 색은 categorical 1·2·3번 고정 순서 (styles.css --series-*)
type SegKey = "compute" | "db" | "fixed";
const SEGS: { key: SegKey; label: string; hint: string }[] = [
  { key: "compute", label: "컴퓨트", hint: "클러스터 관리비 + 노드" },
  { key: "db", label: "DB", hint: "관리형 Postgres + 스토리지" },
  { key: "fixed", label: "고정비", hint: "온프레 서버 (클러스터·DB 포함)" },
];

const ITEM_LABEL: Record<string, string> = {
  cluster: "클러스터", cluster_credit: "크레딧", node: "노드", db: "DB", storage: "스토리지", fixed: "고정비",
};

export const usd = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `$${x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
const r1 = (x: number) => Math.round(x * 10) / 10;

export function segValues(e: EnvEstimate): Record<SegKey, number> {
  const p = e.parts;
  return { compute: r1(p.cluster + p.nodes), db: r1(p.db + p.storage), fixed: r1(p.fixed) };
}

function segDetail(e: EnvEstimate, k: SegKey): string {
  const p = e.parts;
  if (k === "compute") {
    const node = e.nodeSku ? `노드 ${e.nodeSku}×${e.nodes} ${usd(p.nodes)}` : `노드 ${usd(p.nodes)}`;
    const credit = e.creditUsd > 0 ? ` (크레딧 ${usd(e.creditUsd)} 반영)` : "";
    return `클러스터 ${usd(p.cluster)}${credit} + ${node}`;
  }
  if (k === "db") return `DB ${usd(p.db)} + 스토리지 ${usd(p.storage)}`;
  return `서버 고정비 ${usd(p.fixed)}`;
}

// 출발, 도착을 맨 위에 두고 나머지는 원래 순서
export function orderEnvs(v: MigrationCostView): EnvEstimate[] {
  const rank = (p: Provider) => (p === v.source.provider ? 0 : p === v.target.provider ? 1 : 2);
  return [...v.estimate.envs].sort((a, b) => rank(a.provider) - rank(b.provider));
}

// 가격표 출처 한 칸. 온프레는 캐시가 live로 적혀 있어도 API가 아니라 가정치다 (V onprem.ts)
function evidenceText(p: Provider, src: PriceSourceSummary | undefined): string {
  if (p === "azure_mock") return "Mock 가격";
  if (p === "onprem") return "고정 가정치";
  if (!src) return "—";
  const kind = src.origin === "live" ? "실제 가격 API" : src.origin === "seed" ? "샘플값 (API 키 대기)" : "샘플";
  return `${kind} · ${src.fetchedAt.slice(0, 10)}`;
}

type Tip = { x: number; y: number; title: string; body: string };

export function CostCompare(p: { id: string }) {
  // 30초마다 다시 읽는다 (가격·저장된 추정이 바뀔 수 있음). 404면 { v: null }
  const cost = usePoll404<MigrationCostView>(() => api.migrationCost(p.id), 30000, [p.id]);
  const v = cost.data?.v;
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  if (cost.error) return <ErrorBox error={cost.error} />;
  if (!v) return <NotYet answered={!!cost.data} what="비용 추정" />;

  const envs = orderEnvs(v);
  const max = Math.max(1, ...envs.map((e) => e.monthlyUsd ?? 0));
  const d = v.pair.monthlyUsd;
  const unverifiedAny = envs.some((e) => e.unverified.length > 0);

  const show = (el: HTMLElement, e: EnvEstimate, k: SegKey, val: number) => {
    const b = box.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!b) return;
    setTip({
      x: r.left - b.left + r.width / 2, y: r.top - b.top,
      title: `${PROVIDER_LABEL[e.provider]} · ${SEGS.find((s) => s.key === k)!.label} ${usd(val)}/월`,
      body: segDetail(e, k),
    });
  };

  return (
    <div className="cost">
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-l">출발 · {PROVIDER_LABEL[v.source.provider]} ({v.source.name})</span>
          <span className="kpi-v">{usd(v.pair.sourceMonthlyUsd)}<small>/월</small></span>
        </div>
        <div className="kpi">
          <span className="kpi-l">도착 · {PROVIDER_LABEL[v.target.provider]} ({v.target.name})</span>
          <span className="kpi-v">{usd(v.pair.targetMonthlyUsd)}<small>/월</small></span>
        </div>
        <div className="kpi">
          <span className="kpi-l">옮기면</span>
          <span className="kpi-v">
            {d === null ? "계산 불가" : d >= 0 ? <>월 {usd(d)} 아낌</> : <>월 {usd(-d)} 더 듦</>}
          </span>
          {d !== null && v.pair.creditPortionUsd !== 0 && (
            <span className="kpi-s">그중 무료 크레딧 몫 {usd(v.pair.creditPortionUsd)} · 크레딧 빼면 {usd(r1(d - v.pair.creditPortionUsd))}</span>
          )}
        </div>
      </div>

      <p className="muted small">
        <span className="tag-est">【추정】</span> 피크 {v.estimate.peakRps} rps · 필요 vCPU {v.estimate.requiredVcpu} ·
        보안 프로필 {v.estimate.profile} · 가격 기준 {v.estimate.priceAsOf.slice(0, 10)} ·{" "}
        {v.origin === "stored" ? `저장된 추정 (${v.createdAt.slice(0, 16).replace("T", " ")} UTC${v.planId ? ", 승인 계획에 묶임" : ""})` : "미리보기 (저장 안 됨)"} ·
        명세 {v.specFrom === "demo" ? "데모 앱 (아직 가져온 명세 없음)" : v.specFrom === "spec_versions" ? "가져온 명세 최신판" : "저장 당시 명세"}
      </p>
      {v.estimate.priceStale && <div className="note">가격표가 7일 넘게 갱신 안 됐어. 숫자가 지금 가격과 다를 수 있어.</div>}

      <ul className="legend" aria-label="막대 색 범례">
        {SEGS.map((s, i) => (
          <li key={s.key}><span className={`sw s${i + 1}`} aria-hidden="true" />{s.label} <span className="muted">({s.hint})</span></li>
        ))}
      </ul>

      <div className="cbars" ref={box} onMouseLeave={() => setTip(null)}
        role="group" aria-label={`환경별 월 비용 추정: ${envs.map((e) => `${PROVIDER_LABEL[e.provider]} ${usd(e.monthlyUsd)}`).join(", ")}`}>
        {envs.map((e) => {
          const sv = segValues(e);
          const isSrc = e.provider === v.source.provider;
          const isDst = e.provider === v.target.provider;
          const present = SEGS.filter((s) => sv[s.key] > 0);
          return (
            <div className={`crow${isSrc || isDst ? " pair" : ""}`} key={e.provider}>
              <div className="clabel">
                <b>{PROVIDER_LABEL[e.provider]}</b>
                {isSrc && <span className="chip">출발</span>}
                {isDst && <span className="chip tone-run">도착</span>}
                {v.estimate.cheapest === e.provider && <span className="chip tone-ok">최저</span>}
              </div>
              <div className="ctrack">
                {e.feasible && e.monthlyUsd !== null ? (
                  <>
                    <div className="cfill" style={{ width: `calc((100% - 72px) * ${e.monthlyUsd / max})` }}>
                      {present.map((s) => (
                        <span key={s.key} tabIndex={0} role="img"
                          className={`cseg s${SEGS.indexOf(s) + 1}`}
                          style={{ flexGrow: sv[s.key] }}
                          aria-label={`${PROVIDER_LABEL[e.provider]} ${s.label} ${usd(sv[s.key])}`}
                          onMouseEnter={(ev) => show(ev.currentTarget, e, s.key, sv[s.key])}
                          onFocus={(ev) => show(ev.currentTarget, e, s.key, sv[s.key])}
                          onBlur={() => setTip(null)} />
                      ))}
                    </div>
                    <span className="ctotal">{usd(e.monthlyUsd)}</span>
                  </>
                ) : <span className="muted small">계산 불가 ({e.reason ?? "?"})</span>}
              </div>
              {(e.unverified.length > 0 || e.unknown.length > 0) && (
                <div className="cnote small muted">
                  {e.provider === "azure_mock" ? "Mock 가격" : "미확인·가정 값"}: {e.unverified.map((x) => ITEM_LABEL[x] ?? x).join(", ")}
                  {e.unknown.length > 0 && ` · 가격 없음(합계 제외): ${e.unknown.map((x) => ITEM_LABEL[x] ?? x).join(", ")}`}
                </div>
              )}
            </div>
          );
        })}
        {tip && (
          <div className="ctip" role="status" style={{ left: tip.x, top: tip.y }}>
            <b>{tip.title}</b><span>{tip.body}</span>
          </div>
        )}
      </div>

      <p className="muted small">
        <span className="tag-est">전송료 제외</span> 네트워크 데이터 전송료는 합계에 넣지 않았어(단가 근거가 아직 없음). 기본 인그레스가 cloudflared 터널이라 로드 밸런서 비용도 없어.
        노드 단가·보안 강화 추가비는 【추정】 값이야.
        {unverifiedAny && " 막대 밑 \"미확인·가정 값\" 항목은 실제 가격 API로 확인 안 된 값이야."}
      </p>

      <details className="ctable">
        <summary>표로 보기</summary>
        <table className="tbl">
          <thead>
            <tr><th>환경</th><th>노드 【추정】</th><th>컴퓨트</th><th>DB</th><th>고정비</th><th>크레딧 (컴퓨트에 반영됨)</th><th>월 합계</th><th>근거</th></tr>
          </thead>
          <tbody>
            {envs.map((e) => {
              const sv = segValues(e);
              const src = v.priceSources.find((s) => s.vendor === e.provider);
              return (
                <tr key={e.provider}>
                  <td>{PROVIDER_LABEL[e.provider]}</td>
                  <td>{e.nodeSku ? `${e.nodeSku} ×${e.nodes}` : "—"}</td>
                  <td>{usd(sv.compute)}</td><td>{usd(sv.db)}</td><td>{usd(sv.fixed)}</td>
                  <td>{e.creditUsd > 0 ? `−${usd(e.creditUsd)}` : "—"}</td>
                  <td><b>{usd(e.monthlyUsd)}</b></td>
                  <td>{evidenceText(e.provider, src)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
      <div className="actions"><button className="link" onClick={() => void cost.reload()}>다시 계산</button></div>
    </div>
  );
}

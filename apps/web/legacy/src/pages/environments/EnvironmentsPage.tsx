// 표시 메모: 환경. 환경 고르기 → 지금 돌고 있는 자원 → 이 환경에서 옮기는 앱 → (이전 고르면) 이전 흐름과 전·지금·뒤 표.
//   자원 표: 종류, 서비스, 이름, 상태, 내용 + 읽은 곳·시각·걸린 시간. 앱 표: 7칸 + 자원 펼치기.
//   이전 흐름: 6단계 띠 + 대응표 5칸(무엇, 출발, 도착, 방식, 단계). 전·지금·뒤 표: 출발 3칸 + 도착 3칸. 온프레면 Agent 보고가 더 붙는다.
//   폴링: 인벤토리 15초, 진행 중 대응표 3초, 양쪽 인벤토리 5초. 한 페이지 정보량이 가장 많다.
import { useEffect, useState } from "react";
import { api, store } from "../../api";
import { HttpError } from "../../http";
import { usePoll } from "../../usePoll";
import type { EnvironmentView, MigrationView, Provider } from "../../types";
import { CONN_LABEL, PROVIDER_LABEL, isTerminal } from "../../status";
import { splitEnvs } from "../../envs";
import { StatusChip } from "../../components/StatusChip";
import { CATEGORY_LABEL, type PlanResourcesView, type ResourceCategory, type ResourceRow, type StepState } from "../../resourceMap";
import {
  CATEGORY_ORDER, EVIDENCE_LABEL, SOURCE_LABEL, STAGE_LABEL, STATE_LABEL, STATE_MARK, STATE_TONE, inventoryApi,
  type AppFootprint, type CloudInventory, type EnvInventory, type FootprintCategory, type FootprintResource,
} from "./inventory";
import { AgentReports } from "./AgentReports";
import "./page.css";

// Z86: 환경 보기. 사용자가 묻는 순서대로 (Jeong 23:31Z·23:38Z)
//   1) 환경 하나 고르기 → 2) 그 환경에 지금 무엇이 돌고 있나 (클라우드에서 직접 읽음, 못 읽으면 "확인 불가"와 이유)
//   3) 이 플랫폼이 그 환경에서 옮기는 앱과 그 자원의 단계 (만들 예정·만드는 중·돌고 있음·걷음)
//   4) 이전 하나 고르기 → 출발 서비스가 도착에서 무엇이 되나 (RDS → Cloud SQL 같은 대응표 + 방식 + 단계)
//   5) 이전 전 · 지금 · 이전 뒤 를 한 표에서
// 읽는 경로: GET /environments/:id/inventory (15초), GET /migrations/:id/plan/resources (진행 중 3초). 둘 다 읽기 전용 (Z86 백엔드)

const PICK_KEY = "web.envPick";
const STEPS: { id: NonNullable<ResourceRow["step"]>; label: string; what: string }[] = [
  { id: "provision", label: "만들기", what: "Terraform 으로 도착 자원 만들기" },
  { id: "deploy", label: "배포", what: "같은 이미지로 앱 띄우기 (Argo CD)" },
  { id: "sync", label: "DB 복제", what: "논리 복제로 따라잡기" },
  { id: "shift", label: "트래픽 전환", what: "Cloudflare LB 가중치 옮기기" },
  { id: "cutover", label: "컷오버", what: "출발 쓰기 막고 도착이 주인" },
  { id: "cleanup", label: "정리", what: "복제 걷고 출발 앱 0 개로" },
];
const STEP_STATE_LABEL: Record<StepState, string> = { todo: "남음", doing: "지금", done: "끝", skipped: "해당 없음", undone: "되돌림" };

// 대응표 분류 → 플랫폼 자원 분류 (이전 전·지금·뒤 표에서 "지금" 칸을 채울 때)
const FOOT_OF: Partial<Record<ResourceCategory, FootprintCategory[]>> = {
  workload: ["compute"], database: ["database", "replication"], secret: ["secret"], identity: ["identity"], network: ["network"],
};

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour12: false });
const errText = (e: unknown) => (e instanceof HttpError ? (e.status === 404 ? "서버에 이 경로가 아직 없어 (Z86 백엔드 패치 전)" : `${e.status} ${e.body?.code ?? ""}`) : "읽기 실패");

export function EnvironmentsPage(p: { envs: EnvironmentView[]; migrations: MigrationView[]; migrationId?: string; onSelect: (id: string | null) => void }) {
  const { real, test } = splitEnvs(p.envs);
  const sel = p.migrations.find((m) => m.id === p.migrationId);
  const [pick, setPick] = useState<string | null>(() => store.get(PICK_KEY) || null);
  // 고른 환경이 목록에 없으면(회사 바뀜 등) 고른 이전의 출발, 그것도 없으면 첫 환경
  const envId = real.some((e) => e.id === pick) ? pick! : (sel?.sourceEnvId && real.some((e) => e.id === sel.sourceEnvId) ? sel.sourceEnvId : real[0]?.id ?? null);
  useEffect(() => { if (envId) store.set(PICK_KEY, envId); }, [envId]);
  const env = real.find((e) => e.id === envId) ?? null;

  if (real.length === 0)
    return <div className="page pg-env"><section className="card"><p className="muted">환경이 아직 없어. 서버 seed(db/migrations/0002·0016)를 넣으면 dev-aws·dev-gcp·dev-azure-mock·dev-onprem 이 생겨.</p></section></div>;

  return (
    <div className="page pg-env">
      <section className="card" aria-label="환경 고르기">
        <div className="card-head"><h2>환경 고르기</h2>
          <span className="small muted">{test.length ? `시험용 환경 ${test.length}개(load-/e2e-/test-/tmp-)는 뺐어` : "누르면 아래가 그 환경으로 바뀌어"}</span></div>
        <div className="env-pick" role="tablist">
          {real.map((e) => (
            <button key={e.id} role="tab" aria-selected={e.id === envId} className={e.id === envId ? "on" : ""} onClick={() => setPick(e.id)}>
              <span className="nm">{e.name}</span>
              <span className="small muted">{PROVIDER_LABEL[e.provider]} · {CONN_LABEL[e.connectionStatus]}</span>
            </button>
          ))}
        </div>
      </section>
      {env && <EnvBody key={env.id} env={env} migrations={p.migrations} selected={p.migrationId} onSelect={p.onSelect} />}
      {sel && <MigrationFlow key={sel.id} m={sel} envs={p.envs} />}
      {!sel && (
        <section className="card"><div className="card-head"><h2>이전하면 자원이 어떻게 바뀌나</h2></div>
          <p className="muted">위 "이전 고르기"에서 이전을 고르거나, 아래 표의 "흐름 보기"를 누르면 출발 서비스가 도착에서 무엇이 되는지(예: RDS → Cloud SQL), 어떤 방식·단계로 옮겨지는지, 이전 전·지금·뒤가 나와.</p>
        </section>
      )}
    </div>
  );
}

// ---- 2)·3) 고른 환경 ----

function EnvBody(p: { env: EnvironmentView; migrations: MigrationView[]; selected?: string; onSelect: (id: string | null) => void }) {
  const inv = usePoll(() => inventoryApi.get(p.env.id), 15000, [p.env.id], { keepOnError: false });
  const d = inv.data;
  return (
    <>
      <section className="card" id="env-cloud">
        <div className="card-head">
          <h2>지금 돌고 있는 자원 · {p.env.name}</h2>
          <span className="small muted">{PROVIDER_LABEL[p.env.provider]} · 15초마다 (서버는 30초 캐시)</span>
        </div>
        {inv.loading ? <p className="muted">클라우드에서 읽는 중… (처음엔 몇 초 걸려)</p>
          : inv.error ? <p className="bad">{errText(inv.error)}</p>
          : d ? <CloudTable c={d.cloud} /> : null}
      </section>
      <section className="card" id="env-apps">
        <div className="card-head">
          <h2>이 환경에서 옮기는 앱</h2>
          {d && <span className="small muted">자원: 돌고 있음 {d.totals.running} · 바뀌는 중 {d.totals.changing} · 만들 예정 {d.totals.planned} · 걷음 {d.totals.gone}</span>}
        </div>
        {d ? <AppsTable apps={d.apps} selected={p.selected} onSelect={p.onSelect} migrations={p.migrations} />
          : <p className="muted">{inv.loading ? "읽는 중…" : "—"}</p>}
      </section>
      {p.env.provider === "onprem" && <AgentReports envId={p.env.id} />}
    </>
  );
}

function CloudHead(p: { c: CloudInventory }) {
  const c = p.c;
  const mark = c.status === "ok" ? "✓" : c.status === "partial" ? "◐" : "✕";
  const example = (c.scope ?? "").startsWith("모의 API");
  const word = c.status === "ok" ? (c.source === "azure-mock" ? "Mock 값" : example ? "모의 API 예시" : "직접 읽음") : c.status === "partial" ? "일부만 읽음" : "확인 불가";
  return (
    <div className={`env-status st-${example && c.status === "ok" ? "partial" : c.status}`}>
      <span className="mk" aria-hidden="true">{mark}</span>
      <div>
        <p><b>{word}</b>{c.reason ? ` — ${c.reason}` : ""}</p>
        <p className="small muted">읽은 곳: {SOURCE_LABEL[c.source]}{c.scope ? ` · ${c.scope}` : ""}{c.region ? ` · ${c.region}` : ""} · {fmtTime(c.checkedAt)} · {(c.elapsedMs / 1000).toFixed(1)}초</p>
      </div>
    </div>
  );
}

function CloudTable(p: { c: CloudInventory }) {
  const c = p.c;
  const groups = [...c.groups].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <>
      <CloudHead c={c} />
      {c.status === "unavailable" && groups.length === 0 ? (
        <p className="muted small">가짜 값은 안 보여 줘. 맥에서 API 를 띄운 셸에 자격(AWS_PROFILE·gcloud 로그인·k3d context)이 있으면 여기 실제 목록이 떠.</p>
      ) : (
        <table className="tbl env-tbl">
          <thead><tr><th>종류</th><th>서비스</th><th>이름</th><th>상태</th><th>내용</th></tr></thead>
          <tbody>
            {groups.map((g) => g.error ? (
              <tr key={g.category} className="g-err"><td>{CATEGORY_LABEL[g.category]}</td><td>{g.service}</td><td colSpan={3} className="bad small">읽기 실패: {g.error}</td></tr>
            ) : g.items.length === 0 ? (
              <tr key={g.category} className="g-zero"><td>{CATEGORY_LABEL[g.category]}</td><td>{g.service}</td><td colSpan={3} className="muted small">0개</td></tr>
            ) : g.items.map((x, i) => (
              <tr key={`${g.category}:${x.name}`}>
                <td>{i === 0 ? CATEGORY_LABEL[g.category] : ""}</td><td>{i === 0 ? g.service : ""}</td>
                <td><code>{x.name}</code></td><td>{x.status ?? "—"}</td><td className="small muted">{x.detail ?? ""}</td>
              </tr>
            )))}
          </tbody>
        </table>
      )}
      {groups.length > 0 && <p className="small muted foot">합계 {total}개 · 종류 {groups.length}가지</p>}
    </>
  );
}

function StateChip(p: { r: Pick<FootprintResource, "state" | "evidence"> }) {
  return (
    <span className={`chip fp fp-${STATE_TONE[p.r.state]}`} title={`근거: ${EVIDENCE_LABEL[p.r.evidence]}`}>
      <span className="mk" aria-hidden="true">{STATE_MARK[p.r.state]}</span>{STATE_LABEL[p.r.state]}
    </span>
  );
}

function AppsTable(p: { apps: AppFootprint[]; selected?: string; onSelect: (id: string | null) => void; migrations: MigrationView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (p.apps.length === 0) return <p className="muted">이 환경을 출발이나 도착으로 쓰는 이전이 아직 없어. "이전 만들고 진행하기"에서 만들면 여기 앱과 자원이 생겨.</p>;
  return (
    <table className="tbl env-tbl apps">
      <thead><tr><th>이전</th><th>이 환경은</th><th>상대 환경</th><th>단계</th><th className="r">트래픽</th><th>자원</th><th /></tr></thead>
      <tbody>
        {p.apps.map((a) => {
          const st = (p.migrations.find((m) => m.id === a.migrationId)?.status ?? a.migrationStatus) as MigrationView["status"];
          const n = (s: string[]) => a.resources.filter((r) => s.includes(r.state)).length;
          const isOpen = open === a.migrationId || p.selected === a.migrationId;
          return [
            <tr key={a.migrationId} className={p.selected === a.migrationId ? "sel" : ""}>
              <td><code>{a.migrationId.slice(0, 8)}</code> <StatusChip status={st} />{a.spec && <div className="small muted">{a.spec.app}</div>}</td>
              <td>{a.role === "source" ? "출발 (옮겨 가는 쪽)" : "도착 (옮겨 오는 쪽)"}</td>
              <td>{a.peer.name} <span className="small muted">{PROVIDER_LABEL[a.peer.provider]}</span></td>
              <td>{STAGE_LABEL[a.stage]}</td>
              <td className="r num">{a.trafficPct === null ? "—" : `${a.trafficPct}%`}</td>
              <td className="small">
                {a.resources.length === 0 ? <span className="muted">명세 확정 전 — 아직 모름</span> : <>
                  돌고 있음 {n(["running", "standby"])} · 바뀌는 중 {n(["creating", "stopping"])} · 예정 {n(["planned"])} · 걷음 {n(["removed", "stopped"])}
                  <button className="link" onClick={() => setOpen(isOpen && open === a.migrationId ? null : a.migrationId)} aria-expanded={isOpen}>{isOpen ? "접기" : "자원 펼치기"}</button>
                </>}
              </td>
              <td><button onClick={() => p.onSelect(a.migrationId)} disabled={p.selected === a.migrationId}>{p.selected === a.migrationId ? "보는 중" : "흐름 보기"}</button></td>
            </tr>,
            isOpen && a.resources.length > 0 && (
              <tr key={`${a.migrationId}:r`} className="sub"><td colSpan={7}>
                <ul className="fp-list">
                  {a.resources.map((r) => (
                    <li key={r.type}><StateChip r={r} /><span>{r.label}</span><code className="small muted">{r.type}</code><span className="small muted">{EVIDENCE_LABEL[r.evidence]}</span></li>
                  ))}
                </ul>
              </td></tr>
            ),
          ];
        })}
      </tbody>
    </table>
  );
}

// ---- 4)·5) 고른 이전: 대응표 + 전·지금·뒤 ----

function MigrationFlow(p: { m: MigrationView; envs: EnvironmentView[] }) {
  const live = !isTerminal(p.m.status);
  const src = p.envs.find((e) => e.id === p.m.sourceEnvId), dst = p.envs.find((e) => e.id === p.m.targetEnvId);
  // Z101: 서버 대응표만 (예전 404 → 정적 표 대체는 지웠다)
  const plan = usePoll(async (): Promise<{ v: PlanResourcesView }> => ({ v: await api.planResources(p.m.id) }), live ? 3000 : null, [p.m.id, p.m.status]);
  const srcInv = usePoll(() => (src ? inventoryApi.get(src.id) : Promise.resolve(null)), live ? 5000 : null, [src?.id, p.m.status], { keepOnError: false });
  const dstInv = usePoll(() => (dst ? inventoryApi.get(dst.id) : Promise.resolve(null)), live ? 5000 : null, [dst?.id, p.m.status], { keepOnError: false });
  const v = plan.data?.v;
  const footOf = (inv: EnvInventory | null | undefined) => inv?.apps.find((a) => a.migrationId === p.m.id) ?? null;
  return (
    <>
      <section className="card" id="env-flow">
        <div className="card-head">
          <h2>이전 흐름 · {src?.name ?? "?"} <span className="muted">({src ? PROVIDER_LABEL[src.provider] : "?"})</span> → {dst?.name ?? "?"} <span className="muted">({dst ? PROVIDER_LABEL[dst.provider] : "?"})</span></h2>
          <span className="small"><StatusChip status={p.m.status} /></span>
        </div>
        {plan.loading ? <p className="muted">읽는 중…</p> : plan.error ? <p className="bad">{errText(plan.error)}</p> : v && <>
          <StepStrip rows={v.rows} status={p.m.status} />
          {!v.specKnown && <p className="small muted">명세가 확정되기 전이라 크기·개수는 비어 있어. 서비스 대응은 클라우드 종류만으로 정해져.</p>}
          <table className="tbl env-tbl map">
            <thead><tr><th>무엇</th><th>출발에서 쓰던 것</th><th>도착에서 쓸 것</th><th>옮기는 방식</th><th>단계</th></tr></thead>
            <tbody>
              {v.rows.map((r) => (
                <tr key={r.category} className={r.method === "out_of_scope" ? "off" : ""}>
                  <td>{CATEGORY_LABEL[r.category]}</td>
                  <td>{r.source ? <><b>{r.source.service}</b>{r.source.detail && <div className="small muted">{r.source.detail}</div>}</> : <span className="muted">—</span>}</td>
                  <td>{r.target ? <><b>{r.target.service}</b>{r.target.detail && <div className="small muted">{r.target.detail}</div>}
                    {r.target.tfTypes && r.target.tfTypes.length > 0 && <div className="small muted mono" title={r.target.tfTypes.join("\n")}>Terraform {r.target.tfTypes.length}개: {r.target.tfTypes.slice(0, 2).join(", ")}{r.target.tfTypes.length > 2 ? " …" : ""}</div>}</> : <span className="muted">—</span>}</td>
                  <td className="small">{r.methodLabel}</td>
                  <td className="small"><span className={`ss ss-${r.stepState}`}>{r.step ? `${STEPS.find((s) => s.id === r.step)?.label} · ` : ""}{STEP_STATE_LABEL[r.stepState]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
      </section>
      {v && <BeforeAfter rows={v.rows} src={footOf(srcInv.data)} dst={footOf(dstInv.data)} srcName={src?.name ?? "출발"} dstName={dst?.name ?? "도착"}
        srcProvider={src?.provider} dstProvider={dst?.provider} loading={srcInv.loading || dstInv.loading} />}
    </>
  );
}

function StepStrip(p: { rows: ResourceRow[]; status: MigrationView["status"] }) {
  const stateOf = (id: string): StepState => {
    const xs = p.rows.filter((r) => r.step === id).map((r) => r.stepState);
    return xs.includes("doing") ? "doing" : xs.length && xs.every((x) => x === "done") ? "done" : xs.includes("undone") ? "undone" : xs.includes("done") ? "done" : "todo";
  };
  // 컷오버·정리는 대응표 줄이 없어서 이전 상태로 본다
  const order = ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "completed"];
  const at = order.indexOf(p.status);
  const byStatus = (run: string, doneAt: string): StepState => at < 0 ? (p.status === "rolled_back" || p.status === "cancelled" || p.status === "failed" ? "undone" : "todo")
    : at >= order.indexOf(doneAt) ? "done" : at === order.indexOf(run) ? "doing" : "todo";
  return (
    <ol className="steps" aria-label="이전 단계">
      {STEPS.map((s) => {
        const st = s.id === "cutover" ? byStatus("cutover", "rollback_window") : s.id === "cleanup" ? byStatus("cleanup", "completed") : stateOf(s.id);
        const what = p.rows.filter((r) => r.step === s.id && r.method !== "out_of_scope").map((r) => CATEGORY_LABEL[r.category]);
        return (
          <li key={s.id} className={`st-${st}`} aria-current={st === "doing" ? "step" : undefined}>
            <span className="lb">{s.label} <span className="small muted">· {STEP_STATE_LABEL[st]}</span></span>
            <span className="small muted">{s.what}{what.length ? ` (${what.join("·")})` : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Now(p: { f: AppFootprint | null; cats: FootprintCategory[] | undefined; ingress?: boolean; loading: boolean }) {
  if (p.loading && !p.f) return <span className="muted small">읽는 중…</span>;
  if (!p.f) return <span className="muted small">—</span>;
  if (p.ingress) return <span className="num">{p.f.trafficPct === null ? "—" : `트래픽 ${p.f.trafficPct}%`}</span>;
  const rs = p.f.resources.filter((r) => p.cats?.includes(r.category) && r.type !== "kubernetes_namespace_v1" && r.type !== "core/namespaces");
  if (rs.length === 0) return <span className="muted small">—</span>;
  return <div className="now">{rs.map((r) => <div key={r.type} className="small"><StateChip r={r} /> {r.label}</div>)}</div>;
}

function BeforeAfter(p: { rows: ResourceRow[]; src: AppFootprint | null; dst: AppFootprint | null; srcName: string; dstName: string;
  srcProvider?: Provider; dstProvider?: Provider; loading: boolean }) {
  const rows = p.rows.filter((r) => r.method !== "out_of_scope");
  return (
    <section className="card" id="env-diff">
      <div className="card-head">
        <h2>이전 전 · 지금 · 이전 뒤</h2>
        <span className="small muted">지금 = 플랫폼이 아는 단계(감사 기록·명세 기준) · 5초마다</span>
      </div>
      <div className="diff-wrap">
        <table className="tbl env-tbl diff">
          <thead>
            <tr><th rowSpan={2}>무엇</th><th colSpan={3}>출발 · {p.srcName}</th><th colSpan={3}>도착 · {p.dstName}</th></tr>
            <tr><th>이전 전</th><th>지금</th><th>이전 뒤</th><th>이전 전</th><th>지금</th><th>이전 뒤</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const reuse = r.method === "reuse_existing", ing = r.category === "ingress";
              return (
                <tr key={r.category}>
                  <td>{CATEGORY_LABEL[r.category]}</td>
                  <td className="small">{r.source ? <>{r.source.service}{ing ? " · 트래픽 100%" : ""}</> : <span className="muted">—</span>}</td>
                  <td><Now f={p.src} cats={FOOT_OF[r.category]} ingress={ing} loading={p.loading} /></td>
                  <td className="small">{ing ? "트래픽 0%" : r.afterSource ?? (reuse ? "그대로" : "—")}</td>
                  <td className="small">{reuse ? <>{r.target?.service} (기존)</> : ing ? "트래픽 0%" : <span className="muted">없음</span>}</td>
                  <td><Now f={p.dst} cats={FOOT_OF[r.category]} ingress={ing} loading={p.loading} /></td>
                  <td className="small">{r.target ? <>{r.target.service}{ing ? " · 트래픽 100%" : reuse ? "" : " · 돌고 있음"}</> : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted foot">이전 뒤 출발 DB 는 쓰기를 막은 채 남겨 둬(지울지는 사람이 정함). 롤백 창이 끝나기 전엔 "롤백"으로 출발이 다시 주인이 돼. 칩에 마우스를 올리면 그 값의 근거가 나와.</p>
    </section>
  );
}


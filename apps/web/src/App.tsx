import { useEffect, useState } from "react";
import type { AuthUser } from "./auth";
import { api, DEFAULT_TENANT, setTenant, store, unwrap } from "./api";
import { usePoll } from "./usePoll";
import { Environments } from "./components/Environments";
import { AzureMockCard } from "./components/AzureMockCard";
import { MigrationList, bucketOf } from "./components/MigrationList";
import { MigrationDetail } from "./components/MigrationDetail";
import { DETAIL_SECTIONS, SideMenu, type MenuItem } from "./components/SideMenu";
import { LABEL } from "./status";
import { envNameOf, splitEnvs } from "./envs";
import { goPage, pageDef, useHashRoute, type PageId } from "./router";
import { DashboardPage } from "./pages/DashboardPage";
import { AgentPage } from "./pages/AgentPage";
import { DocsPage } from "./pages/DocsPage";
import { EnvironmentsPage } from "./pages/environments/EnvironmentsPage";
import { CostPage } from "./pages/cost/CostPage";
import { MonitoringPage } from "./pages/monitoring/MonitoringPage";
import { SecurityPage } from "./pages/security/SecurityPage";

// 회사 번호는 uuid여야 서버가 받는다. 치는 중간 값(예: "1111")은 요청을 보내지 않는다
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// vite.config.ts 가 넣는 프록시 대상 주소 (API_URL). 화면에 그대로 보여 준다
const API_TARGET: string = typeof __API_TARGET__ === "string" ? __API_TARGET__ : "API 서버";

// Z101: 예전 fallback 목록 키. 서버 GET /migrations 가 늘 있어 더 안 쓰지만, 옛 브라우저에 남은 값은 ?reset=1 로 지운다
const KNOWN_KEY = "web.knownMigrations";
// Z83-09: 리허설·데모 리셋(demo-reset.sh)은 서버 DB 만 비우고 브라우저 localStorage 는 못 지운다.
// 주소에 ?reset=1 (예: http://localhost:5173/?reset=1 또는 /?reset=1#/dashboard) 을 붙여 열면 화면 표식을 전부 지우고 주소에서 뗀다.
// 지우는 키: 숨김 표식·고른 이전·회사 번호 기억·fallback 목록. 회사 번호(web.tenant)는 그대로(리허설이 같은 회사를 쓴다)
const CLIENT_KEYS = ["web.hiddenMigrations", "web.selected", "web.selectedTenant", KNOWN_KEY] as const;
export function resetClientMarks(): boolean {
  const q = new URLSearchParams(window.location.search);
  if (q.get("reset") !== "1") return false;
  for (const k of CLIENT_KEYS) store.set(k, k === KNOWN_KEY ? "[]" : "");
  q.delete("reset");
  const rest = q.toString();
  history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  return true;
}
resetClientMarks(); // 모듈이 읽히는 순간(첫 렌더 전) — useState 초기값이 지운 뒤 값을 읽게

// Z96: authUser 가 있으면(로그인) 회사는 토큰이 정한다 → 회사 번호 칸 대신 이름·로그아웃. 없으면(DEV_AUTH) 예전 화면 그대로
export interface AppProps { authUser?: AuthUser | null; onLogout?: () => void; onLogin?: () => void }

export function App({ authUser = null, onLogout, onLogin }: AppProps = {}) {
  const page = useHashRoute();
  const [tenant, setTenantState] = useState(() => {
    if (authUser && UUID_RE.test(authUser.tenantId)) return authUser.tenantId.toLowerCase();
    const t = store.get("web.tenant");
    return t && UUID_RE.test(t) ? t : DEFAULT_TENANT;
  });
  const [tenantDraft, setTenantDraft] = useState(tenant);
  const draftValid = UUID_RE.test(tenantDraft);
  const onTenantInput = (v: string) => {
    const t = v.trim();
    setTenantDraft(t);
    if (UUID_RE.test(t) && t.toLowerCase() !== tenant.toLowerCase()) setTenantState(t.toLowerCase());
  };
  const [selected, setSelectedRaw] = useState<string | null>(() => store.get("web.selected") || null);
  // Z83-08: 어느 회사 번호로 고른 이전인지 같이 기억한다. 같은 회사인데 서버 목록에도 없고 조회도 404 면(서버 재시작·DB 초기화) 선택을 자동으로 푼다.
  // 회사 번호를 바꿔서 404 가 난 경우는 그대로 둔다(e2e ux 5: 옛 상세를 지우고 안내만 남김)
  const [selTenant, setSelTenant] = useState(() => store.get("web.selectedTenant") || "");
  const [stale, setStale] = useState<string | null>(null);
  const setSelected = (id: string | null) => { setSelectedRaw(id); setSelTenant(tenant); setStale(null); };

  useEffect(() => { setTenant(tenant); if (!authUser) store.set("web.tenant", tenant); }, [tenant, authUser]);
  setTenant(tenant); // 첫 렌더 전에 요청이 나가도 맞는 헤더를 쓰게
  useEffect(() => { store.set("web.selected", selected ?? ""); }, [selected]);
  useEffect(() => { store.set("web.selectedTenant", selTenant); }, [selTenant]);
  const onNotFound = (id: string) => {
    if (selTenant.toLowerCase() !== tenant.toLowerCase()) return; // 회사 번호를 바꾼 경우는 안내만 남긴다
    setSelectedRaw(null); setStale(id);
  };

  const health = usePoll(() => api.health(), 5000, []);

  // Z101: 서버 목록만 쓴다. 예전의 404 대체(고정 seed 환경 3개·브라우저가 기억한 번호 목록)는 지웠다 — 오류는 오류로 보인다
  const envs = usePoll(async () => ({ items: unwrap(await api.listEnvironments()) }), 10000, [tenant]);
  const migrations = usePoll(async () => ({ items: unwrap(await api.listMigrations()) }), 3000, [tenant]);

  const create = async (src: string, dst: string) => {
    const { id } = await api.createMigration(src, dst);
    setSelected(id);
    void migrations.reload();
  };

  const envList = envs.data?.items ?? [];
  const apiUp = health.data?.ok === true && !health.error;
  const apiText = health.loading ? "API 확인 중…"
    : apiUp ? "API 연결됨"
    : `API 응답 없음 (${API_TARGET}) — npm run dev:api 가 떠 있는지 확인해`;
  // Z83: API 끊김은 맨 위 한 줄 띠 + 다시 시도. 카드마다 빨간 상자를 반복하지 않는다
  const retry = () => { void health.reload(); void envs.reload(); void migrations.reload(); };

  // Z83-04/05: 왼쪽 메뉴. 페이지 7개 + 이전 페이지에서 고른 이전의 상세 칸
  const migItems = migrations.data?.items ?? [];
  const mine = migItems.filter((m) => bucketOf(m) === "mine").length;
  const { real, test } = splitEnvs(envList);
  const counts: Partial<Record<PageId, string>> = {
    dashboard: envList.length ? `환경 ${real.length}${test.length ? `+${test.length}` : ""}` : undefined,
    migrations: migItems.length ? `${migItems.length}${mine ? ` · 차례 ${mine}` : ""}` : undefined,
  };
  const sections: MenuItem[] = [
    { id: "sec-env", label: "환경" },
    { id: "sec-list", label: "이전 목록" },
    ...DETAIL_SECTIONS.map((d) => ({ id: d.id, label: d.label, off: !selected })),
  ];
  const open = (id: string) => { setSelected(id); goPage("migrations"); };
  const sel = migItems.find((m) => m.id === selected);
  const def = pageDef(page);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>이전 콘솔</h1>
          <span className="sub">멀티클라우드 리플랫폼 · 22상태</span>
        </div>
        <span className="api">
          <span className={`dot ${health.loading ? "wait" : apiUp ? "up" : "down"}`} title="GET /healthz" aria-hidden="true" />
          <span className={apiUp || health.loading ? "muted" : "bad"} role="status">{apiText}</span>
        </span>
        {authUser ? (
          <span className="who tenant" data-testid="auth-user">
            <span>{authUser.tenantName ?? <code>{authUser.tenantId.slice(0, 8)}</code>}</span>
            <span aria-hidden="true">·</span>
            <span>{authUser.displayName ?? authUser.email}</span>
            <button type="button" onClick={onLogout} data-testid="logout">로그아웃</button>
          </span>
        ) : (
          <label className="tenant">
            회사 번호 (x-dev-tenant)
            <input value={tenantDraft} onChange={(e) => onTenantInput(e.target.value)} spellCheck={false}
              aria-invalid={!draftValid} className={draftValid ? "" : "invalid"} />
          </label>
        )}
        {!authUser && onLogin && <button type="button" className="link" onClick={onLogin} data-testid="login-open">로그인</button>}
        {!authUser && !draftValid && (
          <span className="tenant-hint bad small">
            uuid 모양(8-4-4-4-12)이 될 때까지 요청을 안 보내. 지금 화면은 <code>{tenant.slice(0, 8)}…</code> 회사 기준이야.
          </span>
        )}
      </header>
      {!health.loading && !apiUp && (
        <div className="banner" role="alert">
          <span>API 서버에 닿지 못했어. 화면의 숫자는 마지막으로 읽은 값이야. <code>npm run dev:api</code> 가 떠 있는지 확인한 뒤 다시 시도해.</span>
          <button onClick={retry}>다시 시도</button>
        </div>
      )}

      <main className={`grid${page === "migrations" ? "" : " grid-page"}`} data-page={page}>
        <SideMenu page={page} counts={counts} sections={sections} />
        {page === "migrations" ? (
          <>
            <aside className="side">
              <div id="sec-env">
                <Environments envs={envList} loading={envs.loading} error={envs.error} />
              </div>
              {/* Z41: 통합 때 header 위로 밀려나 있던 것을 X 원래 자리(환경 표 바로 아래)로 */}
              {envList.filter((e) => e.provider === "azure_mock").map((e) => <AzureMockCard key={e.id} env={e} />)}
              <div id="sec-list">
              <MigrationList
                envs={envList}
                key={tenant}
                items={migItems}
                loading={migrations.loading}
                error={migrations.error}
                selected={selected}
                onSelect={setSelected}
                onCreate={create}
              />
              </div>
            </aside>
            <section className="main">
              {selected
                ? <MigrationDetail key={`${tenant}:${selected}`} id={selected} envs={envList}
                    inList={migrations.data ? migItems.some((m) => m.id === selected) : undefined}
                    onNotFound={onNotFound}
                    onChanged={() => void migrations.reload()} onClose={() => setSelected(null)} />
                : <div className="card empty">왼쪽에서 이전을 고르거나 새로 만들어.
                    {stale && <p className="muted small" data-testid="stale-note">마지막으로 보던 <code>{stale.slice(0, 8)}</code> 는 서버 목록에 없어서 선택을 풀었어 (서버를 다시 띄웠거나 DB 를 비운 뒤면 정상이야).</p>}
                  </div>}
            </section>
          </>
        ) : (
          <section className="main page-main">
            <div className="phead">
              <div>
                <h2>{def.label}</h2>
                <p className="muted">{def.hint}</p>
              </div>
              {def.perMigration && (
                <label className="pick">
                  이전 고르기
                  <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value || null)} aria-label="이전 고르기">
                    <option value="">— 고르지 않음 —</option>
                    {migItems.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id.slice(0, 8)} · {LABEL[m.status]} · {envNameOf(envList, m.sourceEnvId)} → {envNameOf(envList, m.targetEnvId)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {page === "dashboard" && <DashboardPage envs={envList} migrations={migItems} onOpen={open} />}
            {page === "environments" && <EnvironmentsPage envs={envList} migrations={migItems} migrationId={selected ?? undefined} onSelect={setSelected} />}
            {page === "cost" && <CostPage migrationId={selected ?? undefined} />}
            {page === "monitoring" && <MonitoringPage migrationId={selected ?? undefined} status={sel?.status} />}
            {page === "security" && <SecurityPage migrationId={selected ?? undefined} />}
            {page === "agent" && <AgentPage migrationId={selected ?? undefined} />}
            {page === "docs" && <DocsPage />}
          </section>
        )}
      </main>
    </div>
  );
}

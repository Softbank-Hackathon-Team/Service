// 표시 메모: 한눈에 보기. 사람이 지금 할 일 → 돌아가는 것 → 환경 건강 → 최근 기록 순서.
//   정보량: 숫자 타일 4개(전체, 사람 차례, 진행 중, 끝남), 사람 차례 목록 최대 8줄, 진행 중 목록 최대 8줄(줄마다 상태, 번호, 경로, 실패 코드, 열기),
//   환경 표 5칸(이름, 클라우드, 연결, 건강, 자원 수·리전), 가장 최근 이전의 타임라인 전체. 환경 건강은 15초마다 환경 수만큼 읽는다.
import { usePoll } from "../usePoll";
import type { EnvironmentView, MigrationView } from "../types";
import { readEnvHealth, type EnvHealthView, type Health } from "../envHealth";
import { CONN_LABEL, LABEL, PROVIDER_SHORT, isTerminal } from "../status";
import { envNameOf, splitEnvs } from "../envs";
import { BUCKET_LABEL, bucketOf, type Bucket } from "../components/MigrationList";
import { StatusChip } from "../components/StatusChip";
import { Timeline } from "../components/Timeline";
import { errText } from "../components/ErrorBox";
import { hrefOf } from "../router";

// Z83-05: "한눈에 보기". 사람이 지금 뭘 해야 하는지(사람 차례), 돌아가는 게 뭔지(진행 중), 환경이 살아 있는지.
// 숫자는 모두 서버에서 읽은 값. 환경 건강은 envHealth.ts (status 실값, 없으면 inventory 실조회)

const HEALTH: Record<Health, { label: string; cls: string }> = {
  healthy: { label: "정상", cls: "tone-ok" }, degraded: { label: "불안정", cls: "tone-wait" }, unknown: { label: "모름", cls: "" },
};

function useEnvHealth(envs: EnvironmentView[]) {
  const key = envs.map((e) => e.id).join(",");
  return usePoll(async () => {
    const out: Record<string, { s: EnvHealthView | null; note: string }> = {};
    await Promise.all(envs.map(async (e) => {
      try { out[e.id] = { s: await readEnvHealth(e), note: "" }; }
      catch (err) { out[e.id] = { s: null, note: `확인 불가: ${errText(err)}` }; }
    }));
    return out;
  }, 15000, [key]);
}

function Row(p: { m: MigrationView; envs: EnvironmentView[]; onOpen: (id: string) => void }) {
  const m = p.m;
  return (
    <li>
      <StatusChip status={m.status} />
      <code className="mid">{m.id.slice(0, 8)}</code>
      <span className="muted">{envNameOf(p.envs, m.sourceEnvId)} → {envNameOf(p.envs, m.targetEnvId)}</span>
      {m.failureCode && <code className="bad small">{m.failureCode}</code>}
      <button type="button" className="link" onClick={() => p.onOpen(m.id)}>열기</button>
    </li>
  );
}

export function DashboardPage(p: { envs: EnvironmentView[]; migrations: MigrationView[]; onOpen: (id: string) => void }) {
  const { real, test } = splitEnvs(p.envs);
  const health = useEnvHealth(real);
  const counts: Record<Bucket, number> = { all: p.migrations.length, mine: 0, running: 0, done: 0 };
  for (const m of p.migrations) counts[bucketOf(m)] += 1;
  const mine = p.migrations.filter((m) => bucketOf(m) === "mine");
  const running = p.migrations.filter((m) => bucketOf(m) === "running");
  // 최근 기록: 끝나지 않은 것 중 가장 최근 갱신, 없으면 가장 최근 것
  const recent = [...p.migrations].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const focus = recent.find((m) => !isTerminal(m.status)) ?? recent[0];

  return (
    <div className="page pg-dash">
      <div className="tiles" role="list" aria-label="이전 현황">
        {(Object.keys(BUCKET_LABEL) as Bucket[]).map((b) => (
          <a key={b} role="listitem" className={`tile${b === "mine" && counts.mine ? " tile-mine" : ""}`} href={hrefOf("migrations")}>
            <span className="tile-l">{BUCKET_LABEL[b]}</span>
            <span className="tile-v">{counts[b]}</span>
          </a>
        ))}
      </div>

      <div className="two">
        <div className="card" id="dash-mine">
          <div className="card-head"><h3>사람 차례 <span className="mc">{mine.length}</span></h3><span className="muted small">명세 확정·승인·실행, 멈춘 것 다시 보기</span></div>
          {mine.length === 0
            ? <p className="muted">지금 사람이 할 일은 없어. 워커가 알아서 돌고 있어.</p>
            : <ul className="dlist">{mine.slice(0, 8).map((m) => <Row key={m.id} m={m} envs={p.envs} onOpen={p.onOpen} />)}</ul>}
        </div>
        <div className="card" id="dash-running">
          <div className="card-head"><h3>진행 중 <span className="mc">{running.length}</span></h3><span className="muted small">워커가 돌리는 중 (3초마다 새로 읽음)</span></div>
          {running.length === 0
            ? <p className="muted">돌아가는 이전이 없어.</p>
            : <ul className="dlist">{running.slice(0, 8).map((m) => <Row key={m.id} m={m} envs={p.envs} onOpen={p.onOpen} />)}</ul>}
        </div>
      </div>

      <div className="card" id="dash-env">
        <div className="card-head"><h3>환경 <span className="mc">{real.length}{test.length ? `+${test.length}` : ""}</span></h3><span className="muted small">연결 상태와 자원 건강 (15초마다)</span></div>
        <table className="env-tbl">
          <thead><tr><th>이름</th><th>클라우드</th><th>연결</th><th>건강</th><th>자원</th></tr></thead>
          <tbody>
            {real.map((e) => {
              const h = health.data?.[e.id];
              const st = h?.s;
              return (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{PROVIDER_SHORT[e.provider]}</td>
                  <td><span className={`chip ${e.connectionStatus === "connected" ? "tone-ok" : e.connectionStatus === "failed" || e.connectionStatus === "disconnected" ? "tone-bad" : "tone-wait"}`}>{CONN_LABEL[e.connectionStatus]}</span></td>
                  <td>{st ? <><span className={`chip ${HEALTH[st.health].cls}`}>{HEALTH[st.health].label}{st.mock ? " (Mock)" : ""}</span>{st.note && <div className="muted small">{st.note}</div>}</> : <span className="muted small">{h?.note ?? "확인 중…"}</span>}</td>
                  <td className="muted small">{st ? `${st.count}개${st.region ? ` · ${st.region}` : ""}${st.source === "inventory" ? " · 직접 읽음" : ""}` : ""}</td>
                </tr>
              );
            })}
            {real.length === 0 && <tr><td colSpan={5} className="muted">환경이 아직 없어.</td></tr>}
          </tbody>
        </table>
        {test.length > 0 && <p className="muted small">시험용 환경 {test.length}개는 이전 페이지의 "시험용 환경" 접힘 칸에 있어.</p>}
      </div>

      {focus && (
        <div className="card" id="dash-recent">
          <div className="card-head">
            <h3>최근 기록 <code className="mid">{focus.id.slice(0, 8)}</code> <span className="muted small">{LABEL[focus.status]}</span></h3>
            <button type="button" className="link" onClick={() => p.onOpen(focus.id)}>이 이전 열기</button>
          </div>
          <Timeline id={focus.id} live={!isTerminal(focus.status)} />
        </div>
      )}
    </div>
  );
}

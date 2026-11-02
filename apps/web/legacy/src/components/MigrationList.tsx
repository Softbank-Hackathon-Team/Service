// 표시 메모: 이전 목록과 새 이전 폼. 폼: 출발, 도착 선택 + 만들기. 4건 이상이면 묶음(전체, 사람 차례, 진행 중, 끝남), 찾기, 상태순.
//   줄마다 번호, 상태, 경로, 버전, 갱신, 진행 막대. 끝난 이전은 이 브라우저에서만 숨긴다(서버에 삭제 없음).
import { useEffect, useState } from "react";
import type { EnvironmentView, MigrationView } from "../types";
import { HUMAN_STEP, HUMAN_WAIT, LABEL, isTerminal, progressPct, toneOf } from "../status";
import { store } from "../api";
import { is404, isApiDown } from "../api";
import { envNameOf, splitEnvs } from "../envs";
import { ErrorBox } from "./ErrorBox";
import { Loading } from "./Loading";
import { StatusChip } from "./StatusChip";

// 갱신 시각을 "방금 · 3분 전 · 14:02" 로. 목록은 3초마다 다시 읽으므로 초 단위까지는 안 쓴다
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(t).toLocaleDateString("ko-KR");
}

const optionLabel = (e: EnvironmentView) => `${e.name} (${e.provider})`;

// Z83-05: 목록 탐색. 묶음(전체 / 사람 차례 / 진행 중 / 끝남) + 글자 찾기(번호 앞자리·환경 이름·상태 이름) + 정렬(최근 갱신 / 상태순)
export type Bucket = "all" | "mine" | "running" | "done";
export const BUCKET_LABEL: Record<Bucket, string> = { all: "전체", mine: "사람 차례", running: "진행 중", done: "끝남" };
export function bucketOf(m: Pick<MigrationView, "status">): Exclude<Bucket, "all"> {
  if (isTerminal(m.status)) return "done";
  if (HUMAN_STEP.includes(m.status) || HUMAN_WAIT.includes(m.status)) return "mine";
  return "running";
}
export function filterMigrations(items: MigrationView[], envs: EnvironmentView[], bucket: Bucket, q: string, sort: "recent" | "status"): MigrationView[] {
  const needle = q.trim().toLowerCase();
  let out = items.filter((m) => bucket === "all" || bucketOf(m) === bucket);
  if (needle) out = out.filter((m) =>
    m.id.toLowerCase().startsWith(needle) || LABEL[m.status].includes(needle) || m.status.includes(needle)
    || envNameOf(envs, m.sourceEnvId).toLowerCase().includes(needle) || envNameOf(envs, m.targetEnvId).toLowerCase().includes(needle));
  if (sort === "status") {
    const rank = { mine: 0, running: 1, done: 2 } as const;
    out = [...out].sort((a, b) => rank[bucketOf(a)] - rank[bucketOf(b)] || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  return out; // "recent" 는 서버 순서(updatedAt desc) 그대로
}

function EnvOptions({ envs }: { envs: EnvironmentView[] }) {
  const { real, test } = splitEnvs(envs);
  if (test.length === 0) return <>{envs.map((e) => <option key={e.id} value={e.id}>{optionLabel(e)}</option>)}</>;
  return (
    <>
      <optgroup label="실 환경">{real.map((e) => <option key={e.id} value={e.id}>{optionLabel(e)}</option>)}</optgroup>
      <optgroup label="시험용">{test.map((e) => <option key={e.id} value={e.id}>{optionLabel(e)}</option>)}</optgroup>
    </>
  );
}

export function MigrationList(p: {
  envs: EnvironmentView[];
  items: MigrationView[];
  loading: boolean;
  error: unknown;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (src: string, dst: string) => Promise<void>;
}) {
  const [src, setSrc] = useState("");
  const [dst, setDst] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [bucket, setBucket] = useState<Bucket>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "status">("recent");
  // Z83-09: 서버에는 삭제(DELETE)가 없다 — 끝난 이전은 감사 기록이라 남는다(최근 50건). 화면에서만 숨긴다(이 브라우저 localStorage).
  // 숨길 수 있는 건 끝난 것(완료·취소·롤백)뿐. 돌아가는 건 '취소' 버튼으로 끝낸 뒤 숨긴다
  const HIDE_KEY = "web.hiddenMigrations";
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(store.get(HIDE_KEY) ?? "[]") as string[]; } catch { return []; } });
  const [showHidden, setShowHidden] = useState(false);
  const setHiddenSave = (h: string[]) => { setHidden(h); store.set(HIDE_KEY, JSON.stringify(h)); };
  const hide = (id: string) => { setHiddenSave([...hidden.filter((x) => x !== id), id]); if (p.selected === id) p.onSelect(null); };
  const unhideAll = () => setHiddenSave([]);
  // Z83-09: 서버 목록(fallback 아님)에 없는 숨김 표식은 바로 지운다 — 데모 리셋으로 이전이 새로 생기면 옛 표식이 남지 않게
  useEffect(() => {
    if (p.loading || p.items.length === 0) return;
    const live = new Set(p.items.map((m) => m.id));
    const keep = hidden.filter((id) => live.has(id));
    if (keep.length !== hidden.length) setHiddenSave(keep);
  }, [p.items, p.loading]);

  // 고른 값이 지금 보이는 환경 목록에 없으면(회사를 바꿨거나 환경이 사라짐) 버리고 기본값으로
  const has = (id: string) => p.envs.some((e) => e.id === id);
  const source = (has(src) ? src : p.envs[0]?.id) ?? "";
  // Z46: 기본 도착은 실제 클라우드(Mock 아님)를 먼저. 이름순이면 dev-azure-mock 이 dev-gcp 보다 앞이라 Mock 으로 가 버린다 (콘티 S1 은 AWS → GCP)
  const target = (has(dst) ? dst
    : (p.envs.find((e) => e.id !== source && e.provider !== "azure_mock") ?? p.envs.find((e) => e.id !== source))?.id) ?? "";
  const same = !!source && source === target;
  const canCreate = !busy && !!source && !!target && !same;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true); setErr(null);
    try { await p.onCreate(source, target); } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  // 사람 차례인 건 수 (GOV.UK task list: 미완만 눈에 띄게)
  const counts = { all: p.items.length, mine: 0, running: 0, done: 0 };
  for (const m of p.items) counts[bucketOf(m)] += 1;
  const mine = counts.mine;
  const hiddenNow = p.items.filter((m) => hidden.includes(m.id)).length;
  const shown = filterMigrations(showHidden ? p.items : p.items.filter((m) => !hidden.includes(m.id)), p.envs, bucket, q, sort);

  return (
    <div className="card">
      <div className="card-head">
        <h2>이전</h2>
        {p.items.length > 0 && <span className="mcount">{p.items.length}건{mine > 0 && ` · 사람 차례 ${mine}`}</span>}
      </div>
      <div className="form">
        <label>출발
          <select value={source} disabled={p.envs.length === 0} onChange={(e) => { setSrc(e.target.value); setErr(null); }}>
            <EnvOptions envs={p.envs} />
          </select>
        </label>
        <label>도착
          <select value={target} disabled={p.envs.length === 0} onChange={(e) => { setDst(e.target.value); setErr(null); }}>
            <EnvOptions envs={p.envs} />
          </select>
        </label>
        <button className="primary" disabled={!canCreate} onClick={submit}>
          {busy ? "만드는 중…" : "새 이전 만들기"}
        </button>
        {same && <p className="note">출발과 도착이 같아. 다른 환경을 골라야 만들 수 있어.</p>}
        {p.envs.length === 0 && !p.loading && <p className="muted small">환경이 있어야 이전을 만들 수 있어 (위 환경 표 안내 참고).</p>}
        <ErrorBox error={err} hint={(e) => is404(e)
          ? "고른 출발·도착 환경 중 이 회사에서 안 보이는 게 있어. 회사 번호와 환경 목록을 다시 확인해."
          : null} />
      </div>

      {!isApiDown(p.error) && <ErrorBox error={p.error} />}

      {p.items.length > 3 && (
        <div className="mfilter" role="group" aria-label="목록 탐색">
          <div className="mbuckets">
            {(Object.keys(BUCKET_LABEL) as Bucket[]).map((b) => (
              <button key={b} type="button" className={`mb${bucket === b ? " on" : ""}`} aria-pressed={bucket === b} onClick={() => setBucket(b)}>
                {BUCKET_LABEL[b]} <span className="mc">{counts[b]}</span>
              </button>
            ))}
          </div>
          <div className="row">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="번호 앞자리·환경·상태로 찾기" aria-label="이전 찾기" />
            <button type="button" className={`mb${sort === "status" ? " on" : ""}`} aria-pressed={sort === "status"}
              onClick={() => setSort(sort === "status" ? "recent" : "status")} title="켜면 사람 차례 → 진행 중 → 끝남 순, 끄면 최근 갱신 순">
              상태순
            </button>
          </div>
        </div>
      )}
      <ul className="mlist">
        {shown.map((m) => {
          const sel = m.id === p.selected;
          // 줄 전체가 버튼 하나: 마우스·Tab·Enter·Space 모두 같은 동작. "목록에서 빼기"는 버튼 안에 넣지 않고 옆에 둔다
          return (
            <li key={m.id} className={sel ? "sel" : ""}>
              <button type="button" className="mpick" aria-current={sel ? "true" : undefined}
                onClick={() => p.onSelect(m.id)}>
                <span className="mrow">
                  <code title={m.id}>{m.id.slice(0, 8)}</code>
                  <StatusChip status={m.status} />
                </span>
                <span className="msub">
                  <span>{envNameOf(p.envs, m.sourceEnvId)} → {envNameOf(p.envs, m.targetEnvId)} · v{m.version}</span>
                  <span className="num"> · {ago(m.updatedAt)}</span>
                </span>
                <span className="bar" aria-hidden="true"><span className={`fill tone-${toneOf(m.status)}`} style={{ width: `${progressPct(m)}%` }} /></span>
              </button>
              {isTerminal(m.status) && !hidden.includes(m.id) && (
                <button className="link small mforget" onClick={() => hide(m.id)} title="서버 기록은 남고 이 브라우저 목록에서만 사라져">목록에서 숨기기</button>
              )}
              {hidden.includes(m.id) && <span className="muted small mforget">숨김</span>}
            </li>
          );
        })}
        {p.loading && p.items.length === 0 && <li className="muted"><Loading /></li>}
        {!p.loading && !p.error && p.items.length === 0 && <li className="muted">아직 이전이 없어. 위에서 출발·도착을 고르고 "새 이전 만들기"를 눌러.</li>}
        {p.items.length > 0 && shown.length === 0 && <li className="muted">조건에 맞는 이전이 없어. 묶음을 "전체"로 하거나 찾는 글자를 지워.</li>}
        {hiddenNow > 0 && (
          <li className="muted small mhidden">숨긴 이전 {hiddenNow}건 ·{" "}
            <button type="button" className="link small" onClick={() => setShowHidden(!showHidden)}>{showHidden ? "다시 감추기" : "보기"}</button>
            {" · "}<button type="button" className="link small" onClick={unhideAll}>전부 되살리기</button>
            <span className="muted"> — 서버에는 삭제가 없어(감사 기록). 돌아가는 이전은 상세의 '취소'로 끝낸 뒤 숨길 수 있어.</span>
          </li>
        )}
      </ul>
    </div>
  );
}

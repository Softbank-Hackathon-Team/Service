// 보안 회귀 비교 (Z95). 순수 함수: DB·파일·네트워크 없음.
// 입력 = Z91 실점검 결과 LiveSecurityReport 두 개(출발·도착). 같은 열쇠(key)끼리 비교한다.
// 클라우드가 달라도 같은 질문이면 같은 열쇠라서 (RDS ↔ Cloud SQL 모두 public_ports.db) 바로 맞댈 수 있다
import { CHECK_META, type LiveCheck, type LiveCheckKey, type LiveCheckState, type LiveSecurityReport,
  type RegressionChange, type RegressionItem } from "./live/types.js";

// 지켜짐 2 > 알려진 약점 1 > 위반 0. 못 읽음·해당 없음은 순위 없음 → 비교 불가(unknown). 같다고 우기지 않는다
const RANK: Record<LiveCheckState, number | null> = { pass: 2, warn: 1, fail: 0, unavailable: null, n_a: null };
// 화면에 나쁜 것부터: worse → better → unknown → same, 같은 묶음 안은 CHECK_META 순서(영역별)
const ORDER: Record<RegressionChange, number> = { worse: 0, better: 1, unknown: 2, same: 3 };
const KEY_ORDER = new Map((Object.keys(CHECK_META) as LiveCheckKey[]).map((k, i) => [k, i]));

export function judgeChange(before: LiveCheckState | null, after: LiveCheckState | null): RegressionChange {
  const a = before === null ? null : RANK[before], b = after === null ? null : RANK[after];
  if (a === null || b === null) return "unknown";
  return b < a ? "worse" : b > a ? "better" : "same";
}

export interface RegressionOutcome {
  verdict: "regressed" | "no_regression" | "unavailable";
  summary: { worse: number; better: number; same: number; unknown: number };
  items: RegressionItem[];
}

// 같은 보고서 안에 같은 열쇠가 둘이면 먼저 온 줄을 쓴다
const index = (r: LiveSecurityReport | null) => {
  const m = new Map<LiveCheckKey, LiveCheck>();
  for (const c of r?.checks ?? []) if (!m.has(c.key)) m.set(c.key, c);
  return m;
};

// 보고서가 없는 쪽(null)은 모든 줄이 before/after null → unknown. 열쇠 목록 = 양쪽에 나온 열쇠의 합집합
export function compareLiveReports(source: LiveSecurityReport | null, target: LiveSecurityReport | null): RegressionOutcome {
  const s = index(source), t = index(target);
  const keys = [...new Set([...s.keys(), ...t.keys()])];
  const items: RegressionItem[] = keys.map((key) => {
    const b = s.get(key) ?? null, a = t.get(key) ?? null;
    const meta = CHECK_META[key] ?? { category: (b ?? a)!.category, title: (b ?? a)!.title };
    return {
      key, category: meta.category, title: meta.title,
      before: b?.state ?? null, after: a?.state ?? null,
      change: judgeChange(b?.state ?? null, a?.state ?? null),
      beforeEvidence: b?.evidence ?? null, afterEvidence: a?.evidence ?? null,
    };
  });
  items.sort((x, y) => ORDER[x.change] - ORDER[y.change] || (KEY_ORDER.get(x.key) ?? 99) - (KEY_ORDER.get(y.key) ?? 99));
  const summary = { worse: 0, better: 0, same: 0, unknown: 0 };
  for (const i of items) summary[i.change]++;
  // 비교한 줄 = unknown 이 아닌 줄. 0 이면 판정 불가 (Z91 계약 주석)
  const compared = summary.worse + summary.better + summary.same;
  const verdict = summary.worse > 0 ? "regressed" : compared > 0 ? "no_regression" : "unavailable";
  return { verdict, summary, items };
}

import type { ImportResultV2 } from "@svc/contracts";

// PREVIDS2 DRAFT(ai): 다시 가져올 때 앞 판에서 사람이 손댄 칸 유지 (순수 함수, 같은 입력이면 같은 출력).
//   단위 = (자원 id, 칸) 한 쌍. fieldMeta 키 "components.<id>.<칸>" 과 그 아래 "components.<id>.<칸>.<이름>" 이 한 단위이고, 값은 그 자원의 props.<칸>.
//   사람이 손댄 것 = 앞 판 표시가 ① source "human"(PATCH changes) 또는 ② needs_review 가 false 인데 새로 읽은 표시는 true(PATCH confirm).
//   (a) 출발 값이 앞 판의 "가져온 값"과 같다 → 사람 값·표시를 그대로(① 값까지, ② 확인 표시만).
//   (b) 달라졌다 → 새로 읽은 값 + needs_review=true + 메모(CARRY_NOTE). 사람이 정한 값은 버린다(메모로만 알림).
//   가져온 값(baseline): ② 는 앞 판 값 그대로, ① 은 앞 판보다 더 앞에서 그 단위에 사람 표시가 없던 가장 가까운 판의 값. 못 찾으면 모름 = (b).
//   경계: 같은 id 끼리만. 새 판에 그 자원·그 칸 표시가 없으면 건드리지 않는다. links·check.reviews 등 components 밖 키는 그대로.
export const CARRY_NOTE = "출발 값이 바뀜, 앞서 사람이 정한 값 있음";

export interface PrevSpecV2 { spec: ImportResultV2["spec"]; fieldMeta: ImportResultV2["fieldMeta"] }
export interface CarryReport { kept: string[]; flagged: string[] }   // 단위 이름 "<id>.<칸>"

const KEY = /^components\.([a-z][a-z0-9-]{0,39})\.([A-Za-z][A-Za-z0-9]{0,39})(\..*)?$/;
const unitOf = (k: string): string | null => { const m = KEY.exec(k); return m ? `${m[1]}.${m[2]}` : null; };
const propOf = (spec: PrevSpecV2["spec"], unit: string): unknown => {
  const [id, field] = [unit.slice(0, unit.indexOf(".")), unit.slice(unit.indexOf(".") + 1)];
  const c = (spec.components as Array<{ id: string; props?: Record<string, unknown> }>).find((x) => x.id === id);
  return c ? { present: true, value: c.props?.[field] } : undefined;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * @param fresh 새로 읽은 가져오기 결과 (checkV2 전). 입력은 안 바꾸고 복사본을 돌려준다
 * @param history 앞 판들 spec_v2, 가장 새 것부터 (history[0] = 사람이 본 최신 판). 비면 아무것도 안 한다 (첫 가져오기)
 */
export function carryHumanEdits(fresh: ImportResultV2, history: PrevSpecV2[]): { result: ImportResultV2; report: CarryReport } {
  const report: CarryReport = { kept: [], flagged: [] };
  const last = history[0];
  if (!last) return { result: fresh, report };
  const result = structuredClone(fresh);
  const keysByUnit = (meta: PrevSpecV2["fieldMeta"]) => {
    const m = new Map<string, string[]>();
    for (const k of Object.keys(meta)) { const u = unitOf(k); if (u) m.set(u, [...(m.get(u) ?? []), k]); }
    return m;
  };
  const prevUnits = keysByUnit(last.fieldMeta);
  const freshUnits = keysByUnit(result.fieldMeta);
  for (const [unit, prevKeys] of [...prevUnits].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const freshKeys = freshUnits.get(unit);
    const freshProp = propOf(result.spec, unit) as { present: true; value: unknown } | undefined;
    if (!freshKeys || !freshProp) continue;                       // 새 판에 그 자원·칸 표시가 없음 → 건드리지 않음
    const human = prevKeys.filter((k) => last.fieldMeta[k]!.source === "human");
    const confirmed = prevKeys.filter((k) => last.fieldMeta[k]!.source !== "human" && !last.fieldMeta[k]!.needs_review && result.fieldMeta[k]?.needs_review === true);
    if (!human.length && !confirmed.length) continue;
    // 가져온 값
    let baseline: { present: true; value: unknown } | undefined;
    if (!human.length) baseline = propOf(last.spec, unit) as typeof baseline;
    else for (const h of history.slice(1)) {
      const hk = keysByUnit(h.fieldMeta).get(unit) ?? [];
      if (hk.some((k) => h.fieldMeta[k]!.source === "human")) continue;
      baseline = propOf(h.spec, unit) as typeof baseline;
      break;
    }
    const comp = (result.spec.components as Array<{ id: string; props?: Record<string, unknown> }>).find((x) => x.id === unit.slice(0, unit.indexOf(".")))!;
    const field = unit.slice(unit.indexOf(".") + 1);
    if (baseline && same(baseline.value, freshProp.value)) {
      // (a) 그대로 유지
      if (human.length) {
        const value = (propOf(last.spec, unit) as { value: unknown } | undefined)?.value;
        comp.props = { ...(comp.props ?? {}) };
        if (value === undefined) delete comp.props[field]; else comp.props[field] = structuredClone(value);
        for (const k of freshKeys) delete result.fieldMeta[k];
        for (const k of prevKeys) result.fieldMeta[k] = structuredClone(last.fieldMeta[k]!);
      } else for (const k of confirmed) result.fieldMeta[k] = { ...result.fieldMeta[k]!, needs_review: false };
      report.kept.push(unit);
    } else {
      // (b) 새 값 + 다시 검토
      for (const k of human.length ? freshKeys : confirmed) {
        const e = result.fieldMeta[k];
        if (!e) continue;
        const rationale = e.rationale ? `${e.rationale} / ${CARRY_NOTE}` : CARRY_NOTE;
        result.fieldMeta[k] = { ...e, needs_review: true, rationale };
      }
      report.flagged.push(unit);
    }
  }
  return { result, report };
}

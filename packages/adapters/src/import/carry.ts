import type { ImportResultV2 } from "@svc/contracts";

// PREVIDS2 DRAFT(ai): 다시 가져올 때 앞 판에서 사람이 손댄 칸 유지 (순수 함수, 같은 입력이면 같은 출력).
//   단위 = (자원 id, 칸) 한 쌍. fieldMeta 키 "components.<id>.<칸>" 과 그 아래 "components.<id>.<칸>.<이름>" 이 한 단위이고, 값은 그 자원의 props.<칸>.
//   사람이 손댄 것 = 앞 판 표시가 ① source "human"(PATCH changes) 또는 ② needs_review 가 false 인데 새로 읽은 표시는 true(PATCH confirm).
//   (a) 출발 값이 앞 판의 "가져온 값"과 같다 → 사람 값·표시를 그대로(① 값까지, ② 확인 표시만).
//   (b) 달라졌다 → 새로 읽은 값 + needs_review=true + 메모(CARRY_NOTE). 사람이 정한 값은 버린다(메모로만 알림).
//   가져온 값(baseline): ② 는 앞 판 값 그대로, ① 은 앞 판보다 더 앞에서 그 단위에 사람 표시가 없던 가장 가까운 판의 값. 못 찾으면 모름 = (b).
//   경계: 같은 id 끼리만. 새 판에 그 자원·그 칸 표시가 없으면 건드리지 않는다. links·check.reviews 등 components 밖 키는 그대로.
export const CARRY_NOTE = "출발 값이 바뀜, 앞서 사람이 정한 값 있음";

export interface PrevSpecV2 { spec: ImportResultV2["spec"]; fieldMeta: ImportResultV2["fieldMeta"]; fresh?: ImportResultV2["fresh"] }
// G3b-2 DRAFT(ai): 합친 명세가 검증을 못 넘을 때 부르는 쪽이 단위 하나씩 빼 보며 다시 부른다. skip 에 든 단위("<id>.<칸>" 또는 "links"|"entry"|"posture")는
//   사람 값을 옮기지 않고 새로 읽은 값 + 다시 검토(CARRY_SKIP_NOTE)로 둔다 (조용히 출발 값으로 돌아가지 않게)
export const CARRY_SKIP_NOTE = "앞서 사람이 정한 값을 합치면 명세 검증을 못 넘어 새로 읽은 값으로 둠. 사람이 다시 정함";
export interface CarryOptions { skip?: ReadonlySet<string> }
//
// PREVIDS3 DRAFT(ai): 사람 결정 전부 유지 (VPREVIDS2 가 찾은 구멍 3개).
//   ① links·entry·posture: PATCH 가 통째로 바꾸므로 fieldMeta 키 "links"|"entry"|"posture" 가 source "human". 항목 단위 3-way 합치기:
//      바탕 B(그 사람 편집 바로 앞의 사람 표시 없던 판 값) · 사람 H(사람 표시 달린 가장 새 판 값) · 새로 읽은 F.
//      항목 열쇠 = links: from|to|intent · entry: 호스트명들 · posture: permissions(주체|근거|효과|actions|resources), network(namespace 이름 | 주체).
//      H==F 면 합의(그대로). H==B(사람이 안 건드림)면 F 를 따름. 사람이 바꾼 항목: F==B(출발 안 바뀜)면 H, F!=B 면 F + 다시 검토(메모).
//      사람이 지운 항목(B 에 있고 H 에 없음): F==B 면 계속 지움, F!=B 면 F 살림 + 다시 검토. 사람이 넣은 항목(H 에만): 대상(id)이 새 판에 있으면 유지.
//      바탕을 못 찾으면 H 를 대상 있는 항목만 유지 + 다시 검토.
//   ② 판 창: 칸마다 "이 이전에서 그 칸에 사람 표시가 처음 나오는 판"(최근 CARRY_WINDOW 판 안)을 쓴다. 한 판 동안 묶음 밖이었다 돌아와도 유지.
//   ③ 대상이 새 판에 없어 못 옮긴 사람 값은 report.dropped 에 이름만 (값은 안 담음). 판 창 안에 남아 있어 대상이 돌아오면 다시 살아난다.
//   BOUNDPULL 과의 약속: 사람이 경계 안으로 넣은 자원(source human)은 경계 안 유지 — 그 자원의 칸은 새 판에 자원이 있어야만 여기서 다룬다(없으면 dropped).
export const CARRY_WINDOW = 10;
export interface CarryReport { kept: string[]; flagged: string[]; dropped: string[] }   // 단위 이름 "<id>.<칸>" 또는 "links"|"entry"|"posture"(+ 항목은 ":이름")

const KEY = /^components\.([a-z][a-z0-9-]{0,39})\.([A-Za-z][A-Za-z0-9]{0,39})(\..*)?$/;
// BOUNDPULL: components.<id>.boundary 는 칸 값이 아니라 경계 판단 표시(사람이 끌어옴 = source human). 재가져오기 때 included 가 따로 이어 주므로 여기선 단위로 안 센다
const unitOf = (k: string): string | null => { const m = KEY.exec(k); return m && m[2] !== "boundary" ? `${m[1]}.${m[2]}` : null; };
const propOf = (spec: PrevSpecV2["spec"], unit: string): unknown => {
  const [id, field] = [unit.slice(0, unit.indexOf(".")), unit.slice(unit.indexOf(".") + 1)];
  const c = (spec.components as Array<{ id: string; props?: Record<string, unknown> }>).find((x) => x.id === id);
  // VPREVIDS2 고침: 상속 속성(constructor·toString)을 칸 값으로 읽지 않는다 (structuredClone 이 함수에서 던짐)
  return c ? { present: true, value: c.props && Object.hasOwn(c.props, field) ? c.props[field] : undefined } : undefined;
};
// VPREVIDS2/3 고침: 키 순서와 상관없이 같은 값이면 같다 (DB jsonb 는 키를 다시 정렬해서 돌려준다 — JSON.stringify 비교는 {cpuMilli,memMiB} 가 순서만 달라도 다르다고 봤다)
const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

type Meta = PrevSpecV2["fieldMeta"];
type Obj = Record<string, any>;
const keysByUnit = (meta: Meta) => {
  const m = new Map<string, string[]>();
  for (const k of Object.keys(meta)) { const u = unitOf(k); if (u) m.set(u, [...(m.get(u) ?? []), k]); }
  return m;
};
const flagNote = (e: Meta[string]): Meta[string] => ({ ...e, needs_review: true, rationale: e.rationale?.includes(CARRY_NOTE) ? e.rationale : e.rationale ? `${e.rationale} / ${CARRY_NOTE}` : CARRY_NOTE });

/**
 * @param fresh 새로 읽은 가져오기 결과 (checkV2 전). 입력은 안 바꾸고 복사본을 돌려준다
 * @param history 앞 판들 spec_v2, 가장 새 것부터 (history[0] = 사람이 본 최신 판). 비면 아무것도 안 한다 (첫 가져오기). 앞 CARRY_WINDOW 개만 본다
 */
export function carryHumanEdits(fresh: ImportResultV2, history: PrevSpecV2[], opts: CarryOptions = {}): { result: ImportResultV2; report: CarryReport } {
  const report: CarryReport = { kept: [], flagged: [], dropped: [] };
  if (!history[0]) return { result: fresh, report };
  const skip = opts.skip ?? new Set<string>();
  const skipNote = (e: Meta[string]): Meta[string] => ({ ...e, needs_review: true, rationale: e.rationale?.includes(CARRY_SKIP_NOTE) ? e.rationale : e.rationale ? `${e.rationale} / ${CARRY_SKIP_NOTE}` : CARRY_SKIP_NOTE });
  const hist = history.slice(0, CARRY_WINDOW);
  const result = structuredClone(fresh);
  const freshUnits = keysByUnit(result.fieldMeta);
  const claimed = new Set<string>();
  // ── 부품 칸 (판 창: 칸마다 가장 새 판에서 처음 나오는 곳을 쓴다) ──
  for (const [vi, last] of hist.entries()) {
    for (const [unit, prevKeys] of [...keysByUnit(last.fieldMeta)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (claimed.has(unit)) continue;
      // 가장 새 판이 그 단위를 차지한다 (사람이 출발 값으로 되돌린 판이면 더 옛 사람 값을 되살리지 않음).
      //   G3b-2: 합치기를 못 해 뺀 단위는 그 판에 다시 검토 표시(CARRY_SKIP_NOTE)가 남으므로 더는 조용히 사라지지 않는다
      claimed.add(unit);
      const human = prevKeys.filter((k) => last.fieldMeta[k]!.source === "human");
      const freshKeys = freshUnits.get(unit);
      const confirmed = prevKeys.filter((k) => last.fieldMeta[k]!.source !== "human" && !last.fieldMeta[k]!.needs_review && result.fieldMeta[k]?.needs_review === true);
      if (!human.length && !confirmed.length) continue;
      if (skip.has(unit)) {
        for (const k of freshKeys ?? []) { const e = result.fieldMeta[k]; if (e) result.fieldMeta[k] = skipNote(e); }
        report.flagged.push(unit);
        continue;
      }
      const freshProp = propOf(result.spec, unit) as { present: true; value: unknown } | undefined;
      if (!freshKeys || !freshProp) { report.dropped.push(unit); continue; }   // 대상 없음 (경계 밖·출발에서 사라짐)
      // 가져온 값
      let baseline: { present: true; value: unknown } | undefined;
      if (!human.length) baseline = propOf(last.spec, unit) as typeof baseline;
      else for (const h of hist.slice(vi + 1)) {
        const hk = keysByUnit(h.fieldMeta).get(unit) ?? [];
        if (hk.length === 0 || hk.some((k) => h.fieldMeta[k]!.source === "human")) continue;
        baseline = propOf(h.spec, unit) as typeof baseline;
        break;
      }
      const comp = (result.spec.components as Array<{ id: string; props?: Record<string, unknown> }>).find((x) => x.id === unit.slice(0, unit.indexOf(".")))!;
      const field = unit.slice(unit.indexOf(".") + 1);
      if (baseline && same(baseline.value, freshProp.value)) {
        if (human.length) {   // (a) 그대로 유지
          const value = (propOf(last.spec, unit) as { value: unknown } | undefined)?.value;
          comp.props = { ...(comp.props ?? {}) };
          if (value === undefined) delete comp.props[field]; else comp.props[field] = structuredClone(value);
          for (const k of freshKeys) delete result.fieldMeta[k];
          for (const k of prevKeys) result.fieldMeta[k] = structuredClone(last.fieldMeta[k]!);
        } else for (const k of confirmed) result.fieldMeta[k] = { ...result.fieldMeta[k]!, needs_review: false };
        report.kept.push(unit);
      } else if (human.length && !baseline && pulledByHuman(last, unit.slice(0, unit.indexOf(".")))) {
        // VPREVIDS3 DRAFT(ai): 끌어오기와 고치기를 한 요청에 한 자원은 사람 표시 없던 앞 판에 그 자원이 아예 없어 바탕을 못 찾는다.
        //   그렇다고 "출발이 바뀜"으로 보고 사람 값을 버리면 끌어온 직후 고친 값이 첫 재가져오기에서 사라진다 → 사람 값 유지 + 다시 검토(바탕 모름, links·entry·posture 와 같은 규칙)
        const value = (propOf(last.spec, unit) as { value: unknown } | undefined)?.value;
        comp.props = { ...(comp.props ?? {}) };
        if (value === undefined) delete comp.props[field]; else comp.props[field] = structuredClone(value);
        for (const k of freshKeys) delete result.fieldMeta[k];
        for (const k of prevKeys) result.fieldMeta[k] = flagNote(last.fieldMeta[k]!);
        report.flagged.push(unit);
      } else {   // (b) 새 값 + 다시 검토
        for (const k of human.length ? freshKeys : confirmed) { const e = result.fieldMeta[k]; if (e) result.fieldMeta[k] = flagNote(e); }
        report.flagged.push(unit);
      }
    }
  }
  // ── links · entry · posture · security (PREVIDS3) ──
  const ids = new Set((result.spec.components as Array<{ id: string }>).map((c) => c.id));
  for (const key of ["links", "entry", "posture", "security", "secrets"] as const) {
    const hi = hist.findIndex((h) => h.fieldMeta[key]?.source === "human");
    if (hi < 0) continue;
    const H = hist[hi]!;
    if (skip.has(key)) {   // G3b-2: 사람 값을 합치면 검증을 못 넘음 → 새로 읽은 값 + 다시 검토
      const prev = H.fieldMeta[key]!;
      result.fieldMeta[key] = skipNote(prev);
      report.flagged.push(key);
      continue;
    }
    // G3b-1: 바탕 B = 사람 판(H)을 만든 가져오기가 그때 새로 읽은 값(H.fresh). 없으면(옛 판) 예전처럼 사람 표시 없던 가장 가까운 앞 판
    const freshB = key !== "security" && H.fresh ? { has: true, value: (H.fresh as Obj)[key] } : null;
    const B = freshB ? undefined : hist.slice(hi + 1).find((h) => h.fieldMeta[key]?.source !== "human");
    const out = mergeTop(key, freshB ? freshB.value : B ? (B.spec as Obj)[key] : undefined, freshB ? true : !!B, (H.spec as Obj)[key], (result.spec as Obj)[key], ids);
    (result.spec as Obj)[key] = out.value;
    if (out.value === undefined) delete (result.spec as Obj)[key];
    report.dropped.push(...out.dropped.map((d) => `${key}:${d}`));
    const prev = H.fieldMeta[key]!;
    result.fieldMeta[key] = out.conflict ? flagNote(prev) : structuredClone(prev);
    // 하위 표시: 사람 판의 것을 그대로 (그 판이 항목에 대해 정한 표시), 합쳐서 사라진 링크의 새 표시는 지움
    for (const k of Object.keys(H.fieldMeta)) if (k.startsWith(`${key}.`)) result.fieldMeta[k] = structuredClone(H.fieldMeta[k]!);
    if (key === "links") for (const k of Object.keys(result.fieldMeta)) {
      const m = /^links\.(.+)->(.+)$/.exec(k);
      if (m && !(out.value as Obj[]).some((l) => l.from === m[1] && (typeof l.to === "string" ? l.to : "") === m[2])) delete result.fieldMeta[k];
    }
    (out.conflict ? report.flagged : report.kept).push(key);
  }
  // G3b-7 DRAFT(ai): components 밖 확인 표시도 이어받는다. 앞 판에서 사람이 확인(needs_review false, 사람 값 아님)했고 새 판에 같은 키가 검토 필요로 다시 생겼을 때
  //   - check.* : 내용 키(자리 + 값 지문)라 같은 키 = 같은 값 → 확인 유지
  //   - links.<a>-><b> : 그 링크 항목(의도·grants)이 앞 판과 같을 때만 유지
  //   entry.<호스트>.routes[i] 는 번호 키라 같은 경로인지 못 가려 이어받지 않는다 (안전한 쪽)
  const prev0 = hist[0]!;
  const linkOf = (spec: PrevSpecV2["spec"], k: string) => { const m = /^links\.(.+)->(.+)$/.exec(k); return m ? (spec.links as Obj[]).find((l) => l.from === m[1] && (typeof l.to === "string" ? l.to : "") === m[2]) : undefined; };
  for (const [k, pm] of Object.entries(prev0.fieldMeta)) {
    const fm = result.fieldMeta[k];
    if (!fm || !fm.needs_review || pm.needs_review || pm.source === "human") continue;
    if (k.startsWith("check.") || (k.startsWith("links.") && !skip.has("links") && linkOf(prev0.spec, k) !== undefined && same(linkOf(prev0.spec, k), linkOf(result.spec, k)))) {
      result.fieldMeta[k] = { ...fm, needs_review: false };
      report.kept.push(k);
    }
  }
  return { result, report };
}

/** 사람이 경계 밖에서 끌어온 자원이다 (boundary 표시가 human). 바탕을 못 찾은 사람 값이 이 자원 것이면 호출부가 유지 + 다시 검토로 본다 */
function pulledByHuman(h: PrevSpecV2, id: string): boolean {
  return h.fieldMeta[`components.${id}.boundary`]?.source === "human";
}

// ── 항목 단위 3-way 합치기 ──────────────────────────────
interface Spec3 { keyOf: (x: Obj) => string; exists: (x: Obj) => boolean; keysOf?: (a: Obj[]) => string[] }
function merge3(Bi: Obj[] | undefined, Hi: Obj[], Fi: Obj[], sp: Spec3): { items: Obj[]; conflict: boolean; dropped: string[] } {
  const keys = (a: Obj[]) => sp.keysOf ? sp.keysOf(a) : a.map(sp.keyOf);
  const idx = (a: Obj[]) => new Map(keys(a).map((k, i) => [k, a[i]!]));
  const B = Bi ? idx(Bi) : undefined, H = idx(Hi), F = idx(Fi);
  const out: Obj[] = []; const dropped: string[] = []; let conflict = false;
  if (!B) {   // 바탕을 못 찾음: 사람 값 그대로(대상 있는 것) + 출발에서만 나온 항목, 사람 값과 출발이 다르면 다시 검토
    Hi.forEach((h, i) => { if (!sp.exists(h)) dropped.push(keys(Hi)[i]!); });
    return { items: [...Hi.filter((h) => sp.exists(h)), ...Fi.filter((_f, i) => !H.has(keys(Fi)[i]!))], conflict: !same(Hi, Fi), dropped };
  }
  const used = new Set<string>();
  for (const [k, f] of F) {
    used.add(k);
    const h = H.get(k), b = B.get(k);
    if (h === undefined && b === undefined) { out.push(f); continue; }  // 새로 읽힌 항목
    if (h !== undefined && same(h, f)) { out.push(f); continue; }       // 합의
    if (h === undefined) {                                           // 사람이 지움
      if (b !== undefined && same(b, f)) continue;                   // 출발 안 바뀜 → 계속 지움
      out.push(f); conflict = true; continue;                        // 출발이 바뀜 → 살리고 다시 검토
    }
    if (b !== undefined && same(h, b)) { out.push(f); continue; }    // 사람이 안 건드림 → 출발 따름
    if (b !== undefined && same(b, f)) { out.push(h); continue; }    // 사람이 바꿈, 출발 그대로 → 사람 값
    out.push(f); conflict = true;                                    // 둘 다 바뀜 → 출발 값 + 다시 검토
  }
  for (const [k, h] of H) {                                          // 사람이 넣은 항목 (새 판에 없는 것 중 바탕에도 없던 것)
    if (used.has(k) || B.has(k)) continue;
    if (sp.exists(h)) out.push(h); else dropped.push(k);
  }
  // 사람이 바꾼 항목인데 새 판에서 출발이 사라진 경우(F 에 없고 B·H 에 있음): 사람 값이면 유지, 아니면 출발에서 사라진 것이니 뺌
  for (const [k, h] of H) {
    if (used.has(k) || !B.has(k)) continue;
    if (!same(h, B.get(k))) { if (sp.exists(h)) { out.push(h); conflict = true; } else dropped.push(k); }
  }
  return { items: out, conflict, dropped };
}

const str = (x: unknown) => canon(x);
function mergeTop(key: "links" | "entry" | "posture" | "security" | "secrets", B: unknown, hasB: boolean, H: unknown, F: unknown, ids: Set<string>): { value: unknown; conflict: boolean; dropped: string[] } {
  // security 는 가져오기가 채우지 않는다 (F 는 늘 비어 있음). 사람이 넣은 요구사항을 그대로 둔다
  if (key === "security") return { value: H, conflict: false, dropped: [] };
  const idOk = (id: unknown) => typeof id === "string" && ids.has(id);
  if (key === "links") {
    const r = merge3(hasB ? (B as Obj[]) ?? [] : undefined, (H as Obj[]) ?? [], (F as Obj[]) ?? [], {
      // 항목 열쇠 = (from,to). G3c-6: checkV2 가 같은 (from,to) 두 줄을 막으므로 intent 로 가르는 갈래는 없앴다 (intent 를 사람이 바꿔도 같은 항목)
      keyOf: (l) => `${l.from}->${typeof l.to === "string" ? l.to : str(l.to)}`,
      exists: (l) => idOk(l.from) && (typeof l.to !== "string" || idOk(l.to)),
    });
    return { value: r.items, conflict: r.conflict, dropped: r.dropped };
  }
  // T1·SC-1: 비밀 표. 항목 = 비밀 이름. 사람이 켠 binary·고친 짝은 출발(이름·키 목록·type 추정)이 안 바뀌면 유지. 짝 대상이 새 판에 없으면 못 옮김
  if (key === "secrets") {
    const r = merge3(hasB ? (B as Obj[]) ?? [] : undefined, (H as Obj[]) ?? [], (F as Obj[]) ?? [], {
      keyOf: (s) => String(s.name),
      exists: (s) => ((s.keys ?? []) as Obj[]).every((k) => !k.pairedWith || idOk((k.pairedWith as Obj).component)),
    });
    return { value: r.items.length ? [...r.items].sort((a, b) => String(a.name).localeCompare(String(b.name))) : undefined, conflict: r.conflict, dropped: r.dropped };
  }
  if (key === "entry") {
    const hostsOf = (e: unknown) => ((e as Obj | undefined)?.hosts ?? []) as Obj[];
    const r = merge3(hasB ? hostsOf(B) : undefined, hostsOf(H), hostsOf(F), {
      keyOf: (h) => (h.hostnames as string[]).join(","),
      exists: (h) => (h.routes as Obj[]).every((rt) => (rt.backends as Obj[]).every((b) => idOk(b.to))),
    });
    const base = (F ?? H) as Obj | undefined;
    return { value: r.items.length ? { ...(base ?? { via: "cloudflare-lb" }), hosts: r.items } : undefined, conflict: r.conflict, dropped: r.dropped };
  }
  const P = (x: unknown) => ((x ?? { permissions: [], network: [] }) as { permissions: Obj[]; network: Obj[] });
  const perm = merge3(hasB ? P(B).permissions : undefined, P(H).permissions, P(F).permissions, {
    keyOf: (p) => `${p.subject}|${p.source}|${p.effect}|${str(p.actions)}|${str(p.resources)}`,
    exists: (p) => idOk(p.subject),
  });
  const net = merge3(hasB ? P(B).network : undefined, P(H).network, P(F).network, {
    keyOf: (n) => (n.scope === "namespace" ? `ns:${n.namespace}` : `c:${n.subject}`),
    exists: (n) => n.scope === "namespace" || idOk(n.subject),
  });
  return { value: { ...((F ?? H) as Obj), permissions: perm.items, network: net.items }, conflict: perm.conflict || net.conflict, dropped: [...perm.dropped, ...net.dropped] };
}

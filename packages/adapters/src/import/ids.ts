import type { MappedComponent } from "./types.js";

// DRAFT(ai): id 정하기 (설계 20번 5.1장 "결정성", PoC assignIds).
//   열쇠 = 벤더 고유 ID(ARN·selfLink) → 없으면 종류/범위/네임스페이스/이름.
//   ① 이전 판에 같은 열쇠가 있으면 그 id 를 그대로 (다시 가져와도 같은 자원 = 같은 id)
//   ② 새로 온 것: 워크로드(service·job)를 먼저. 워크로드끼리 이름이 겹치면 네임스페이스를 붙이고,
//      나머지가 겹치면 종류를 붙인다. 그래도 겹치면 열쇠 해시 4자리, 그래도 겹치면 -2, -3 …

/** 글자로 시작, 소문자·숫자·하이픈, 40자 이하 */
export const slug = (s: string): string => {
  const x = String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return /^[a-z]/.test(x) ? x : `c-${x}`.slice(0, 40).replace(/-+$/, "");
};
const hash4 = (s: string): string => {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h.toString(36).padStart(4, "0").slice(-4);
};
export const nativeKey = (c: MappedComponent): string =>
  c.native.uid ?? `${c.native.type}/${c.native.scope ?? ""}/${c.ns ?? ""}/${c.name}`;

const byKey = (a: MappedComponent, b: MappedComponent) => (nativeKey(a) < nativeKey(b) ? -1 : nativeKey(a) > nativeKey(b) ? 1 : 0);
const isWorkload = (c: MappedComponent) => c.kind === "service" || c.kind === "job";

/** c.id 를 채운다 (제자리). 반환 = 열쇠 → id */
export function assignIds(cs: MappedComponent[], previous: Record<string, string> = {}): Record<string, string> {
  const used = new Set<string>();
  for (const c of [...cs].sort(byKey)) {
    const prev = previous[nativeKey(c)];
    if (prev && !used.has(prev)) { c.id = prev; used.add(prev); }
  }
  const fresh = cs.filter((c) => !c.id).sort(byKey);
  const count = (list: MappedComponent[]) => {
    const n = new Map<string, number>();
    for (const c of list) n.set(slug(c.name), (n.get(slug(c.name)) ?? 0) + 1);
    return n;
  };
  const size = count(fresh);
  const wsCount = count(fresh.filter(isWorkload));
  const take = (c: MappedComponent, first: string) => {
    let cand = first;
    if (used.has(cand) && !isWorkload(c)) cand = slug(`${c.kind}-${c.name}`);   // 이름이 이미 쓰였으면 종류를 붙여 본다
    if (used.has(cand)) cand = slug(`${cand.slice(0, 35)}-${hash4(nativeKey(c))}`);
    for (let n = 2; used.has(cand); n++) cand = `${cand.slice(0, 37)}-${n}`;
    c.id = cand; used.add(cand);
  };
  for (const c of fresh.filter(isWorkload)) take(c, wsCount.get(slug(c.name)) === 1 ? slug(c.name) : slug(`${c.ns ?? c.kind}-${c.name}`));
  for (const c of fresh.filter((x) => !isWorkload(x))) take(c, size.get(slug(c.name)) === 1 ? slug(c.name) : slug(`${c.kind}-${c.name}`));
  return Object.fromEntries(cs.map((c) => [nativeKey(c), c.id!]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
}

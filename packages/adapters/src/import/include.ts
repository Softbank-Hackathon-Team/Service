import { type BoundaryPoolItem, type ImportResultV2 } from "@svc/contracts";

// BOUNDPULL DRAFT(ai): 사람이 경계 밖 목록에서 데이터 자원을 명세 안으로 끌어오기 (PATCH include) 와 재가져오기 때 그 선택 유지. 순수 함수.
//   재료 = 가져오기 때 판 안에 둔 boundaryPool (매퍼 결과). 원본(인벤토리)은 저장하지 않으므로 풀에 없으면 만들 수 없다 → "unavailable"(409)
//   워크로드(서비스·잡)는 풀에 없다: 앱 묶음(IMPORT_APP)으로 빠진 것은 끌어올 수 없고, 앱 이름을 바꿔 다시 가져와야 한다
//   끌어온 자원은 fieldMeta components.<id>.boundary = {source:"human", confidence:1, needs_review:true} (사람이 넣었으니 값은 확인 필요).
//   링크는 만들지 않는다 (어느 워크로드가 쓰는지 모름) — 사람이 links 를 PATCH 로 고친다.

export type IncludeFailure = "not_found" | "already" | "unavailable";
export class IncludeError extends Error {
  constructor(readonly failure: IncludeFailure, readonly resource: string, message: string) { super(message); }
}

export interface IncludeOut {
  result: ImportResultV2;
  added: string[];
}

/** names = outOfBoundary.resource. 하나라도 못 끌어오면 IncludeError (아무것도 바꾸지 않음). 입력은 안 바꿈 */
export function applyInclude(base: ImportResultV2, names: string[], opts: { lenient?: boolean } = {}): IncludeOut {
  const result = structuredClone(base) as ImportResultV2;
  const added: string[] = [];
  const out = result.outOfBoundary ?? [];
  const pool = { ...(result.boundaryPool ?? {}) } as Record<string, BoundaryPoolItem>;
  const included = new Set(result.included ?? []);
  for (const name of [...new Set(names)]) {
    const o = out.find((x) => x.resource === name);
    if (!o) {
      if (included.has(name) && !opts.lenient) throw new IncludeError("already", name, `${name}: 이미 명세 안으로 끌어온 자원`);
      if (opts.lenient) continue;   // 재가져오기: 원본에서 사라졌거나 이미 안에 있음 = 조용히 넘어감
      throw new IncludeError("not_found", name, `${name}: 경계 밖 목록에 없음 (이름이 틀렸거나 이미 명세 안에 있음)`);
    }
    const item = pool[name];
    if (!item) {
      if (opts.lenient) continue;
      throw new IncludeError("unavailable", name,
        `${name}: 끌어올 재료가 판에 없음 (${o.kind === "service" || o.kind === "job" ? "워크로드는 앱 묶음(IMPORT_APP)을 바꿔 다시 가져와야 함" : "재료 저장 전 판이면 다시 가져오기 필요"})`);
    }
    if (result.spec.components.some((c) => c.id === item.component.id)) {
      if (opts.lenient) continue;
      throw new IncludeError("unavailable", name, `${name}: 같은 id(${item.component.id}) 구성요소가 이미 명세에 있음`);
    }
    result.spec.components = [...result.spec.components, structuredClone(item.component)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    Object.assign(result.fieldMeta, structuredClone(item.fieldMeta));
    result.fieldMeta[`components.${item.component.id}.boundary`] = { source: "human", confidence: 1, needs_review: true,
      rationale: `사람이 경계 밖 목록에서 끌어옴 (${o.reason.slice(0, 120)}). 이 앱 자원이 맞는지·값이 맞는지 확인 필요` };
    delete pool[name];
    included.add(name);
    added.push(name);
  }
  result.outOfBoundary = out.filter((x) => !added.includes(x.resource));
  if (Object.keys(pool).length) result.boundaryPool = pool; else delete result.boundaryPool;
  if (included.size) result.included = [...included].sort();
  result.fieldMeta = Object.fromEntries(Object.entries(result.fieldMeta).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return { result, added };
}

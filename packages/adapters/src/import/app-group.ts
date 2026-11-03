import type { FieldMetaV2, OutOfBoundaryV2 } from "@svc/contracts";
import type { MappedComponent } from "./types.js";

// PARTOF DRAFT(ai): 앱 경계 2순위 — 워크로드를 "앱 묶음" 라벨로 한정 (설계 20번 5.1장, ALIGN-v2 IR-3).
//   묶음 값 = 워크로드 라벨에서 앞 열쇠부터 처음 있는 것.
//     k8s(Deployment·CronJob): app.kubernetes.io/part-of → app.kubernetes.io/name (k8s 의 맨 "app" 라벨은 보통 Deployment 이름이라 안 씀)
//     Cloud Run·그 밖(라벨에 "/"·"." 못 씀): part-of → app
//   ECS 는 지금 원본에 태그가 없어(reader 가 안 읽음) 묶음 값 없음 = 아래 "라벨 없음" 취급.
//   고르는 값: 작업 입력(opts.partOf, 연결 화면에서 고른 앱 이름) → 없거나 맞는 워크로드가 없으면 워크로드가 가장 많은 묶음(같으면 이름순 앞) + 검토 표시.
//   라벨이 하나도 없으면 아무것도 안 함 (BOUNDARY v1 그대로).
//   입력 없이 모든 묶음이 워크로드 1개짜리면 고를 근거가 없어 한정하지 않고 검토만 표시 (name 라벨이 워크로드마다 다른 흔한 Helm 모양).
//   라벨이 없는 워크로드는 묶음 밖이라고 단정할 근거가 없어 두고 0.6 검토 표시.
//   묶음 밖 워크로드는 outOfBoundary (이름·종류만). 데이터 자원 경계(BOUNDARY)는 남은 워크로드 기준으로 그 뒤에 계산된다.

const K8S_KEYS = ["app.kubernetes.io/part-of", "app.kubernetes.io/name"];
// PARTOF: Deployment·CronJob 자신의 metadata.labels 중 앱 묶음 라벨만 (Pod 템플릿 라벨은 native.labels 에 이미 있음)
export const appLabelsOf = (l: Record<string, string> | undefined): Record<string, string> | undefined => {
  const o = Object.fromEntries(K8S_KEYS.filter((k) => typeof l?.[k] === "string").map((k) => [k, l![k]!]));
  return Object.keys(o).length ? o : undefined;
};

const LABEL_KEYS = ["part-of", "app"];
const isWorkload = (c: MappedComponent) => c.kind === "service" || c.kind === "job";
const keysOf = (c: MappedComponent) => (c.native.type.startsWith("k8s.") ? K8S_KEYS : LABEL_KEYS);

/** 워크로드의 앱 묶음 [열쇠, 값]. 없으면 null */
export function appGroupOf(c: MappedComponent): [string, string] | null {
  const labels = { ...(c.native.labels ?? {}), ...(c.native.appLabels ?? {}) };
  for (const k of keysOf(c)) {
    const v = labels[k];
    if (typeof v === "string" && v.trim()) return [k, v.trim()];
  }
  return null;
}

export interface AppGroupOut {
  components: MappedComponent[];
  outOfBoundary: OutOfBoundaryV2[];
  /** 고른 묶음 값 (한정 안 했으면 null) */
  chosen: string | null;
}

/** components(id 정해진 뒤) → 고른 묶음의 워크로드 + 데이터 자원 전부. fieldMeta 는 제자리에서 고친다 */
export function selectAppGroup(components: MappedComponent[], fieldMeta: FieldMetaV2, partOf?: string): AppGroupOut {
  const workloads = components.filter(isWorkload);
  const groups = new Map<string, MappedComponent[]>();
  for (const w of workloads) {
    const g = appGroupOf(w);
    if (g) groups.set(g[1], [...(groups.get(g[1]) ?? []), w]);
  }
  if (!groups.size) return { components, outOfBoundary: [], chosen: null };
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const want = partOf?.trim();
  let chosen: string, source: string, confidence: 1 | 0.6, rationale: string | undefined;
  if (want && groups.has(want)) {
    chosen = want; source = "input:partOf"; confidence = 1;
  } else {
    if (ranked.length > 1 && ranked[0]![1].length === 1) {
      for (const w of workloads)
        fieldMeta[`components.${w.id}.appGroup`] = { source: "label:app-group", confidence: 0.6, needs_review: true,
          rationale: `앱 묶음 라벨 값이 워크로드마다 달라(${ranked.length}개) 한 앱을 고를 근거가 없음 → 한정하지 않음. 이 앱 워크로드가 맞는지 사람 확인` };
      return { components, outOfBoundary: [], chosen: null };
    }
    chosen = ranked[0]![0]; source = "label:most-workloads"; confidence = 0.6;
    rationale = `${want ? `입력한 앱 "${want.slice(0, 63)}" 과 같은 라벨 묶음이 없어 ` : ""}워크로드가 가장 많은 묶음(${ranked[0]![1].length}개)을 고름. 다른 묶음 ${ranked.length - 1}개는 경계 밖. 사람 확인 필요`;
  }
  const keep = new Set<MappedComponent>();
  for (const c of components) {
    if (!isWorkload(c)) { keep.add(c); continue; }
    const g = appGroupOf(c);
    if (!g) {
      keep.add(c);
      fieldMeta[`components.${c.id}.appGroup`] = { source: "label:none", confidence: 0.6, needs_review: true,
        rationale: `앱 묶음 라벨이 없음 → 묶음 "${chosen}" 밖이라고 단정 못 해 둠. 이 앱 것인지 사람 확인` };
      continue;
    }
    if (g[1] !== chosen) continue;
    keep.add(c);
    fieldMeta[`components.${c.id}.appGroup`] = { source: `${source}:${g[0]}=${chosen}`, confidence, needs_review: confidence < 1, ...(rationale ? { rationale } : {}) };
  }
  const out = components.filter((c) => !keep.has(c));
  const gone = new Set(out.map((c) => c.id!));
  for (const k of Object.keys(fieldMeta)) {
    const [head, id, rest] = k.split(".", 3) as [string, string?, string?];
    if (head === "components" && id && rest !== undefined && gone.has(id)) delete fieldMeta[k];
  }
  return {
    components: components.filter((c) => keep.has(c)),
    outOfBoundary: out.map((c) => ({ resource: `${c.native.type}:${c.native.name}`, kind: c.kind,
      reason: `앱 묶음 라벨이 "${appGroupOf(c)![1].slice(0, 63)}" (고른 묶음 "${chosen.slice(0, 63)}" 아님) → 다른 앱, 명세 밖` })),
    chosen,
  };
}

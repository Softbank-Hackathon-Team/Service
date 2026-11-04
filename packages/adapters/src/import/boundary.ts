import type { BoundaryPoolItem, FieldMetaV2, LinkV2, OutOfBoundaryV2 } from "@svc/contracts";
import type { MappedComponent } from "./types.js";

// BOUNDARY DRAFT(ai): 앱 경계 (설계 20번 5.1장). 계정 전체를 읽은 데이터 자원(버킷·큐·캐시·DB) 중
//   이 앱의 워크로드(서비스·잡)가 근거 있는 의존성으로 닿는 것만 명세에 넣는다.
//   근거 = inferLinks 의 규칙 1(env 주소)·1b·2b(비밀로 뺀 연결 문자열)·3(비밀 이름)·2(IAM 정책 리소스). 규칙 4(이름 앞부분 추측)만으로는 안 넣는다.
//   경계 안 큐의 DLQ 대상 큐도 경계 안 (데이터 쪽 근거, 끝까지 따라감).
//   안 닿는 자원은 outOfBoundary 에 이름·종류만 (값 없음) → 화면·보고에서 "경계 밖 N개" 로 센다. 출발 자원은 건드리지 않는다.
//   워크로드를 하나도 못 읽은 가져오기(데이터만)는 경계를 정할 근거가 없어 전부 두고 검토 표시 (DRAFT(ai): 빈 명세보다 사람 확인이 낫다고 봄)

const HEURISTIC = "heuristic:name";
const isWorkload = (c: MappedComponent) => c.kind === "service" || c.kind === "job";
const strongParts = (source: string) => source.split(" + ").filter((s) => s !== HEURISTIC);

export interface BoundaryOut {
  components: MappedComponent[];
  links: LinkV2[];
  outOfBoundary: OutOfBoundaryV2[];
  /** BOUNDPULL: 경계 밖으로 뺀 데이터 자원의 매퍼 결과 (키 = outOfBoundary.resource). 사람이 PATCH include 로 끌어올 재료 */
  pool: Record<string, BoundaryPoolItem>;
}

/** components·links·fieldMeta(링크 근거) → 경계 안 components·links, 경계 밖 목록. fieldMeta 는 제자리에서 고친다 */
export function applyBoundary(components: MappedComponent[], links: LinkV2[], fieldMeta: FieldMetaV2): BoundaryOut {
  const workloads = components.filter(isWorkload);
  const data = components.filter((c) => !isWorkload(c));
  if (!workloads.length) {
    for (const c of data)
      fieldMeta[`components.${c.id}.boundary`] = { source: "boundary:no-workload", confidence: 0.6, needs_review: true,
        rationale: "서비스·잡을 하나도 못 읽어 앱 경계를 정할 근거가 없음 → 읽은 데이터 자원을 전부 둠. 이 앱 것인지 사람 확인 필요" };
    return { components, links, outOfBoundary: [], pool: {} };
  }
  const wl = new Set(workloads.map((c) => c.id!));
  // 데이터 자원 id → [근거 출처, 신뢰도] (가장 센 것)
  const why = new Map<string, { source: string; confidence: 1 | 0.9 | 0.6; rationale?: string }>();
  for (const l of links) {
    if (typeof l.to !== "string" || !wl.has(l.from) || wl.has(l.to)) continue;
    const m = fieldMeta[`links.${l.from}->${l.to}`];
    const parts = m ? strongParts(m.source) : [];
    if (!parts.length) continue;   // 이름 추측뿐
    const prev = why.get(l.to);
    if (!prev || m!.confidence > prev.confidence)
      why.set(l.to, { source: `boundary:${l.from}:${parts.join("+")}`, confidence: m!.confidence });
  }
  // DRAFT(ai): 3티어 전제(앱마다 DB 하나). 근거로 닿은 postgres 가 하나도 없을 때만, 이름 추측(규칙 4)으로 이어진 postgres 를
  //   신뢰도 0.6·검토 필요로 둔다 (비밀 안의 연결 문자열을 못 읽는 흔한 경우에 DB 가 통째로 빠지지 않게). 버킷·큐·캐시는 이름 추측으로 안 넣음
  if (!data.some((c) => c.kind === "postgres" && why.has(c.id!)))
    for (const l of links) {
      if (typeof l.to !== "string" || !wl.has(l.from) || why.has(l.to)) continue;
      if (data.find((c) => c.id === l.to)?.kind !== "postgres") continue;
      why.set(l.to, { source: `boundary:${l.from}:${HEURISTIC}`, confidence: 0.6,
        rationale: "근거로 닿은 DB 가 없어 이름 앞부분만 같은 DB 를 앱 DB 로 둠 (3티어 전제). 이 앱 DB 가 맞는지 사람 확인 필요" });
    }
  // 경계 안 큐의 DLQ 대상 (따라가기). B-1b·B-2: 경계 안 버킷 알림·토픽 구독 대상 큐도 같이
  for (let grew = true; grew;) {
    grew = false;
    for (const c of data) {
      const tos = [
        ["deadLetter", (c.props.deadLetter as { to?: string } | undefined)?.to],
        ...((c.props.notifications ?? []) as Array<{ to?: string }>).map((x) => ["notifications", x.to] as const),
        ...((c.props.topicSubscriptions ?? []) as Array<{ to?: string }>).map((x) => ["topicSubscriptions", x.to] as const),
      ] as Array<readonly [string, string | undefined]>;
      for (const [field, to] of tos) {
        if (!to || !why.has(c.id!) || why.has(to)) continue;
        why.set(to, { source: `boundary:${c.id}:${field}`, confidence: why.get(c.id!)!.confidence });
        grew = true;
      }
    }
  }
  const keep = (c: MappedComponent) => isWorkload(c) || why.has(c.id!);
  const out = data.filter((c) => !keep(c));
  const gone = new Set(out.map((c) => c.id!));
  // BOUNDPULL: 지우기 전에 경계 밖 자원의 fieldMeta 를 재료로 챙긴다
  const pool: Record<string, BoundaryPoolItem> = {};
  for (const c of out) {
    const pre = `components.${c.id}.`;
    pool[`${c.native.type}:${c.native.name}`] = {
      component: { id: c.id!, kind: c.kind, props: c.props } as unknown as BoundaryPoolItem["component"],
      fieldMeta: Object.fromEntries(Object.entries(fieldMeta).filter(([k]) => k.startsWith(pre)).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      ...(c.kind === "postgres" ? { nativeType: c.native.type } : {}),
    };
  }
  for (const k of Object.keys(fieldMeta)) {
    const [head, id, rest] = k.split(".", 3) as [string, string?, string?];
    if (head === "components" && id && rest !== undefined && gone.has(id)) delete fieldMeta[k];
    if (head === "links") {
      const to = k.slice("links.".length).split("->")[1];
      if (to && gone.has(to)) delete fieldMeta[k];
    }
  }
  for (const [id, w] of why)
    fieldMeta[`components.${id}.boundary`] = { source: w.source, confidence: w.confidence, needs_review: w.confidence < 1, ...(w.rationale ? { rationale: w.rationale } : {}) };
  return {
    pool,
    components: components.filter(keep),
    links: links.filter((l) => !(typeof l.to === "string" && gone.has(l.to)) && !gone.has(l.from)),
    outOfBoundary: out.map((c) => ({ resource: `${c.native.type}:${c.native.name}`, kind: c.kind,
      reason: "이 앱의 서비스·잡이 env·비밀·IAM 근거로 닿지 않음 (이름만 비슷한 것도 안 넣음) → 명세 밖, 출발에 그대로" }))
      .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0)),
  };
}

import { COMPONENT_KINDS_V2, LINK_OUTPUTS, LINK_TEMPLATE, type AppSpecV2, type ApprovalRowV2 } from "./spec-v2.js";

// DRAFT(ai): IR v2 의미 검증. Zod(AppSpecV2) 는 모양만 보고, 참조·중복·의도·벤더 주소는 여기서 본다.
//   설계 20번 4.5장 + 24번 3.5장 R1. PoC verify-20-ir-v2 checkV2 를 옮김.
//   errors   = 구조 오류. 가져오기를 막는다
//   reviews  = 검토 표시. 막지 않는다 (벤더 주소·사설 IP 가 값으로 남음)
//   approvals= 사람 승인이 필요한 줄. 막지 않는다. 계획서 확인 항목으로 간다
//   입력은 parse 전 값일 수도 있어(시험·AI 초안) 모든 접근을 방어적으로 한다.

export interface CheckV2Result {
  errors: string[];
  reviews: string[];
  approvals: ApprovalRowV2[];
}
/** G3c-5: 검토 줄 하나 + 그 줄의 fieldMeta 키 (내용 키: check.<id>.<자리>.<종류>.<값 지문>). 같은 자리·같은 값이면 판이 바뀌어도 같은 키 */
export interface CheckReviewItem { key: string; text: string }

const ID_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;   // G3c-6: 끝 하이픈 안 됨 (spec-v2.ts Id 와 같음)
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// 유형별 꼭 있어야 하는 필드 (R3: postgres 는 없음 — 못 읽으면 null + 검토)
export const REQUIRED_V2: Record<string, readonly string[]> = {
  service: ["image", "runtime", "replicas"],
  job: ["image", "schedule"],
  postgres: [],
  cache: ["engine"],
  objectStore: ["versioning"],
  queue: ["model"],
};

// 의도가 대상 유형에 맞나
const INTENT_OK: Record<string, readonly string[]> = {
  postgres: ["connect"],
  cache: ["connect"],
  objectStore: ["read", "write", "readwrite", "admin"],
  queue: ["read", "write", "readwrite", "admin"],
  service: ["call"],
};

// 벤더 주소: 값의 호스트 조각이 벤더 도메인으로 끝나면. 경로·파일 이름(/tmp/app.cache.db)은 안 본다
// DRAFT(ai): 뒤붙이 목록은 PoC 그대로. 빠진 벤더(예: Cloudflare R2)는 검토 때 더함
export const VENDOR_SUFFIXES = [
  ".amazonaws.com", ".amazonaws.com.cn", ".googleapis.com", ".cloud.goog", ".run.app",
  ".azure.com", ".windows.net", ".azurewebsites.net",
] as const;
export const hostsIn = (v: string): string[] => v.toLowerCase().match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) ?? [];
export const hasVendorHost = (v: string, except: ReadonlySet<string> = new Set()): boolean =>
  hostsIn(v).some((h) => !except.has(h) && VENDOR_SUFFIXES.some((x) => h.endsWith(x)));
// 사설 IP 는 네 칸 다 있어야 (APP_VERSION=10.4.1 은 아님)
export const hasPrivateIp = (v: string): boolean =>
  /(^|[^0-9.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![0-9.])/.test(v);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// 의존성 대상 문자열 (정렬·중복 판단용): id 그대로, 객체면 "unmapped:<x>" / "external:<x>"
const linkTarget = (to: unknown): string => {
  if (typeof to === "string") return to;
  if (isObj(to) && typeof to.unmapped === "string") return `unmapped:${to.unmapped}`;
  if (isObj(to) && typeof to.external === "string") return `external:${to.external}`;
  return JSON.stringify(to);
};

// env 한 줄이 가리키는 의존성 출력 (fromLink 또는 template 의 ${id.output})
const envRefs = (e: Obj): { to: string; output: string; endpoint?: string }[] => {
  if (isObj(e.fromLink)) return [{ to: String(e.fromLink.to), output: String(e.fromLink.output), ...(typeof e.fromLink.endpoint === "string" ? { endpoint: e.fromLink.endpoint } : {}) }];
  const t = str(e.template);
  if (t === undefined) return [];
  // G3-5: 예전 느슨한 꼴(\${id.xyz})도 잡아서 "없는 출력" 오류를 그대로 낸다 + Service 이름 붙은 꼴
  const loose = [...t.matchAll(/\$\{([a-z][a-z0-9-]*)\.([a-z]+)\}/g)].map((m) => ({ to: m[1] ?? "", output: m[2] ?? "" }));
  const named = [...t.matchAll(LINK_TEMPLATE)].filter((m) => m[3]).map((m) => ({ to: m[1] ?? "", output: m[2] ?? "", endpoint: m[3]! }));
  return [...loose, ...named];
};

// 주 컨테이너(props 자체, label "") + sidecars·initContainers (label "sidecars.<이름>." 등). fieldMeta 키 모양과 같은 이름
const containersOf = (props: Obj): { label: string; c: Obj }[] => [
  { label: "", c: props },
  ...(["sidecars", "initContainers"] as const).flatMap((k) => arr(props[k]).filter(isObj).map((c) => ({ label: `${k}.${String(c.name)}.`, c }))),
];

// 값 지문 (FNV-1a 32비트, 16진 8자). 값 자체는 키에 안 넣는다 (비밀일 수 있음). 암호용 아님: 같은 값이면 같은 키면 된다
const fp = (v: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
};

export function checkV2(spec: AppSpecV2): CheckV2Result {
  const { errors, reviewItems, approvals } = checkV2Detailed(spec);
  return { errors, reviews: reviewItems.map((r) => r.text), approvals };
}

/** G3c-5: checkV2 의 검토 줄을 fieldMeta 키와 같이. 가져오기·PATCH 가 syncCheckReviews 로 fieldMeta 에 맞춰 넣는다 */
export function checkV2Reviews(spec: AppSpecV2): CheckReviewItem[] {
  return checkV2Detailed(spec).reviewItems;
}

type MetaLike = Record<string, { source: string; confidence: number; needs_review: boolean; rationale?: string } | Record<string, unknown>>;
/**
 * G3c-5 DRAFT(ai): fieldMeta 의 checkV2 검토 표시(check.* 키)를 지금 명세의 검토 줄에 맞춘다 (순수 함수, 입력은 안 바꿈).
 *   - 지금 줄에 없는 check.* 키는 지운다 (사람이 고쳐서 없어진 줄, 예전 번호 키 check.reviews[i])
 *   - 이미 있는 키는 표시 그대로 둔다 (사람이 확인했으면 확인 유지). 근거 글만 새 글로
 *   - 새 키는 검토 필요(needs_review true, 신뢰도 0.6)
 */
export function syncCheckReviews<M extends MetaLike>(fieldMeta: M, items: readonly CheckReviewItem[]): M {
  const out: MetaLike = {};
  for (const [k, v] of Object.entries(fieldMeta)) if (!k.startsWith("check.")) out[k] = v;
  for (const it of items) {
    const prev = fieldMeta[it.key] as { needs_review?: unknown } | undefined;
    out[it.key] = prev && typeof prev === "object" && typeof prev.needs_review === "boolean"
      ? { ...(prev as object), rationale: it.text } as never
      : { source: "checkV2", confidence: 0.6, needs_review: true, rationale: it.text };
  }
  return out as M;
}

function checkV2Detailed(spec: AppSpecV2): { errors: string[]; reviewItems: CheckReviewItem[]; approvals: ApprovalRowV2[] } {
  const errors: string[] = [];
  const reviewItems: CheckReviewItem[] = [];
  const review = (key: string, text: string) => { const k = `check.${key}`; if (!reviewItems.some((r) => r.key === k)) reviewItems.push({ key: k, text }); };
  const approvals: ApprovalRowV2[] = [];
  const s = spec as unknown as Obj;
  const components = arr(s.components).filter(isObj);
  const links = arr(s.links).filter(isObj);

  if (s.schemaVersion !== "2") errors.push("schemaVersion 이 2 아님");

  const kindOf = new Map<string, string>();
  for (const c of components) {
    const id = String(c.id);
    const kind = String(c.kind);
    const props = isObj(c.props) ? c.props : {};
    if (kindOf.has(id)) errors.push(`id 중복: ${id}`);
    else kindOf.set(id, kind);
    if (!ID_RE.test(id)) errors.push(`id 모양 틀림: ${id}`);
    if (!(COMPONENT_KINDS_V2 as readonly string[]).includes(kind)) errors.push(`모르는 유형: ${id} ${kind}`);
    for (const k of REQUIRED_V2[kind] ?? []) if (props[k] == null) errors.push(`${id}.${k} 비었음`);

    // 숫자 필드가 진짜 숫자 (NaN·무한 아님)
    const walk = (o: unknown, path: string): void => {
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
      if (!isObj(o)) return;
      for (const [k, v] of Object.entries(o)) {
        const p = path ? `${path}.${k}` : k;
        if (typeof v === "number" && !Number.isFinite(v)) errors.push(`${id}.${p} 숫자 아님`);
        else walk(v, p);
      }
    };
    walk(props, "");

    const replicas = props.replicas;
    if (kind === "service" && isObj(replicas) && typeof replicas.min === "number" && typeof replicas.max === "number" && replicas.min > replicas.max)
      errors.push(`${id}.replicas min > max`);
    // 0으로 줄여 둔 서비스: 막지 않고 검토 표시 (도착에서도 0으로 뜨는 게 재현이지만 사람이 알아야 함)
    if (kind === "service" && isObj(replicas) && replicas.max === 0) review(`${id}.replicas.zero`, `${id}.replicas 0 (출발에서 0으로 줄여 둔 서비스)`);
    // INCL: 클러스터 안 데이터 서비스는 그 워크로드(service)를 가리켜야 함. 데이터는 안 따라가니 늘 검토 줄
    if (isObj(props.inCluster)) {
      const w = str(props.inCluster.workload);
      if (!w || !components.some((c) => c.id === w && c.kind === "service")) errors.push(`${id}.inCluster.workload 가 service 아님: ${String(w)}`);
      review(`${id}.inCluster`, `${id} 는 클러스터 안 ${String(props.inCluster.product)}(워크로드 ${String(w)}) → 데이터 복사 필요. 도착 방식은 사람이 정함`);
    }

    // SSL-1 DRAFT(ai): 출발 DB 가 평문 연결을 허용 → 도착도 같게 둠(그대로 이식). 보안이 낮아지는 쪽이라 막지 않고 사람 승인 줄
    if (kind === "postgres" && props.tlsRequired === false)
      approvals.push({ kind: "tls_relaxed", subject: id, detail: "출발 DB 가 평문(TLS 없는) 연결을 허용 → 도착 DB 도 평문을 허용하게 만듦 (보안 낮음). 앱이 TLS 로 붙을 수 있으면 명세에서 tlsRequired 를 true 로" });

    // B-2 DECISION(team): 출발이 공개 버킷이면 도착도 공개 ("그대로 이식, 예외 없음" decisions/2026-11-03 20:02Z). 보안이 낮은 쪽이라 승인 줄
    if (kind === "objectStore" && props.public === true)
      approvals.push({ kind: "public_bucket", subject: id, detail: "출발 버킷이 공개 → 도착 버킷도 익명 읽기(객체 GetObject·objectViewer)로 엶 (보안 낮음). 출발 정책이 일부 경로만·쓰기까지 열었다면 다름 → 확인. 막으려면 명세에서 public 을 false 로" });

    // HN-1 DRAFT(ai): 노드 네트워크·프로세스·경로·포트를 직접 쓰는 파드 → 그대로 옮기되(DaemonSet 등이 기댐) 보안이 낮은 쪽이라 사람 승인 줄
    if (kind === "service" || kind === "job") {
      const host = isObj(props.host) ? Object.keys(props.host).sort().map((k) => `host${k === "pid" ? "PID" : k === "ipc" ? "IPC" : "Network"}`) : [];
      const cs = [props, ...(Array.isArray(props.sidecars) ? props.sidecars : []), ...(Array.isArray(props.initContainers) ? props.initContainers : [])].filter(isObj);
      const hostPorts = cs.flatMap((c) => (Array.isArray(c.ports) ? c.ports : []).filter(isObj).map((p) => p.hostPort).filter((n): n is number => typeof n === "number"));
      const hostPaths = (Array.isArray(props.podVolumes) ? props.podVolumes : []).filter(isObj).filter((v) => v.type === "hostPath").map((v) => String(v.name));
      const what = [...host, ...(hostPorts.length ? [`hostPort ${[...new Set(hostPorts)].sort((a, b) => a - b).join(",")}`] : []), ...(hostPaths.length ? [`hostPath 볼륨 ${hostPaths.sort().join(",")}`] : [])];
      if (what.length) approvals.push({ kind: "host_access", subject: id, detail: `노드를 직접 씀(${what.join(", ")}) → 도착에서도 그대로 (보안 낮음). 도착 보안 정책이 막을 수 있음` });
    }

    // G3c-6 DRAFT(ai): 같은 이름 두 개. 보조·초기화 컨테이너 이름과 파드 볼륨 이름은 k8s 가 거부 → 오류.
    //   env 이름 중복(뒤 값이 이김, fieldMeta 키가 하나라 표시가 겹침)·configs 이름 중복은 막지 않고 검토 줄
    if (kind === "service" || kind === "job") {
      const dup = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))].sort();
      const cnames = [...arr(props.sidecars), ...arr(props.initContainers)].filter(isObj).map((c) => String(c.name));
      for (const n of dup(cnames)) errors.push(`${id} 컨테이너 이름 중복: ${n}`);
      const vnames = [...arr(props.volumes), ...arr(props.podVolumes)].filter(isObj).map((v) => String(v.name));
      for (const n of dup(vnames)) errors.push(`${id} 볼륨 이름 중복: ${n}`);
      for (const { label, c: ct } of containersOf(props))
        for (const n of dup(arr(ct.env).filter(isObj).map((e) => String(e.name))))
          review(`${id}.${label}env.${n}.dup`, `${id}.${label}env.${n} 이름이 두 번 나옴 (뒤 값이 이김)`);
      for (const n of dup(arr(props.configs).filter(isObj).map((c) => String(c.name))))
        review(`${id}.configs.${n}.dup`, `${id}.configs.${n} 이름이 두 번 나옴`);
    }

    // D6: 종류별 칸이 종류와 맞나
    if (kind === "service" || kind === "job") {
      const wk = str(props.workloadKind) ?? "deployment";
      if (isObj(props.statefulSet) && wk !== "statefulset") errors.push(`${id}.statefulSet 은 workloadKind statefulset 에만`);
      const vols = arr(props.volumes).filter(isObj);
      const vn = new Set<string>();
      for (const v of vols) {
        const n = String(v.name);
        if (vn.has(n)) errors.push(`${id}.volumes 이름 중복: ${n}`);
        vn.add(n);
        if (v.claimTemplate === true && wk !== "statefulset") errors.push(`${id}.volumes.${n} claimTemplate 은 StatefulSet 에만`);
      }
      if (kind === "service" && wk === "statefulset") {
        const sn = isObj(props.statefulSet) ? str(props.statefulSet.serviceName) : undefined;
        const heads = arr(props.endpoints).filter(isObj).filter((e) => e.type === "Headless").map((e) => String(e.name));
        if (sn && !heads.includes(sn)) review(`sts-headless.${id}`, `${id}.statefulSet.serviceName ${sn} 에 맞는 headless Service 가 없음 (파드별 고정 DNS 가 도착에 안 생김)`);
      }
      if (kind === "service" && wk === "daemonset" && isObj(props.scale)) errors.push(`${id}.scale 은 DaemonSet 에 못 씀 (개수 = 노드 수)`);
      for (const v of vols) if (v.claimTemplate !== true && v.sizeGb === undefined && wk === "statefulset") review(`sts-volume.${id}.${String(v.name)}`, `${id}.volumes.${String(v.name)} 크기 없음`);
    }

    if (kind === "service" || kind === "job") {
      const image = props.image;
      if (isObj(image)) {
        const source = image.source ?? "registry";
        if (source === "registry" && !DIGEST_RE.test(str(image.digest) ?? "")) errors.push(`${id}.image digest 아님 (source=registry)`);
        // DRAFT(ai): build 인데 빌드 계획이 없으면 도착 이미지를 만들 길이 없다 → 구조 오류 (설계 23번 S0 거부 시험)
        if (source === "build" && !isObj(image.build)) errors.push(`${id}.image build 계획 없음 (source=build)`);
        if (source === "build") {
          const method = isObj(image.build) ? str(image.build.method) : undefined;
          approvals.push({ kind: "build", subject: id, ...(method !== undefined ? { detail: method } : {}) });
        }
      }

      if (kind === "service" && isObj(props.origin)) {
        const from = str(props.origin.runtime);
        const to = str(props.runtime);
        if (from !== undefined && to !== undefined && from !== to) approvals.push({ kind: "runtime_change", subject: id, from, to });
      }

      // 고객 밖 서비스를 external 의존성으로 적었으면 그 호스트는 그대로 둬도 된다
      {
        const except = new Set(
          links.filter((l) => l.from === id && isObj(l.to) && typeof l.to.external === "string")
            .map((l) => String((l.to as Obj).external).toLowerCase()),
        );
        // G3c-2: 주 컨테이너 + 보조(sidecars)·초기화(initContainers) 컨테이너의 env·args·command 를 다 본다
        const vals: [string, string][] = [
          ...containersOf(props).flatMap(({ label, c: ct }) => [
            ...arr(ct.env).filter(isObj).filter((e) => typeof e.value === "string").map((e): [string, string] => [`${label}env.${String(e.name)}`, e.value as string]),
            ...arr(ct.args).map((a, i): [string, string] => [`${label}args[${i}]`, String(a)]),
            ...arr(ct.command).map((a, i): [string, string] => [`${label}command[${i}]`, String(a)]),
          ]),
          ...arr(props.configs).filter(isObj).flatMap((cf) =>
            Object.entries(isObj(cf.data) ? cf.data : {}).map(([k, v]): [string, string] => [`configs.${String(cf.name)}.${k}`, String(v)])),
        ];
        for (const [where, v] of vals) {
          if (hasVendorHost(v, except)) review(`${id}.${where}.vendor.${fp(v)}`, `${id}.${where} 에 벤더 주소가 값으로 남음`);
          if (hasPrivateIp(v)) review(`${id}.${where}.privateIp.${fp(v)}`, `${id}.${where} 에 출발 사설 IP 가 값으로 남음`);
        }
      }
    }
  }

  // deadLetter 는 다른 queue (kindOf 가 다 찬 뒤에 본다)
  for (const c of components) {
    if (c.kind !== "queue" || !isObj(c.props) || !isObj(c.props.deadLetter)) continue;
    const to = c.props.deadLetter.to;
    if (typeof to === "string" && kindOf.get(to) !== "queue") errors.push(`${String(c.id)}.deadLetter.to 가 queue 아님: ${to}`);
    else if (to === c.id) errors.push(`${String(c.id)}.deadLetter.to 가 자기 자신`);   // G3c-6
  }
  // B-1b·B-2: 버킷 알림·토픽 구독 대상은 IR 큐
  for (const c of components) {
    const props = isObj(c.props) ? c.props : {};
    for (const [field, list] of [["notifications", props.notifications], ["topicSubscriptions", props.topicSubscriptions]] as const)
      for (const x of arr(list).filter(isObj))
        if (typeof x.to === "string" && kindOf.get(x.to) !== "queue") errors.push(`${String(c.id)}.${field}.to 가 queue 아님: ${x.to}`);
  }

  // 의존성
  const seen = new Set<string>();
  for (const l of links) {
    const from = String(l.from);
    const to = linkTarget(l.to);
    const key = `${from}->${to}`;
    // DRAFT(ai): 같은 (from,to) 는 한 줄 (의도는 가져오기가 하나로 합친다: connect·read·write → readwrite·admin)
    if (seen.has(key)) errors.push(`의존성 중복: ${key}`);
    seen.add(key);
    if (typeof l.to === "string" && l.to === from) errors.push(`의존성이 자기 자신: ${key}`);   // G3c-6
    const fromKind = kindOf.get(from);
    if (fromKind === undefined) errors.push(`의존성 출발 없음: ${from}`);
    else if (fromKind !== "service" && fromKind !== "job") errors.push(`의존성 출발이 service·job 아님: ${from}`);
    if (typeof l.to === "string") {
      const toKind = kindOf.get(l.to);
      if (toKind === undefined) errors.push(`의존성 대상 없음: ${l.to}`);
      else {
        const ok = INTENT_OK[toKind];
        if (ok !== undefined && !ok.includes(String(l.intent))) errors.push(`의도가 대상과 안 맞음: ${key} ${String(l.intent)}`);
      }
    }
  }

  // env 참조 (fromLink·template) → 맞는 의존성 + 출력 이름
  for (const c of components) {
    const id = String(c.id);
    const props = isObj(c.props) ? c.props : {};
    // G3c-2: 보조·초기화 컨테이너 env 의 fromLink·template 도 같은 규칙 (링크가 없으면 도착 허용 목록·권한에 안 들어감)
    for (const { label, c: ct } of containersOf(props))
      for (const e of arr(ct.env).filter(isObj)) {
        for (const r of envRefs(e)) {
          if (!links.some((l) => l.from === id && l.to === r.to)) {
            errors.push(`${id}.${label}env.${String(e.name)} 참조 ${r.to} 에 맞는 의존성 없음`);
            continue;
          }
          const toKind = kindOf.get(r.to) ?? "";
          const outs: readonly string[] = (LINK_OUTPUTS as Record<string, readonly string[]>)[toKind] ?? [];
          if (!outs.includes(r.output)) errors.push(`${id}.${label}env.${String(e.name)} 출력 ${r.output} 가 ${toKind} 에 없음`);
          // G3-5: 부른 Service 이름은 대상 서비스의 endpoints 에 있어야 (없으면 도착에서 다른 Service 로 감)
          if (r.endpoint !== undefined) {
            const tc = components.find((c) => c.id === r.to);
            const names = arr(isObj(tc?.props) ? (tc!.props as Obj).endpoints : undefined).filter(isObj).map((x) => str(x.name));
            if (toKind !== "service") errors.push(`${id}.${label}env.${String(e.name)} Service 이름(${r.endpoint})은 서비스 대상에만`);
            else if (!names.includes(r.endpoint)) errors.push(`${id}.${label}env.${String(e.name)} Service 이름 ${r.endpoint} 가 ${r.to}.endpoints 에 없음`);
          }
        }
        // SUB-1: 구독 이름 참조는 queue 의 구독 목록에 있는 이름 + output name 만
        const fl = isObj(e.fromLink) ? e.fromLink : undefined;
        if (fl && fl.subscription !== undefined) {
          const t = components.find((x) => String(x.id) === String(fl.to));
          const subs = t && isObj(t.props) ? arr(t.props.subscriptions).filter(isObj).map((x) => String(x.name)) : [];
          if (kindOf.get(String(fl.to)) !== "queue" || fl.output !== "name" || !subs.includes(String(fl.subscription)))
            errors.push(`${id}.${label}env.${String(e.name)} 구독 ${String(fl.subscription)} 이 ${String(fl.to)} 의 구독 목록에 없음 (queue·output name 만)`);
        }
      }
  }

  // 라우팅 대상은 있는 service
  const props0 = (id: string): Obj => { const c = components.find((x) => String(x.id) === id); return c && isObj(c.props) ? c.props : {}; };
  const entry = s.entry;
  if (isObj(entry)) {
    for (const h of arr(entry.hosts).filter(isObj))
      for (const r of arr(h.routes).filter(isObj))
        for (const b of arr(r.backends).filter(isObj)) {
          const to = String(b.to);
          const k = kindOf.get(to);
          if (k === undefined) errors.push(`라우팅 대상 없음: ${to}`);
          else if (k !== "service") errors.push(`라우팅 대상이 service 아님: ${to} (${k})`);
          else {
            // G3c-6 DRAFT(ai): 라우팅 포트가 대상 서비스의 Service 포트(endpoints) 또는 컨테이너 포트(ports)에 있나. 없으면 도착 Ingress 가 없는 포트를 가리킴 → 검토 줄
            //   (막지 않음: Service 객체를 못 읽고 Deployment 로 추측한 경우 등 가져오기가 만들 수 있다)
            const tp = props0(to);
            const known = [...arr(tp.endpoints).filter(isObj).flatMap((e) => arr(e.ports).filter(isObj).map((p) => p.port)),
              ...arr(tp.ports).filter(isObj).map((p) => p.port)];
            const host = String(arr(h.hostnames)[0] ?? "");
            if (!known.includes(b.port)) review(`entry.${host}.routes.${to}.${String(b.port)}.port`, `라우팅 ${host} → ${to}:${String(b.port)} 포트가 그 서비스의 Service·컨테이너 포트에 없음`);
          }
        }
  }

  // 보안 기준선 대상
  const posture = isObj(s.posture) ? s.posture : {};
  const subjects = [
    ...arr(posture.permissions).filter(isObj),
    ...arr(posture.network).filter(isObj).filter((x) => x.scope === "component"),
  ];
  for (const p of subjects) {
    const subj = String(p.subject);
    if (!kindOf.has(subj)) errors.push(`보안 기준선 대상 없음: ${subj}`);
  }
  for (const p of arr(posture.permissions).filter(isObj))
    for (const cv of arr(p.covers)) if (typeof cv === "string" && !kindOf.has(cv)) errors.push(`보안 기준선 covers 대상 없음: ${cv}`);

  // G3-5: 출발 Service 하나가 Deployment 여럿을 고르면 같은 endpoint 가 컴포넌트마다 복사된다 → 도착에서 같은 이름 Service 가 두 번 그려질 수 있음
  // TODO(human): 공유 endpoint 를 IR 에 한 번만 두는 모양은 차트 계약(BV-1)과 같이 정한다. 지금은 막지 않고 검토 표시만
  const epOwners = new Map<string, string[]>();
  for (const c of components) if (c.kind === "service" && isObj(c.props))
    for (const ep of arr((c.props as Obj).endpoints).filter(isObj)) {
      const k = `${str((c.props as Obj).namespace) ?? ""}/${str(ep.name) ?? ""}`;
      epOwners.set(k, [...(epOwners.get(k) ?? []), String(c.id)]);
    }
  for (const [k, ids] of epOwners) if (ids.length > 1)
    review(`shared-endpoint.${k}`, `Service ${k.split("/")[1]} 가 서비스 ${ids.join("·")} 에 같이 있음 (출발 Service 하나가 여러 워크로드를 고름) → 도착에서 두 번 그려지지 않는지 확인`);
  // T1·SC-1: 비밀 표 (있을 때만 = 옛 판은 안 봄). 이름 중복 없음, 키 중복 없음, 짝 대상은 있는 postgres·cache,
  //   워크로드가 쓰는 비밀은 표에 다 있어야 함 (도착 Builder 가 표만 보고 비밀을 만든다)
  if (Array.isArray(s.secrets)) {
    const names = new Set<string>();
    for (const sec of arr(s.secrets).filter(isObj)) {
      const n = String(sec.name);
      if (names.has(n)) errors.push(`비밀 이름 중복: ${n}`);
      names.add(n);
      const keys = new Set<string>();
      for (const k of arr(sec.keys).filter(isObj)) {
        const key = String(k.key);
        if (keys.has(key)) errors.push(`비밀 ${n} 키 중복: ${key}`);
        keys.add(key);
        if (isObj(k.pairedWith)) {
          const to = String(k.pairedWith.component);
          const kd = kindOf.get(to);
          if (kd !== "postgres" && kd !== "cache") errors.push(`비밀 ${n}.${key} 짝 대상이 postgres·cache 아님: ${to}`);
          if (k.binary === true) errors.push(`비밀 ${n}.${key} 은 짝(도착 비밀번호)인데 binary 로 표시됨`);
        }
      }
    }
    for (const c of components) {
      const props = isObj(c.props) ? c.props : {};
      const used = new Set<string>();
      for (const e of [...arr(props.env), ...arr(props.sidecars).filter(isObj).flatMap((x) => arr(x.env)), ...arr(props.initContainers).filter(isObj).flatMap((x) => arr(x.env))].filter(isObj))
        if (isObj(e.fromSecret)) used.add(String(e.fromSecret.secret));
      for (const f of arr(props.envFrom).filter(isObj)) if (typeof f.secret === "string") used.add(f.secret);
      for (const m of arr(props.secretMounts).filter(isObj)) if (typeof m.secret === "string") used.add(m.secret);
      for (const u of [...used].sort()) if (!names.has(u)) errors.push(`${String(c.id)} 가 쓰는 비밀 ${u} 이 secrets 표에 없음`);
    }
  }
  // E-2: 사설 DNS 레코드는 IR 자원을 가리켜야 하고, 이름이 겹치면 안 된다
  if (Array.isArray(s.privateDns)) {
    const seen = new Set<string>();
    for (const r of arr(s.privateDns).filter(isObj)) {
      const key = `${String(r.name)}/${String(r.type)}`;
      if (seen.has(key)) errors.push(`사설 DNS 레코드 중복: ${key}`);
      seen.add(key);
      if (!kindOf.has(String(r.to))) errors.push(`사설 DNS ${String(r.name)} 가 가리키는 자원 없음: ${String(r.to)}`);
    }
  }
  // NP-1: NodePort 번호는 클러스터 하나에서 겹치면 안 됨. 기본 범위 밖이면 도착 클러스터 설정을 봐야 함
  const nodePorts = new Map<string, string>();
  for (const c of components) {
    if (c.kind !== "service" || !isObj(c.props)) continue;
    for (const e of arr(c.props.endpoints).filter(isObj))
      for (const p of arr(e.ports).filter(isObj)) {
        if (typeof p.nodePort !== "number") continue;
        const key = `${String(p.protocol ?? "TCP")}/${p.nodePort}`;
        const who = `${String(c.id)}.${String(e.name)}`;
        if (nodePorts.has(key)) errors.push(`NodePort 중복: ${key} (${nodePorts.get(key)}, ${who})`);
        else nodePorts.set(key, who);
        if ((p.nodePort < 30000 || p.nodePort > 32767)) review(`nodeport.${who}`, `${who} NodePort ${p.nodePort} 가 기본 범위(30000-32767) 밖 → 도착 클러스터 범위 확인`);
      }
  }
  // NS-1·M-1: 네임스페이스 목록과 워크로드 네임스페이스가 맞나
  const nsList = arr(s.namespaces).filter(isObj).map((n) => String(n.name));
  if (new Set(nsList).size !== nsList.length) errors.push("namespaces 이름 중복");
  if (nsList.length)
    for (const c of components) {
      if ((c.kind !== "service" && c.kind !== "job") || !isObj(c.props)) continue;
      const ns = str(c.props.namespace);
      if (ns && !nsList.includes(ns)) errors.push(`${String(c.id)}.namespace ${ns} 가 namespaces 에 없음`);
    }
  // V-1: ExternalName 이름이 같은 네임스페이스의 다른 Service 이름과 겹치면 안 됨
  const svcNames = new Set<string>();
  for (const c of components) {
    if (c.kind !== "service" || !isObj(c.props)) continue;
    for (const e of arr(c.props.endpoints).filter(isObj)) svcNames.add(`${str(c.props.namespace) ?? ""}/${String(e.name)}`);
  }
  const aliasSeen = new Set<string>();
  for (const a of arr(s.serviceAliases).filter(isObj)) {
    const key = `${str(a.namespace) ?? ""}/${String(a.name)}`;
    if (svcNames.has(key) || aliasSeen.has(key)) errors.push(`serviceAliases 이름 겹침: ${key}`);
    aliasSeen.add(key);
  }

  return { errors, reviewItems, approvals };
}

import { COMPONENT_KINDS_V2, LINK_OUTPUTS, type AppSpecV2, type ApprovalRowV2 } from "./spec-v2.js";

// DRAFT(ai): IR v2 의미 검증. Zod(AppSpecV2) 는 모양만 보고, 참조·중복·의도·벤더 주소는 여기서 본다.
//   설계 20번 4.5장 + 24번 3.5장 R1. PoC verify-20-ir-v2 checkV2 를 옮김.
//   errors   = 구조 오류. 가져오기를 막는다
//   reviews  = 검토 표시. 막지 않는다 (벤더 주소·사설 IP 가 값으로 남음). legacy:true 면 안 본다
//   approvals= 사람 승인이 필요한 줄. 막지 않는다. 계획서 확인 항목으로 간다
//   입력은 parse 전 값일 수도 있어(시험·AI 초안) 모든 접근을 방어적으로 한다.

export interface CheckV2Result {
  errors: string[];
  reviews: string[];
  approvals: ApprovalRowV2[];
}
export interface CheckV2Options {
  legacy?: boolean;   // v1 에서 올린 판: 벤더 주소를 바꿀 근거가 없으니 reviews 를 안 낸다 (이 판으로는 계획 못 만듦)
}

const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
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
const envRefs = (e: Obj): { to: string; output: string }[] => {
  if (isObj(e.fromLink)) return [{ to: String(e.fromLink.to), output: String(e.fromLink.output) }];
  const t = str(e.template);
  if (t === undefined) return [];
  return [...t.matchAll(/\$\{([a-z][a-z0-9-]*)\.([a-z]+)\}/g)].map((m) => ({ to: m[1] ?? "", output: m[2] ?? "" }));
};

export function checkV2(spec: AppSpecV2, opts: CheckV2Options = {}): CheckV2Result {
  const errors: string[] = [];
  const reviews: string[] = [];
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
      if (!opts.legacy) {
        const except = new Set(
          links.filter((l) => l.from === id && isObj(l.to) && typeof l.to.external === "string")
            .map((l) => String((l.to as Obj).external).toLowerCase()),
        );
        const vals: [string, string][] = [
          ...arr(props.env).filter(isObj).filter((e) => typeof e.value === "string").map((e): [string, string] => [`env.${String(e.name)}`, e.value as string]),
          ...arr(props.args).map((a, i): [string, string] => [`args[${i}]`, String(a)]),
          ...arr(props.command).map((a, i): [string, string] => [`command[${i}]`, String(a)]),
          ...arr(props.configs).filter(isObj).flatMap((cf) =>
            Object.entries(isObj(cf.data) ? cf.data : {}).map(([k, v]): [string, string] => [`configs.${String(cf.name)}.${k}`, String(v)])),
        ];
        for (const [where, v] of vals) {
          if (hasVendorHost(v, except)) reviews.push(`${id}.${where} 에 벤더 주소가 값으로 남음`);
          if (hasPrivateIp(v)) reviews.push(`${id}.${where} 에 출발 사설 IP 가 값으로 남음`);
        }
      }
    }
  }

  // deadLetter 는 다른 queue (kindOf 가 다 찬 뒤에 본다)
  for (const c of components) {
    if (c.kind !== "queue" || !isObj(c.props) || !isObj(c.props.deadLetter)) continue;
    const to = c.props.deadLetter.to;
    if (typeof to === "string" && kindOf.get(to) !== "queue") errors.push(`${String(c.id)}.deadLetter.to 가 queue 아님: ${to}`);
  }

  // 의존성
  const seen = new Set<string>();
  for (const l of links) {
    const from = String(l.from);
    const to = linkTarget(l.to);
    const key = `${from}->${to}`;
    if (seen.has(key)) errors.push(`의존성 중복: ${key}`);
    seen.add(key);
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
    for (const e of arr(props.env).filter(isObj)) {
      for (const r of envRefs(e)) {
        if (!links.some((l) => l.from === id && l.to === r.to)) {
          errors.push(`${id}.env.${String(e.name)} 참조 ${r.to} 에 맞는 의존성 없음`);
          continue;
        }
        const toKind = kindOf.get(r.to) ?? "";
        const outs: readonly string[] = (LINK_OUTPUTS as Record<string, readonly string[]>)[toKind] ?? [];
        if (!outs.includes(r.output)) errors.push(`${id}.env.${String(e.name)} 출력 ${r.output} 가 ${toKind} 에 없음`);
      }
    }
  }

  // 라우팅 대상은 있는 service
  const entry = s.entry;
  if (isObj(entry)) {
    for (const h of arr(entry.hosts).filter(isObj))
      for (const r of arr(h.routes).filter(isObj))
        for (const b of arr(r.backends).filter(isObj)) {
          const to = String(b.to);
          const k = kindOf.get(to);
          if (k === undefined) errors.push(`라우팅 대상 없음: ${to}`);
          else if (k !== "service") errors.push(`라우팅 대상이 service 아님: ${to} (${k})`);
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

  return { errors, reviews, approvals };
}

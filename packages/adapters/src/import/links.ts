import { SPEC_LIMITS, type FieldMetaV2, type LinkV2, type UnmappedV2 } from "@svc/contracts";
import type { MappedComponent } from "./types.js";
import { iamGrants, type PermissionV2, type RawAwsIamPolicy } from "./mappers/iam-grants.js";

// DRAFT(ai): 의존성 추론 (설계 20번 4.3(가)·5.3장, PoC inferLinks 의 k8s·DB 부분).
//   신뢰도: env 주소 = 1 (맨 이름이면 0.9), 비밀 이름 = 0.9, 이름 추측 = 0.6.
//   I4: 앱 신원(Pod Identity·IRSA)의 IAM 정책 → grants 원문 + 기준선 (규칙 2, mappers/iam-grants.ts). 신뢰도 1 (조건 있으면 0.9).
//   S3·SQS·캐시 매퍼는 I6 몫.

type Intent = LinkV2["intent"];
// G3-5: endpoint = 서비스 대상일 때 맞춘 출발 k8s Service 이름 (도착 주소를 그 Service 로 계산하게)
export interface EnvHit { from: string; env: string; target: MappedComponent; address: string; confidence: 1 | 0.9; endpoint?: string;
  /** G3b-4(a-secrets): 매퍼가 정한 다시 쓰기 출력. 지금 다시 쓰기는 outputFor 가 정함 (안 씀) */
  output?: "host" | "url" | "name" | null }
export interface LinksOut {
  links: LinkV2[]; meta: FieldMetaV2; envHits: EnvHit[];
  /** I4: IAM 정책 중 의존성으로 못 옮긴 문장 (posture.permissions) · 붙일 곳을 못 찾은 정책 */
  permissions: PermissionV2[]; unmapped: UnmappedV2[];
}

// G3b-4: S3 주소의 리전·dualstack 이 붙은 꼴을 리전 없는 꼴로 (bkt.s3.<리전>.amazonaws.com → bkt.s3.amazonaws.com, s3.<리전>.amazonaws.com/bkt → s3.amazonaws.com/bkt)
const canonS3 = (h: string, seg: string | undefined): string[] => {
  const host = h.toLowerCase();
  const v = /^(.+)\.s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.exec(host);
  if (v && v[1] !== "s3") return [`${v[1]}.s3.amazonaws.com`];
  if (/^s3(?:[.-](?:dualstack\.)?[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.test(host) && seg) return [`s3.amazonaws.com/${seg.toLowerCase()}`];
  return [];
};
/** 값에서 "주소 조각"을 뽑는다: 값 전체, URL 호스트, 호스트:포트의 호스트, 쉼표·공백 조각. 부분 문자열은 안 본다 */
export const tokensOf = (v: string): Set<string> => {
  const out = new Set<string>();
  const add = (x: string | undefined) => { if (x) out.add(x.toLowerCase()); };
  const one = (part0: string) => {
    add(part0);
    const part = part0.replace(/^jdbc:/i, "");
    try {
      const u = new URL(part);
      const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      add(h);
      if (h) add(`${h}${u.pathname}`.replace(/\/$/, ""));
      // G3b-4: 경로식 주소의 첫 칸 (s3.amazonaws.com/<버킷>/키, storage.googleapis.com/<버킷>/객체)
      const seg = u.pathname.split("/")[1];
      if (h && seg) add(`${h}/${seg}`);
      for (const x of canonS3(h, seg)) add(x);
    } catch { /* URL 아님 */ }
    // G3b-4: ARN 뒤 경로(arn:aws:s3:::bkt/*, …:bkt/prefix)는 자원 ARN 까지만
    if (/^arn:/i.test(part) && part.includes("/")) add(part.slice(0, part.indexOf("/")));
    // 스킴 없는 호스트/경로 꼴 (bkt.s3.ap-northeast-2.amazonaws.com/key)
    if (!/:\/\//.test(part) && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(part)) {
      const [h0, seg0] = part.split("/");
      add(h0);
      if (h0 && seg0) add(`${h0}/${seg0}`);
      for (const x of canonS3(h0 ?? "", seg0)) add(x);
    }
    const hp = part.match(/^\[?([A-Za-z0-9.:-]+?)\]?:\d+$/);
    if (hp) add(hp[1]);
  };
  const s = String(v).trim();
  add(s);
  // DM-4: Cloud SQL 소켓(/cloudsql/<연결 이름>[/.s.PGSQL.5432]) · Auth Proxy 인자(<연결 이름>?port=…, --instances=<연결 이름>=tcp:…)
  for (const m of s.matchAll(/\/cloudsql\/([A-Za-z0-9.:_-]+)/g)) add(m[1]);
  for (const m of s.matchAll(/(?:^|[\s=,'"])([a-z][a-z0-9.-]*:[a-z0-9-]+:[a-z][a-z0-9-]*)(?=$|[?=\s,'"])/gi)) add(m[1]);
  for (const part of s.split(/[\s,;]+/).filter(Boolean)) {
    one(part);
    for (const sub of part.split(/[=@'"]+/).filter(Boolean)) if (sub !== part) one(sub);   // --db=host, host=x, user@host
  }
  return out;
};
// DM-4: 글자 안에 a 가 앞뒤로 이름 글자(영문·숫자·_·-·.) 없이 들어 있나 ("…=tcp:5432" 처럼 붙은 꼬리는 허용, "shop-sqlx" 는 아님)
const hasBounded = (v: string, a: string) => {
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.-])${esc}(?=$|[^A-Za-z0-9_.-])`, "i").test(v);
};
const isBare = (v: string) => !/[.:/@]/.test(v);   // 점·스킴·포트 없는 맨 이름 → 우연히 같은 글자일 수 있음
export const addressesOf = (c: MappedComponent): string[] =>
  [c.native.endpoint, ...(c.native.aliases ?? [])].filter((x): x is string => typeof x === "string" && x.length > 0);

const merge = (a: Intent | null, b: Intent | null): Intent | null =>
  !a ? b : !b ? a : a === b ? a : a === "admin" || b === "admin" ? "admin" : "readwrite";
const defaultIntent = (k: string): Intent | null => (k === "postgres" || k === "cache" ? "connect" : null);

/** LK-1 DRAFT(ai): env 밖에서 주소가 들어 있을 수 있는 글자 자리. name 은 "@" 로 시작 (env 이름과 안 겹침).
 *  @command[i] · @args[i] · @configs.<이름>.<키> · @sidecars.<이름>.env.<env> · @sidecars.<이름>.args[i] · @initContainers.<이름>.… */
export function extraValuesOf(c: MappedComponent): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const p = c.props as Record<string, unknown>;
  const strs = (label: string, xs: unknown) => { if (Array.isArray(xs)) xs.forEach((x, i) => { if (typeof x === "string" && x) out.push({ name: `@${label}[${i}]`, value: x }); }); };
  strs("command", p.command); strs("args", p.args);
  for (const cfg of (Array.isArray(p.configs) ? p.configs : []) as Array<{ name?: string; data?: Record<string, string> }>)
    for (const [k, v] of Object.entries(cfg.data ?? {})) if (typeof v === "string" && v) out.push({ name: `@configs.${String(cfg.name)}.${k}`, value: v });
  for (const kind of ["sidecars", "initContainers"] as const)
    for (const sc of (Array.isArray(p[kind]) ? p[kind] : []) as Array<Record<string, unknown>>) {
      const n = String(sc.name);
      for (const e of (Array.isArray(sc.env) ? sc.env : []) as Array<Record<string, unknown>>)
        if (typeof e.value === "string" && e.value) out.push({ name: `@${kind}.${n}.env.${String(e.name)}`, value: e.value });
      strs(`${kind}.${n}.command`, sc.command); strs(`${kind}.${n}.args`, sc.args);
    }
  return out;
}

/** 명세에서 뺀 평문 비밀 env (값은 여기서 의존성 근거로만 쓰고 어디에도 안 남긴다) */
export interface MaskedEvidence { from: string; env: string; value: string }

type Grant = NonNullable<LinkV2["grants"]>[number];

export function inferLinks(components: MappedComponent[], masked: MaskedEvidence[] = [], iamPolicies: RawAwsIamPolicy[] = []): LinksOut {
  const links = new Map<string, { from: string; to: string; intent: Intent | null; confidence: number; grants: Grant[] }>();
  const meta: FieldMetaV2 = {};
  const envHits: EnvHit[] = [];
  const add = (from: string, to: string, intent: Intent | null, source: string, confidence: 1 | 0.9 | 0.6, rationale?: string, grant?: Grant) => {
    const k = `${from}->${to}`;
    const prev = links.get(k);
    const next = { from, to, intent: prev ? merge(prev.intent, intent) : intent, confidence: Math.max(prev?.confidence ?? 0, confidence),
      grants: [...(prev?.grants ?? []), ...(grant ? [grant] : [])] };
    links.set(k, next);
    const pm = meta[`links.${k}`];
    const why = [...new Set([pm?.rationale, rationale].filter((x): x is string => Boolean(x)).flatMap((x) => x.split(" / ")))].join(" / ");
    const src = pm ? (pm.source.split(" + ").includes(source) ? pm.source : `${pm.source} + ${source}`) : source;
    meta[`links.${k}`] = { source: src, confidence: next.confidence as 1 | 0.9 | 0.6,
      needs_review: next.confidence < 1, ...(why ? { rationale: why } : {}) };
  };
  const workloads = components.filter((c) => c.kind === "service" || c.kind === "job");
  const targets = components.filter((c) => c.kind !== "service" && c.kind !== "job");
  const envOf = (c: MappedComponent) => (Array.isArray(c.props.env) ? c.props.env : []) as Array<Record<string, unknown>>;

  for (const s of workloads) {
    // LK-1: env 값 + command·args·ConfigMap 값·보조 컨테이너 env·인자도 같은 규칙으로 본다 (이름 앞 "@" = env 밖 자리, extraValuesOf)
    for (const e of [...envOf(s), ...extraValuesOf(s)]) {
      const v = typeof e.value === "string" ? e.value : "";
      if (!v) continue;
      const toks = tokensOf(v), bare = isBare(v);
      // 규칙 1: 값의 주소 조각이 데이터 리소스 주소와 똑같다 → 확실 (맨 이름이면 0.9)
      for (const t of targets) {
        const hit = addressesOf(t).find((a) => toks.has(a.toLowerCase()));
        if (!hit) continue;
        const conf = bare ? 0.9 : 1;
        add(s.id!, t.id!, defaultIntent(t.kind), `env:${String(e.name)}`, conf, bare ? "값이 맨 이름 → 우연히 같을 수 있음" : undefined);
        const ao = t.native.aliasOutputs;
        const output = ao && hit.toLowerCase() in ao ? ao[hit.toLowerCase()] : undefined;
        envHits.push({ from: s.id!, env: String(e.name), target: t, address: hit, confidence: conf, ...(output !== undefined ? { output } : {}) });
      }
      // 규칙 1c (DM-4): Cloud SQL 연결 이름·/cloudsql 소켓(Auth Proxy 사이드카 인자, 소켓 경로 env). 연결 근거는 되지만
      //   도착에서 무엇으로 붙을지(프록시를 도착 인스턴스로·사설 주소로)는 사람이 정한다 → 0.6 검토, 주소 다시 쓰기 안 함
      for (const t of targets) {
        const hit = (t.native.proxyAliases ?? []).find((a) => toks.has(a.toLowerCase()) || hasBounded(v, a));
        if (!hit) continue;
        const why = `Cloud SQL 연결 이름(${hit}) 으로 붙음 (Auth Proxy·소켓) → 도착에서 프록시를 도착 인스턴스로 바꿀지·주소로 붙일지 사람이 정함. 그대로 두면 출발 DB 를 가리킴`;
        add(s.id!, t.id!, defaultIntent(t.kind), `env:${String(e.name)}`, 0.6, why);
        const at = String(e.name).startsWith("@") ? String(e.name).slice(1) : `env.${String(e.name)}`;
        meta[`components.${s.id}.${at}`] = { source: String(e.name).startsWith("@") ? at : `env:${String(e.name)}`, confidence: 0.6, needs_review: true, rationale: why };
      }
      // 규칙 1b: 다른 서비스의 클러스터 안 주소. 같은 네임스페이스의 맨 이름은 0.9
      for (const o of workloads) {
        if (o === s || o.kind !== "service") continue;
        const ns = o.native.namespace;
        const names = [o.native.name, ...(o.svcNames ?? [])];
        // I9: k8s 밖 서비스(ECS Service Connect)는 매퍼가 넘긴 이름(aliases)이 주소. k8s 서비스는 aliases 가 없어 그대로
        // G3-5: 주소마다 어느 Service 이름에서 나왔는지 같이 든다 (endpoints 에 있는 이름일 때만 = 실제 Service 객체).
        //   DRAFT(ai): Service 가 둘 이상일 때만 적는다 (하나면 고를 것이 없어 예전 IR 과 같게 둠)
        const epList = ((o.props.endpoints ?? []) as Array<{ name?: string }>).map((x) => String(x.name));
        const epNames = new Set(epList.length > 1 ? epList : []);
        const withName = (x: string, addrs: string[]) => addrs.map((a) => ({ a, ep: epNames.has(x) ? x : undefined }));
        const full = [...(ns ? names.flatMap((x) => withName(x, [`${x}.${ns}.svc.cluster.local`, `${x}.${ns}.svc`, `${x}.${ns}`])) : []),
          ...addressesOf(o).map((a) => ({ a: a.toLowerCase(), ep: undefined as string | undefined }))];
        const short = ns === s.native.namespace ? names.flatMap((x) => withName(x, [x])) : [];
        const found = full.find((x) => toks.has(x.a)) ?? short.find((x) => toks.has(x.a));
        if (!found) continue;
        const hit = found.a;
        const conf: 1 | 0.9 = full.includes(found) ? 1 : bare ? 0.9 : 1;
        add(s.id!, o.id!, "call", `env:${String(e.name)}`, conf, conf < 1 ? "값이 맨 이름 → 우연히 같을 수 있음" : undefined);
        envHits.push({ from: s.id!, env: String(e.name), target: o, address: hit, confidence: conf, ...(found.ep ? { endpoint: found.ep } : {}) });
      }
    }
    // 규칙 3: 비밀 이름이 DB·캐시 id 와 같거나 id- 로 시작 → 거의 확실
    for (const e of envOf(s)) {
      const fs = e.fromSecret as { secret?: string } | undefined;
      if (!fs?.secret) continue;
      for (const t of targets)
        if ((t.kind === "postgres" || t.kind === "cache") && (fs.secret === t.id || fs.secret.startsWith(`${t.id}-`)))
          add(s.id!, t.id!, "connect", `secretRef:${fs.secret}`, 0.9, "비밀 이름이 대상 id 와 같음");
    }
  }
  // 규칙 2b: 비밀이라 명세에서 뺀 env 라도, 값에 든 호스트 조각이 데이터 리소스 주소와 같으면 의존성 근거로 (비밀 이름 급 0.9).
  //   주소 모양(점·콜론·슬래시·@)이 있는 값만: 비밀번호가 우연히 이름과 같은 경우를 근거로 삼지 않는다. env 다시 쓰기(envHits)는 안 함 — 값은 이미 없다
  for (const m of masked) {
    if (isBare(m.value)) continue;
    const toks = tokensOf(m.value);
    for (const t of targets) {
      if (!addressesOf(t).some((a) => toks.has(a.toLowerCase()))) continue;
      add(m.from, t.id!, defaultIntent(t.kind), `env:${m.env}`, 0.9, "비밀로 뺀 연결 문자열의 호스트가 대상 주소와 같음 (값은 안 남김)");
    }
  }
  // 규칙 2 (I4): 앱 신원의 IAM 정책 → grants 원문. "*" 만으로 덮인 대상은 위에서 이미 이어진 의존성에만 붙는다
  const iam = iamGrants(components, iamPolicies, (from, to) => links.has(`${from}->${to}`));
  for (const a of iam.adds) add(a.from, a.to, a.intent, a.source, a.confidence, a.rationale, a.grant);
  // 규칙 4: 근거 있는 연결이 하나도 없는 대상만, 이름 앞부분이 같은 서비스와 추측(검토 필요). 근거 목록을 먼저 고정 → 순서 무관
  const evidenced = new Set([...links.values()].map((l) => l.to));
  for (const t of targets) {
    const dl = t.props.deadLetter as { to?: string } | undefined;
    if (dl?.to) evidenced.add(dl.to);
  }
  for (const s of workloads)
    for (const t of targets)
      if (!evidenced.has(t.id!) && t.id!.split("-")[0] === s.id!.split("-")[0])
        add(s.id!, t.id!, defaultIntent(t.kind), "heuristic:name", 0.6, "이름 앞부분만 같음. 사람 확인 필요");
  // 신뢰도가 1로 올라간 연결에서는 "맨 이름이라 우연일 수 있음" 이유를 지운다
  for (const [k, l] of links) {
    const mm = meta[`links.${k}`];
    if (l.confidence === 1 && mm?.rationale) {
      const r = mm.rationale.split(" / ").filter((x) => !x.startsWith("값이 맨 이름")).join(" / ");
      if (r) mm.rationale = r; else delete mm.rationale;
    }
  }
  for (const [k, l] of links) if (!l.intent) {
    l.intent = "readwrite";
    const mm = meta[`links.${k}`]!;
    meta[`links.${k}`] = { ...mm, needs_review: true, rationale: [mm.rationale, "읽기·쓰기 근거 없음 → 넓게 둠"].filter(Boolean).join(" / ") };
  }
  // ID-5: 버킷·큐 링크인데 권한 원문(grants)이 없다 → 도착 앱 권한이 비어 403. 검토 줄로 막는다 (출발 IAM 을 못 읽었으면 unread.IAM 줄도 같이 뜸)
  const kindById = new Map(targets.map((t) => [t.id!, t.kind]));
  for (const [k, l] of links) if (!l.grants.length && ["objectStore", "queue"].includes(kindById.get(l.to) ?? "")) {
    const mm = meta[`links.${k}`]!;
    meta[`links.${k}`] = { ...mm, needs_review: true, rationale: [mm.rationale, "출발 권한 원문 없음 → 도착 앱 권한이 안 그려짐(403). 출발 신원 권한을 읽거나 grants 를 적을 것"].filter(Boolean).join(" / ") };
  }
  // DRAFT(ai): grants 는 링크당 SPEC_LIMITS.grantsPerLink 개까지(계약 상한, L-1 로 50 → 500). 넘으면 조용히 자르지 않고 검토 표시 + 몇 개가 잘렸는지 근거에 남긴다 (I4fix)
  for (const [k, l] of links) if (l.grants.length > SPEC_LIMITS.grantsPerLink) {
    const mm = meta[`links.${k}`]!;
    meta[`links.${k}`] = { ...mm, needs_review: true, rationale: [mm.rationale, `grants ${l.grants.length}개 중 ${SPEC_LIMITS.grantsPerLink}개만 담김 → 나머지 ${l.grants.length - SPEC_LIMITS.grantsPerLink}개는 사람이 확인`].filter(Boolean).join(" / ") };
  }
  const key = (l: { from: string; to: string }) => `${l.from}\0${l.to}`;
  const sorted: LinkV2[] = [...links.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .map((l) => ({ from: l.from, to: l.to, intent: l.intent ?? "readwrite", ...(l.grants.length ? { grants: l.grants.slice(0, SPEC_LIMITS.grantsPerLink) } : {}) }));
  return { links: sorted, meta, envHits, permissions: iam.permissions, unmapped: iam.unmapped };
}

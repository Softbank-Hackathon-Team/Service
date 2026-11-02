import type { FieldMetaV2, LinkV2 } from "@svc/contracts";
import type { MappedComponent } from "./types.js";

// DRAFT(ai): 의존성 추론 (설계 20번 4.3(가)·5.3장, PoC inferLinks 의 k8s·DB 부분).
//   신뢰도: env 주소 = 1 (맨 이름이면 0.9), 비밀 이름 = 0.9, 이름 추측 = 0.6.
//   IAM 정책(grants)·S3·SQS·캐시는 다음 묶음(I4·I6) 몫이라 여기서는 안 본다.

type Intent = LinkV2["intent"];
export interface EnvHit { from: string; env: string; target: MappedComponent; address: string; confidence: 1 | 0.9 }
export interface LinksOut { links: LinkV2[]; meta: FieldMetaV2; envHits: EnvHit[] }

/** 값에서 "주소 조각"을 뽑는다: 값 전체, URL 호스트, 호스트:포트의 호스트, 쉼표·공백 조각. 부분 문자열은 안 본다 */
export const tokensOf = (v: string): Set<string> => {
  const out = new Set<string>();
  const add = (x: string | undefined) => { if (x) out.add(x.toLowerCase()); };
  const one = (part0: string) => {
    add(part0);
    const part = part0.replace(/^jdbc:/i, "");
    try {
      const u = new URL(part);
      const h = u.hostname.replace(/^\[|\]$/g, "");
      add(h);
      if (h) add(`${h}${u.pathname}`.replace(/\/$/, ""));
    } catch { /* URL 아님 */ }
    const hp = part.match(/^\[?([A-Za-z0-9.:-]+?)\]?:\d+$/);
    if (hp) add(hp[1]);
  };
  const s = String(v).trim();
  add(s);
  for (const part of s.split(/[\s,;]+/).filter(Boolean)) {
    one(part);
    for (const sub of part.split(/[=@'"]+/).filter(Boolean)) if (sub !== part) one(sub);   // --db=host, host=x, user@host
  }
  return out;
};
const isBare = (v: string) => !/[.:/@]/.test(v);   // 점·스킴·포트 없는 맨 이름 → 우연히 같은 글자일 수 있음
export const addressesOf = (c: MappedComponent): string[] =>
  [c.native.endpoint, ...(c.native.aliases ?? [])].filter((x): x is string => typeof x === "string" && x.length > 0);

const merge = (a: Intent | null, b: Intent | null): Intent | null =>
  !a ? b : !b ? a : a === b ? a : a === "admin" || b === "admin" ? "admin" : "readwrite";
const defaultIntent = (k: string): Intent | null => (k === "postgres" || k === "cache" ? "connect" : null);

/** 명세에서 뺀 평문 비밀 env (값은 여기서 의존성 근거로만 쓰고 어디에도 안 남긴다) */
export interface MaskedEvidence { from: string; env: string; value: string }

export function inferLinks(components: MappedComponent[], masked: MaskedEvidence[] = []): LinksOut {
  const links = new Map<string, { from: string; to: string; intent: Intent | null; confidence: number }>();
  const meta: FieldMetaV2 = {};
  const envHits: EnvHit[] = [];
  const add = (from: string, to: string, intent: Intent | null, source: string, confidence: 1 | 0.9 | 0.6, rationale?: string) => {
    const k = `${from}->${to}`;
    const prev = links.get(k);
    const next = { from, to, intent: prev ? merge(prev.intent, intent) : intent, confidence: Math.max(prev?.confidence ?? 0, confidence) };
    links.set(k, next);
    const pm = meta[`links.${k}`];
    const why = [...new Set([pm?.rationale, rationale].filter((x): x is string => Boolean(x)).flatMap((x) => x.split(" / ")))].join(" / ");
    meta[`links.${k}`] = { source: pm ? `${pm.source} + ${source}` : source, confidence: next.confidence as 1 | 0.9 | 0.6,
      needs_review: next.confidence < 1, ...(why ? { rationale: why } : {}) };
  };
  const workloads = components.filter((c) => c.kind === "service" || c.kind === "job");
  const targets = components.filter((c) => c.kind !== "service" && c.kind !== "job");
  const envOf = (c: MappedComponent) => (Array.isArray(c.props.env) ? c.props.env : []) as Array<Record<string, unknown>>;

  for (const s of workloads) {
    for (const e of envOf(s)) {
      const v = typeof e.value === "string" ? e.value : "";
      if (!v) continue;
      const toks = tokensOf(v), bare = isBare(v);
      // 규칙 1: 값의 주소 조각이 데이터 리소스 주소와 똑같다 → 확실 (맨 이름이면 0.9)
      for (const t of targets) {
        const hit = addressesOf(t).find((a) => toks.has(a.toLowerCase()));
        if (!hit) continue;
        const conf = bare ? 0.9 : 1;
        add(s.id!, t.id!, defaultIntent(t.kind), `env:${String(e.name)}`, conf, bare ? "값이 맨 이름 → 우연히 같을 수 있음" : undefined);
        envHits.push({ from: s.id!, env: String(e.name), target: t, address: hit, confidence: conf });
      }
      // 규칙 1b: 다른 서비스의 클러스터 안 주소. 같은 네임스페이스의 맨 이름은 0.9
      for (const o of workloads) {
        if (o === s || o.kind !== "service") continue;
        const ns = o.native.namespace;
        const names = [o.native.name, ...(o.svcNames ?? [])];
        const full = ns ? names.flatMap((x) => [`${x}.${ns}.svc.cluster.local`, `${x}.${ns}.svc`, `${x}.${ns}`]) : [];
        const short = ns === s.native.namespace ? names : [];
        const hit = full.find((x) => toks.has(x)) ?? short.find((x) => toks.has(x));
        if (!hit) continue;
        const conf: 1 | 0.9 = full.includes(hit) ? 1 : bare ? 0.9 : 1;
        add(s.id!, o.id!, "call", `env:${String(e.name)}`, conf, conf < 1 ? "값이 맨 이름 → 우연히 같을 수 있음" : undefined);
        envHits.push({ from: s.id!, env: String(e.name), target: o, address: hit, confidence: conf });
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
  const key = (l: { from: string; to: string }) => `${l.from}\0${l.to}`;
  const sorted: LinkV2[] = [...links.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .map((l) => ({ from: l.from, to: l.to, intent: l.intent ?? "readwrite" }));
  return { links: sorted, meta, envHits };
}

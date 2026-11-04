import { SECRET_VALUE_PATTERNS, type FieldMetaV2, type UnmappedV2 } from "@svc/contracts";
import type { EnvHit } from "./links.js";
import type { MappedComponent } from "./types.js";

// DRAFT(ai): 환경변수 다루기 (설계 20번 4.3(나), PoC rewriteEnv).
//   ① 평문 비밀 가리기: v1 normalize.ts(Z3-F5)와 같은 규칙. 평문 비밀은 v2 명세에도 안 들어감 → unmapped B + 검토 표시
//   ② 주소 다시 쓰기: 값 전체가 대상 주소면 fromLink, 일부면 template (스킴·포트·경로·쿼리는 출발 글자 그대로)

// LLM-1: 값 모양 규칙은 contracts/src/redact.ts 한 곳(SECRET_VALUE_PATTERNS)을 쓴다.
// DRAFT(ai): 이름 규칙만 여기 따로 둔다. 공통 SECRET_NAME 은 "auth" 를 어디서나 잡는데(가리기용), 여기서 비밀로 보면 env 가 명세에서 빠지므로
//   OAUTH_ISSUER 같은 평범한 주소 env 가 빠지지 않게 auth 는 낱말 경계에서만 잡는다 (NM-1)
export const SECRET_ENV_NAME = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|(^|[_.-])auth([_.-]|$)/i;   // NM-1: REDIS_AUTH·AUTH_KEY (AUTHOR·OAUTH_URL 은 아님)
export const SECRET_ENV_VALUE = SECRET_VALUE_PATTERNS;
export const isPlainSecret = (name: string, value: string) => SECRET_ENV_NAME.test(name) || SECRET_ENV_VALUE.some((r) => r.test(value));

type Env = Record<string, unknown>;
const envList = (c: MappedComponent) => (Array.isArray(c.props.env) ? c.props.env : []) as Env[];

/** ① value 로 적힌 평문 비밀을 명세에서 뺀다 (제자리). 투영 재료에서도 빼고 이름만 남긴다 */
export interface MaskedEnv { from: string; env: string; value: string }
export function maskPlainSecrets(components: MappedComponent[], fieldMeta: FieldMetaV2, unmapped: UnmappedV2[]): MaskedEnv[] {
  const masked: MaskedEnv[] = [];
  for (const c of components) {
    if (c.kind !== "service" && c.kind !== "job") continue;
    const plain = envList(c).filter((e) => typeof e.value === "string" && isPlainSecret(String(e.name), e.value as string));
    if (!plain.length) continue;
    c.props.env = envList(c).filter((e) => !plain.includes(e));
    for (const e of plain) {
      const name = String(e.name);
      masked.push({ from: c.id!, env: name, value: String(e.value) });
      fieldMeta[`components.${c.id}.env.${name}`] = { source: "source.env", confidence: 0.6, needs_review: true,
        rationale: "평문 비밀로 보여 명세에서 뺐다. 도착 비밀 저장소에 등록 후 fromSecret 으로 연결" };
      unmapped.push({ resource: `env:${c.id}.${name}`, grade: "B", reason: "평문 비밀로 보이는 환경변수 → 명세에 안 넣음. 비밀 저장소로 옮겨야 함" });
    }
  }
  // VI9: 보조 컨테이너(sidecars, ECS 매퍼) env 도 같은 규칙. 예전엔 주 컨테이너만 봐서 보조 컨테이너 평문 비밀 값이 spec_v2 에 남았다
  // SEC-1: 초기화 컨테이너(initContainers, N4 로 채움) env 도 같은 규칙
  for (const c of components) {
    if (c.kind !== "service" && c.kind !== "job") continue;
    for (const sc of [...(Array.isArray(c.props.sidecars) ? c.props.sidecars : []), ...(Array.isArray(c.props.initContainers) ? c.props.initContainers : [])] as Env[]) {
      const list = (Array.isArray(sc.env) ? sc.env : []) as Env[];
      const plain = list.filter((e) => typeof e.value === "string" && isPlainSecret(String(e.name), e.value as string));
      if (!plain.length) continue;
      sc.env = list.filter((e) => !plain.includes(e));
      for (const e of plain) {
        const name = String(e.name), scn = String(sc.name);
        masked.push({ from: c.id!, env: `${scn}.${name}`, value: String(e.value) });
        fieldMeta[`components.${c.id}.sidecars.${scn}.env.${name}`] = { source: "source.env", confidence: 0.6, needs_review: true,
          rationale: "보조 컨테이너의 평문 비밀로 보여 명세에서 뺐다. 도착 비밀 저장소에 등록 후 fromSecret 으로 연결" };
        unmapped.push({ resource: `env:${c.id}.${scn}.${name}`, grade: "B", reason: "보조 컨테이너의 평문 비밀로 보이는 환경변수 → 명세에 안 넣음. 비밀 저장소로 옮겨야 함" });
      }
    }
  }
  // SEC-1 DRAFT(ai): command·args 안의 평문 비밀 (주·사이드카·init). "--db-password=값" 은 값만, "--password 값" 은 다음 칸을 바꾼다.
  //   값 자리는 k8s 의 $(이름) 자리표시로 바꾸고(그 이름의 env 는 없음 → 사람이 비밀로 옮겨 env fromSecret 을 더해야 뜸), 검토 표시 + unmapped B
  for (const c of components) {
    if (c.kind !== "service" && c.kind !== "job") continue;
    const holders: Array<{ label: string; o: Env }> = [{ label: "", o: c.props as Env },
      ...((Array.isArray(c.props.sidecars) ? c.props.sidecars : []) as Env[]).map((o) => ({ label: `sidecars.${String(o.name)}.`, o })),
      ...((Array.isArray(c.props.initContainers) ? c.props.initContainers : []) as Env[]).map((o) => ({ label: `initContainers.${String(o.name)}.`, o }))];
    // IA-1: 프로브 exec 명령도 같은 규칙 (redis-cli -a 비번 ping 등). 칸 이름은 probes.<종류>.command
    const fieldsOf = (o: Env): Array<{ field: string; key: string; get: () => unknown; set: (v: string[]) => void }> => [
      ...(["command", "args"] as const).map((f) => ({ field: f, key: f, get: () => o[f], set: (v: string[]) => { o[f] = v; } })),
      ...Object.entries((o.probes && typeof o.probes === "object" ? o.probes : {}) as Record<string, Env>)
        .filter(([, pr]) => pr?.type === "exec")
        .map(([k, pr]) => ({ field: "probe", key: `probes.${k}.command`, get: () => pr.command, set: (v: string[]) => { pr.command = v; } })),
    ];
    for (const { label, o } of holders) for (const { field, key, get, set } of fieldsOf(o)) {
      const raw = get();
      const list = Array.isArray(raw) ? (raw as unknown[]).map(String) : null;
      if (!list) continue;
      let n = 0;
      const tag = key.replace(/\W+/g, "_").toUpperCase();
      const hit = (i: number, value: string, j?: number) => {
        const ph = `$(PLAIN_SECRET_${tag}_${i}${j === undefined ? "" : `_${j}`})`;
        masked.push({ from: c.id!, env: `${label}${key}[${i}]`, value });
        n++;
        return ph;
      };
      const out = list.map((a, i) => {
        const kv = /^(-{1,2}[A-Za-z0-9_.-]+)=(.+)$/.exec(a);
        if (kv && isPlainSecret(kv[1]!, kv[2]!)) return `${kv[1]}=${hit(i, kv[2]!)}`;
        const prev = list[i - 1];
        if (prev && /^-{1,2}[A-Za-z0-9_.-]+$/.test(prev) && SECRET_ENV_NAME.test(prev) && !a.startsWith("-")) return hit(i, a);
        if (prev === "-a" && !a.startsWith("-") && list.slice(0, i).some((x) => /(^|\/)redis-cli$|(^|\/)valkey-cli$/.test(x))) return hit(i, a);
        if (/^-p\S+$/.test(a) && list.slice(0, i).some((x) => /(^|\/)(mysql|mysqladmin|mariadb|mariadb-admin|mysqldump)$/.test(x))) return `-p${hit(i, a.slice(2))}`;
        if (SECRET_ENV_VALUE.some((r) => r.test(a))) return hit(i, a);
        // IA-1: 한 칸에 셸 글이 통째로 든 꼴 (sh -c "redis-cli -a 비번 ping", "psql 'host=… password=…'")
        let j = 0;
        const inline = maskInlineSecrets(a, (v) => hit(i, v, j++));
        return inline;
      });
      if (!n) continue;
      set(out);
      fieldMeta[`components.${c.id}.${label}${key}`] = { source: `source.${field}`, confidence: 0.6, needs_review: true,
        rationale: `${field} 안 평문 비밀로 보이는 값 ${n}개를 $(PLAIN_SECRET_…) 자리표시로 바꿨다. 비밀 저장소에 등록하고 같은 이름 env(fromSecret)를 더해야 함` };
      unmapped.push({ resource: `${field}:${c.id}.${label}${key}`, grade: "B", reason: `${field} 안 평문 비밀로 보이는 값 → 명세에 안 넣음. 비밀 저장소로 옮겨야 함` });
    }
  }
  return masked;
}

// IA-1 DRAFT(ai): 셸 글 한 줄 안의 흔한 비밀 꼴. 값 자리만 바꾼다 (명령 모양은 그대로)
//   redis-cli/valkey-cli -a 값 · mysql/mysqladmin -p값 · --password 값/--password=값 · password=값(DSN) · PGPASSWORD=값 · 접속 주소 안 비밀번호
const INLINE_SECRET: RegExp[] = [
  /((?:^|[\s/])(?:redis|valkey)-cli\b[^|;&]*?\s-a\s+)("[^"]*"|'[^']*'|[^\s;&|'"]+)/g,
  /((?:^|[\s/])(?:mysql|mysqladmin|mariadb|mariadb-admin|mysqldump)\b[^|;&]*?\s-p)([^\s;&|'"]+)/g,
  /((?:^|\s)--?[A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[_-]?key)[A-Za-z0-9_.-]*(?:=|\s+))("[^"]*"|'[^']*'|[^\s;&|'"-][^\s;&|'"]*)/gi,
  /((?:^|[\s'"])(?:[A-Z_]*PASS(?:WORD)?|password|passwd)=)("[^"]*"|[^\s;&|'"]+)/g,
  /(:\/\/[^/\s:@]+:)([^/\s@]+)(?=@)/g,
];
export function maskInlineSecrets(s: string, onHit: (value: string) => string): string {
  let out = s;
  for (const re of INLINE_SECRET) out = out.replace(re, (_m, pre: string, v: string) => (v.startsWith("$(PLAIN_SECRET_") ? `${pre}${v}` : `${pre}${onHit(v)}`));
  return out;
}

const OUTPUT: Record<string, "host" | "name" | "url"> = { postgres: "host", cache: "host", objectStore: "name", queue: "url", service: "host" };
// CNPG-RO DRAFT(ai): 출발 CNPG 의 읽기 전용(<이름>-ro)·아무 인스턴스(<이름>-r) Service 주소였으면 reader (주 서버 host 로 바꾸면 읽기 부하가 주 서버로 감)
const isCnpgReadAddress = (t: MappedComponent, address: string): boolean => {
  if (t.kind !== "postgres" || t.native.type !== "cnpg.cluster") return false;
  const a = address.toLowerCase(), n = String(t.native.name).toLowerCase();
  return ["-ro", "-r"].some((k) => a === `${n}${k}` || a.startsWith(`${n}${k}.`));
};
// SUB-1: 맞춘 글자가 topic 모델 queue 의 구독 이름이면 그 출발 구독 이름 (도착 구독 이름으로 바뀐다)
const subscriptionOf = (h: EnvHit): string | undefined => {
  if (h.target.kind !== "queue" || !Array.isArray(h.target.props.subscriptions)) return undefined;
  return (h.target.props.subscriptions as Array<{ name: string }>).find((s) => s.name.toLowerCase() === h.address.toLowerCase())?.name;
};
// G3b-4 DRAFT(ai): 맞춘 주소가 무슨 꼴이냐에 따라 출력이 다르다. 큐·버킷은 이름 → name, 대표 주소(큐 URL·버킷 이름) → 그 주소 모양(url 꼴 → url, 아니면 name),
//   그 밖(ARN·가상 호스트·경로 주소·토픽 전체 이름)은 도착 출력에 맞는 칸이 없다 → null (값을 바꾸지 않고 검토). 나머지 종류는 기본 출력
//   통합: PSN-1(queue 는 글자 모양) · CNPG-RO(reader) · SUB-1(구독 이름 → name) 을 같은 함수에 합침
export function outputFor(t: MappedComponent, address: string): "host" | "name" | "url" | "reader" | null {
  const a = address.toLowerCase();
  if (isCnpgReadAddress(t, address)) return "reader";
  const def = OUTPUT[t.kind] ?? "host";
  if (t.kind !== "queue" && t.kind !== "objectStore") return def;
  if (typeof t.native.name === "string" && a === t.native.name.toLowerCase()) return "name";
  if (typeof t.native.endpoint === "string" && a === t.native.endpoint.toLowerCase()) return /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? "url" : "name";
  if (subscriptionOf({ target: t, address } as EnvHit)) return "name";
  // PSN-1: 큐를 맨 이름(구독 하나 model=queue 의 구독 이름 등)으로 적었으면 name. ARN(:)·전체 경로(/)는 위 null 규칙대로
  if (t.kind === "queue" && /^[A-Za-z0-9._-]+$/.test(address)) return "name";
  return null;
}
const PORT_KINDS = new Set(["cache"]);   // CT-1: 캐시만 (Memorystore TLS 6378 등 도착마다 포트가 다름). DB 는 출발 글자 그대로(4.3) 유지
// DM-7 DRAFT(ai): DB 도 출발 포트가 기본(5432)이 아니면 링크 port 로 바꾼다 (Cloud SQL·CNPG 도착은 5432 고정, RDS 도착은 같은 포트로 만듦). 5432 는 그대로(4.3)
const portRewrites = (kind: string, port: string) => PORT_KINDS.has(kind) || (kind === "postgres" && port !== ":5432");
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 값 안 주소 자리를 \${<id>.<출력>} 로 바꾼 글자. 주소 자리를 못 정하면 null */
export function templateOf(v: string, pairs: EnvHit[]): string | null {
  // 주소 자리만 바꾼다: 앞이 처음·"//"·"@"·"="·구분자, 뒤가 끝·":"·"/"·"?"·구분자. 긴 주소부터 한 번에
  // G3b-4: 도착 출력이 없는 꼴(ARN 등)은 바꾸지 않는다
  const byLen = [...pairs].filter((h) => outputFor(h.target, h.address) !== null).sort((a, b) => b.address.length - a.address.length);
  if (!byLen.length) return null;
  // CT-1 DRAFT(ai): 캐시 주소 바로 뒤 ":포트" 도 링크 출력 port 로 바꾼다 (도착 포트가 다를 수 있음: Memorystore TLS 6378 등).
  //   주소와 따로 적힌 포트(REDIS_PORT=6379 같은 env)는 근거가 없어 그대로 둔다
  const re = new RegExp(`(^|//|[@=\\s,;'"])(${byLen.map((h) => esc(h.address)).join("|")})(:\\d{1,5})?(?=$|[:/?\\s,;'"])`, "gi");
  // SUB-1: 구독 이름은 템플릿 글자(\${id.출력})로 못 적는다 → 자리 못 정함으로 (값 그대로 + 검토)
  if (pairs.some((h) => subscriptionOf(h))) return null;
  const tpl = v.replace(re, (_all, pre: string, ep: string, port: string | undefined) => {
    const h = byLen.find((x) => x.address.toLowerCase() === ep.toLowerCase())!;
    // G3-5: 서비스 대상이면 부른 Service 이름을 @ 뒤에 남긴다 (도착 Builder 가 그 Service 의 주소로 계산)
    const host = `${pre}\${${h.target.id}.${outputFor(h.target, h.address) ?? "host"}${h.endpoint ? `@${h.endpoint}` : ""}}`;
    if (!port) return host;
    return portRewrites(h.target.kind, port) ? `${host}:\${${h.target.id}.port}` : `${host}${port}`;
  });
  return tpl === v ? null : tpl;
}

/** ② 주소가 든 env 를 fromLink·template 으로 (제자리). 신뢰도 = 이 줄이 맞춘 근거 중 가장 낮은 것 (G3c-3: 연결 신뢰도로 안 올림).
 *  LK-1: 이름이 "@" 로 시작하는 자리(command·args·ConfigMap 값·보조 컨테이너)는 rewriteExtra 가 맡는다 */
export function rewriteEnv(components: MappedComponent[], envHits: EnvHit[], fieldMeta: FieldMetaV2): void {
  rewriteExtra(components, envHits.filter((h) => h.env.startsWith("@")), fieldMeta);
  envHits = envHits.filter((h) => !h.env.startsWith("@"));
  const byId = new Map(components.map((c) => [c.id!, c]));
  const groups = new Map<string, EnvHit[]>();
  for (const h of envHits) groups.set(`${h.from}\0${h.env}`, [...(groups.get(`${h.from}\0${h.env}`) ?? []), h]);
  for (const [k, hits] of groups) {
    const [sid, name] = k.split("\0") as [string, string];
    const e = envList(byId.get(sid)!).find((x) => x.name === name);
    if (!e || typeof e.value !== "string") continue;
    const v = e.value;
    // G3c-3 DRAFT(ai): 신뢰도 = 이 줄이 맞은 근거만 (가장 낮은 것). 링크 신뢰도로 올리지 않는다 — 같은 링크에 다른 확실한 근거(UPSTREAM=http://worker.shop.svc)가
    //   있어도 이 줄(ROLE=worker, 맨 이름 0.9)은 우연일 수 있어 사람이 봐야 한다
    const conf = Math.min(...hits.map((h) => h.confidence)) as 1 | 0.9 | 0.6;
    // 같은 대상을 여러 주소로 맞췄을 수 있다 → (대상, 주소) 쌍
    const pairs = [...new Map(hits.map((h) => [`${h.target.id}\0${h.address.toLowerCase()}`, h])).values()];
    // G3b-4: 같은 모양 출력이 도착에 없는 주소(ARN·버킷 가상 호스트·토픽 전체 이름)로 맞췄으면 값은 그대로, 의존성만 잇고 검토 줄
    if (pairs.some((h) => h.output === null)) {
      fieldMeta[`components.${sid}.env.${name}`] = { source: `env:${name}`, confidence: 0.6, needs_review: true,
        rationale: `값이 ${[...new Set(pairs.map((h) => h.target.id))].join(", ")} 를 가리키는 출발 주소 모양(ARN·버킷 주소·전체 이름) → 도착 이름으로 사람이 고칠 것` };
      continue;
    }
    const targets = new Set(pairs.map((h) => h.target.id));
    const wholeHit = targets.size === 1 ? pairs.find((h) => v.toLowerCase() === h.address.toLowerCase()) : undefined;
    // G3b-4: ARN·가상 호스트처럼 도착 출력이 없는 꼴로만 맞았으면 값은 출발 그대로 두고 검토 (의존성은 이미 생김)
    if (pairs.every((h) => outputFor(h.target, h.address) === null)) {
      fieldMeta[`components.${sid}.env.${name}`] = { source: `env:${name}`, confidence: 0.6, needs_review: true,
        rationale: "출발 자원을 ARN·가상 호스트·전체 이름 꼴로 적음 → 도착 출력(이름·주소)으로 바꿀 칸이 없어 출발 값 그대로. 도착 값으로 고쳐야 함" };
      continue;
    }
    delete e.value;
    if (wholeHit && outputFor(wholeHit.target, wholeHit.address) !== null) {
      const t = wholeHit.target, ep = wholeHit.endpoint, sub = subscriptionOf(wholeHit);
      e.fromLink = { to: t.id, output: sub ? "name" : outputFor(t, wholeHit.address)!, ...(ep ? { endpoint: ep } : {}), ...(sub ? { subscription: sub } : {}) };
    } else {
      const tpl = templateOf(v, pairs) ?? v;
      // 주소 자리를 못 찾았으면(조각 규칙과 자리 규칙이 어긋남) 값을 그대로 두고 검토만
      if (tpl === v) { e.value = v; fieldMeta[`components.${sid}.env.${name}`] = { source: `env:${name}`, confidence: 0.6, needs_review: true,
        rationale: "대상 주소가 값 안에 있지만 주소 자리를 못 정함 → 사람이 확인" }; continue; }
      e.template = tpl;
    }
    // DM-4: 읽기 전용 주소(CNPG -ro·-r)를 쓰기 주소로 바꿈 → 검토
    const ro = pairs.some((h) => h.target.native.type === "cnpg.cluster" && /-(ro|r)(\.|$)/.test(h.address));
    const c2 = (ro ? Math.min(conf, 0.9) : conf) as 1 | 0.9 | 0.6;
    fieldMeta[`components.${sid}.env.${name}`] = { source: `env:${name}`, confidence: c2, needs_review: c2 < 1,
      rationale: [e.fromLink ? "값 전체가 대상 주소 → 의존성 출력으로" : "값 일부가 대상 주소 → 나머지 글자(스킴·포트·경로·쿼리)는 그대로 두고 주소만 바꿈",
        ro && "읽기 전용 주소(-ro·-r) → 도착은 DB 쓰기 주소 하나로 바뀜 (읽기 분산 사라짐)"].filter(Boolean).join(" / ") };
  }
}

// LK-1 DRAFT(ai): env 밖 글자 자리(command·args·ConfigMap 값·보조 컨테이너 env·인자)의 출발 주소 → 템플릿 (제자리).
//   command·args 는 위치 번호를 commandTemplates·argTemplates 에, ConfigMap 은 키를 templateKeys 에 적는다 (도착 렌더가 그 자리만 푼다).
//   보조 컨테이너 env 는 주 컨테이너 env 와 같이 fromLink·template. 주소 자리를 못 정하면 값 그대로 + 0.6 검토
type Holder = Record<string, unknown>;
function rewriteExtra(components: MappedComponent[], hits: EnvHit[], fieldMeta: FieldMetaV2): void {
  const byId = new Map(components.map((c) => [c.id!, c]));
  const groups = new Map<string, EnvHit[]>();
  for (const h of hits) groups.set(`${h.from}\0${h.env}`, [...(groups.get(`${h.from}\0${h.env}`) ?? []), h]);
  const mark = (o: Holder, key: "commandTemplates" | "argTemplates", i: number) => {
    const xs = new Set((o[key] as number[] | undefined) ?? []); xs.add(i); o[key] = [...xs].sort((a, b) => a - b);
  };
  for (const [k, hs] of groups) {
    const [sid, label] = k.split("\0") as [string, string];
    const c = byId.get(sid);
    if (!c) continue;
    const pairs = [...new Map(hs.map((h) => [`${h.target.id}\0${h.address.toLowerCase()}`, h])).values()];
    const conf = Math.min(...hs.map((h) => h.confidence)) as 1 | 0.9 | 0.6;   // G3c-3: 이 자리가 맞은 근거만
    const key = `components.${sid}.${label.slice(1)}`;
    const fail = () => { fieldMeta[key] = { source: label.slice(1), confidence: 0.6, needs_review: true, rationale: "출발 주소가 값 안에 있지만 주소 자리를 못 정함 → 출발을 가리킨 채 옮겨짐. 사람이 확인" }; };
    const ok = () => { fieldMeta[key] = { source: label.slice(1), confidence: conf, needs_review: conf < 1, rationale: "값 안 출발 주소를 도착 주소 자리표시로 바꿈 (나머지 글자는 그대로)" }; };
    // 자리 찾기
    let m = /^@(?:(sidecars|initContainers)\.([^.]+)\.)?(command|args)\[(\d+)\]$/.exec(label);
    if (m) {
      const holder: Holder | undefined = m[1] ? ((c.props[m[1]] as Holder[] | undefined) ?? []).find((x) => String(x.name) === m![2]) : c.props;
      const list = holder?.[m[3]!] as string[] | undefined;
      const i = Number(m[4]);
      if (!holder || !list || typeof list[i] !== "string") continue;
      const tpl = templateOf(list[i]!, pairs);
      if (!tpl) { fail(); continue; }
      list[i] = tpl; mark(holder, m[3] === "command" ? "commandTemplates" : "argTemplates", i); ok();
      continue;
    }
    m = /^@configs\.([^.]+)\.(.+)$/.exec(label);
    if (m) {
      const cfg = ((c.props.configs as Holder[] | undefined) ?? []).find((x) => String(x.name) === m![1]);
      const data = cfg?.data as Record<string, string> | undefined;
      if (!cfg || !data || typeof data[m[2]!] !== "string") continue;
      const tpl = templateOf(data[m[2]!]!, pairs);
      if (!tpl) { fail(); continue; }
      data[m[2]!] = tpl;
      cfg.templateKeys = [...new Set([...((cfg.templateKeys as string[] | undefined) ?? []), m[2]!])].sort();
      ok();
      continue;
    }
    m = /^@(sidecars|initContainers)\.([^.]+)\.env\.(.+)$/.exec(label);
    if (m) {
      const holder = ((c.props[m[1]!] as Holder[] | undefined) ?? []).find((x) => String(x.name) === m![2]);
      const e = ((holder?.env as Holder[] | undefined) ?? []).find((x) => x.name === m![3]);
      if (!e || typeof e.value !== "string") continue;
      const v = e.value;
      const targets = new Set(pairs.map((h) => h.target.id));
      if (targets.size === 1 && pairs.some((h) => v.toLowerCase() === h.address.toLowerCase())) {
        const w = pairs.find((h) => v.toLowerCase() === h.address.toLowerCase())!, out = outputFor(w.target, w.address), sub = subscriptionOf(w);
        if (out) { delete e.value; e.fromLink = { to: w.target.id, output: sub ? "name" : out, ...(w.endpoint ? { endpoint: w.endpoint } : {}), ...(sub ? { subscription: sub } : {}) }; ok(); continue; }
      }
      const tpl = templateOf(v, pairs);
      if (!tpl) { fail(); continue; }
      delete e.value; e.template = tpl; ok();
    }
  }
}

/** DM-7 DRAFT(ai): 주소와 따로 적힌 포트 env (DB_PORT=5433). 이 워크로드가 이어진 DB·캐시의 출발 포트가 기본값이 아니고,
 *  env 이름에 PORT 가 들고 값이 그 포트와 똑같으면 링크 출력 port 로 (0.9: 이름·값 일치라 우연일 수 있음). 기본 포트면 그대로 둔다 */
export function rewritePortEnv(components: MappedComponent[], links: Array<{ from: string; to: unknown }>, fieldMeta: FieldMetaV2): void {
  const byId = new Map(components.map((c) => [c.id!, c]));
  const DEF: Record<string, number> = { postgres: 5432, cache: 6379 };
  for (const l of links) {
    if (typeof l.to !== "string") continue;
    const t = byId.get(l.to), s = byId.get(l.from);
    if (!t || !s || !(t.kind in DEF) || typeof t.props.port !== "number" || t.props.port === DEF[t.kind]) continue;
    const hits = envList(s).filter((e) => typeof e.value === "string" && /PORT/i.test(String(e.name)) && e.value.trim() === String(t.props.port));
    for (const e of hits) {
      delete e.value; e.fromLink = { to: t.id, output: "port" };
      fieldMeta[`components.${s.id}.env.${String(e.name)}`] = { source: `env:${String(e.name)}`, confidence: 0.9, needs_review: true,
        rationale: `이름에 PORT 가 있고 값이 ${t.id} 출발 포트(${t.props.port})와 같음 → 도착 포트 출력으로 바꿈. 사람 확인` };
    }
  }
}

/** FM-IR-C07 DRAFT(ai): 다시 쓰기가 끝난 뒤에도 env·ConfigMap 값에 출발 클라우드 관리형 DB·캐시 주소가 글자 그대로 남아 있으면
 *  (그 DB 가 명세에 없음: 다른 리전·계정·경계 밖·못 읽음) 도착 앱이 출발 DB 를 가리키게 된다 → 조용히 두지 않고 검토 줄.
 *  값은 안 바꾼다 (끌어오기 BOUNDPULL·사람 PATCH 몫). 이미 검토 표시가 있는 칸은 그대로 둔다 */
const SOURCE_DATA_HOST = /[a-z0-9-]+(\.[a-z0-9-]+)*\.(rds|cache|docdb|redshift)\.amazonaws\.com(\.cn)?|[a-z0-9-]+\.(postgres\.database\.azure\.com|redis\.cache\.windows\.net)/i;
export function flagSourceDataHosts(components: MappedComponent[], fieldMeta: FieldMetaV2): void {
  const why = (host: string) => `출발 관리형 데이터 주소 ${host} 가 그대로 남음 → 그 DB·캐시가 명세에 없어(다른 리전·계정·경계 밖) 도착 앱이 출발을 가리킴. 경계 밖 목록에서 끌어오거나 값을 고침`;
  for (const c of components) {
    if (c.kind !== "service" && c.kind !== "job") continue;
    for (const e of envList(c)) {
      const hit = typeof e.value === "string" ? SOURCE_DATA_HOST.exec(e.value) : null;
      const key = `components.${c.id}.env.${String(e.name)}`;
      if (hit && !fieldMeta[key]) fieldMeta[key] = { source: `env:${String(e.name)}`, confidence: 0.6, needs_review: true, rationale: why(hit[0]) };
    }
    for (const cfg of ((c.props.configs as Array<{ name?: unknown; data?: Record<string, unknown> }> | undefined) ?? [])) {
      for (const [k, v] of Object.entries(cfg.data ?? {})) {
        const hit = typeof v === "string" ? SOURCE_DATA_HOST.exec(v) : null;
        const key = `components.${c.id}.configs.${String(cfg.name)}.${k}`;
        if (hit && !fieldMeta[key]) fieldMeta[key] = { source: `configmap:${String(cfg.name)}.${k}`, confidence: 0.6, needs_review: true, rationale: why(hit[0]) };
      }
    }
  }
}

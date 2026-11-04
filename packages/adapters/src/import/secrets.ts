import type { FieldMetaV2, LinkV2, SecretKeyV2, SecretV2 } from "@svc/contracts";
import type { RawK8sIngress } from "./raw-k8s.js";
import type { MappedComponent } from "./types.js";

// T1·SC-1·CA-1 DRAFT(ai): 워크로드가 쓰는 비밀 → 공통 명세 secrets 표 (이름·type·키 이름만, 값 없음). 순수 함수.
//   1) 쓰임 모으기: env fromSecret(키 하나) · envFrom secret · secretMounts(통째 = allKeys)
//   2) type 추정: 플랫폼은 Secret 객체를 안 읽는다(값 보호) → 쓰임새로. Ingress tls → kubernetes.io/tls, imagePullSecrets → dockerconfigjson, 나머지 Opaque.
//      신뢰도 0.9 지만 검토 표시는 안 함 (복사 Job 이 type 별 필수 키를 출발 파일에서 확인하고 없으면 멈춤 = SECRET_TYPE_REQUIRED_KEYS)
//   3) 짝 추론(T1·CA-1): 같은 워크로드가 connect 로 닿는 postgres·cache(AUTH 켬) 중 하나의 비밀번호로 보이는 키 → pairedWith.
//      근거 = env 이름 접두어가 그 대상 주소 env 와 같음(DB_HOST ↔ DB_PASSWORD) → 이름 힌트(REDIS·PG…) → 대상이 하나뿐. 신뢰도 0.9 + 검토 표시.
//      대상이 여럿인데 못 고르면 짝 없이 0.6 검토 줄. 두 워크로드가 같은 키를 다른 대상 짝으로 쓰면 짝을 안 붙이고 0.6

type Env = Record<string, unknown>;
const envsOf = (c: MappedComponent): Env[] => [
  ...((Array.isArray(c.props.env) ? c.props.env : []) as Env[]),
  ...((Array.isArray(c.props.sidecars) ? c.props.sidecars : []) as Env[]).flatMap((s) => (Array.isArray(s.env) ? s.env : []) as Env[]),
  ...((Array.isArray(c.props.initContainers) ? c.props.initContainers : []) as Env[]).flatMap((s) => (Array.isArray(s.env) ? s.env : []) as Env[]),
];

const SUFFIX = /_?(HOST|HOSTNAME|ADDR|ADDRESS|URL|URI|DSN|ENDPOINT|PORT|USER|USERNAME|PASSWORD|PASSWD|PASS|PWD|AUTH|AUTH_TOKEN|TOKEN|SECRET)$/i;
const prefixOf = (name: string) => name.replace(SUFFIX, "").toUpperCase();
const PG_PASS = /PASS|PWD/i;
const CACHE_PASS = /PASS|PWD|AUTH|TOKEN/i;
const CACHE_HINT = /REDIS|CACHE|VALKEY|MEMCACHE|ELASTICACHE|MEMORYSTORE/i;
const PG_HINT = /PG|POSTGRES|DB|DATABASE|SQL/i;

interface Use { secret: string; key?: string; env?: string; from: string }

export function buildSecrets(components: MappedComponent[], links: LinkV2[], ingresses: RawK8sIngress[], fieldMeta: FieldMetaV2): SecretV2[] {
  const workloads = components.filter((c) => c.kind === "service" || c.kind === "job");
  const uses: Use[] = [];
  const whole = new Set<string>();
  for (const w of workloads) {
    for (const e of envsOf(w)) {
      const fs = e.fromSecret as { secret?: string; key?: string } | undefined;
      if (fs?.secret && fs.key) uses.push({ secret: fs.secret, key: fs.key, env: String(e.name), from: w.id! });
    }
    for (const f of (Array.isArray(w.props.envFrom) ? w.props.envFrom : []) as Env[])
      if (typeof f.secret === "string") { uses.push({ secret: f.secret, from: w.id! }); whole.add(f.secret); }
    for (const m of (Array.isArray(w.props.secretMounts) ? w.props.secretMounts : []) as Env[])
      if (typeof m.secret === "string") { uses.push({ secret: m.secret, from: w.id! }); whole.add(m.secret); }
  }
  if (!uses.length) return [];

  const tlsNames = new Set(ingresses.flatMap((i) => (i.spec.tls ?? []).map((t) => t.secretName).filter((x): x is string => !!x)));
  const pullNames = new Set(workloads.flatMap((w) => (Array.isArray(w.props.imagePullSecrets) ? w.props.imagePullSecrets : []) as unknown[])
    .map((x) => (typeof x === "string" ? x : (x as { name?: string })?.name)).filter((x): x is string => !!x));

  // 짝 후보: 워크로드 → connect 로 닿는 postgres·cache(AUTH 켬)
  const byId = new Map(components.map((c) => [c.id!, c] as const));
  const targetsOf = (from: string) => links.filter((l) => l.from === from && l.intent === "connect" && typeof l.to === "string")
    .map((l) => byId.get(l.to as string)).filter((t): t is MappedComponent => !!t && (t.kind === "postgres" || (t.kind === "cache" && t.props.auth === true)));
  // 대상 주소 env 의 접두어 (rewriteEnv 뒤라 fromLink·template 으로 보인다)
  const prefixesTo = (w: MappedComponent, to: string) => new Set(envsOf(w).filter((e) => {
    const fl = e.fromLink as { to?: string } | undefined;
    return fl?.to === to || (typeof e.template === "string" && e.template.includes(`\${${to}.`));
  }).map((e) => prefixOf(String(e.name))));

  const pairs = new Map<string, Set<string>>();   // "<비밀>\u0000<키>" → 대상 id 들
  const pairWhy = new Map<string, string>();
  const ambiguous = new Map<string, string>();
  for (const u of uses) {
    if (!u.key || !u.env) continue;
    const w = byId.get(u.from)!;
    const word = `${u.env} ${u.key}`;
    const cands = targetsOf(u.from).filter((t) => (t.kind === "postgres" ? PG_PASS : CACHE_PASS).test(word));
    if (!cands.length) continue;
    const p = prefixOf(u.env);
    let pick = cands.filter((t) => prefixesTo(w, t.id!).has(p));
    let why = `env 이름 접두어 ${p || "(없음)"} 가 ${pick[0]?.id ?? ""} 주소 env 와 같음`;
    if (pick.length !== 1) {
      const hint = cands.filter((t) => (t.kind === "cache" ? CACHE_HINT : PG_HINT).test(word));
      if (hint.length === 1) { pick = hint; why = `이름(${u.env}/${u.key})이 ${hint[0]!.kind} 를 가리킴`; }
      else if (cands.length === 1) { pick = cands; why = `${u.from} 가 connect 로 닿는 비밀번호 대상이 ${cands[0]!.id} 하나`; }
      else { ambiguous.set(`${u.secret}\u0000${u.key}`, `${u.from}.${u.env}: 비밀번호로 보이는데 대상 ${cands.map((t) => t.id).sort().join(",")} 중 어느 것인지 모름`); continue; }
    }
    const k = `${u.secret}\u0000${u.key}`;
    pairs.set(k, (pairs.get(k) ?? new Set()).add(pick[0]!.id!));
    pairWhy.set(k, `${u.from}.${u.env}: ${why}`);
  }

  const names = [...new Set(uses.map((u) => u.secret))].sort();
  return names.map((name): SecretV2 => {
    const keys = [...new Set(uses.filter((u) => u.secret === name && u.key).map((u) => u.key!))].sort();
    const type = tlsNames.has(name) || (keys.includes("tls.crt") && keys.includes("tls.key")) ? "kubernetes.io/tls"
      : pullNames.has(name) || keys.includes(".dockerconfigjson") ? "kubernetes.io/dockerconfigjson" : "Opaque";
    fieldMeta[`secrets.${name}.type`] = { source: `uses:${[...new Set(uses.filter((u) => u.secret === name).map((u) => u.from))].sort().join(",")}`,
      confidence: 0.9, needs_review: false,
      rationale: type === "Opaque" ? "Secret 객체는 안 읽음(값 보호) → 특별한 쓰임새가 없어 Opaque 로 둠" : `쓰임새로 ${type} 추정 (복사 Job 이 필수 키 확인)` };
    const out: SecretKeyV2[] = keys.map((key) => {
      const k = `${name}\u0000${key}`;
      const to = pairs.get(k);
      if (to && to.size === 1) {
        const component = [...to][0]!;
        fieldMeta[`secrets.${name}.keys.${key}.pairedWith`] = { source: "import.secrets", confidence: 0.9, needs_review: true,
          // PF-A6: 설명은 실제로 하는 일만. 도착 렌더·값 복사가 짝 키를 도착 비밀번호로 바꿔 끼우는 길은 아직 없음(target/cloud.ts TODO(human), PREFLIGHT FM-APP-20)
          rationale: `${pairWhy.get(k)} → 이 키는 ${component} 비밀번호로 봄. 도착에서는 출발 값이 아니라 ${component} 의 도착 비밀번호가 들어가야 함(자동 바꿔 끼우기는 아직 없음, 계획·배포 전에 사람이 확인)` };
        return { key, pairedWith: { component, output: "password" } };
      }
      if (to && to.size > 1)
        fieldMeta[`secrets.${name}.keys.${key}.pairedWith`] = { source: "import.secrets", confidence: 0.6, needs_review: true,
          rationale: `여러 워크로드가 이 키를 서로 다른 대상(${[...to].sort().join(",")})의 비밀번호로 씀 → 짝을 안 붙임. 사람이 정함` };
      else if (ambiguous.has(k))
        fieldMeta[`secrets.${name}.keys.${key}.pairedWith`] = { source: "import.secrets", confidence: 0.6, needs_review: true, rationale: `${ambiguous.get(k)} → 짝을 안 붙임. 사람이 정함` };
      return { key };
    });
    return { name, type, allKeys: whole.has(name), keys: out };
  });
}

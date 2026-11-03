import type { FieldMetaV2, UnmappedV2 } from "@svc/contracts";
import type { EnvHit } from "./links.js";
import type { MappedComponent } from "./types.js";

// DRAFT(ai): 환경변수 다루기 (설계 20번 4.3(나), PoC rewriteEnv).
//   ① 평문 비밀 가리기: v1 normalize.ts(Z3-F5)와 같은 규칙. 평문 비밀은 v2 명세에도 안 들어감 → unmapped B + 검토 표시
//   ② 주소 다시 쓰기: 값 전체가 대상 주소면 fromLink, 일부면 template (스킴·포트·경로·쿼리는 출발 글자 그대로)

// common/normalize.ts 의 SECRET_ENV_NAME·SECRET_ENV_VALUE 와 같은 기준 (그쪽은 export 안 됨 → 같이 고칠 것)
export const SECRET_ENV_NAME = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential/i;
export const SECRET_ENV_VALUE = [/AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /sk-ant-[A-Za-z0-9_-]{10,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /:\/\/[^/\s:@]+:[^/\s@]+@/];
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
    if (c.projection) {
      const names = new Set(plain.map((e) => String(e.name)));
      c.projection.plainSecretNames = c.projection.env.filter((e) => names.has(e.name)).map((e) => e.name);
      c.projection.env = c.projection.env.filter((e) => !names.has(e.name));
    }
  }
  return masked;
}

const OUTPUT: Record<string, "host" | "name" | "url"> = { postgres: "host", cache: "host", objectStore: "name", queue: "url", service: "host" };
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ② 주소가 든 env 를 fromLink·template 으로 (제자리). 신뢰도 = 맞춘 근거 중 가장 낮은 것(연결 신뢰도와 큰 쪽) */
export function rewriteEnv(components: MappedComponent[], envHits: EnvHit[], fieldMeta: FieldMetaV2): void {
  const byId = new Map(components.map((c) => [c.id!, c]));
  const groups = new Map<string, EnvHit[]>();
  for (const h of envHits) groups.set(`${h.from}\0${h.env}`, [...(groups.get(`${h.from}\0${h.env}`) ?? []), h]);
  for (const [k, hits] of groups) {
    const [sid, name] = k.split("\0") as [string, string];
    const e = envList(byId.get(sid)!).find((x) => x.name === name);
    if (!e || typeof e.value !== "string") continue;
    const v = e.value;
    const conf = Math.min(...hits.map((h) => Math.max(h.confidence, fieldMeta[`links.${sid}->${h.target.id}`]?.confidence ?? 0))) as 1 | 0.9 | 0.6;
    // 같은 대상을 여러 주소로 맞췄을 수 있다 → (대상, 주소) 쌍
    const pairs = [...new Map(hits.map((h) => [`${h.target.id}\0${h.address.toLowerCase()}`, h])).values()];
    const targets = new Set(pairs.map((h) => h.target.id));
    const whole = targets.size === 1 && pairs.some((h) => v.toLowerCase() === h.address.toLowerCase());
    delete e.value;
    if (whole) {
      const t = pairs[0]!.target;
      e.fromLink = { to: t.id, output: OUTPUT[t.kind] ?? "host" };
    } else {
      // 주소 자리만 바꾼다: 앞이 처음·"//"·"@"·"="·구분자, 뒤가 끝·":"·"/"·"?"·구분자. 긴 주소부터 한 번에
      const byLen = [...pairs].sort((a, b) => b.address.length - a.address.length);
      const re = new RegExp(`(^|//|[@=\\s,;'"])(${byLen.map((h) => esc(h.address)).join("|")})(?=$|[:/?\\s,;'"])`, "gi");
      const tpl = v.replace(re, (_all, pre: string, ep: string) => {
        const h = byLen.find((x) => x.address.toLowerCase() === ep.toLowerCase())!;
        return `${pre}\${${h.target.id}.${h.target.kind === "queue" ? "url" : OUTPUT[h.target.kind] ?? "host"}}`;
      });
      // 주소 자리를 못 찾았으면(조각 규칙과 자리 규칙이 어긋남) 값을 그대로 두고 검토만
      if (tpl === v) { e.value = v; fieldMeta[`components.${sid}.env.${name}`] = { source: `env:${name}`, confidence: 0.6, needs_review: true,
        rationale: "대상 주소가 값 안에 있지만 주소 자리를 못 정함 → 사람이 확인" }; continue; }
      e.template = tpl;
    }
    fieldMeta[`components.${sid}.env.${name}`] = { source: `env:${name}`, confidence: conf, needs_review: conf < 1,
      rationale: e.fromLink ? "값 전체가 대상 주소 → 의존성 출력으로" : "값 일부가 대상 주소 → 나머지 글자(스킴·포트·경로·쿼리)는 그대로 두고 주소만 바꿈" };
  }
}

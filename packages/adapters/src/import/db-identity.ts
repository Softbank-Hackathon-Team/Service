import type { FieldMetaV2 } from "@svc/contracts";
import { addressesOf, extraValuesOf, tokensOf, type EnvHit, type MaskedEvidence } from "./links.js";
import type { MappedComponent } from "./types.js";

// DBN-1·E10-2 DRAFT(ai): 앱이 실제로 붙는 DB 이름·계정을 앱 연결 글자에서 읽어 postgres IR(appDatabase·appUser)에 담는다.
//   근거 순서: 연결 주소 글자(postgres://user@host/db, jdbc:…?user=, "host=… dbname=… user=…") = 1,
//   이 DB 하나에만 이어진 워크로드의 DB_NAME·DB_USER 류 env = 0.9, 매퍼 값(RDS DBName·MasterUsername, CNPG initdb) = 매퍼 신뢰도.
//   앱마다 값이 다르면 아무 값도 고르지 않고(매퍼 값 유지) 0.6 검토. 비밀번호는 읽지도 남기지도 않는다.

type Env = Record<string, unknown>;
const envList = (c: MappedComponent) => (Array.isArray(c.props.env) ? c.props.env : []) as Env[];
const ident = (x: string | null | undefined) => (x && /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(x) ? x : null);

/** 연결 글자 하나에서 { user, db }. 못 읽으면 null 칸 */
export function dbIdentityOf(v: string): { user: string | null; db: string | null } {
  const s = v.trim().replace(/^jdbc:/i, "");
  try {
    const u = new URL(s);
    if (/^postgres(ql)?:$/i.test(u.protocol)) {
      const dec = (x: string) => { try { return decodeURIComponent(x); } catch { return x; } };
      return { user: ident(dec(u.username) || u.searchParams.get("user")), db: ident(dec(u.pathname.replace(/^\//, "")) || u.searchParams.get("dbname")) };
    }
  } catch { /* URL 아님 */ }
  const kv = (k: string) => new RegExp(`(?:^|\\s)${k}\\s*=\\s*'?([^\\s']+)'?`, "i").exec(s)?.[1] ?? null;
  return { user: ident(kv("user")), db: ident(kv("dbname")) };
}

const DB_NAME_ENV = /^(DB|DATABASE|POSTGRES|POSTGRESQL|PG)_?(NAME|DATABASE|DB)$/i;
const DB_USER_ENV = /^(DB|DATABASE|POSTGRES|POSTGRESQL|PG)_?(USER|USERNAME)$/i;

export function inferDbIdentity(components: MappedComponent[], envHits: EnvHit[], masked: MaskedEvidence[],
  links: Array<{ from: string; to: unknown }>, fieldMeta: FieldMetaV2): void {
  const byId = new Map(components.map((c) => [c.id!, c]));
  const pgs = components.filter((c) => c.kind === "postgres");
  if (!pgs.length) return;
  type Cand = { v: string; src: string; conf: 1 | 0.9 };
  const users = new Map<string, Cand[]>(), dbs = new Map<string, Cand[]>();
  const put = (m: Map<string, Cand[]>, id: string, c: Cand) => m.set(id, [...(m.get(id) ?? []), c]);
  const valueOf = (h: EnvHit): string | null => {
    const c = byId.get(h.from);
    if (!c) return null;
    if (h.env.startsWith("@")) return extraValuesOf(c).find((x) => x.name === h.env)?.value ?? null;
    const e = envList(c).find((x) => x.name === h.env);
    return typeof e?.value === "string" ? e.value : null;
  };
  // ① 연결 글자 (env·command·ConfigMap 값 등에서 대상 주소를 맞춘 자리)
  for (const h of envHits) {
    if (h.target.kind !== "postgres") continue;
    const v = valueOf(h);
    if (!v) continue;
    const r = dbIdentityOf(v), src = `${h.from}:${h.env.startsWith("@") ? h.env.slice(1) : `env:${h.env}`}`;
    if (r.user) put(users, h.target.id!, { v: r.user, src, conf: 1 });
    if (r.db) put(dbs, h.target.id!, { v: r.db, src, conf: 1 });
  }
  // ①b 비밀로 뺀 연결 문자열 (값은 여기서만 보고 버림. 계정·DB 이름만 남김)
  for (const m of masked) {
    const toks = tokensOf(m.value);
    const t = pgs.find((p) => addressesOf(p).some((a) => toks.has(a.toLowerCase())));
    if (!t) continue;
    const r = dbIdentityOf(m.value), src = `${m.from}:env:${m.env}`;
    if (r.user) put(users, t.id!, { v: r.user, src, conf: 1 });
    if (r.db) put(dbs, t.id!, { v: r.db, src, conf: 1 });
  }
  // ② 이 postgres 하나에만 이어진 워크로드의 DB_NAME·DB_USER 류 env
  for (const w of components.filter((c) => c.kind === "service" || c.kind === "job")) {
    const to = [...new Set(links.filter((l) => l.from === w.id && typeof l.to === "string" && byId.get(l.to)?.kind === "postgres").map((l) => l.to as string))];
    if (to.length !== 1) continue;
    for (const e of envList(w)) {
      if (typeof e.value !== "string") continue;
      const n = String(e.name), v = ident(e.value.trim());
      if (!v) continue;
      if (DB_NAME_ENV.test(n)) put(dbs, to[0]!, { v, src: `${w.id}:env:${n}`, conf: 0.9 });
      if (DB_USER_ENV.test(n)) put(users, to[0]!, { v, src: `${w.id}:env:${n}`, conf: 0.9 });
    }
  }
  const settle = (m: Map<string, Cand[]>, field: "appUser" | "appDatabase", what: string) => {
    for (const [id, cs] of m) {
      const c = byId.get(id)!;
      // 주소 글자(1)가 있으면 그것만 본다 (따로 적힌 env 는 다른 DB 를 가리킬 수 있음)
      const best = cs.some((x) => x.conf === 1) ? cs.filter((x) => x.conf === 1) : cs;
      const vals = [...new Set(best.map((x) => x.v))].sort();
      const key = `components.${id}.${field}`;
      if (vals.length > 1) {
        fieldMeta[key] = { source: best.map((x) => x.src).sort().join(" + "), confidence: 0.6, needs_review: true,
          rationale: `앱마다 ${what} 이 다름 (${vals.join(",")}) → 도착은 ${String(c.props[field] ?? "기본값")} 으로 만듦. 사람이 정함` };
        continue;
      }
      const prev = c.props[field];
      c.props[field] = vals[0];
      const conf = Math.min(...best.map((x) => x.conf)) as 1 | 0.9;
      const note = [conf < 1 ? `${what} env 이름·값으로 봄` : "", prev !== undefined && prev !== vals[0] ? `출발 DB 설정 값(${String(prev)})과 다름 → 앱이 쓰는 값으로` : ""].filter(Boolean).join(" / ");
      fieldMeta[key] = { source: [...new Set(best.map((x) => x.src))].sort().join(" + "), confidence: conf, needs_review: conf < 1, ...(note ? { rationale: note } : {}) };
    }
  };
  settle(users, "appUser", "앱 계정");
  settle(dbs, "appDatabase", "DB 이름");
}

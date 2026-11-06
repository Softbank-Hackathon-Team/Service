import type pg from "pg";
import { type Endpoint, schemaOf, withClient } from "./endpoint.js";
import { ident, lit, now } from "./sql.js";
import { listTables, type TableRef } from "./tables.js";

// Z77 DRAFT(ai): 출발 스키마(표 모양만, 데이터 없음)를 도착에 만든다. REPL_COPY_SCHEMA=1 일 때만.
// 왜: 논리 복제는 표를 만들지 않는다. 도착 표는 원래 "앱 재배포 때 앱 마이그레이션이 만든다"(precheck DB-T4).
//   클러스터 없이 DB 만 만드는 데모(RDS 만)나 GKE 안 빈 Postgres 처럼 앱이 안 뜨는 도착에서는 표가 없어 구독이 실패한다.
// 어떻게: pg_dump 바이너리 대신 카탈로그(pg_catalog)를 읽어 DDL 을 만든다. 워커가 도는 곳(맥·컨테이너)에 pg_dump 가 없거나
//   서버와 판이 달라도 된다. 출발 스키마 이름과 도착 스키마 이름이 달라도 된다 (search_path 로 이름을 안 붙인 DDL 을 만든다).
// 범위: 일반 표, 열(타입·NOT NULL·기본값·identity·generated·collation), PK·UNIQUE·CHECK·EXCLUDE, 인덱스, 외래키,
//   열이 쓰는 시퀀스(serial), 출발 스키마의 enum 타입, 앱 계정의 표·시퀀스 권한.
// 안 하는 것 (만나면 SchemaCopyError 로 바로 멈춘다): 파티션 표, enum 밖 사용자 타입(domain·composite·range).
//   트리거·정책(RLS)·뷰·함수는 옮기지 않는다 (복제 적용은 트리거를 안 부르고, 앱이 뜨면 앱 마이그레이션이 다시 만든다).
// 도착에 이미 있는 표는 건드리지 않는다. 모든 DDL 은 도착에서 한 트랜잭션 → 중간에 실패하면 아무것도 안 남는다.
// 대안 "pg_dump --schema-only | psql" 은 버림: 맥·컨테이너에 클라이언트 판 맞추기 + 셸 호출 + 전 스키마(함수·트리거까지)가 섞인다.

export class SchemaCopyError extends Error {
  readonly code = "REPL_SCHEMA_COPY_FAILED";
}

export interface SchemaCopyResult {
  /** 이번에 만든 표 (이미 있던 표는 빠진다) */
  created: string[];
  types: string[]; sequences: string[]; indexes: number; foreignKeys: number;
  /** 참조하는 표가 도착에 없어 못 단 외래키 (이름) */
  skippedForeignKeys: string[];
  roleCreated: boolean; grants: number;
  ms: number;
  /** 실제로 돌린 DDL (감사용. 비밀값 없음) */
  ddl: string[];
  /** PF-E16: 도착에 새로 만든 함수·뷰·트리거 (function:이름 · view:이름 · trigger:표.이름) */
  objects?: string[];
}

interface Col { name: string; type: string; notnull: boolean; identity: string; generated: string; def: string | null; coll: string | null }

/** 도착에 없는 표만 출발 모양대로 만든다. 만들 게 없으면 created=[] (아무 DDL 도 안 돌림, 역할 만들기는 따로 본다) */
export async function copySchema(source: Endpoint, target: Endpoint, tables: TableRef[]): Promise<SchemaCopyResult> {
  const t0 = now();
  const srcSchema = schemaOf(source), dstSchema = schemaOf(target);
  const have = await withClient(target, (c) => listTables(c, dstSchema));
  const todo = tables.filter((t) => !have.some((h) => h.name === t.name)).map((t) => t.name);
  const existing = new Set(have.map((h) => h.name));

  // PF-E16 (FM-APP-19): 출발 앱 스키마의 함수·뷰·트리거 중 도착에 없는 것 (스키마 이름이 같을 때만 — 정의 안에 스키마 이름이 박혀 있다)
  const dstObjs = srcSchema === dstSchema ? await withClient(target, (c) => objectKeys(c, dstSchema)) : null;
  const plan = await withClient(source, async (c) => ({ ...(await readSource(c, srcSchema, todo, source.appRole)),
    objects: dstObjs ? (await readAppObjects(c, srcSchema)).filter((o) => !dstObjs.has(o.key)) : [] }));
  const ddl: string[] = [`CREATE SCHEMA IF NOT EXISTS ${ident(dstSchema)}`];
  const skippedForeignKeys: string[] = [];

  return withClient(target, async (c) => {
    const roleMissing = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [target.appRole])).rowCount === 0;
    if (!todo.length && !roleMissing && !plan.objects.length) return { created: [], types: [], sequences: [], indexes: 0, foreignKeys: 0, skippedForeignKeys, roleCreated: false, grants: 0, ms: now() - t0, ddl: [] };
    // 앱 계정이 없으면 로그인 없는 역할로 만든다 (펜스·권한 복원이 이 이름을 쓴다. 앱이 뜨면 비밀번호·LOGIN 은 앱 배포가 준다)
    if (roleMissing) ddl.push(`CREATE ROLE ${ident(target.appRole)} NOLOGIN`);
    // PF-E9 (FM-APP-18): 출발이 쓰는 확장(citext·uuid-ossp·pg_trgm 등)을 도착에 먼저 만든다. 예전엔 'type "citext" does not exist' 로 멈췄다.
    //   도착 상품이 허용 안 하는 확장이면 이 트랜잭션이 실패 → SchemaCopyError(원문에 확장 이름) 로 멈춘다 (조용히 빼지 않음)
    for (const x of plan.extensions) ddl.push(`CREATE EXTENSION IF NOT EXISTS ${ident(x)}`);
    for (const e of plan.enums) {
      ddl.push(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${lit(dstSchema)} AND t.typname = ${lit(e.name)}) THEN CREATE TYPE ${ident(e.name)} AS ENUM (${e.labels.map(lit).join(", ")}); END IF; END $$`);
    }
    for (const s of plan.sequences) ddl.push(`CREATE SEQUENCE IF NOT EXISTS ${ident(s.name)} AS ${s.type} INCREMENT ${s.inc} MINVALUE ${s.min} MAXVALUE ${s.max} START ${s.start}${s.cycle ? " CYCLE" : ""}`);
    // PF-E16: 함수는 표보다 먼저 (기본값·CHECK 가 함수를 부를 수 있다). 본문 검사는 끈다 (SQL 함수가 아직 없는 표를 가리켜도 되게)
    const fnDdl = plan.objects.filter((o) => o.kind === "function");
    if (fnDdl.length) ddl.push(`SET LOCAL check_function_bodies = off`);
    for (const o of fnDdl) ddl.push(o.ddl);
    for (const t of todo) {
      const cols = plan.cols[t]!.map((x) => {
        let s = `${ident(x.name)} ${x.type}`;
        if (x.coll) s += ` COLLATE ${x.coll}`;
        if (x.generated === "s" && x.def) s += ` GENERATED ALWAYS AS (${x.def}) STORED`;
        else if (x.identity) s += ` GENERATED ${x.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
        else if (x.def) s += ` DEFAULT ${x.def}`;
        if (x.notnull && !x.identity) s += " NOT NULL";
        return s;
      });
      const cons = (plan.cons[t] ?? []).map((k) => `CONSTRAINT ${ident(k.name)} ${k.def}`);
      ddl.push(`CREATE TABLE ${ident(t)} (\n  ${[...cols, ...cons].join(",\n  ")}\n)`);
    }
    for (const s of plan.sequences) if (s.owner) ddl.push(`ALTER SEQUENCE ${ident(s.name)} OWNED BY ${ident(s.owner.table)}.${ident(s.owner.col)}`);
    for (const i of plan.indexes) ddl.push(i);
    let foreignKeys = 0;
    for (const f of plan.fks) {
      if (todo.includes(f.ref) || existing.has(f.ref)) { ddl.push(`ALTER TABLE ${ident(f.table)} ADD CONSTRAINT ${ident(f.name)} ${f.def}`); foreignKeys++; }
      else skippedForeignKeys.push(f.name);
    }
    // PF-E16: 뷰는 표 다음(만든 순서대로 = 뷰가 뷰를 가리켜도 앞의 것이 먼저), 트리거는 맨 뒤. 도착 구독 적용 중엔 보통 트리거가 안 돈다(session_replication_role=replica)
    for (const o of plan.objects) if (o.kind === "view") ddl.push(o.ddl);
    for (const o of plan.objects) if (o.kind === "trigger") ddl.push(o.ddl);
    let grants = 0;
    if (plan.grants.length || roleMissing) ddl.push(`GRANT USAGE ON SCHEMA ${ident(dstSchema)} TO ${ident(target.appRole)}`);
    for (const g of plan.grants) {
      if (g.kind === "view" && !plan.objects.some((o) => o.key === `view:${g.name}`)) continue;   // PF-E16: 이번에 만드는 뷰만
      ddl.push(`GRANT ${g.privs.join(", ")} ON ${g.kind === "sequence" ? "SEQUENCE" : "TABLE"} ${ident(g.name)} TO ${ident(target.appRole)}`);
      grants++;
    }

    try {
      await c.query("BEGIN");
      // 스키마를 먼저 만들고 나서 search_path 를 건다 (없는 스키마를 건 채 만들면 이름 풀이가 다른 스키마로 샐 수 있다)
      await c.query(ddl[0]!);
      await c.query(`SET LOCAL search_path TO ${ident(dstSchema)}`);
      for (const s of ddl.slice(1)) await c.query(s);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      // Z38 R8-34: 연결 끊김(08xxx·57P01·코드 없음)은 DDL 문제가 아니다 → 원래 오류 그대로 (sync 의 보통 재시도가 받는다)
      if (isTransient(e)) throw e;
      throw new SchemaCopyError(`도착 스키마 만들기 실패 (아무것도 안 남김): ${(e as Error).message}`);
    }
    return { created: todo, types: plan.enums.map((e) => e.name), sequences: plan.sequences.map((s) => s.name),
      indexes: plan.indexes.length, foreignKeys, skippedForeignKeys, roleCreated: roleMissing, grants, ms: now() - t0, ddl,
      objects: plan.objects.map((o) => o.key) };
  });
}

/** 연결이 끊긴 오류인가 (다시 하면 될 수 있다) */
export function isTransient(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code !== "string" || code.startsWith("08") || code === "57P01";
}

async function readSource(c: pg.Client, schema: string, tables: string[], appRole: string) {
  // 이름을 안 붙인 DDL 을 받으려고 출발 스키마만 보이게 한다 (pg_catalog 는 늘 먼저 보인다)
  await c.query(`SET search_path TO ${ident(schema)}`);
  const rel = await c.query<{ name: string; kind: string; part: boolean }>(
    `SELECT c.relname name, c.relkind kind, c.relispartition part FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2)`, [schema, tables]);
  const bad = rel.rows.filter((r) => r.kind !== "r" || r.part).map((r) => r.name);
  if (bad.length) throw new SchemaCopyError(`파티션 표는 스키마 복사를 안 한다: ${bad.join(", ")} (도착에 앱 마이그레이션을 먼저 돌린다)`);

  const colRows = await c.query<Col & { tbl: string; typtype: string; typname: string; typns: string }>(
    `SELECT c.relname tbl, a.attname name, format_type(a.atttypid, a.atttypmod) type, a.attnotnull AS notnull,
            a.attidentity identity, a.attgenerated generated, pg_get_expr(d.adbin, d.adrelid) def,
            CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN quote_ident(co.collname) END coll,
            t.typtype, t.typname, tn.nspname typns
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE n.nspname = $1 AND c.relname = ANY($2) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`, [schema, tables]);
  const cols: Record<string, Col[]> = {};
  const enumNames = new Set<string>();
  const unsupported: string[] = [];
  for (const r of colRows.rows) {
    (cols[r.tbl] ??= []).push(r);
    const userType = r.typns !== "pg_catalog" && r.typns !== "information_schema";
    if (userType && r.typtype === "e" && r.typns === schema) enumNames.add(r.typname);
    else if (userType && r.typtype !== "b") unsupported.push(`${r.tbl}.${r.name} (${r.typns}.${r.typname})`);
  }
  if (unsupported.length) throw new SchemaCopyError(`enum 밖 사용자 타입은 스키마 복사를 안 한다: ${unsupported.join(", ")}`);
  const enums = (await c.query<{ name: string; labels: string[] }>(
    `SELECT t.typname name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] labels
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = $1 AND t.typname = ANY($2) GROUP BY t.typname ORDER BY 1`, [schema, [...enumNames]])).rows;

  // 열 기본값이 쓰는 시퀀스 (serial). identity 시퀀스는 열 정의가 같이 만든다
  const sequences = (await c.query<{ name: string; type: string; inc: string; min: string; max: string; start: string; cycle: boolean; otbl: string | null; ocol: string | null }>(
    `SELECT s.relname name, format_type(q.seqtypid, NULL) type, q.seqincrement inc, q.seqmin min, q.seqmax max, q.seqstart start, q.seqcycle cycle,
            oc.relname otbl, oa.attname ocol
       FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace JOIN pg_sequence q ON q.seqrelid = s.oid
       LEFT JOIN pg_depend dp ON dp.objid = s.oid AND dp.classid = 'pg_class'::regclass AND dp.refclassid = 'pg_class'::regclass AND dp.deptype IN ('a','i')
       LEFT JOIN pg_class oc ON oc.oid = dp.refobjid LEFT JOIN pg_attribute oa ON oa.attrelid = dp.refobjid AND oa.attnum = dp.refobjsubid
      WHERE n.nspname = $1 AND s.relkind = 'S' AND (dp.deptype IS NULL OR dp.deptype = 'a')
        AND EXISTS (SELECT 1 FROM pg_attrdef d JOIN pg_class t ON t.oid = d.adrelid
                     WHERE t.relnamespace = n.oid AND t.relname = ANY($2) AND pg_get_expr(d.adbin, d.adrelid) LIKE '%nextval(%' || quote_literal(s.relname) || '%')
      ORDER BY 1`, [schema, tables])).rows
    .map((s) => ({ ...s, owner: s.otbl && s.ocol && tables.includes(s.otbl) ? { table: s.otbl, col: s.ocol } : null }));

  const conRows = await c.query<{ tbl: string; name: string; type: string; def: string; ref: string | null }>(
    `SELECT c.relname tbl, k.conname name, k.contype type, pg_get_constraintdef(k.oid) def, r.relname ref
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class r ON r.oid = k.confrelid
      WHERE n.nspname = $1 AND c.relname = ANY($2) AND k.contype IN ('p','u','c','x','f')
      ORDER BY c.relname, k.contype = 'p' DESC, k.conname`, [schema, tables]);
  const cons: Record<string, { name: string; def: string }[]> = {};
  const fks: { table: string; name: string; def: string; ref: string }[] = [];
  for (const k of conRows.rows) {
    if (k.type === "f") fks.push({ table: k.tbl, name: k.name, def: k.def, ref: k.ref! });
    else (cons[k.tbl] ??= []).push({ name: k.name, def: k.def });
  }
  // 제약이 만든 인덱스(PK·UNIQUE·EXCLUDE)는 위 제약이 다시 만든다 → 그 밖 인덱스만
  // pg_get_indexdef 는 search_path 와 상관없이 표 이름에 스키마를 붙인다 → 그 부분만 이름 없는 표로 바꾼다
  const indexes = (await c.query<{ def: string; qn: string; tn: string }>(
    `SELECT pg_get_indexdef(i.indexrelid) def, quote_ident(n.nspname) || '.' || quote_ident(c.relname) qn, quote_ident(c.relname) tn FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2)
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p','u','x'))
      ORDER BY 1`, [schema, tables])).rows.map((r) => {
    const at = r.def.indexOf(` ON ${r.qn} USING `), only = r.def.indexOf(` ON ONLY ${r.qn} USING `);
    if (at < 0 && only < 0) throw new SchemaCopyError(`인덱스 정의를 못 읽었다: ${r.def.slice(0, 200)}`);
    return at >= 0 ? r.def.replace(` ON ${r.qn} USING `, ` ON ${r.tn} USING `) : r.def.replace(` ON ONLY ${r.qn} USING `, ` ON ONLY ${r.tn} USING `);
  });

  // 앱 계정이 출발에서 가진 표·시퀀스 권한을 그대로 (펜스는 도착에서 이 권한을 걷고 되돌린다)
  //   앱 계정이 표 주인이고 relacl 이 NULL 이면 주인 기본 권한(acldefault)을 센다 (예전: 0개 → 도착에서 앱 계정 권한 없음)
  const grants = (await c.query<{ kind: "table" | "sequence" | "view"; name: string; privs: string[] }>(
    `SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' WHEN c.relkind = 'v' THEN 'view' ELSE 'table' END kind, c.relname name,
            array_agg(DISTINCT x.privilege_type ORDER BY x.privilege_type)::text[] privs
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) x
      WHERE n.nspname = $1 AND x.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)
        AND (c.relname = ANY($3) OR c.relname = ANY($4) OR c.relkind = 'v')
      GROUP BY 1, 2 ORDER BY 1, 2`, [schema, appRole, tables, sequences.map((s) => s.name)])).rows;

  // PF-E9: 확장 (plpgsql 은 늘 있다)
  const extensions = (await c.query<{ n: string }>(`SELECT extname n FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1`)).rows.map((r) => r.n);

  return { cols, enums, sequences, cons, fks, indexes, grants, extensions };
}

/** PF-E16 (FM-APP-19): 논리 복제는 표 데이터만 옮긴다. 출발 앱 스키마의 사용자 함수·뷰·트리거 정의를 읽는다 (확장이 만든 함수·집계·구체화 뷰는 뺀다:
 *  집계는 정의를 못 뽑고, 구체화 뷰는 데이터가 있어야 해서 → precheck DB-T6 이 빠진 것으로 멈춰 사람이 만든다) */
interface AppObject { kind: "function" | "view" | "trigger"; key: string; ddl: string }
async function readAppObjects(c: pg.Client, schema: string): Promise<AppObject[]> {
  const fns = (await c.query<{ key: string; ddl: string }>(
    `SELECT 'function:' || p.proname key, pg_get_functiondef(p.oid) ddl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f','p','w')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      ORDER BY p.oid`, [schema])).rows;
  const views = (await c.query<{ key: string; name: string; def: string }>(
    `SELECT 'view:' || c.relname key, c.relname name, pg_get_viewdef(c.oid) def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'v'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      ORDER BY c.oid`, [schema])).rows;
  const trg = (await c.query<{ key: string; ddl: string; enabled: string; tbl: string; name: string }>(
    `SELECT 'trigger:' || c.relname || '.' || t.tgname key, pg_get_triggerdef(t.oid) ddl, t.tgenabled enabled, c.relname tbl, t.tgname name
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.oid`, [schema])).rows;
  return [
    ...fns.map((r) => ({ kind: "function" as const, key: r.key, ddl: r.ddl })),
    ...views.map((r) => ({ kind: "view" as const, key: r.key, ddl: `CREATE VIEW ${ident(r.name)} AS ${r.def}` })),
    ...trg.flatMap((r) => [{ kind: "trigger" as const, key: r.key, ddl: r.ddl },
      // 꺼 둔(D)·복제 때만(R)·늘(A) 켠 트리거는 그 상태까지 그대로
      ...(r.enabled === "D" ? [{ kind: "trigger" as const, key: r.key, ddl: `ALTER TABLE ${ident(r.tbl)} DISABLE TRIGGER ${ident(r.name)}` }]
        : r.enabled === "R" ? [{ kind: "trigger" as const, key: r.key, ddl: `ALTER TABLE ${ident(r.tbl)} ENABLE REPLICA TRIGGER ${ident(r.name)}` }]
        : r.enabled === "A" ? [{ kind: "trigger" as const, key: r.key, ddl: `ALTER TABLE ${ident(r.tbl)} ENABLE ALWAYS TRIGGER ${ident(r.name)}` }] : [])]),
  ];
}
async function objectKeys(c: pg.Client, schema: string): Promise<Set<string>> {
  return new Set((await c.query<{ k: string }>(
    `SELECT 'function:' || p.proname k FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
     UNION ALL SELECT 'view:' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('v','m')
     UNION ALL SELECT 'trigger:' || c.relname || '.' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal`, [schema])).rows.map((r) => r.k));
}

/** ADR-029 후속: 스키마 복사(copySchema)는 관리자(CNPG svc_migrate)가 표·시퀀스·뷰·함수·타입을 만들어 그 주인이 관리자가 된다.
 *  그대로 두면 정리 뒤 CNPG 가 svc_migrate 를 지우려다 "role cannot be dropped because some objects depend on it" 로 멈췄다
 *  (2026-11-06 실플랫폼 889c1257, 사람이 손으로 주인을 넘김). 정리 때 앱 스키마 안에서 관리자가 주인인 것만 앱 계정(= initdb.owner)으로 넘긴다.
 *  _repl(울타리 흔적)·다른 스키마는 건드리지 않는다. CNPG 이고, 관리자가 superuser 가 아니고, 앱 계정으로 SET ROLE 할 수 있을 때만 (RDS 관리자는 보통 못 한다)
 *  돌려주는 값: 넘긴 객체 수 */
export async function handOwnershipToApp(c: pg.Client, e: Endpoint): Promise<number> {
  if (e.provider !== "cnpg") return 0;
  const ok = (await c.query<{ ok: boolean }>(
    `SELECT NOT r.rolsuper AND current_user <> $1 AND to_regrole($1) IS NOT NULL AND pg_has_role(current_user, $1, 'SET') AS ok
       FROM pg_roles r WHERE r.rolname = current_user`, [e.appRole])).rows[0]?.ok;
  if (!ok) return 0;
  const r = await c.query<{ n: number }>(`DO $own$ DECLARE x record; n int := 0; sch oid := to_regnamespace(${lit(schemaOf(e))}); app text := ${lit(e.appRole)};
  BEGIN
    IF sch IS NULL THEN PERFORM set_config('svc.owned', '0', true); RETURN; END IF;
    -- 표·뷰 (ALTER TABLE 은 뷰에도 쓴다. 딸린 인덱스·표에 묶인 시퀀스도 같이 넘어간다)
    FOR x IN SELECT cl.oid::regclass AS o FROM pg_class cl WHERE cl.relnamespace = sch AND cl.relowner = current_user::regrole
                AND cl.relkind IN ('r','p','v','m','f') LOOP
      EXECUTE format('ALTER TABLE %s OWNER TO %I', x.o, app); n := n + 1; END LOOP;
    -- 표에 묶이지 않은 시퀀스만 (묶인 것은 위에서 표와 같이 넘어갔고, 따로 바꾸면 오류)
    FOR x IN SELECT cl.oid::regclass AS o FROM pg_class cl WHERE cl.relnamespace = sch AND cl.relowner = current_user::regrole AND cl.relkind = 'S'
                AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = cl.oid AND d.deptype IN ('a','i')) LOOP
      EXECUTE format('ALTER SEQUENCE %s OWNER TO %I', x.o, app); n := n + 1; END LOOP;
    FOR x IN SELECT p.oid::regprocedure AS o FROM pg_proc p WHERE p.pronamespace = sch AND p.proowner = current_user::regrole LOOP
      EXECUTE format('ALTER ROUTINE %s OWNER TO %I', x.o, app); n := n + 1; END LOOP;
    FOR x IN SELECT t.oid::regtype AS o FROM pg_type t WHERE t.typnamespace = sch AND t.typowner = current_user::regrole AND t.typtype IN ('e','d','c')
                AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class cl WHERE cl.oid = t.typrelid AND cl.relkind = 'c')) LOOP
      EXECUTE format('ALTER TYPE %s OWNER TO %I', x.o, app); n := n + 1; END LOOP;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE oid = sch AND nspowner = current_user::regrole) THEN
      EXECUTE format('ALTER SCHEMA %I OWNER TO %I', ${lit(schemaOf(e))}, app); n := n + 1; END IF;
    PERFORM set_config('svc.owned', n::text, true);
  END $own$; SELECT current_setting('svc.owned', true)::int AS n`);
  return Number((r as unknown as pg.QueryResult<{ n: number }>[]).at?.(-1)?.rows[0]?.n ?? 0);
}

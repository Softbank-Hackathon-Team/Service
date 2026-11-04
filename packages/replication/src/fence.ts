import type pg from "pg";
import { type Endpoint, schemaOf } from "./endpoint.js";
import { ident, lit, qualified } from "./sql.js";
import { MARKER_SCHEMA, MARKER_TABLE, MARKER_DDL_LOCK, createIdem } from "./names.js";

// 쓰기 울타리. 10/31 실험 결과: default_transaction_read_only는 이미 붙은 세션에 안 먹고 SET으로 우회되므로
// 진짜 울타리는 권한 회수(REVOKE) + 앱 세션 끊기. read_only는 이중 안전장치로만 쓴다.
// 원래 권한 저장·복원 (10/31 보드 기본값 "펜스 해제 시 원래 DB 권한을 저장해 두고 그대로 복원", Z57):
//   fence 가 REVOKE 직전에 앱 계정에 "직접" 준 쓰기 권한(표 INSERT·UPDATE·DELETE·TRUNCATE, 시퀀스 USAGE·UPDATE)을
//   그 DB 안 _repl.fence_saved 에 적는다. unfence(writable) 는 저장본이 있으면 그 권한만 되돌리고 저장본을 지운다.
//   저장본이 없으면(울타리 친 적 없는 도착 DB) 예전처럼 "읽기·쓰기 전체"를 준다.
//   - 같은 DB에 두 번 fence 하면 첫 저장본을 지킨다 (두 번째는 이미 회수된 뒤라 비어 있음)
//   - 저장 위치를 그 DB 안에 둔 이유: 워커가 죽어 다른 워커가 unfence 해도 같은 저장본을 본다. _repl 은 발행(publication)에 안 들어간다(marker 표만 들어감)
//   - 대안 "워커 메모리": 워커가 죽으면 잃는다. "플랫폼 DB": 고객 DB 와 트랜잭션을 묶을 수 없다
//   - 남는 것: cleanup 의 teardown 이 _repl 을 CASCADE 로 지우면 저장본도 같이 지워진다(옛 출발은 회수 상태로 남음, cleanup.ts TODO(human) 그대로)

const SAVED = qualified(MARKER_SCHEMA, "fence_saved");
const TABLE_KINDS = ["r", "p", "v", "m", "f"];          // ON ALL TABLES IN SCHEMA 가 덮는 종류
const REVOKED: Record<"table" | "sequence", readonly string[]> = {
  table: ["INSERT", "UPDATE", "DELETE", "TRUNCATE"],
  sequence: ["USAGE", "UPDATE"],
};
export interface SavedGrant { kind: "table" | "sequence"; name: string; privilege: string; grantable: boolean }

/** 앱 계정에 직접 준 쓰기 권한 (fence 가 걷는 것만). 그룹·PUBLIC 경유 권한은 REVOKE 대상이 아니라 안 적는다 */
// z75-31: fence 가 같은 질의를 한 번의 왕복 안에 넣을 수 있게 값을 글자로 박은 판도 만든다 (여러 문장 묶음은 $1 을 못 쓴다)
const directWriteGrantsSql = (schema: string, role: string, p: (v: unknown) => string) =>
  `SELECT CASE WHEN cl.relkind = 'S' THEN 'sequence' ELSE 'table' END AS kind, cl.relname AS name,
          a.privilege_type AS privilege, a.is_grantable AS grantable
     FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
     CROSS JOIN LATERAL aclexplode(cl.relacl) a
    WHERE n.nspname = ${p(schema)} AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${p(role)})
      AND ((cl.relkind = ANY(${p(TABLE_KINDS)}) AND a.privilege_type = ANY(${p(REVOKED.table)})) OR (cl.relkind = 'S' AND a.privilege_type = ANY(${p(REVOKED.sequence)})))`;
const textArray = (xs: readonly string[]) => `ARRAY[${xs.map(lit).join(", ")}]::text[]`;
const asLiteral = (v: unknown) => (Array.isArray(v) ? textArray(v as string[]) : lit(String(v)));

export async function directWriteGrants(c: pg.Client, e: Endpoint): Promise<SavedGrant[]> {
  const args: unknown[] = [];
  const sql = directWriteGrantsSql(schemaOf(e), e.appRole, (v) => { args.push(v); return `$${args.length}`; });
  const r = await c.query<SavedGrant>(`${sql}\n      ORDER BY 1, 2, 3`, args);
  return r.rows;
}

/** 저장본 읽기. 없으면 null (표가 아직 없는 DB 포함) */
export async function savedGrants(c: pg.Client, e: Endpoint): Promise<SavedGrant[] | null> {
  const t = await c.query<{ t: string | null }>(`SELECT to_regclass($1) t`, [`${MARKER_SCHEMA}.fence_saved`]);
  if (!t.rows[0]?.t) return null;
  const r = await c.query<{ grants: SavedGrant[] }>(`SELECT grants FROM ${SAVED} WHERE schema_name=$1 AND app_role=$2`,
    [schemaOf(e), e.appRole]);
  return r.rows[0]?.grants ?? null;
}

const SAVED_DDL = () => `${MARKER_DDL_LOCK};
    ${createIdem(`CREATE SCHEMA IF NOT EXISTS ${ident(MARKER_SCHEMA)}`)};
    ${createIdem(`CREATE TABLE IF NOT EXISTS ${SAVED} (schema_name text NOT NULL, app_role text NOT NULL, grants jsonb NOT NULL,
      saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (schema_name, app_role))`)}`;
// ALTER DATABASE 는 DB 이름이 필요하다. 이름을 따로 묻지 않게(왕복 1번) 서버 안에서 current_database() 로 만든다
const alterDbReadOnly = (on: boolean) =>
  `DO $z75$ BEGIN EXECUTE format(${lit(on ? "ALTER DATABASE %I SET default_transaction_read_only = on" : "ALTER DATABASE %I RESET default_transaction_read_only")}, current_database()); END $z75$`;

// z75-31: 예전엔 저장(3)·회수(1)·끊기(1)·DB 이름(1)·read_only(1) = 왕복 7번. 원격(맥↔서울)에서는 왕복마다 ~20ms 라 컷오버 멈춤이 늘었다.
//   지금은 여러 문장을 한 번에 보낸다 (왕복 1번). 순서와 경계는 같다: 저장 + 회수를 한 트랜잭션으로 커밋한 "뒤에" 세션을 끊는다
//   (끊긴 세션이 다시 붙어도 이미 회수된 권한을 본다). 예전엔 저장과 회수가 따로 커밋됐다 → 지금은 둘이 같이 되거나 같이 안 된다
// Z80: marker 를 주면 같은 왕복 끝에 C3 표지를 넣는다. 단 L4 검사가 깨끗할 때만 (새는 표가 있으면 표지 없이 C6' 되돌림 = 예전과 같다).
//   pg_terminate_backend(pid, timeout) 으로 세션이 정말 끝나길 기다리는 판도 재 봤으나 서버가 100ms 단위로 다시 봐서 멈춤이 ~100ms 늘었다(로컬 실측 112.6ms) → 버림.
//   끊긴 앱 세션의 "커밋 중이던" 쓰기가 표지보다 늦게 들어갈 틈은 예전과 같고, C3 행 수 비교가 잡는다(ROW_COUNT_MISMATCH → C6' 되돌림)
// APP-22 (가) DECISION(team): 컷오버 전까지 도착 앱이 출발 DB 에 붙는다 (11/4 01:57Z Jeong 결정, 관리 스레드 전달).
//   도착 앱은 출발에 전용 최소 권한 계정(source-db-link 가 만드는 svc_link_<이전 앞 8자>)으로 붙으므로, 울타리가 앱 계정만 막으면
//   C2~C5 사이 도착 앱 쓰기가 출발에 들어가 표지(C3) 뒤로 새어 잃는다. → 끝점의 fenceRoles 도 같은 울타리(저장·회수·세션 끊기·L4 검사)에 넣는다.
//   추가 계정은 없을 수 있다(링크를 안 연 이전·도착 DB): 없으면 건너뛴다. 걷기는 저장본이 있을 때만 되돌린다 (기본 "읽기·쓰기 전체"는 앱 계정만)
export const extraRoles = (e: Endpoint): string[] => [...new Set((e.fenceRoles ?? []).filter((x) => x && x !== e.appRole))];
const roleExists = (role: string) => `EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(role)})`;
/** 앱 계정 또는 추가 계정 중 하나라도 표 t 에 쓸 수 있나 (없는 계정은 has_table_privilege 가 에러라 CASE 로 감싼다) */
function anyRoleCanWrite(e: Endpoint, t: string): string {
  return [e.appRole, ...extraRoles(e)].map((x, i) => i === 0
    ? `has_table_privilege(${lit(x)}, ${t}, 'INSERT, UPDATE, DELETE')`
    : `(CASE WHEN ${roleExists(x)} THEN has_table_privilege(${lit(x)}, ${t}, 'INSERT, UPDATE, DELETE') ELSE false END)`).join(" OR ");
}
function fenceExtraSql(schema: string, role: string): string {
  const body = `BEGIN
    IF NOT ${roleExists(role)} THEN RETURN; END IF;
    INSERT INTO ${SAVED} (schema_name, app_role, grants)
      SELECT ${lit(schema)}, ${lit(role)}, COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.kind, g.name, g.privilege), '[]'::jsonb)
        FROM (${directWriteGrantsSql(schema, role, asLiteral)}) g
      ON CONFLICT (schema_name, app_role) DO NOTHING;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA %I FROM %I', ${lit(schema)}, ${lit(role)});
    EXECUTE format('REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA %I FROM %I', ${lit(schema)}, ${lit(role)});
  END`;
  const tag = dollarTag(body);
  return `DO ${tag} ${body} ${tag}`;
}
/** 추가 계정 걷기: 저장본이 있을 때만 그 권한을 되돌리고 저장본을 지운다 (계정·저장본 표가 없으면 아무것도 안 함) */
function unfenceExtraSql(schema: string, role: string): string {
  const tk = REVOKED.table.map(lit).join(", "), sq = REVOKED.sequence.map(lit).join(", ");
  const body = `DECLARE saved jsonb; g jsonb; obj text; kind text; priv text; BEGIN
    IF NOT ${roleExists(role)} OR to_regclass(${lit(`${MARKER_SCHEMA}.fence_saved`)}) IS NULL THEN RETURN; END IF;
    EXECUTE ${lit(`SELECT grants FROM ${SAVED} WHERE schema_name = $1 AND app_role = $2`)} INTO saved USING ${lit(schema)}, ${lit(role)};
    IF saved IS NULL THEN RETURN; END IF;
    FOR g IN SELECT * FROM jsonb_array_elements(saved) LOOP
      kind := g->>'kind'; priv := g->>'privilege';
      CONTINUE WHEN NOT ((kind = 'table' AND priv IN (${tk})) OR (kind = 'sequence' AND priv IN (${sq})));
      obj := format('%I.%I', ${lit(schema)}, g->>'name');
      CONTINUE WHEN to_regclass(obj) IS NULL;
      EXECUTE format('GRANT %s ON %s %s TO %I%s', priv, CASE kind WHEN 'sequence' THEN 'SEQUENCE' ELSE 'TABLE' END, obj, ${lit(role)},
                     CASE WHEN (g->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    EXECUTE ${lit(`DELETE FROM ${SAVED} WHERE schema_name = $1 AND app_role = $2`)} USING ${lit(schema)}, ${lit(role)};
  END`;
  const tag = dollarTag(body);
  return `DO ${tag} ${body} ${tag}`;
}

export interface FenceOptions {
  /** 주면 같은 왕복 끝에 L4 검사(writableTables 와 같은 질의)를 붙인다 */
  check?: { schema: string; name: string }[];
  /** 주면 L4 검사가 비었을 때만 _repl.marker 에 이 token 을 넣는다 (C3 마지막 따라잡기 표지) */
  marker?: string;
}
export async function fence(c: pg.Client, e: Endpoint, o: FenceOptions = {}):
    Promise<{ terminated: number; leaky: string[]; markerInserted: boolean }> {
  const s = ident(schemaOf(e)), r = ident(e.appRole);
  const names = (o.check ?? []).map((t) => `${ident(t.schema)}.${ident(t.name)}`);
  const extras = extraRoles(e);
  const leakyFrom = `FROM unnest(${textArray(names)}) t WHERE ${anyRoleCanWrite(e, "t")}`;
  const leakySql = names.length ? `;\n    SELECT t AS leaky ${leakyFrom}` : "";
  const markerSql = o.marker === undefined ? "" : `;\n    INSERT INTO ${qualified(MARKER_SCHEMA, MARKER_TABLE)} (token) SELECT ${lit(o.marker)}` +
    (names.length ? ` WHERE NOT EXISTS (SELECT 1 ${leakyFrom})` : "");
  const sql = `BEGIN;
    ${SAVED_DDL()};
    INSERT INTO ${SAVED} (schema_name, app_role, grants)
      SELECT ${lit(schemaOf(e))}, ${lit(e.appRole)}, COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.kind, g.name, g.privilege), '[]'::jsonb)
        FROM (${directWriteGrantsSql(schemaOf(e), e.appRole, asLiteral)}) g
      ON CONFLICT (schema_name, app_role) DO NOTHING;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${s} FROM ${r};
    REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA ${s} FROM ${r};${extras.map((x) => `\n    ${fenceExtraSql(schemaOf(e), x)};`).join("")}
    COMMIT;
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = current_database() AND usename = ANY(${textArray([e.appRole, ...extras])}) AND pid <> pg_backend_pid();
    ${alterDbReadOnly(true)}${leakySql}${markerSql}`;
  try {
    const res = results(await c.query(sql));
    const selects = res.filter((x) => x.command === "SELECT");
    const leaky = names.length ? (selects.at(-1)?.rows ?? []).map((x: { leaky: string }) => x.leaky) : [];
    const markerInserted = o.marker !== undefined && (res.at(-1)?.command === "INSERT") && (res.at(-1)?.rowCount ?? 0) === 1;
    return { terminated: selects[0]?.rowCount ?? 0, leaky, markerInserted };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});   // BEGIN 안에서 깨졌으면 연결이 "트랜잭션 깨짐" 상태로 남는다
    throw err;
  }
}

/** 여러 문장 묶음이면 pg 는 결과 배열을, 한 문장이면 결과 하나를 돌려준다 → 늘 배열로 */
const results = (x: unknown): pg.QueryResult[] => (Array.isArray(x) ? x : [x]) as pg.QueryResult[];

// 서버 안 DO 블록 본문을 감쌀 달러 따옴표. 본문(글자로 박은 이름)에 같은 표시가 있으면 다른 것을 고른다
function dollarTag(body: string): string {
  for (let k = 0; ; k++) { const t = `$svc_u${k || ""}$`; if (!body.includes(t)) return t; }
}
const UNFENCE_GUC = "svc_repl.unfence";

/** 울타리 걷기 SQL (왕복 1번). 끝 문장이 "종류:개수" 한 줄을 돌려준다 → parseUnfence.
 *  Z80: 컷오버 C5 가 슬롯 만들기와 같은 왕복에 붙이려고 SQL 을 따로 내보낸다 */
export function unfenceSql(e: Endpoint, { writable = true } = {}): string {
  if (!writable) return `${alterDbReadOnly(false)}; SELECT 'none:0' AS r`;
  const sch = lit(schemaOf(e)), role = lit(e.appRole);
  const tk = REVOKED.table.map(lit).join(", "), sq = REVOKED.sequence.map(lit).join(", ");
  // Z80: 저장본 읽기·검사·되돌리기·지우기를 전부 서버 안에서 (예전 TS 와 같은 규칙):
  //   - 저장본 없음(표 자체가 없어도) → 기본 읽기·쓰기 전체. 저장본 표를 새로 만들지 않는다 (Z75 초안의 "빈 표 만들기" 없앰)
  //   - 저장본 있음 → fence 가 걷는 권한(REVOKED)만, 지금 있는 객체에만, grantable 이면 WITH GRANT OPTION, 끝나면 저장본 지움
  //   - read_only 풀기와 권한 되돌리기가 한 트랜잭션: 중간에 깨지면 둘 다 안 된 상태(울타리 그대로) → 다시 시도할 수 있다
  const body = `DECLARE saved jsonb; g jsonb; obj text; kind text; priv text; BEGIN
    EXECUTE format('ALTER DATABASE %I RESET default_transaction_read_only', current_database());
    IF to_regclass(${lit(`${MARKER_SCHEMA}.fence_saved`)}) IS NOT NULL THEN
      EXECUTE ${lit(`SELECT grants FROM ${SAVED} WHERE schema_name = $1 AND app_role = $2`)} INTO saved USING ${sch}, ${role};
    END IF;
    IF saved IS NULL THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', ${sch}, ${role});
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', ${sch}, ${role});
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', ${sch}, ${role});
      PERFORM set_config(${lit(UNFENCE_GUC)}, 'default:0', true);
      RETURN;
    END IF;
    FOR g IN SELECT * FROM jsonb_array_elements(saved) LOOP
      kind := g->>'kind'; priv := g->>'privilege';
      CONTINUE WHEN NOT ((kind = 'table' AND priv IN (${tk})) OR (kind = 'sequence' AND priv IN (${sq})));
      obj := format('%I.%I', ${sch}, g->>'name');
      CONTINUE WHEN to_regclass(obj) IS NULL;
      EXECUTE format('GRANT %s ON %s %s TO %I%s', priv, CASE kind WHEN 'sequence' THEN 'SEQUENCE' ELSE 'TABLE' END, obj, ${role},
                     CASE WHEN (g->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    EXECUTE ${lit(`DELETE FROM ${SAVED} WHERE schema_name = $1 AND app_role = $2`)} USING ${sch}, ${role};
    PERFORM set_config(${lit(UNFENCE_GUC)}, 'saved:' || jsonb_array_length(saved), true);
  END`;
  const tag = dollarTag(body);
  const extras = extraRoles(e).map((x) => `${unfenceExtraSql(schemaOf(e), x)}; `).join("");
  // set_config(..., true) 는 이 트랜잭션 안에서만 보인다. 여러 문장 묶음 = 한 트랜잭션이라 뒤 SELECT 가 읽는다
  return `${extras}DO ${tag} ${body} ${tag}; SELECT current_setting(${lit(UNFENCE_GUC)}, true) AS r`;
}

export type UnfenceResult = { restored: "none" | "saved" | "default"; grants: number };
/** unfenceSql 결과 읽기. 앞에 다른 문장이 붙어 있어도 마지막 결과만 본다 */
export function parseUnfence(res: unknown): UnfenceResult {
  const v = String(results(res).at(-1)?.rows[0]?.r ?? "");
  const m = /^(none|saved|default):(\d+)$/.exec(v);
  if (!m) throw new Error(`unfence: unexpected result ${JSON.stringify(v)}`);
  return { restored: m[1] as UnfenceResult["restored"], grants: Number(m[2]) };
}

/** 울타리 걷기. writable=false면 read_only만 풀고 권한 회수는 유지 (옛 출발 = 읽기 전용 대기)
 *  z75-31/Z80: 예전엔 DB 이름(1)·read_only(1)·저장본 표 있나(1)·저장본(1)·권한(표마다 1~2 + BEGIN/DELETE/COMMIT) 왕복 → 늘 1번 */
export async function unfence(c: pg.Client, e: Endpoint, o: { writable?: boolean } = {}): Promise<UnfenceResult> {
  return parseUnfence(await c.query(unfenceSql(e, o)));
}

/** 앱 계정이 지금 쓸 수 있나 (표 하나 기준) */
export async function appCanWrite(c: pg.Client, e: Endpoint, table: string): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, 'INSERT') ok`, [e.appRole, `${ident(schemaOf(e))}.${ident(table)}`]);
  return r.rows[0]!.ok;
}

/** L4: 울타리 뒤 앱 계정이 아직 쓸 수 있는 표 목록. 비어야 정상이다.
 *  REVOKE는 앱 계정에 직접 준 권한만 걷는다. 다른 역할(그룹)을 거쳐 받았거나 PUBLIC에 준 권한은 남는다.
 *  has_table_privilege는 상속된 권한까지 본다. INSERT·UPDATE·DELETE 중 하나라도 있으면 "쓸 수 있음" */
export async function writableTables(c: pg.Client, e: Endpoint, tables: { schema: string; name: string }[]): Promise<string[]> {
  if (!tables.length) return [];
  const names = tables.map((t) => `${ident(t.schema)}.${ident(t.name)}`);
  const r = await c.query<{ t: string }>(`SELECT t FROM unnest($1::text[]) t WHERE ${anyRoleCanWrite(e, "t")}`, [names]);
  return r.rows.map((x) => x.t);
}

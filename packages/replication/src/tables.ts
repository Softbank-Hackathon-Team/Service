import type pg from "pg";
import { MARKER_SCHEMA, MARKER_TABLE, MARKER_DDL_LOCK, createIdem } from "./names.js";
import { ident, lit, qualified } from "./sql.js";

export interface TableRef { schema: string; name: string }
export const fq = (t: TableRef) => qualified(t.schema, t.name);

/** 스키마 안의 일반 표 목록 (파티션 자식 제외) */
export async function listTables(c: pg.Client, schema: string): Promise<TableRef[]> {
  const r = await c.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`, [schema]);
  return r.rows.map((x) => ({ schema, name: x.name }));
}

export const markerRef: TableRef = { schema: MARKER_SCHEMA, name: MARKER_TABLE };

/** 지연 측정·마지막 따라잡기 확인용 표. 양쪽 DB에 같은 모양으로 있어야 복제된다 */
// Z77 (주제 69): 같은 DB 에 이전 두 건이 동시에 오면 CREATE SCHEMA/TABLE IF NOT EXISTS 끼리 부딪쳐
//   "duplicate key … pg_namespace_nspname_index" 가 난다 (IF NOT EXISTS 는 동시 생성에 안전하지 않다). 트랜잭션 잠금으로 줄 세우고, 그래도 겹치면 "이미 있음" 만 삼킨다 (names.ts createIdem)
export const markerDdl = () => `${MARKER_DDL_LOCK};
    ${createIdem(`CREATE SCHEMA IF NOT EXISTS ${ident(MARKER_SCHEMA)}`)};
    ${createIdem(`CREATE TABLE IF NOT EXISTS ${fq(markerRef)} (token text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`)}`;

// z75-31: 표마다 왕복하던 count 를 한 문장으로 (표 하나 = 칸 하나). 칸 목록만 따로 내보내 다른 질의에 붙일 수 있게 했다
export const rowCountCols = (tables: TableRef[]) => tables.map((t, k) => `(SELECT count(*) FROM ${fq(t)})::bigint AS n${k}`).join(", ");
export function rowCountsFrom(row: Record<string, unknown>, tables: TableRef[]): Record<string, number> {
  const out: Record<string, number> = {};
  tables.forEach((t, k) => { out[`${t.schema}.${t.name}`] = Number(row[`n${k}`]); });
  return out;
}
export async function rowCounts(c: pg.Client, tables: TableRef[]): Promise<Record<string, number>> {
  if (!tables.length) return {};
  return rowCountsFrom((await c.query(`SELECT ${rowCountCols(tables)}`)).rows[0], tables);
}

/** 표 전체 md5. 데모 크기 표용 (큰 표는 범위별로 나눠야 한다) */
export async function checksum(c: pg.Client, t: TableRef): Promise<string | null> {
  return (await c.query(`SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM ${fq(t)} x`)).rows[0].h;
}

export const tableList = (ts: TableRef[]) => ts.map(fq).join(", ");

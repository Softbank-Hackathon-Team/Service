import type pg from "pg";
import { type Endpoint, type Provider, peerPathProblem, schemaOf, withClient, workerTlsProblem } from "./endpoint.js";
import { qualified } from "./sql.js";
import { listTables, type TableRef } from "./tables.js";

// 옮기기 전 점검: "이 DB를 논리 복제로 옮길 수 있나". 실패 항목은 고칠 방법(hint)을 같이 준다.
/** level "warn" = 실패해도 전체 ok를 막지 않는 권고 (Z52: RDS 기본값처럼 고객이 바꾸기 어려운 설정) */
export interface Check { id: string; side: "source" | "target"; ok: boolean; detail: string; hint?: string; level?: "warn" }
export interface PrecheckResult { ok: boolean; tables: TableRef[]; checks: Check[] }

const WAL_HINT: Record<Provider, string> = {
  postgres: "postgresql.conf: wal_level = logical (재시작 필요)",
  cnpg: "Cluster spec.postgresql.parameters.wal_level: logical",
  rds: "파라미터 그룹 rds.logical_replication = 1 (재부팅 필요)",
  cloudsql: "DB 플래그 cloudsql.logical_decoding = on",
  azure: "서버 파라미터 wal_level = LOGICAL",
};

// DRAFT(ai) Z52: 권고값 = 출발 디스크 여유의 절반 이하. 데모 RDS(20GB)면 10GB
const SLOT_KEEP_HINT: Record<Provider, string> = {
  postgres: "postgresql.conf: max_slot_wal_keep_size = 10GB (reload만)",
  cnpg: "Cluster spec.postgresql.parameters.max_slot_wal_keep_size: 10GB",
  rds: "파라미터 그룹 max_slot_wal_keep_size = 10240 (MB, 동적)",
  cloudsql: "DB 플래그 max_slot_wal_keep_size (MB)",
  azure: "서버 파라미터 max_slot_wal_keep_size (MB)",
};

export async function precheck(source: Endpoint, target: Endpoint, opts: { tables?: string[] } = {}): Promise<PrecheckResult> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  let tables: TableRef[] = [];
  // Z77: 상대 DB 가 붙는 주소(PEER_URL)가 공개 경로면 암호화여야 한다 (공개 경로 평문 복제 금지)
  // Z38 REVIEW-5 (04): TLS 를 안 켠 출발(맥)도 본다 (Z77-2) + 관리형 DB 에 워커 TLS 없이 붙는 것도 연결 전에 잡는다 (Z77-3)
  for (const [e, other, side] of [[source, target, "source"], [target, source, "target"]] as const) {
    const w = workerTlsProblem(e);
    if (w) add({ id: "NET-TLS0", side, ok: false, detail: w,
      hint: e.provider === "rds" ? "REPL_*_SSLMODE=verify-full + REPL_CA_FILE=<RDS 지역 묶음 ap-northeast-2-bundle.pem>"
                                 : "REPL_*_SSLMODE=verify-ca + REPL_CA_FILE=<tf:db_ca_file>" });
    const p = peerPathProblem(e, other);
    if (e.tls || p) add({ id: "NET-TLS1", side, ok: !p, detail: p ?? `peer sslmode ok, worker ${e.tls?.mode}`,
      hint: p ? "REPL_*_PEER_URL 끝에 ?sslmode=require 를 붙인다 (관리형 DB 는 서버 쪽 CA 파일을 못 둔다. 맥 Postgres 는 ssl=on 필요)" : undefined });
  }
  // 연결 전에 알 수 있는 네트워크 문제가 있으면 붙어 보지 않는다 → pg 오류 대신 위 이유가 그대로 남는다
  if (checks.some((c) => c.id.startsWith("NET-") && !c.ok)) return { ok: false, tables, checks };

  await withClient(source, async (c) => {
    await serverChecks(c, source, "source", add);
    const all = await listTables(c, schemaOf(source));
    tables = opts.tables ? all.filter((t) => opts.tables!.includes(t.name)) : all;
    const missing = (opts.tables ?? []).filter((n) => !all.some((t) => t.name === n));
    add({ id: "DB-T1", side: "source", ok: tables.length > 0 && missing.length === 0,
      detail: `${tables.length} tables${missing.length ? `, missing: ${missing.join(",")}` : ""}` });
    // 기본키(또는 REPLICA IDENTITY FULL) 없는 표는 UPDATE/DELETE가 복제되지 않고 출발에서 에러가 난다
    const noPk = await c.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname = ANY($2) AND c.relreplident <> 'f'
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (i.indisprimary OR i.indisreplident))`,
      [schemaOf(source), tables.map((t) => t.name)]);
    add({ id: "DB-T2", side: "source", ok: noPk.rowCount === 0,
      detail: noPk.rowCount ? `no primary key: ${noPk.rows.map((r) => r.name).join(", ")}` : "all tables have PK/replica identity",
      hint: "기본키를 추가하거나 ALTER TABLE ... REPLICA IDENTITY FULL" });
    // 대형 객체(lo)는 논리 복제가 옮기지 않는다
    const lo = Number((await c.query(`SELECT count(*) n FROM pg_largeobject_metadata`)).rows[0].n);
    add({ id: "DB-T3", side: "source", ok: lo === 0, detail: `${lo} large objects`, hint: "large object는 논리 복제 대상이 아님. bytea로 바꾸거나 따로 옮긴다" });
  });

  await withClient(target, async (c) => {
    await serverChecks(c, target, "target", add);
    // 앱 재배포 전제: 도착 스키마는 앱 마이그레이션이 미리 만든다. 표가 없으면 구독이 실패한다
    const have = await listTables(c, schemaOf(target));
    const absent = tables.filter((t) => !have.some((h) => h.name === t.name));
    // Z77: 복제는 표를 안 만든다 → 표가 없으면 구독이 "relation does not exist" 로 늦게 깨지기 전에 여기서 분명히 멈춘다
    add({ id: "DB-T4", side: "target", ok: absent.length === 0,
      detail: absent.length ? `도착 DB 에 표가 없다 (논리 복제는 표를 만들지 않는다): ${absent.map((t) => t.name).join(", ")}` : "schema present",
      hint: "도착에 앱 마이그레이션(스키마만)을 먼저 돌리거나, 워커에 REPL_COPY_SCHEMA=1 (출발 표 모양만 도착에 복사, 데이터 없음)" });
    if (absent.length === 0 && tables.length) {
      const nonEmpty: string[] = [];
      for (const t of tables) {
        const r = await c.query(`SELECT 1 FROM ${qualified(schemaOf(target), t.name)} LIMIT 1`);
        if (r.rowCount) nonEmpty.push(t.name);
      }
      add({ id: "DB-T5", side: "target", ok: nonEmpty.length === 0,
        detail: nonEmpty.length ? `target not empty: ${nonEmpty.join(", ")}` : "target tables empty",
        hint: "초기 복사(copy_data)는 빈 표를 가정한다. 비우거나 copyData:false" });
    }
  });

  return { ok: checks.every((c) => c.ok || c.level === "warn"), tables, checks };
}

async function serverChecks(c: pg.Client, e: Endpoint, side: "source" | "target", add: (c: Check) => void) {
  const s = (await c.query<{ wal: string; slots: string; senders: string; ver: string }>(
    `SELECT current_setting('wal_level') wal, current_setting('max_replication_slots') slots,
            current_setting('max_wal_senders') senders, current_setting('server_version_num') ver`)).rows[0]!;
  add({ id: "DB-01", side, ok: s.wal === "logical", detail: `wal_level=${s.wal}`, hint: WAL_HINT[e.provider] });
  // Z77 (Z62 주제 60): wal_senders 도 2 이상 (정방향·역방향 walsender 가 한때 같이 붙는다). 예전엔 값만 읽고 판정 안 함
  add({ id: "DB-02", side, ok: Number(s.slots) >= 2 && Number(s.senders) >= 2, detail: `max_replication_slots=${s.slots} max_wal_senders=${s.senders}`, hint: "정방향·역방향 슬롯·walsender 각각 2개 이상" });
  add({ id: "DB-03", side, ok: Number(s.ver) >= 140000, detail: `server_version_num=${s.ver}`, hint: "PG 14 이상 (pg_stat_subscription 지표·streaming)" });
  // 복제 권한: superuser 또는 클라우드의 대체 역할
  // Z77 (맥 실측 00:01Z): Cloud SQL cloudsqlsuperuser·Azure azure_pg_admin 은 슬롯 권한이 아니다 → REPLICATION 속성이 따로 필요.
  //   예전엔 cloudsqlsuperuser 만으로 통과해서, 역방향 슬롯을 만드는 전환 C5 뒤에 "must be superuser or replication role" 로 깨졌다
  //   RDS 는 rds_superuser 가 rds_replication 을 품는다 (그대로 인정)
  const r = (await c.query<{ su: boolean; repl: boolean; cloud: boolean }>(
    `SELECT rolsuper su, rolreplication repl,
            EXISTS (SELECT 1 FROM pg_roles g JOIN pg_auth_members m ON m.roleid=g.oid
                     WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                       AND g.rolname IN ('rds_superuser','rds_replication')) cloud
       FROM pg_roles WHERE rolname = current_user`)).rows[0]!;
  add({ id: "DB-04", side, ok: r.su || r.repl || r.cloud, detail: `superuser=${r.su} replication=${r.repl} rdsReplication=${r.cloud}`,
    hint: e.provider === "rds" ? "GRANT rds_replication TO <user>" : e.provider === "cloudsql" ? "ALTER USER <user> WITH REPLICATION" : "ALTER ROLE <user> REPLICATION" });
  // Z52 (Q16): 복제가 느리거나 끊기면 슬롯이 WAL을 붙잡아 출발 디스크가 찬다. PG 13+ max_slot_wal_keep_size가
  //   상한을 걸어 디스크 대신 슬롯을 끊게 한다(끊기면 judge가 SLOT_LOST로 보고 롤백). -1(무제한, 기본값)이면 권고만
  if (side === "source") {
    const k = (await c.query<{ v: string }>(`SELECT setting v FROM pg_settings WHERE name = 'max_slot_wal_keep_size'`)).rows[0]?.v;
    add({ id: "DB-06", side, ok: k != null && k !== "-1", level: "warn", detail: `max_slot_wal_keep_size=${k ?? "n/a"}${k && k !== "-1" ? "MB" : ""}`,
      hint: SLOT_KEEP_HINT[e.provider] });
  }
  const app = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [e.appRole]);
  add({ id: "DB-05", side, ok: app.rowCount === 1, detail: `app role ${e.appRole} ${app.rowCount ? "exists" : "missing"}` });
}

/** Z77: Cloud SQL 관리자(cloudsqlsuperuser)는 자기에게 REPLICATION 을 줄 수 있다 (Cloud SQL 논리 복제 안내의 ALTER USER … WITH REPLICATION).
 *  terraform google_sql_user 에는 이 속성 칸이 없어서, 복제를 처음 걸기 전에 워커가 한 번 준다. cloudsql 이 아니면 아무것도 안 한다.
 *  결과: already(이미 있음) | granted(이번에 줌) | skipped(cloudsql 아님) | failed(못 줌 → precheck DB-04 가 이유와 함께 멈춘다) */
export async function ensureReplicationAttr(e: Endpoint): Promise<{ side: string; result: "already" | "granted" | "skipped" | "failed"; error?: string }> {
  if (e.provider !== "cloudsql") return { side: e.label, result: "skipped" };
  return withClient(e, async (c) => {
    const r = (await c.query<{ su: boolean; repl: boolean }>(`SELECT rolsuper su, rolreplication repl FROM pg_roles WHERE rolname = current_user`)).rows[0]!;
    if (r.su || r.repl) return { side: e.label, result: "already" as const };
    try {
      await c.query(`ALTER ROLE CURRENT_USER WITH REPLICATION`);
      return { side: e.label, result: "granted" as const };
    } catch (x) {
      return { side: e.label, result: "failed" as const, error: (x as Error).message.slice(0, 200) };
    }
  });
}

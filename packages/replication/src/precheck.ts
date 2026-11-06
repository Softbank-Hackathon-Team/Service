import { MARKER_SCHEMA } from "./names.js";
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

export async function precheck(source: Endpoint, target: Endpoint, opts: { tables?: string[]; own?: string[] } = {}): Promise<PrecheckResult> {
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

  tables = await withClient(source, (c) => sourceChecks(c, source, opts, add));

  await withClient(target, async (c) => {
    await serverChecks(c, target, "target", add, opts.own);
    // 앱 재배포 전제: 도착 스키마는 앱 마이그레이션이 미리 만든다. 표가 없으면 구독이 실패한다
    const have = await listTables(c, schemaOf(target));
    const absent = tables.filter((t) => !have.some((h) => h.name === t.name));
    // Z77: 복제는 표를 안 만든다 → 표가 없으면 구독이 "relation does not exist" 로 늦게 깨지기 전에 여기서 분명히 멈춘다
    add({ id: "DB-T4", side: "target", ok: absent.length === 0,
      detail: absent.length ? `도착 DB 에 표가 없다 (논리 복제는 표를 만들지 않는다): ${absent.map((t) => t.name).join(", ")}` : "schema present",
      hint: "도착에 앱 마이그레이션(스키마만)을 먼저 돌리거나, 워커에 REPL_COPY_SCHEMA=1 (출발 표 모양만 도착에 복사, 데이터 없음)" });
    // PF-E10 (FM-APP-19) DRAFT(ai): 논리 복제·스키마 복사는 표만 옮긴다. 출발 앱 스키마의 뷰·함수·트리거·확장이 도착에 없으면
    //   컷오버 뒤 앱이 깨지는데 예전엔 아무 점검도 못 잡았다 → 이름으로 비교해 빠진 게 있으면 멈춘다 ("그대로 이식" 조용히 빼지 않음)
    // TODO(human): 도착에 자동으로 만들지(pg_get_viewdef·pg_get_functiondef), 사람이 앱 마이그레이션으로 만들지
    const missingObjs = await missingAppObjects(source, c, schemaOf(target));
    add({ id: "DB-T6", side: "target", ok: missingObjs.length === 0,
      detail: missingObjs.length ? `출발에만 있는 객체 (복제가 안 옮김): ${missingObjs.slice(0, 20).join(", ")}${missingObjs.length > 20 ? " …" : ""}` : "views/functions/triggers/extensions present",
      hint: "REPL_COPY_SCHEMA=1 이면 확장·함수·뷰·트리거를 출발 정의대로 만든다(PF-E16). 그래도 남는 것(구체화 뷰·집계·스키마 이름이 다를 때)은 도착에 앱 마이그레이션으로 먼저 만든다" });
    if (absent.length === 0 && tables.length) {
      const nonEmpty: string[] = [];
      for (const t of tables) {
        const r = await c.query(`SELECT 1 FROM ${qualified(schemaOf(target), t.name)} LIMIT 1`);
        if (r.rowCount) nonEmpty.push(t.name);
      }
      add({ id: "DB-T5", side: "target", ok: nonEmpty.length === 0,
        detail: nonEmpty.length ? `target not empty: ${nonEmpty.join(", ")}` : "target tables empty",
        hint: "초기 복사(copy_data)는 빈 표를 가정한다. 이 이전이나 같은 도착에서 롤백·취소로 끝난 이전의 스키마 복사가 만든 표(주석 svc-copy:<이전 id>)는 sync 가 스스로 지운다. 그 밖의 표는 사람이 비운다 (온프레: tools/onprem-db-reset.sh) 또는 copyData:false" });
    }
  });

  return { ok: checks.every((c) => c.ok || c.level === "warn"), tables, checks };
}

/** 출발 쪽 점검(서버 설정·권한·표·기본키·대형 객체). precheck 와 사전 점검 단계(precheckSource)가 같이 쓴다 */
async function sourceChecks(c: pg.Client, source: Endpoint, opts: { tables?: string[]; own?: string[] }, add: (c: Check) => void): Promise<TableRef[]> {
  await serverChecks(c, source, "source", add, opts.own);
  const all = await listTables(c, schemaOf(source));
  const tables = opts.tables ? all.filter((t) => opts.tables!.includes(t.name)) : all;
  const missing = (opts.tables ?? []).filter((n) => !all.some((t) => t.name === n));
  add({ id: "DB-T1", side: "source", ok: tables.length > 0 && missing.length === 0,
    detail: `${tables.length} tables in ${schemaOf(source)}${missing.length ? `, missing: ${missing.join(",")}` : ""}`,
    // hdd-10 남은 부분: 앱 표가 다른 스키마에만 있으면 "0 tables" 만 떠서 이유를 몰랐다
    ...(tables.length === 0 ? { hint: `복제 스키마(${schemaOf(source)})에 표가 없다. 앱 표가 다른 스키마에 있으면 REPL_SOURCE_SCHEMA·REPL_TARGET_SCHEMA 로 고른다 (DB-T7 참고)` } : {}) });
  // PF-E31 (hdd-10) DRAFT(ai): 끝점마다 스키마가 하나(REPL_*_SCHEMA, 기본 public)라 다른 스키마의 앱 표는 조용히 빠졌다(precheck ok·sync ready).
  //   다른 스키마에 사용자 표가 있으면 멈춘다 ("그대로 이식" 조용히 빼지 않음). TODO(human): 여러 스키마를 한 이전에서 옮길지(발행·구독은 가능)
  const others = await c.query<{ s: string; n: string }>(
    `SELECT n.nspname s, count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname <> $1 AND n.nspname NOT IN ('pg_catalog','information_schema',$2) AND n.nspname NOT LIKE 'pg\_%'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      GROUP BY 1 ORDER BY 1`, [schemaOf(source), MARKER_SCHEMA]);
  add({ id: "DB-T7", side: "source", ok: others.rowCount === 0,
    detail: others.rowCount ? `복제 스키마(${schemaOf(source)}) 밖에도 앱 표가 있다 — 옮기지 않음: ${others.rows.map((r) => `${r.s}(${r.n})`).join(", ")}` : `tables only in ${schemaOf(source)}`,
    hint: "한 이전은 스키마 하나만 옮긴다. 앱 표가 그 스키마에 있으면 REPL_SOURCE_SCHEMA·REPL_TARGET_SCHEMA 로 고른다 (여러 스키마는 아직 안 됨)" });
  // 기본키(또는 REPLICA IDENTITY FULL) 없는 표는 UPDATE/DELETE가 복제되지 않고 출발에서 에러가 난다
  const noPk = await c.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname = ANY($2)
        -- PF-E27 (hdd-05): REPLICA IDENTITY NOTHING(n)이면 기본키가 있어도 발행 뒤 출발 앱 UPDATE/DELETE 가 깨진다. 쓸 수 있는 건 FULL(f) · DEFAULT(d)+기본키 · INDEX(i)+지정 색인뿐
        AND NOT (c.relreplident = 'f'
              OR (c.relreplident = 'd' AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary))
              OR (c.relreplident = 'i' AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisreplident)))`,
    [schemaOf(source), tables.map((t) => t.name)]);
  add({ id: "DB-T2", side: "source", ok: noPk.rowCount === 0,
    detail: noPk.rowCount ? `no usable replica identity (기본키 없음 또는 REPLICA IDENTITY NOTHING): ${noPk.rows.map((r) => r.name).join(", ")}` : "all tables have PK/replica identity",
    hint: "기본키를 추가하거나 ALTER TABLE ... REPLICA IDENTITY DEFAULT(기본키 있을 때)·FULL" });
  // 대형 객체(lo)는 논리 복제가 옮기지 않는다
  const lo = Number((await c.query(`SELECT count(*) n FROM pg_largeobject_metadata`)).rows[0].n);
  add({ id: "DB-T3", side: "source", ok: lo === 0, detail: `${lo} large objects`, hint: "large object는 논리 복제 대상이 아님. bytea로 바꾸거나 따로 옮긴다" });
  return tables;
}

/** PF-E10: 출발 앱 스키마의 사용자 뷰·함수·트리거 + 확장 이름 목록 */
async function appObjects(c: pg.Client, schema: string): Promise<string[]> {
  const r = await c.query<{ k: string }>(
    `SELECT 'view:' || c.relname k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('v','m')
     UNION ALL
     SELECT 'function:' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     UNION ALL
     SELECT 'trigger:' || c.relname || '.' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
     UNION ALL
     SELECT 'extension:' || extname FROM pg_extension WHERE extname <> 'plpgsql'`, [schema]);
  return [...new Set(r.rows.map((x) => x.k))].sort();
}
async function missingAppObjects(source: Endpoint, dst: pg.Client, dstSchema: string): Promise<string[]> {
  const src = await withClient(source, (c) => appObjects(c, schemaOf(source)));
  const have = new Set(await appObjects(dst, dstSchema));
  return src.filter((k) => !have.has(k));
}

/** PF-E1: 사전 점검(prechecking) 단계용. 도착 DB 는 아직 없으니 출발만 본다 → 자원을 만들기 전에 rds.logical_replication·권한·기본키를 잡는다
 *  (예전엔 sync 첫 점검에서야 알았다 = apply·배포 30분 뒤 paused SYNC_FAILED) */
export async function precheckSource(source: Endpoint, opts: { tables?: string[] } = {}): Promise<PrecheckResult> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const w = workerTlsProblem(source);
  if (w) { add({ id: "NET-TLS0", side: "source", ok: false, detail: w }); return { ok: false, tables: [], checks }; }
  const tables = await withClient(source, async (c) => {
    const t = await sourceChecks(c, source, opts, add);
    // PF-E10: 도착 DB 는 아직 없다 → 출발에 뷰·함수·트리거·확장이 있으면 알려만 준다 (도착과 비교는 sync 첫 점검 DB-T6 이 막는다)
    const objs = await appObjects(c, schemaOf(source));
    if (objs.length) add({ id: "DB-T6S", side: "source", ok: false, level: "warn",
      detail: `복제가 안 옮기는 객체 ${objs.length}개: ${objs.slice(0, 20).join(", ")}${objs.length > 20 ? " …" : ""}`,
      hint: "도착에 앱 마이그레이션으로 만들어야 컷오버 뒤 앱이 안 깨진다 (sync 첫 점검 DB-T6 이 도착과 비교해 막는다)" });
    return t;
  });
  return { ok: checks.every((c) => c.ok || c.level === "warn"), tables, checks };
}

async function serverChecks(c: pg.Client, e: Endpoint, side: "source" | "target", add: (c: Check) => void, own: string[] = []) {
  const s = (await c.query<{ wal: string; slots: string; senders: string; ver: string }>(
    `SELECT current_setting('wal_level') wal, current_setting('max_replication_slots') slots,
            current_setting('max_wal_senders') senders, current_setting('server_version_num') ver`)).rows[0]!;
  add({ id: "DB-01", side, ok: s.wal === "logical", detail: `wal_level=${s.wal}`, hint: WAL_HINT[e.provider] });
  // Z77 (Z62 주제 60): wal_senders 도 2 이상 (정방향·역방향 walsender 가 한때 같이 붙는다). 예전엔 값만 읽고 판정 안 함
  add({ id: "DB-02", side, ok: Number(s.slots) >= 2 && Number(s.senders) >= 2, detail: `max_replication_slots=${s.slots} max_wal_senders=${s.senders}`, hint: "정방향·역방향 슬롯·walsender 각각 2개 이상" });
  // PF-E12 (FM-APP-21) DRAFT(ai): 구독 일꾼 자리. 남은 구독(지난 회차·FM-APP-14·고객 것)이 max_logical_replication_workers 를 채우면
  //   새 구독이 만들어져도 초기 복사가 i 상태에서 안 움직이고 도착 로그에만 'out of logical replication worker slots' 이 남는다.
  //   도착(정방향 구독자)은 적용 1 + 표 복사 1 이상 = 2, 출발(컷오버 뒤 역방향 구독자, 복사 없음)은 1. 켜진 구독마다 적용 일꾼 1개를 잡는다. 이 이전 것(own)은 뺀다
  const w = (await c.query<{ max: string; procs: string; n: string }>(
    `SELECT current_setting('max_logical_replication_workers') max, current_setting('max_worker_processes') procs,
            (SELECT count(*) FROM pg_subscription WHERE subenabled AND NOT (subname = ANY($1::text[]))) n`, [own])).rows[0]!;
  const need = side === "target" ? 2 : 1, free = Math.min(Number(w.max), Number(w.procs)) - Number(w.n);
  add({ id: "DB-07", side, ok: free >= need,
    detail: `구독 일꾼 남은 자리 ${free} (max_logical_replication_workers=${w.max} max_worker_processes=${w.procs}, 켜진 다른 구독 ${w.n}개), 필요 ${need}`,
    hint: "남은 구독을 지우거나(DROP SUBSCRIPTION, 지난 이전이면 teardown) max_logical_replication_workers 를 올린다 (재시작 필요)" });
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
  add({ id: "DB-05", side, ok: app.rowCount === 1, detail: `app role ${e.appRole} ${app.rowCount ? "exists" : "missing"}`,
    hint: `워커 env REPL_${side === "source" ? "SOURCE" : "TARGET"}_APP_ROLE=<앱이 접속하는 계정> (기본 app_user). 컷오버 펜스도 이 계정에 건다` });
  // DB-08: 컷오버 울타리는 앱 계정에 "직접" 준 쓰기 권한을 REVOKE 한다. 앱 계정이 superuser 이거나, 쓰기를 통째로 주는 역할
  //   (pg_write_all_data, RDS rds_superuser, Cloud SQL cloudsqlsuperuser, Azure azure_pg_admin)을 물려받으면 REVOKE 뒤에도 쓸 수 있어
  //   컷오버가 FENCE_INEFFECTIVE 로 매번 되돌려진다. 2026-11-06 실제 RDS: 앱 계정 = 마스터(rds_superuser → pg_write_all_data) → 컷오버 2회 실패.
  //   DRAFT(ai): block. 복제를 걸기 전(sync 첫 점검)에 멈춰 고객이 앱 전용 계정으로 바꾸게 한다 (복제·컷오버까지 갔다가 되돌리는 것보다 싸다)
  if (app.rowCount === 1) {
    const f = (await c.query<{ su: boolean; via: string[] }>(
      `SELECT r.rolsuper su,
              ARRAY(SELECT g FROM unnest(ARRAY['pg_write_all_data','rds_superuser','cloudsqlsuperuser','azure_pg_admin']) g
                     WHERE to_regrole(g) IS NOT NULL AND pg_has_role(r.oid, g::regrole, 'USAGE') ORDER BY 1) via
         FROM pg_roles r WHERE r.rolname = $1`, [e.appRole])).rows[0]!;
    add({ id: "DB-08", side, ok: !f.su && f.via.length === 0,
      detail: f.su ? `app role ${e.appRole} is superuser` : f.via.length ? `app role ${e.appRole} inherits ${f.via.join(", ")}` : `app role ${e.appRole} has direct grants only`,
      hint: `앱이 관리자 계정(마스터 등)으로 붙으면 컷오버 때 쓰기를 막을 수 없다. 앱 전용 계정(LOGIN, 표·시퀀스 권한만 직접 GRANT)을 만들어 앱이 그 계정으로 붙게 하고, 명세 appUser 를 그 계정으로 바꾼다` });
  }
  // DB-09 (ADR-029): 전환은 DB 단위 설정(ALTER DATABASE … default_transaction_read_only)을 바꾼다 → 관리자가 DB 주인이거나 주인 역할을 물려받아야 한다.
  //   CNPG 의 svc_migrate 는 Cluster initdb.owner 역할의 멤버로만 권한을 얻는다. 이미 있는 Cluster 는 initdb 가 다시 안 돌아서
  //   실제 DB 주인이 명세 appUser(차트가 initdb.owner 로 렌더)와 다르면, 복제·컷오버까지 간 뒤 "must be owner of database" 로 깨졌다
  //   (2026-11-06 실플랫폼 b76540b7 CUTOVER_HALFWAY). 복제를 걸기 전에 여기서 멈춘다
  const o = (await c.query<{ owner: string; member: boolean; su: boolean }>(
    `SELECT pg_get_userbyid(d.datdba) AS owner, pg_has_role(current_user, d.datdba, 'MEMBER') AS member,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su
       FROM pg_database d WHERE d.datname = current_database()`)).rows[0]!;
  // DRAFT(ai): CNPG(실측된 실패)만 막고, RDS·Cloud SQL·Azure 는 권고(warn). 관리형 DB 는 관리자=마스터가 DB 를 만들어 보통 주인이지만 실측 전이라 결선 전에 새로 막지 않는다
  add({ id: "DB-09", side, ok: o.su || o.member, ...(e.provider === "cnpg" ? {} : { level: "warn" as const }),
    detail: `database owner ${o.owner}, ${o.su ? "admin is superuser" : o.member ? "admin can act as owner" : "admin is not a member of the owner role"}`,
    hint: e.provider === "cnpg"
      ? `CNPG Cluster initdb.owner(= 명세 appUser ${e.appRole})와 실제 DB 주인(${o.owner})이 다르다. 처음 이전하는 도착이면 DB 를 비우고 ALTER DATABASE <db> OWNER TO ${e.appRole}, 아니면 명세 appUser 를 ${o.owner} 로 맞춘다`
      : `관리자 계정에 DB 주인 역할을 준다: GRANT ${o.owner} TO <관리자>` });
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

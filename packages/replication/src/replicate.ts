import type pg from "pg";
import type { Endpoint } from "./endpoint.js";
import { subscriptionConninfo } from "./repluser.js";
import { ident, lit, sleep } from "./sql.js";
import { markerDdl, markerRef, tableList, type TableRef } from "./tables.js";

// 한 방향(from → to) 복제 길 만들기·없애기. 이름 하나 = from 쪽 publication·slot + to 쪽 subscription.
// FOR ALL TABLES는 superuser만 되고 RDS/Cloud SQL 관리자는 superuser가 아니라서 표 목록을 직접 적는다.

// z75-31: 표지 표 만들기 + 있나 보기 + 만들기/바꾸기 = 왕복 3번 → 1번 (서버 안 DO 블록에서 고른다. 결과는 같다)
export async function ensurePublication(c: pg.Client, name: string, tables: TableRef[]) {
  const list = tableList([...tables, markerRef]);
  await c.query(`${markerDdl()};
    DO $z75p$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = ${lit(name)}) THEN
        EXECUTE ${lit(`ALTER PUBLICATION ${ident(name)} SET TABLE ${list}`)};
      ELSE
        EXECUTE ${lit(`CREATE PUBLICATION ${ident(name)} FOR TABLE ${list}`)};
      END IF;
    END $z75p$`);
}

export async function slotExists(c: pg.Client, name: string) {
  return (await c.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name=$1`, [name])).rowCount === 1;
}
export async function subscriptionExists(c: pg.Client, name: string) {
  return (await c.query(`SELECT 1 FROM pg_subscription WHERE subname=$1`, [name])).rowCount === 1;
}

export interface SubscribeOpts {
  /** true = 초기 스냅샷 복사(정방향 처음). false = 이미 같은 데이터(역방향·재연결) */
  copyData: boolean;
  /** true = 슬롯을 구독이 만든다. false = 미리 만든 슬롯을 쓴다 (컷오버 때 RESUME 전에 슬롯부터 만들어 두는 경우) */
  createSlot: boolean;
}

// Z80: "구독 있나 + 표지 표 + 서버 판" 을 왕복 1번으로 (예전 3번). 그 뒤 ENABLE 이나 CREATE SUBSCRIPTION 1번 = 합계 2번.
//   표지 표 DDL 은 IF NOT EXISTS 라 구독이 이미 있을 때(= 표지 표도 이미 있음) 돌아도 바뀌는 것이 없다.
//   CREATE SUBSCRIPTION 은 create_slot=true 면 트랜잭션 블록 안에서 못 돌아 따로 보낸다
export async function ensureSubscription(to: pg.Client, from: Endpoint, name: string, o: SubscribeOpts) {
  const head = await to.query(`${markerDdl()};
    SELECT EXISTS (SELECT 1 FROM pg_subscription WHERE subname = ${lit(name)}) AS e, current_setting('server_version_num') AS v`) as unknown as pg.QueryResult<{ e: boolean; v: string }>[];
  const row = (Array.isArray(head) ? head.at(-1) : (head as pg.QueryResult<{ e: boolean; v: string }>))?.rows[0];
  if (row?.e) {
    await to.query(`ALTER SUBSCRIPTION ${ident(name)} ENABLE`);
    return false;
  }
  // Z52: REPL_EPHEMERAL_USER=1 이면 관리자 대신 이 길 전용 계정(표 읽기 + 복제만)이 접속 문자열에 들어간다
  const conninfo = await subscriptionConninfo(from, name);
  // Z63: PG16부터 구독은 변경을 "표 주인" 권한으로 적용한다. CNPG는 initdb owner(app) = 앱 계정이라
  // 펜스(REVOKE ... FROM app)가 표 주인 권한까지 걷어 역방향 적용이 "permission denied for table"로 멈춘다(롤백 실패).
  // run_as_owner = true면 구독 주인(관리자) 권한으로 적용 → 앱 계정 펜스와 복제 적용이 서로 안 걸린다. PG15 이하는 옵션 없음
  // Z38 R8-30: 행이 없으면 서버 판을 모른다 → run_as_owner 가 조용히 빠지지 않게 멈춘다
  if (!row) throw new Error(`ensureSubscription(${name}): no result row for subscription/version check`);
  const v = Number(row.v);
  const runAsOwner = v >= 160000 && process.env.REPL_RUN_AS_OWNER !== "0" ? ", run_as_owner = true" : "";
  await withPeerTimeout(to, () => to.query(`CREATE SUBSCRIPTION ${ident(name)} CONNECTION ${lit(conninfo)} PUBLICATION ${ident(name)}
    WITH (copy_data = ${o.copyData}, create_slot = ${o.createSlot}, slot_name = ${lit(name)}${runAsOwner})`));
  return true;
}

/** PF-E28 (hdd-06): 구독 서버가 발행자에 접속하는 문장(CREATE SUBSCRIPTION·슬롯 지우는 DROP SUBSCRIPTION)은 PG16 이 접속 문자열의
 *  connect_timeout 을 안 지켜, 응답 없는 출발이면 TCP 시간 초과(~134초)까지 막혔다 → 이 문장만 세션 statement_timeout 을 건다.
 *  CREATE SUBSCRIPTION(create_slot)은 트랜잭션 블록 안에서 못 돌아 SET LOCAL 대신 SET 뒤 RESET.
 *  DRAFT(ai): 기본 60초(REPL_SUBSCRIBE_TIMEOUT_SEC, 0 = 끔). 슬롯 만들기는 출발의 진행 중 트랜잭션이 끝나길 기다리므로 너무 짧으면 바쁜 DB 에서 거짓 실패 */
export async function withPeerTimeout<T>(c: pg.Client, fn: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const raw = env.REPL_SUBSCRIBE_TIMEOUT_SEC;
  const sec = raw === undefined || raw.trim() === "" ? 60 : Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) return fn();
  await c.query(`SET statement_timeout = ${Math.floor(sec * 1000)}`);
  try { return await fn(); }
  finally { await c.query(`RESET statement_timeout`).catch(() => {}); }
}

/** 구독이 있으면 끈다(왕복 1번). 있었으면 true. 끄기는 이 문장으로 커밋돼 적용 프로세스가 바로 끝나기 시작한다 */
export async function disableSubscription(to: pg.Client, name: string): Promise<boolean> {
  const head = await to.query(`SELECT EXISTS (SELECT 1 FROM pg_subscription WHERE subname = ${lit(name)}) AS e;
    DO $z75s$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_subscription WHERE subname = ${lit(name)}) THEN EXECUTE ${lit(`ALTER SUBSCRIPTION ${ident(name)} DISABLE`)}; END IF;
    END $z75s$`) as unknown as pg.QueryResult<{ e: boolean }>[];
  return head[0]?.rows[0]?.e === true;
}

/** Z80 04: 꺼진 구독을 "발행자에 붙지 않고" 지우는 SQL. slot_name=NONE 이면 DROP SUBSCRIPTION 이 발행자에 접속해 슬롯을 지우지 않는다
 *  → 트랜잭션 블록 안에서도 돌고, 원격(RDS·GKE ↔ 맥 중계) 접속 비용(실측 ~110ms)이 멈춤에서 빠진다. 발행자 쪽 슬롯은 부른 쪽이 따로 지운다 */
export const detachSubscriptionSql = (name: string) =>
  `ALTER SUBSCRIPTION ${ident(name)} SET (slot_name = NONE); DROP SUBSCRIPTION ${ident(name)}`;

/** 구독 제거. 연결된 발행자 슬롯도 같이 지운다. 발행자에 못 닿으면 slot_name=NONE으로 떼고 슬롯은 남는다(정리 대장에 남김) */
// z75-31: "있나 보기 + 끄기" 를 왕복 1번으로 (DROP SUBSCRIPTION 은 슬롯을 지울 때 트랜잭션 안에서 못 돌아 따로 보낸다)
export async function dropSubscription(to: pg.Client, name: string): Promise<{ dropped: boolean; slotLeft: boolean }> {
  if (!(await disableSubscription(to, name))) return { dropped: false, slotLeft: false };
  try {
    await withPeerTimeout(to, () => to.query(`DROP SUBSCRIPTION ${ident(name)}`));
    return { dropped: true, slotLeft: false };
  } catch {
    await to.query(`ALTER SUBSCRIPTION ${ident(name)} SET (slot_name = NONE)`);
    await to.query(`DROP SUBSCRIPTION ${ident(name)}`);
    return { dropped: true, slotLeft: true };
  }
}

/** 슬롯이 쉬고 있으면 지운다. L2: DROP SUBSCRIPTION 직후엔 발행자 쪽 walsender가 잠깐 살아 있어(active) 지우기가 예외가 난다.
 *  그래서 active가 풀릴 때까지 waitMs 동안 다시 본다. 끝까지 active면 지우지 않고 false (정리 확인 leftovers가 남은 슬롯을 센다).
 *  DRAFT(ai): 기본 5초. 짧으면 정리 확인에서 슬롯이 남고(T27 실패 → 사람이 봄), 길면 cleanup 작업이 그만큼 늦게 끝난다 */
export async function dropSlotIfIdle(c: pg.Client, name: string, o: { waitMs?: number; everyMs?: number } = {}) {
  const waitMs = o.waitMs ?? 5_000, everyMs = o.everyMs ?? 100;
  const t0 = Date.now();
  for (;;) {
    const r = await c.query<{ active: boolean }>(`SELECT active FROM pg_replication_slots WHERE slot_name=$1`, [name]);
    if (!r.rowCount) return false;
    if (!r.rows[0]!.active) break;
    if (Date.now() - t0 >= waitMs) return false;
    await sleep(everyMs);
  }
  await c.query(`SELECT pg_drop_replication_slot($1)`, [name]);
  return true;
}

/** 정방향 복제 시작: 출발에 publication, 도착에 subscription(copy_data=true → 초기 스냅샷). 여러 번 불러도 안전.
 *  Z80 06: 이미 연 두 연결로 (순서 그대로: 발행 먼저, 그다음 구독). Z104: 연결을 직접 여는 감싸개 startForward 는 부르는 곳 0 이라 지움 */
export async function startForwardOn(s: pg.Client, d: pg.Client, source: Endpoint, name: string, tables: TableRef[]) {
  await ensurePublication(s, name, tables);
  // RV-07 DRAFT(ai): CREATE SUBSCRIPTION(create_slot=true) 은 출발에 슬롯을 먼저 만들고 도착에서 커밋한다. 그 사이 연결이 끊기면
  //   출발에 슬롯만 남고 구독은 없다 → 재시도마다 "replication slot already exists"(42710) 로 SYNC_FAILED, 남은 슬롯은 출발 WAL 을 계속 붙잡는다.
  //   도착에 같은 이름 구독이 없을 때만, 쓰는 사람 없는(active=false) 같은 이름 슬롯을 지우고 만든다 (이름에 이전 id 가 들어 있어 남의 슬롯이 아님)
  if (!(await subscriptionExists(d, name))) await dropSlotIfIdle(s, name, { waitMs: 0 });
  return ensureSubscription(d, source, name, { copyData: true, createSlot: true });
}

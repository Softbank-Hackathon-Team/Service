import { assertName } from "./sql.js";

// 이전 한 건(migrationKey)에서 나오는 복제 객체 이름. 방향마다 이름이 하나:
//   fwd = 출발 → 도착 (컷오버 전), rev = 도착 → 출발 (컷오버 뒤, 롤백 대비)
// 이름 하나가 발행자 쪽 publication·slot, 구독자 쪽 subscription 세 가지에 같이 쓰인다.
export const MARKER_SCHEMA = "_repl";
export const MARKER_TABLE = "marker";

export interface Names { fwd: string; rev: string }
export function namesFor(migrationKey: string): Names {
  // 이전 id(uuid)는 숫자로 시작할 수 있어서 접두어를 붙인 뒤 검사한다. 슬롯 이름 한도 63자
  const k = migrationKey.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  if (!k) throw new Error("invalid migrationKey: empty");
  return { fwd: assertName(`repl_${k}_fwd`, "migrationKey"), rev: assertName(`repl_${k}_rev`, "migrationKey") };
}

// Z77 (주제 69): _repl 스키마·표를 만드는 DDL 앞에 붙이는 트랜잭션 잠금 (동시 CREATE … IF NOT EXISTS 충돌 방지, tables.ts·fence.ts)
export const MARKER_DDL_LOCK = `SELECT pg_advisory_xact_lock(hashtext('svc-replication:_repl-ddl'))`;
// 잠금만으로는 모자랐다: 잠금을 기다린 뒤에도 같은 트랜잭션의 카탈로그 스냅숏이 옛것이라 IF NOT EXISTS 가 남이 막 만든 스키마를 못 봤다 (시험 5회 중 1건).
//   그래서 만들기 한 문장을 "이미 있음" 오류만 삼키는 DO 블록으로 감싼다 (하위 트랜잭션이라 나머지는 그대로)
export const createIdem = (stmt: string) =>
  `DO $z77c$ BEGIN ${stmt}; EXCEPTION WHEN unique_violation OR duplicate_schema OR duplicate_table OR duplicate_object THEN NULL; END $z77c$`;

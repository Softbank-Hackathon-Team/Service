// Z69: 롤백 뒤 복제 객체(구독·슬롯·발행·마커) 걷기. rolled_back은 끝 상태라 cleanup 작업이 안 돈다 → 롤백 작업이 직접 걷는다.
// 예전(int5 1차): 안 걷어서 정방향 구독 1개 + 출발 슬롯 1개가 남았다(Z63 결함 2). 슬롯이 출발 DB의 WAL을 계속 붙잡는다.
// 2b(Z20 M4): 컷오버 뒤 롤백만 걷었고, 걷기가 예외면 롤백 작업 전체가 실패 → 재시도 → ROLLBACK_FAILED가 됐다.
// 결정(기본값, Z69): 걷기 실패는 롤백 실패로 바꾸지 않는다. 데이터 쪽 되돌림(출발이 다시 주인, 트래픽 100% 출발)은 이미 끝났으므로
//   롤백은 rolled_back으로 두고 경고(로그 warn + 감사 rollback.cleanup_incomplete)를 남긴다.
//   대안 "걷기 실패도 롤백 실패": 버림. 다시 돌려도 이미 끝난 전환을 또 하려 하고, 결국 사람이 보는 failed가 되어 실제 상태(출발 정상)와 어긋난다.
//   대안 "rolled_back 뒤 cleanup 큐로 넘기기": 버림. 상태 기계에 새 길이 필요(아키텍처 변경).
// 걷기는 여러 번 불러도 안전하다(teardown은 있는 것만 지움). 그래서 kind와 상관없이 항상 부른다(noop이어도 지난 실패의 찌꺼기를 줍는다).

export interface ReplCleaner {
  teardown(): Promise<{ removed: string[] }>;
  leftovers(): Promise<string[]>;
}

export interface RollbackCleanup {
  /** 걷기가 끝났고 찌꺼기 0 (또는 복제를 시작한 적이 없어 DB 에 걷을 것이 없음 = notStarted) */
  ok: boolean;
  /** 동기화(syncing)에 들어간 적이 없어 DB 걷기 실패를 무시했다 (아래 notStartedCleanup) */
  notStarted?: true;
  removed: string[];
  /** 걷은 뒤 남은 복제 객체. 확인조차 못 했으면 null */
  leftovers: string[] | null;
  /** ok=false일 때 이유 (감사·로그용, 500자까지) */
  warning?: string;
}

const msgOf = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 300);

export async function cleanupAfterRollback(repl: ReplCleaner): Promise<RollbackCleanup> {
  const warnings: string[] = [];
  let removed: string[] = [];
  try { removed = (await repl.teardown()).removed; }
  catch (e) { warnings.push(`teardown failed: ${msgOf(e)}`); }
  let leftovers: string[] | null = null;
  try { leftovers = await repl.leftovers(); }
  catch (e) { warnings.push(`leftovers check failed: ${msgOf(e)}`); }
  if (leftovers && leftovers.length) warnings.push(`replication objects remain: ${leftovers.join(", ")}`.slice(0, 300));
  return warnings.length
    ? { ok: false, removed, leftovers, warning: warnings.join("; ").slice(0, 500) }
    : { ok: true, removed, leftovers };
}

// 복제를 시작하기 전(syncing 에 들어간 적 없음)에 멈춘 이전의 롤백 (DRAFT(ai), 2026-11-07 실플랫폼 59b17ae8).
//   복제 객체(발행·슬롯·구독·전용 계정 repl_*_u)는 동기화 단계에서야 만든다 (repluser.ts subscriptionConninfo 가 구독을 걸 때 계정을 만든다).
//   그 전이면 DB 에 걷을 것이 없는데, 걷기는 중계기 통로(온프레 터널·중계 입구)로 DB 에 붙으려다 ECONNREFUSED 로 실패했고,
//   ok=false 라 gitops 복제 배달 정리와 중계기 지우기가 "replication_leftovers" 로 건너뛰어져 중계 EC2·보안 그룹이 남았다.
//   → 동기화에 들어간 적이 없으면 걷기 실패를 ok 로 보고 notStarted 를 남긴다 (경고 문구는 그대로 둔다). 들어갔으면 예전 그대로
export function notStartedCleanup(c: RollbackCleanup, enteredSync: boolean): RollbackCleanup {
  return c.ok || enteredSync ? c : { ...c, ok: true, notStarted: true };
}

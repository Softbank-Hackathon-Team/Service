// 롤백 뒤 출발 DB 건강 판정 (DRAFT(ai), 2026-11-07).
//   예전 판정 = "출발 앱 계정이 지금 쓸 수 있나" 하나. 그런데 출발이 이 이전 전부터 쓰기 막혀 있을 수 있다:
//   앞선 이전이 같은 출발 DB 로 완료되면 출발 울타리(fence)를 그대로 둔다 (완료 = 출발 은퇴).
//   그 출발로 새 이전을 만들고 컷오버 전에 롤백하면, 이 이전은 출발을 건드린 적이 없는데도 "source not healthy" 로
//   rolling_back → failed 가 되고 잠금도 못 풀었다 (2026-11-07 실플랫폼 59b17ae8: f6c08ef2 완료 뒤 같은 RDS 에서 shop_app INSERT = false).
// 울타리는 컷오버 단계(C2)에서만 친다. 그래서 컷오버에 들어간 적이 없으면 지금의 쓰기 막힘은 이 이전 때문이 아니다 → 롤백은 막지 않고 결과에 남긴다.
//   컷오버에 들어갔거나(울타리를 쳤을 수 있음) 컷오버 뒤 롤백이면 예전처럼 건강하지 않음으로 본다 (출발 쓰기를 돌려줘야 하는 쪽이 이 이전).

export type SourceAppWrite = "ok" | "blocked_before_migration" | "blocked";

export function sourceDbHealth(i: { appWritable: boolean; kind: "before_cutover" | "after_cutover" | "noop"; enteredCutover: boolean }): { healthy: boolean; appWrite: SourceAppWrite } {
  if (i.appWritable) return { healthy: true, appWrite: "ok" };
  if (i.kind !== "after_cutover" && !i.enteredCutover) return { healthy: true, appWrite: "blocked_before_migration" };
  return { healthy: false, appWrite: "blocked" };
}

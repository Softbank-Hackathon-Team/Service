// z75-69 (Z93 미룬 것): 로그아웃 즉시 접근 토큰 무효. 로그인 묶음(family_id) 단위 차단 목록을 API 프로세스 메모리에 둔다.
//   접근 토큰은 무상태 JWT(기본 15분)라 원래는 로그아웃 뒤에도 만료까지 살아 있었다. 갱신할 때마다 새 sid 가 생기므로(회전)
//   sid 가 아니라 묶음(fam)으로 막아야 그 전에 받은 토큰까지 같이 막힌다.
//   요청마다 DB 를 보지 않는다. 한 줄의 유효기간 = 접근 토큰 수명(AUTH_ACCESS_TTL_SEC) → 그 뒤엔 토큰이 어차피 만료라 지운다.
//   한계: API 가 여러 개 뜨면 목록이 공유되지 않고, 다시 띄우면 비워진다 (최대 15분). 결선 구성은 API 1개
// 출처: OWASP JSON Web Token Cheat Sheet "Token explicit revocation by the user" (차단 목록 + 토큰 수명만큼 보관)
const revoked = new Map<string, number>();
const MAX_ROWS = 100_000;

export function revokeFamily(fam: string, ttlSec: number, nowMs = Date.now()): void {
  if (revoked.size >= MAX_ROWS) pruneRevoked(nowMs);
  // 그래도 꽉 차면 가장 먼저 넣은 줄부터 버린다 (메모리 보호. 실제로는 로그아웃이 10만 번 쌓일 일 없음)
  while (revoked.size >= MAX_ROWS) { const k = revoked.keys().next().value; if (k === undefined) break; revoked.delete(k); }
  revoked.set(fam, Math.max(revoked.get(fam) ?? 0, nowMs + Math.max(1, ttlSec) * 1000));
}
export function isFamilyRevoked(fam: string, nowMs = Date.now()): boolean {
  const until = revoked.get(fam);
  if (until === undefined) return false;
  if (until <= nowMs) { revoked.delete(fam); return false; }
  return true;
}
export function pruneRevoked(nowMs = Date.now()): void { for (const [k, v] of revoked) if (v <= nowMs) revoked.delete(k); }
export const revokedCount = () => revoked.size;

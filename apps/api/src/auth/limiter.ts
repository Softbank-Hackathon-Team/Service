// 로그인 실패 횟수 제한 (Z93). 출처: OWASP Authentication Cheat Sheet "Protect against automated attacks"
// 열쇠 2개: (접속 IP + 이메일) 15분에 5번, 접속 IP 하나 15분에 50번. 넘으면 429 + retry-after.
// 성공하면 그 (IP+이메일) 칸은 지운다. 프로세스 메모리 (rate-limit 플러그인과 같은 한계: API 여러 대면 대마다 따로)
// DRAFT(ai) Z93: 계정 잠금(계정 자체를 막기)은 안 한다 — 남이 일부러 틀려서 데모 계정을 잠그는 것을 막으려고. IP 기준만
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_PER_ID = 5;
export const LOGIN_MAX_PER_IP = 50;

type Slot = { n: number; until: number };
export class LoginLimiter {
  private m = new Map<string, Slot>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  private get(k: string) {
    const s = this.m.get(k);
    if (s && s.until <= this.now()) { this.m.delete(k); return undefined; }
    return s;
  }
  // 막혀 있으면 남은 초, 아니면 0
  blockedFor(ip: string, email: string): number {
    const t = this.now();
    for (const [k, max] of [[`id:${ip}|${email}`, LOGIN_MAX_PER_ID], [`ip:${ip}`, LOGIN_MAX_PER_IP]] as const) {
      const s = this.get(k);
      if (s && s.n >= max) return Math.max(1, Math.ceil((s.until - t) / 1000));
    }
    return 0;
  }
  fail(ip: string, email: string) {
    for (const k of [`id:${ip}|${email}`, `ip:${ip}`]) {
      const s = this.get(k);
      if (s) s.n++; else this.m.set(k, { n: 1, until: this.now() + LOGIN_WINDOW_MS });
    }
    if (this.m.size > 10_000) for (const k of this.m.keys()) { this.get(k); if (this.m.size <= 5_000) break; }
  }
  succeed(ip: string, email: string) { this.m.delete(`id:${ip}|${email}`); }
}

import type { TempCredential } from "./temp-role.js";

// 임시 자격 주기 재발급 (작업 Z61). 순수 타이머 장치: 무엇으로 재발급할지는 부르는 쪽(워커)이 renew 로 넘긴다.
// 왜: 실행 역할은 15분(900초) 상한이다. RDS 생성 같은 apply 는 15분을 넘는다 → 상한을 늘리지 않고 중간에 다시 받는다.
// 왜 10분: 만료 5분 전에 새로 받는다. AWS SDK 도 만료 5분 전부터 갱신한다 (CHANGES.md 출처). 한 번 실패해도 옛 자격이 5분 더 산다
// DRAFT(ai): 재발급 실패 1번 = 실패 (재시도 없음). 옛 자격이 아직 5분 살아 있지만, 그 안에 사람이 볼 수 있게 바로 멈추는 쪽을 골랐다

export const CRED_RENEW_DEFAULT_SEC = 600;

// 주기 = min(설정값, 수명의 2/3). 설정을 수명보다 길게 잡아 "갱신 전에 만료"되는 실수를 막는다. 900초 → 600초
export function renewIntervalSec(configuredSec: number, ttlSec: number): number {
  const cap = Math.floor((ttlSec * 2) / 3);
  const v = Number.isFinite(configuredSec) && configuredSec > 0 ? configuredSec : CRED_RENEW_DEFAULT_SEC;
  return Math.min(v, cap > 0 ? cap : v);
}

export interface RenewalHandle {
  signal: AbortSignal;          // 재발급이 실패하면 abort (reason = 그 오류). 오래 도는 일(Terraform)은 이걸 보고 멈춘다
  failed: Promise<never>;       // 재발급 실패 때만 reject. 일과 Promise.race 한다
  renewals(): number;           // 성공한 재발급 수 (자격 하나 = 1). 장부 새 줄 수와 같다. 멈출 때 진행 중이던 것이 성공해도 센다
  stop(): Promise<void>;        // 도는 중인 재발급이 끝날 때까지 기다린다 → 그 뒤 creds 를 회수하면 빠지는 자격이 없다
}

// creds 배열을 제자리에서 바꾼다 (재발급되면 같은 칸에 새 자격). 쓰는 쪽은 항상 배열에서 현재 참조를 읽는다.
// setInterval 대신 setTimeout 사슬: 재발급이 느려도 다음 차례와 겹치지 않는다
export function startRenewal(o: {
  creds: TempCredential[];
  everyMs: number;
  renew: (c: TempCredential) => Promise<TempCredential>;
}): RenewalHandle {
  const ac = new AbortController();
  let reject!: (e: unknown) => void;
  const failed = new Promise<never>((_, rj) => { reject = rj; });
  failed.catch(() => undefined);   // 아무도 안 기다릴 때 unhandled rejection 이 안 나게
  let n = 0, timer: NodeJS.Timeout | null = null, stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      for (let i = 0; i < o.creds.length && !stopped; i++) {
        o.creds[i] = await o.renew(o.creds[i]!);   // 멈춘 뒤 도착해도 넣는다 → 부른 쪽 회수가 새 자격을 본다
        n++;   // 멈춘 뒤 도착한 것도 센다: 장부엔 이미 새 줄이 있다 (예전엔 안 세서 장부 줄 수와 1 어긋났다, Z74 보고)
      }
      if (stopped) return;
      schedule();
    } catch (e) {
      stopped = true;
      ac.abort(e);
      reject(e);
    }
  };
  const schedule = () => { if (!stopped) { timer = setTimeout(() => { inflight = tick(); }, o.everyMs); timer.unref?.(); } };
  schedule();
  return {
    signal: ac.signal, failed, renewals: () => n,
    async stop() { stopped = true; if (timer) clearTimeout(timer); await inflight; },
  };
}

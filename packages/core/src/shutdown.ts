// Z81: 종료 신호 처리 한 곳 (api·worker 공통).
// 예전: api 는 SIGTERM·SIGINT 를 once 로 받았지만 close 가 던지면 처리 안 된 거부(unhandled rejection)로 끝 코드가 1 이 되고,
//   worker 는 SIGTERM 만 받아 Ctrl+C(SIGINT)는 쥔 작업을 버리고 바로 죽었다(생존 신호 10초 뒤에야 다른 워커가 재시도).
//   또 두 번째 SIGTERM 이 오면 stop 을 다시 불렀다.
// 지금:
//   - 첫 신호: 단계(steps)를 차례로 부른다. 다 끝나면 끝 코드 0, 하나라도 던지면 로그 + 끝 코드 1
//   - 두 번째 신호: 기다리지 않고 바로 끝 코드 1 (Ctrl+C 두 번 = 강제 종료. close-with-grace 와 같은 관례)
//   - 단계가 hardTimeoutMs 안에 안 끝나면 끝 코드 1 (멈춘 연결 때문에 종료가 영원히 걸리지 않게)
// 기본 hardTimeoutMs 35초 = pg-boss stop 기본 대기 30초 + 5초. 컨테이너 쪽 기한(docker stop 10초, k8s 30초)이 더 짧으면 그쪽이 먼저 죽인다
export interface ShutdownLog { info(o: Record<string, unknown>, msg: string): void; error(o: Record<string, unknown>, msg: string): void }
export interface ShutdownOpts {
  log: ShutdownLog;
  signals?: readonly NodeJS.Signals[];
  hardTimeoutMs?: number;
  exit?: (code: number) => void;          // 시험용. 기본 process.exit
  on?: (sig: NodeJS.Signals, fn: () => void) => void;  // 시험용. 기본 process.on
}
export const SHUTDOWN_HARD_TIMEOUT_MS = Math.max(1000, Number(process.env.SHUTDOWN_HARD_TIMEOUT_MS) || 35_000);

export function onShutdown(steps: ReadonlyArray<[name: string, fn: () => Promise<unknown>]>, o: ShutdownOpts): void {
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const on = o.on ?? ((s: NodeJS.Signals, fn: () => void) => { process.on(s, fn); });
  let stopping = false;
  const handle = (sig: NodeJS.Signals) => {
    if (stopping) { o.log.info({ signal: sig }, "second signal: exit now"); exit(1); return; }
    stopping = true;
    o.log.info({ signal: sig }, "shutdown: draining");
    const timer = setTimeout(() => { o.log.error({ signal: sig, timeout_ms: o.hardTimeoutMs ?? SHUTDOWN_HARD_TIMEOUT_MS }, "shutdown timed out"); exit(1); },
      o.hardTimeoutMs ?? SHUTDOWN_HARD_TIMEOUT_MS);
    timer.unref();
    void (async () => {
      let code = 0;
      for (const [name, fn] of steps) {
        try { await fn(); } catch (err) { code = 1; o.log.error({ err, step: name }, "shutdown step failed"); }
      }
      clearTimeout(timer);
      exit(code);
    })();
  };
  for (const s of o.signals ?? ["SIGTERM", "SIGINT"]) on(s, () => handle(s));
}

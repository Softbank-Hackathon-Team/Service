// 평가 시나리오 동시 실행 (Z71, Z62 제안). 결과는 넣은 순서 그대로 돌려준다.
//  - concurrency 개 일꾼이 순서대로 일을 집어 간다
//  - 한 일이 "재시도할 실패"(429 등)면 동시 수를 1로 내리고(후퇴), 잠깐 쉰 뒤 그 일만 1번 다시 한다
//  - 동시 수가 1로 내려가면 다른 일꾼은 지금 일을 끝내고 멈춘다 (새 일을 안 집음)
export interface PoolOpts<R> {
  concurrency: number;
  retryable: (r: R) => boolean;
  retryMs?: number;
  onBackoff?: (index: number) => void;   // 처음 후퇴할 때 1번
  onDone?: (index: number, r: R) => void; // 앞쪽이 다 끝난 순서대로 부른다 (출력 순서 유지)
}
export async function runPool<J, R>(jobs: J[], run: (j: J) => Promise<R>, o: PoolOpts<R>): Promise<{ results: R[]; backedOff: boolean; retried: number }> {
  const results: R[] = new Array(jobs.length);
  const done: boolean[] = new Array(jobs.length).fill(false);
  let limit = Math.max(1, Math.floor(o.concurrency) || 1), next = 0, shown = 0, retried = 0, backedOff = false;
  const flush = () => { while (shown < jobs.length && done[shown]) { o.onDone?.(shown, results[shown]!); shown++; } };
  const worker = async (id: number) => {
    while (id < limit && next < jobs.length) {
      const i = next++;
      let r = await run(jobs[i]!);
      if (o.retryable(r)) {
        if (!backedOff) { backedOff = true; limit = 1; o.onBackoff?.(i); }
        retried++;
        await new Promise((res) => setTimeout(res, o.retryMs ?? 5000));
        r = await run(jobs[i]!);
      }
      results[i] = r; done[i] = true; flush();
    }
  };
  await Promise.all(Array.from({ length: limit }, (_, k) => worker(k)));
  return { results, backedOff, retried };
}

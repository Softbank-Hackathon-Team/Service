import { RehearsalInput, SandboxRunJob, type RehearsalResult } from "@svc/contracts";
import { sandboxName, type RehearsalRun } from "@svc/agent";
import type { RehearsalFinish, SandboxRunStore } from "./pg-sandbox-run-store.js";

// sandbox-rehearsal 큐 한 건. 큐 내용(줄 번호)은 믿지 않고 sandbox_runs 줄을 회사 벽 안에서 다시 읽는다.
// 상태(passed·failed·error)만 쓰고 이전 상태는 옮기지 않는다 (워커가 advance() 로 옮긴다)
export interface RehearsalDeps {
  store: SandboxRunStore;
  rehearse(input: RehearsalInput, run: RehearsalRun): Promise<RehearsalResult>;
  now?: () => number;
}
export type RehearsalOutcome =
  | { skipped: true; reason: "missing" | "not_queued" | "deadline" | "claimed_elsewhere" }
  | { skipped: false; status: string; failureCode: string | null; woken: number };

export async function handleRehearsal(raw: unknown, d: RehearsalDeps): Promise<RehearsalOutcome> {
  const job = SandboxRunJob.parse(raw);
  const { tenantId, sandboxRunId: id } = job;
  const row = await d.store.load(tenantId, id);
  if (!row) return { skipped: true, reason: "missing" };
  if (row.status !== "queued") return { skipped: true, reason: "not_queued" };
  // 기한이 지난 줄은 시작하지 않는다. 워커가 조건부 UPDATE 로 REHEARSAL_TIMEOUT 을 쓴다
  if (row.deadlineAt && row.deadlineAt.getTime() <= (d.now ?? Date.now)()) return { skipped: true, reason: "deadline" };
  if (!(await d.store.claim(tenantId, id, sandboxName("rehearsal", id)))) return { skipped: true, reason: "claimed_elsewhere" };

  const input = RehearsalInput.safeParse(row.input);
  let f: RehearsalFinish;
  if (!input.success) {
    f = { failureCode: "REHEARSAL_SANDBOX_UNAVAILABLE",
      reason: `리허설 입력이 계약에 안 맞음: ${input.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  } else {
    try {
      f = { result: await d.rehearse(input.data, { id, tenantId: row.tenantId, onPhase: (p) => d.store.phase(tenantId, id, p) }) };
    } catch (e) {
      f = { failureCode: "REHEARSAL_SANDBOX_UNAVAILABLE", reason: `리허설 처리기 오류: ${(e as Error).message ?? String(e)}` };
    }
  }
  const done = await d.store.finish(tenantId, id, f);
  if (!done) return { skipped: true, reason: "not_queued" };
  return { skipped: false, status: done.status, failureCode: "result" in f ? f.result.failureCode : f.failureCode, woken: done.woken };
}

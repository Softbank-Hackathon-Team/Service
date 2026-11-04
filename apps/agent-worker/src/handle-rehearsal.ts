import { RehearsalInput, SandboxRunJob, type RehearsalResult } from "@svc/contracts";
import { sandboxName, type RehearsalRun } from "@svc/agent";
import type { RehearsalFinish, SandboxRunStore } from "./pg-sandbox-run-store.js";

// sandbox-rehearsal 큐 한 건. 큐 내용(줄 번호)은 믿지 않고 sandbox_runs 줄을 회사 벽 안에서 다시 읽는다.
// 상태(passed·failed·error)만 쓰고 이전 상태는 옮기지 않는다 (워커가 advance() 로 옮긴다)
// 기한 판단은 DB 시계 하나로: 잡기는 줄 서기 기한 전에만 되고, 잡으면서 실행 기한을 새로 쓴다. 기한을 넘긴 줄은 워커가 REHEARSAL_TIMEOUT 으로 닫는다
export interface RehearsalDeps {
  store: SandboxRunStore;
  rehearse(input: RehearsalInput, run: RehearsalRun): Promise<RehearsalResult>;
}
// expired = 기한을 넘겨 워커가 닫았거나 닫을 줄 (먼저 쓴 쪽이 이긴다)
export type RehearsalOutcome =
  | { skipped: true; reason: "missing" | "not_queued" | "expired" | "claimed_elsewhere" }
  | { skipped: false; status: string; failureCode: string | null; woken: number };

export async function handleRehearsal(raw: unknown, d: RehearsalDeps): Promise<RehearsalOutcome> {
  const job = SandboxRunJob.parse(raw);
  const { tenantId, sandboxRunId: id } = job;
  const row = await d.store.load(tenantId, id);
  if (!row) return { skipped: true, reason: "missing" };
  if (row.status !== "queued" || row.expired) return { skipped: true, reason: row.expired ? "expired" : "not_queued" };

  const input = RehearsalInput.safeParse(row.input);
  // 입력이 계약에 안 맞으면 실행 기한을 새로 쓰지 않고 잡아서 바로 끝낸다
  const deadlineAt = await d.store.claim(tenantId, id, sandboxName("rehearsal", id), input.success ? input.data.runBudgetSec : null);
  if (!deadlineAt) return { skipped: true, reason: (await d.store.load(tenantId, id))?.expired ? "expired" : "claimed_elsewhere" };

  let f: RehearsalFinish;
  if (!input.success) {
    f = { failureCode: "REHEARSAL_SANDBOX_UNAVAILABLE",
      reason: `리허설 입력이 계약에 안 맞음: ${input.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  } else {
    try {
      f = { result: await d.rehearse(input.data, { id, tenantId: row.tenantId, deadlineAt, onPhase: (p) => d.store.phase(tenantId, id, p) }) };
    } catch (e) {
      f = { failureCode: "REHEARSAL_SANDBOX_UNAVAILABLE", reason: `리허설 처리기 오류: ${(e as Error).message ?? String(e)}` };
    }
  }
  const done = await d.store.finish(tenantId, id, f);
  if (!done) return { skipped: true, reason: "expired" };
  return { skipped: false, status: done.status, failureCode: "result" in f ? f.result.failureCode : f.failureCode, woken: done.woken };
}

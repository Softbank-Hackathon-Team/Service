import { sweepExpiredSandboxes, type HostKube } from "@svc/agent";
import type { Logger } from "@svc/core";

// 만료 샌드박스 청소 (#177). platform.svc/expires-at 이 지난 sbx-* 네임스페이스를 지운다 (리허설·수정 고리 모두).
// 지우기 실패는 실행 번호·네임스페이스와 함께 경고 한 줄. 다음 주기에 다시 지운다
export async function sweepOnce(kube: HostKube, log: Pick<Logger, "info" | "warn">, nowMs: number = Date.now()) {
  try {
    const r = await sweepExpiredSandboxes(kube, nowMs);
    for (const f of r.failed) log.warn({ sandbox_run_id: f.runId, namespace: f.namespace, err: f.error }, "sandbox sweep: 지우기 실패");
    if (r.deleted.length) log.info({ namespaces: r.deleted }, "sandbox sweep: 만료 샌드박스 지움");
    return r;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "sandbox sweep: 목록 실패");
    return null;
  }
}

// 시작 때 한 번 + 주기. DRAFT(ai): 5분 (만료 기본 30분, 리허설 기한 20분)
export function startSandboxSweeper(kube: HostKube, log: Pick<Logger, "info" | "warn">, intervalMs = 300_000): () => void {
  void sweepOnce(kube, log);
  const t = setInterval(() => void sweepOnce(kube, log), intervalMs);
  t.unref();
  return () => clearInterval(t);
}

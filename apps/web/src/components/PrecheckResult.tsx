import { api } from "../api";
import type { TimelineView } from "../types";
import { usePoll404 } from "./Optional";
import { lastPrecheckBounce } from "../timelineDetail";

// Z83-06: 명세 검토(spec_review)로 되돌아온 이유. 사전 점검이 막힘(block)을 내면 워커가 prechecking → spec_review 로 돌리며
// 감사 기록 detail.precheck 에 항목을 남긴다(apps/worker/src/jobs/precheck.ts). 서버에 따로 경로가 없어 타임라인에서 읽는다.
// 처음 온 spec_review(되돌아온 적 없음)면 아무것도 안 그린다

const LEVEL: Record<string, string> = { block: "막힘", warn: "주의", info: "참고" };

export function PrecheckResult(p: { id: string; version: number }) {
  const r = usePoll404<TimelineView>(() => api.timeline(p.id), null, [p.id, p.version]);
  const bounce = r.data?.v ? lastPrecheckBounce(r.data.v.items) : null;
  if (!bounce) return null;
  const blocks = bounce.items.filter((c) => c.level === "block");
  return (
    <div className="precheck" role="note" data-testid="precheck-result">
      <h4>사전 점검에서 되돌아왔어 — 막힘 {blocks.length}개를 풀고 다시 '명세 확정'을 눌러</h4>
      <ul className="pc">
        {bounce.items.map((c) => (
          <li key={c.id}><span className={`chip lv-${c.level}`}>{LEVEL[c.level] ?? c.level}</span> <code>{c.id}</code> {c.message}
            {c.fix && <div className="muted small">고치는 법: {c.fix}</div>}</li>
        ))}
      </ul>
    </div>
  );
}

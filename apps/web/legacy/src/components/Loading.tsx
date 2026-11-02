// 표시 메모: 돌아가는 표시 + 문구. 8초가 넘으면 확인할 것을 안내한다.
import { useSlow } from "../usePoll";

// 돌아가는 표시 + 8초가 넘으면 무엇을 확인할지 안내
export function Loading({ text = "불러오는 중…", slowHint }: { text?: string; slowHint?: string }) {
  const slow = useSlow(true);
  return (
    <span className="loading" role="status" aria-live="polite">
      <span className="spin" aria-hidden="true" />
      {text}
      {slow && <span className="muted small"> · 8초 넘게 응답이 없어. {slowHint ?? "API·워커 터미널이 떠 있는지 확인해."}</span>}
    </span>
  );
}

import { or404 } from "../api";
import { usePoll } from "../usePoll";

// 이전마다 기록이 아직 없을 수 있는 칸(비용·보안 표 등)을 읽는다. 404 = { v: null }, 다른 오류는 error 로 (z83-11 늦은 응답 버리기는 usePoll 이 한다)
export function usePoll404<T>(fn: () => Promise<T>, ms: number | null, deps: unknown[]) {
  return usePoll<{ v: T | null }>(async () => ({ v: await or404(fn()) }), ms, deps);
}

// 그 칸이 아직 비었을 때 한 줄: 첫 응답 전이면 "불러오는 중…", 404 였으면 "<what> 없음 (…)"
export function NotYet(p: { answered: boolean; what: string }) {
  return (
    <p className="muted">
      {p.answered ? `${p.what} 없음 (서버 404 — 이 이전에 아직 기록이 없거나 이전이 지워짐).` : "불러오는 중…"}
    </p>
  );
}

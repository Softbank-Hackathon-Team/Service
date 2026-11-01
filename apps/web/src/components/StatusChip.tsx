import type { MigrationStatus } from "../types";
import { LABEL, markOf, toneOf } from "../status";

// 상태 칩 하나 (목록·상세·진행 막대가 같이 쓴다). 모양 글자 + 색 + 한국어 이름 (색만으로 구분하지 않는다)
// withCode: "명세 검토 · spec_review" 처럼 영어 이름까지 (e2e helpers.ts 가 "· 영어" 부분을 읽는다)
export function StatusChip(p: { status: MigrationStatus; big?: boolean; withCode?: boolean }) {
  return (
    <span className={`chip${p.big ? " big" : ""} tone-${toneOf(p.status)}`} title={p.status}>
      <span className="mk" aria-hidden="true">{markOf(p.status)}</span>
      {LABEL[p.status] ?? p.status}
      {p.withCode && <span className="code">· {p.status}</span>}
    </span>
  );
}

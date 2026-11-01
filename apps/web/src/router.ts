import { useEffect, useState } from "react";

// Z83-05: 해시 라우터. 화면은 "할 일" 페이지 7개로 나뉜다.
// 해시가 없거나 `#sec-…`(이전 페이지 안 칸 이동)이면 "이전" 페이지 — e2e·장면 측정이 `/` 에서 바로 이전 화면을 찾기 때문에 기본값을 바꾸지 않는다.
export type PageId = "dashboard" | "environments" | "migrations" | "cost" | "monitoring" | "security" | "agent" | "docs";

export interface PageDef {
  id: PageId;
  label: string;        // 메뉴 이름 (할 일 동사형)
  hint: string;         // 페이지 머리 한 줄
  perMigration: boolean; // 이전 하나를 골라야 뜻이 있는 페이지 (페이지 머리에 이전 고르기)
}

export const PAGES: readonly PageDef[] = [
  { id: "dashboard", label: "한눈에 보기", hint: "환경·이전 현황과 사람 차례인 일", perMigration: false },
  { id: "environments", label: "환경 보기", hint: "환경마다 돌고 있는 자원, 이전 때 무엇이 생기고 바뀌고 걷히나", perMigration: true },
  { id: "migrations", label: "이전 만들고 진행하기", hint: "출발·도착 고르기 → 명세 확정 → 승인 → 실행 → 증적", perMigration: false },
  { id: "cost", label: "비용 비교하기", hint: "출발 vs 도착 월 비용, 항목별 차이", perMigration: true },
  { id: "monitoring", label: "모니터링 보기", hint: "가동 중 앱 요청·실패·p95, 지표 대시보드(Grafana)", perMigration: true },
  { id: "security", label: "보안·감사 확인하기", hint: "통제 표, 상태 변화 타임라인, 증적 리포트", perMigration: true },
  { id: "agent", label: "AI 점검 돌리기", hint: "샌드박스 원인 분석 · GitOps 수정안 · 명세 초안", perMigration: true },
  { id: "docs", label: "API 문서 보기", hint: "코드의 Zod 스키마로 만든 OpenAPI 문서", perMigration: false },
];

export const pageDef = (id: PageId): PageDef => PAGES.find((p) => p.id === id) ?? PAGES[1]!;
export const hrefOf = (id: PageId) => (id === "migrations" ? "#/" : `#/${id}`);

export function pageFromHash(hash: string): PageId {
  const m = /^#\/([a-z]+)/.exec(hash);
  if (!m) return "migrations";
  return PAGES.some((p) => p.id === m[1]) ? (m[1] as PageId) : "migrations";
}

export function useHashRoute(): PageId {
  const [page, setPage] = useState<PageId>(() => pageFromHash(window.location.hash));
  useEffect(() => {
    const on = () => setPage(pageFromHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return page;
}

export function goPage(id: PageId) {
  window.location.hash = hrefOf(id);
  window.scrollTo({ top: 0 });
}

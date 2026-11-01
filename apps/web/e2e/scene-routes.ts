// 발표 장면 ↔ 해시 주소(Z83-05 메뉴 7개)와 보여 줄 요소. 표: parallel/Z78/SCENES.md. scene-deeplink·scene-viewport 가 같이 쓴다 (z75-54)
export const ROUTES: Array<{ id: string; hash: string; sel: string }> = [
  { id: "dashboard", hash: "#/dashboard", sel: ".pg-dash .tiles" },
  { id: "migrations", hash: "#/", sel: ".mlist li" },
  { id: "cost", hash: "#/cost", sel: ".pg-cost #cost-detail" },
  { id: "monitoring", hash: "#/monitoring", sel: ".pg-mon h2" },
  { id: "security", hash: "#/security", sel: ".pg-sec h2:has-text('보안 통제 표')" },
  { id: "agent", hash: "#/agent", sel: ".pg-agent button.primary" },
  { id: "docs", hash: "#/docs", sel: ".pg-docs iframe" },
];

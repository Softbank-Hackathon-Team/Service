import type { SecurityLevel, SecurityProfileName } from "./schema.js";

// 보안 단계 (설계 초안 8장). 값은 PoC용 예시이고 전부 【추정】이다.
// 10/31 보드 기본값 확정: 강화 단계 구성·가격은 I 초안 값 그대로 쓰고, 화면·문서에 【추정】으로 표시한다 (재조사는 결선 뒤)
export type SecurityOption = {
  level: SecurityLevel;
  extraMonthly: (p: { db: number }) => number;
  securityScore: number; // 0~1, 높을수록 안전
  timeFactor: number;    // 이전 시간 배수
};

export const SECURITY_OPTIONS: readonly SecurityOption[] = [
  // DRAFT(ai): 기본 = 필수 보안만, 추가비 0
  { level: "basic", extraMonthly: () => 0, securityScore: 0.4, timeFactor: 1 },
  // DRAFT(ai): 강화 = DB 다중 영역 복제(DB 비용 1배) + 위협 탐지 $30, 전환 단계 2배
  { level: "hardened", extraMonthly: (p) => p.db + 30, securityScore: 0.9, timeFactor: 2 },
];

// 가중치 합 1. 점수가 낮을수록 좋다.
export const PROFILES: Record<SecurityProfileName, { cost: number; risk: number; time: number }> = {
  startup: { cost: 0.6, risk: 0.15, time: 0.25 },
  finance: { cost: 0.2, risk: 0.6, time: 0.2 },
};

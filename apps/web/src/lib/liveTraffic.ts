import { t } from './i18n';
// 작업 Z35 (Z15 제안 3): 이전 상세 "가동 중 앱" 칸이 읽는 모양 (서버 apps/api/src/live-traffic.ts LiveTrafficView 와 같다)
// TODO(통합): contracts 로 옮기면 여기 타입은 지운다
export type LiveReason = "not_configured" | "unreachable" | "bad_shape" | "other_migration" | "no_counters";
// 숫자가 없는 이유 (서버 readLiveTraffic). 없는 숫자는 지어내지 않고 이유만 말한다
export const LIVE_REASON: Record<LiveReason, string> = {
  not_configured: t('서버에 앱 앞 프록시 주소가 설정되지 않았습니다.'),
  unreachable: t('앱 앞 프록시에 닿지 못했습니다.'),
  bad_shape: t('앱 앞 프록시가 다른 모양의 숫자를 줬습니다.'),
  other_migration: t('앱 앞 프록시가 다른 마이그레이션을 세고 있습니다.'),
  no_counters: t('앱 앞 프록시가 아직 요청을 세지 않습니다.'),
};
export interface LiveTrafficView {
  migrationId: string;
  available: boolean;
  reason?: LiveReason;
  source: "proxy";
  fetchedAt: string;
  total: number; ok: number; fail: number; c4xx: number;
  p50Ms: number | null; p95Ms: number | null;
  held: number; maxHoldMs: number;
  mode: string | null; switchedAt: string | null; since: string | null;
  byState: { state: string; n: number; fail: number; p95Ms: number | null }[];
}
// Z83: 트래픽 전환 실측 — GET /migrations/:id/traffic-shift (Z75 z75-38 TrafficShiftProgress, 23:01Z 확정).
//   %, 정수 0~100. reached=true 목표 ±tolerancePct 안(성공색) / false "엣지에 퍼지는 중" / null 실측 없음. available=false 면 전환 기록 없음(목표만).
//   워커가 최대 초당 1회 갱신 → 화면은 shifting 동안 1초마다 읽는다
export const SHIFT_TOL_PCT = 10; // 서버 tolerancePct 가 없을 때만
export interface TrafficShiftProgress {
  migrationId: string;
  available: boolean;
  targetWeightPct: number | null;
  observedWeightPct: number | null;
  reached: boolean | null;
  tolerancePct: number;
  reobserve: number;
  stepStartedAt: string | null;
  observedAt: string | null;
  // 흉내 표시 (contracts results.ts). 옛 서버 응답에는 없다
  //   metricsSource: 마지막 shift 결과의 판정 지표 출처 (stub = 가짜 지표, null = 아직 기록 없음)
  //   lbStub: true = mock 전환기라 진짜 LB 가중치는 안 바뀜 (null = 모름) / lbRegistered: 이 이전에 등록된 LB 자리가 있나
  metricsSource?: 'prometheus' | 'stub' | null;
  lbStub?: boolean | null;
  lbRegistered?: boolean;
}

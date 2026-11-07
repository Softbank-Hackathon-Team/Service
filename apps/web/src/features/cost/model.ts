import type { EnvEstimate, MigrationCostView, PlanCostSummary, PriceSourceSummary } from '../../lib/types';
import { t } from '../../lib/i18n';

// 비용 숫자가 무엇을 근거로 했는지. 숫자만 보이면 이 앱의 확정값처럼 읽히므로, 근거가 약하면 그 이유를 숫자 옆에 둔다.
// 단서는 경고(노란 글씨)가 아니라 중립 톤으로 둔다. 가격표 기준일은 날짜로만 보이고 "오래됨"이라고 따로 말하지 않는다 (11/07 사용자 요청)
// 서버 근거: apps/api/src/routes/migration-cost.ts (specFrom: demo = 명세가 없어 예시 앱으로 계산), contracts cost.ts (priceStale, reason, unknown)

const INFEASIBLE: Record<string, string> = {
  ONPREM_CAPACITY_EXCEEDED: t('온프레 용량을 넘습니다'),
  NODE_LIMIT_EXCEEDED: t('노드 수 상한을 넘습니다'),
  PRICE_MISSING: t('가격표에 값이 없습니다'),
};

const PART: Record<string, string> = {
  cluster: t('클러스터'), cluster_credit: t('클러스터 크레딧'), node: t('노드'), nodes: t('노드'), db: 'DB', storage: t('스토리지'), fixed: t('고정비'),
  lb: t('로드 밸런서'), lb_capacity: t('로드 밸런서 용량'), volume: t('노드 디스크'),
};

export const ORIGIN: Record<PriceSourceSummary['origin'], string> = { live: t('공개 가격 API'), seed: t('저장해 둔 표'), sample: t('예시 값') };

/** 카드 머리줄 오른쪽 한 마디. 근거가 약한 이유가 있으면 그것을 먼저 말한다. */
export function costSummary(view: Pick<MigrationCostView, 'origin' | 'specFrom'>): string {
  if (view.specFrom === 'demo') return t('예시 앱 기준');
  return view.origin === 'stored' ? t('승인 때 추정') : t('미리보기');
}

/** 숫자 옆에 꼭 붙여야 하는 단서. 없으면 빈 목록. */
export function costCaveats(view: Pick<MigrationCostView, 'specFrom'>): string[] {
  return view.specFrom === 'demo' ? [t('이 앱의 명세가 아직 없어 예시 앱으로 계산한 값입니다.')] : [];
}

// ---- 계획서에 실린 비용 (PlanDoc.costSummary, 워커 plan.ts estimatePlanCost) ----
// 승인 때 사람이 보는 "처음 전체 비용 고지"라서, 계획서에 있으면 미리보기(GET /cost)보다 이 값을 쓴다.
// unknownFields: 계산 못 한 칸 이름. "*" = 전체를 계산하지 못함. stub = 진짜 계산이 아닌 고정값

const COST_FIELD: Record<string, string> = { monthlySource: t('출발'), monthlyTarget: t('도착') };

/** 카드 머리줄 오른쪽 한 마디. */
export function planCostSummary(c: Pick<PlanCostSummary, 'deltaMonthly' | 'unknownFields' | 'stub'>): string {
  if (c.stub) return t('고정 예시값');
  if (c.unknownFields.includes('*')) return t('계산하지 못함');
  if (c.deltaMonthly === null) return t('차이 계산 불가');
  const rounded = Math.round(c.deltaMonthly);
  return rounded === 0 ? t('월 차이 없음') : t('월 {0}${1}', { 0: rounded > 0 ? '+' : '-', 1: Math.abs(rounded).toLocaleString('en-US') });
}

/** 숫자 옆에 꼭 붙여야 하는 단서(근거가 약한 이유). 없으면 빈 목록. */
export function planCostCaveats(c: Pick<PlanCostSummary, 'unknownFields' | 'stub'>): string[] {
  const unknown = c.unknownFields.filter((field) => field !== '*');
  return [
    c.stub ? t('진짜 계산이 아니라 고정해 둔 예시값입니다.') : null,
    c.unknownFields.includes('*') ? t('가격표로 비용을 계산하지 못했습니다.') : null,
    unknown.length > 0 ? t('{0} 비용을 계산하지 못했습니다.', { 0: unknown.map((field) => COST_FIELD[field] ?? field).join('·') }) : null,
  ].filter((line): line is string => line !== null);
}

/** 비용 카드 맨 아래 안내. 가격표 기준일이 있으면 붙인다. */
export const costNote = (priceAsOf?: string | null) =>
  t('공개 가격표로 낸 추정입니다. 청구서가 아닙니다.{0}', { 0: priceAsOf ? t(' 가격 기준일 {0}.', { 0: priceAsOf.slice(0, 10) }) : '' });

/** 환경 한 줄 밑에 쓰는 단서: 계산할 수 없는 이유, 합계에서 뺀 항목. */
export function envCaption(env: Pick<EnvEstimate, 'feasible' | 'reason' | 'unknown'>): string | null {
  if (!env.feasible) return env.reason ? (INFEASIBLE[env.reason] ?? t('계산할 수 없습니다')) : t('계산할 수 없습니다');
  if (env.unknown.length > 0) return t('{0} 가격이 없어 합계에서 뺐습니다', { 0: env.unknown.map((part) => PART[part] ?? part).join('·') });
  return null;
}

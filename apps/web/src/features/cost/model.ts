import type { EnvEstimate, MigrationCostView, PlanCostSummary, PriceSourceSummary } from '../../lib/types';

// 비용 숫자가 무엇을 근거로 했는지. 숫자만 보이면 이 앱의 확정값처럼 읽히므로, 근거가 약하면 그 이유를 숫자 옆에 둔다.
// 서버 근거: apps/api/src/routes/migration-cost.ts (specFrom: demo = 명세가 없어 예시 앱으로 계산), contracts cost.ts (priceStale, reason, unknown)

const INFEASIBLE: Record<string, string> = {
  ONPREM_CAPACITY_EXCEEDED: '온프레 용량을 넘습니다',
  NODE_LIMIT_EXCEEDED: '노드 수 상한을 넘습니다',
  PRICE_MISSING: '가격표에 값이 없습니다',
};

const PART: Record<string, string> = {
  cluster: '클러스터', cluster_credit: '클러스터 크레딧', node: '노드', nodes: '노드', db: 'DB', storage: '스토리지', fixed: '고정비',
  lb: '로드 밸런서', lb_capacity: '로드 밸런서 용량', volume: '노드 디스크',
};

export const ORIGIN: Record<PriceSourceSummary['origin'], string> = { live: '공개 가격 API', seed: '저장해 둔 표', sample: '예시 값' };

/** 카드 머리줄 오른쪽 한 마디. 근거가 약한 이유가 있으면 그것을 먼저 말한다. */
export function costSummary(view: Pick<MigrationCostView, 'origin' | 'specFrom' | 'estimate'>): string {
  if (view.specFrom === 'demo') return '예시 앱 기준';
  if (view.estimate.priceStale) return '오래된 가격';
  return view.origin === 'stored' ? '승인 때 추정' : '미리보기';
}

/** 숫자 옆에 꼭 붙여야 하는 단서. 없으면 빈 목록. */
export function costCaveats(view: Pick<MigrationCostView, 'specFrom' | 'estimate'>): string[] {
  return [
    view.specFrom === 'demo' ? '이 앱의 명세가 아직 없어 예시 앱으로 계산한 값입니다.' : null,
    view.estimate.priceStale ? `가격표가 오래됐습니다. 기준일 ${view.estimate.priceAsOf.slice(0, 10)}.` : null,
  ].filter((line): line is string => line !== null);
}

// ---- 계획서에 실린 비용 (PlanDoc.costSummary, 워커 plan.ts estimatePlanCost) ----
// 승인 때 사람이 보는 "처음 전체 비용 고지"라서, 계획서에 있으면 미리보기(GET /cost)보다 이 값을 쓴다.
// unknownFields: 계산 못 한 칸 이름. "*" = 전체를 계산하지 못함. stub = 진짜 계산이 아닌 고정값

const COST_FIELD: Record<string, string> = { monthlySource: '출발', monthlyTarget: '도착' };

/** 카드 머리줄 오른쪽 한 마디. */
export function planCostSummary(c: Pick<PlanCostSummary, 'deltaMonthly' | 'unknownFields' | 'stub'>): string {
  if (c.stub) return '고정 예시값';
  if (c.unknownFields.includes('*')) return '계산하지 못함';
  if (c.deltaMonthly === null) return '차이 계산 불가';
  const rounded = Math.round(c.deltaMonthly);
  return rounded === 0 ? '월 차이 없음' : `월 ${rounded > 0 ? '+' : '-'}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

/** 숫자 옆에 꼭 붙여야 하는 단서(근거가 약한 이유). 없으면 빈 목록. */
export function planCostCaveats(c: Pick<PlanCostSummary, 'unknownFields' | 'stub'>): string[] {
  const unknown = c.unknownFields.filter((field) => field !== '*');
  return [
    c.stub ? '진짜 계산이 아니라 고정해 둔 예시값입니다.' : null,
    c.unknownFields.includes('*') ? '가격표로 비용을 계산하지 못했습니다.' : null,
    unknown.length > 0 ? `${unknown.map((field) => COST_FIELD[field] ?? field).join('·')} 비용을 계산하지 못했습니다.` : null,
  ].filter((line): line is string => line !== null);
}

/** 비용 카드 맨 아래 안내. 가격표 기준일이 있으면 붙인다. */
export const costNote = (priceAsOf?: string | null) =>
  `공개 가격표로 낸 추정입니다. 청구서가 아닙니다.${priceAsOf ? ` 가격 기준일 ${priceAsOf.slice(0, 10)}.` : ''}`;

/** 환경 한 줄 밑에 쓰는 단서: 계산할 수 없는 이유, 합계에서 뺀 항목. */
export function envCaption(env: Pick<EnvEstimate, 'feasible' | 'reason' | 'unknown'>): string | null {
  if (!env.feasible) return env.reason ? (INFEASIBLE[env.reason] ?? '계산할 수 없습니다') : '계산할 수 없습니다';
  if (env.unknown.length > 0) return `${env.unknown.map((part) => PART[part] ?? part).join('·')} 가격이 없어 합계에서 뺐습니다`;
  return null;
}

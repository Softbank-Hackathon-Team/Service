import type {
  CostBasis,
  CostGroup,
  CostLine,
  CostPriceRef,
  CostProjection,
  CostPromotion,
  EnvCostView,
  MoveCostRequest,
  MoveCostTarget,
  SourceScope,
} from '../../lib/types';
import type { BadgeTone } from '../../components/ui/controls';
import { errorText } from '../../lib/errors';
import { HttpError } from '../../lib/http';
import { t } from '../../lib/i18n';

// 근거 있는 비용(GET /environments/:id/cost, POST /environments/:id/cost/move)을 화면 글로 바꾸는 순수 함수.
// 계약: packages/contracts/src/cost-evidence.ts. 근거 문장(항 이름·식·수량 근거·뺀 것·프로모션 글)은 서버가 화면 언어로 만들어 준다 (?lang).
//
// DRAFT(ai): 금액 고르기 규칙
//   - 한 달 = 늘 받는 프로모션(applied)을 뺀 평소 한 달 (appliedMonthlyUsd). 정가(monthlyUsd)와 다르면 정가를 옆에 둔다
//   - 1년 = applied 를 뺀 12개월 (appliedYearlyUsd). applied 가 없으면 정가 12개월과 같다
//   - 조건부 금액(새 결제 계정 크레딧 등)까지 뺀 1년(conditionalYearlyUsd)이 더 낮으면 "조건 충족 시"로 따로 보인다. 합치지 않는다
//   - 신청·심사가 필요한 프로그램과 떠날 때 전송료 면제(조건부인데 금액 0)는 금액에 넣지 않고 조건과 출처만 보인다

const CENT = 0.005;
const round2 = (value: number) => Math.round(value * 100) / 100;
/** a 가 b 보다 1센트 이상 작은가 (서버 금액은 센트로 반올림돼 온다) */
const below = (a: number, b: number) => b - a > CENT;

/** DRAFT(ai): 근거 금액은 센트까지 쓴다 (줄 금액을 더하면 합계와 맞아야 해서. 예전 비용 카드의 usd() 는 달러 단위로 반올림). 음수는 -$1.00 */
export function money(value: number): string {
  const cents = round2(value);
  const text = Math.abs(cents).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}$${text}`;
}

export interface Figures {
  /** 평소 한 달 (applied 프로모션을 뺀 것) */
  monthly: number;
  /** 정가 한 달. 평소 한 달과 같으면 null */
  listMonthly: number | null;
  /** 1년 (applied 를 뺀 12개월) */
  yearly: number;
  /** 정가 1년. 1년과 같으면 null */
  listYearly: number | null;
  /** 조건을 채우면 내려가는 1년. 1년과 같으면 null */
  conditionalYearly: number | null;
}

/** 화면에 쓰는 금액 (위 규칙) */
export function figuresOf(p: CostProjection): Figures {
  return {
    monthly: p.appliedMonthlyUsd,
    listMonthly: below(p.appliedMonthlyUsd, p.monthlyUsd) ? p.monthlyUsd : null,
    yearly: p.appliedYearlyUsd,
    listYearly: below(p.appliedYearlyUsd, p.yearlyUsd) ? p.yearlyUsd : null,
    conditionalYearly: below(p.conditionalYearlyUsd, p.appliedYearlyUsd) ? p.conditionalYearlyUsd : null,
  };
}

/** 금액 아래 줄: 정가와 늘 받는 할인(다를 때만), 1년, 조건 충족 시 1년(더 낮을 때만) */
export function figureRows(f: Figures): { name: string; value: string }[] {
  return [
    ...(f.listMonthly !== null
      ? [
          { name: t('정가 한 달'), value: money(f.listMonthly) },
          { name: t('늘 받는 할인'), value: money(f.monthly - f.listMonthly) },
        ]
      : []),
    { name: t('1년'), value: money(f.yearly) },
    ...(f.conditionalYearly !== null ? [{ name: t('조건 충족 시 1년'), value: money(f.conditionalYearly) }] : []),
  ];
}

export type Caption = { text: string; warn: boolean };

/**
 * 비용 경로가 없는 옛 서버(404, 501)이거나 닿지 못함(네트워크). 오류가 아니라 "아직 볼 수 없음"으로 짧게 말한다.
 */
export const costAbsent = (error: unknown) =>
  error instanceof TypeError || (error instanceof HttpError && (error.status === 404 || error.status === 501));

/** 비용 카드 본문 한 문장. 그 밖의 오류는 공통 문장 */
export const costErrorText = (error: unknown) => (costAbsent(error) ? t('비용 정보를 아직 볼 수 없습니다.') : errorText(error));

/**
 * 환경 목록 줄 아래 한 마디. 아직 응답이 없으면 null (읽는 동안 줄이 흔들리지 않게 비워 둔다).
 * failed = 404 가 아닌 오류로 못 읽음 (404 = 경로가 없는 서버이거나 지워진 환경이라 아무 말도 하지 않는다)
 */
export function envCostCaption(view: EnvCostView | null, error: unknown = null): Caption | null {
  if (!view) return error != null && !costAbsent(error) ? { text: t('월 비용을 읽지 못함'), warn: false } : null;
  if (view.status === 'unavailable' || !view.projection) return { text: t('비용 모름 · {0}', { 0: view.reason ?? t('계산하지 못했습니다') }), warn: false };
  const month = money(figuresOf(view.projection).monthly);
  // partial = 일부 자원을 못 읽어 실제보다 낮을 수 있음. 이유(못 읽은 명령)는 길어서 "월 비용" 카드에 둔다
  return view.status === 'partial' ? { text: t('월 {0} 추산 · 일부만 셈', { 0: month }), warn: true } : { text: t('월 {0} 추산', { 0: month }), warn: false };
}

/** "월 비용" 카드 머리줄 오른쪽 */
export function envCostSummary(view: EnvCostView | null, loading: boolean, error: unknown = null): string {
  if (!view) return loading ? t('읽는 중') : costAbsent(error) ? t('볼 수 없음') : t('읽지 못함');
  if (view.status === 'unavailable' || !view.projection) return t('계산 못 함');
  const month = t('{0}/월', { 0: money(figuresOf(view.projection).monthly) });
  return view.status === 'partial' ? t('{0} · 일부만', { 0: month }) : month;
}

export type TargetPrice = { month: string; year: string } | { reason: string };

/** 도착 후보 줄 오른쪽: 위 = 한 달, 아래 = 1년 (+ 조건 충족 시). 계산하지 못했으면 서버가 준 이유 */
export function targetPrice(target: Pick<MoveCostTarget, 'feasible' | 'reason' | 'projection'>): TargetPrice {
  if (!target.feasible || !target.projection) return { reason: target.reason ?? t('계산하지 못했습니다') };
  const f = figuresOf(target.projection);
  const year = t('1년 {0}', { 0: money(f.yearly) });
  return {
    month: t('월 {0}', { 0: money(f.monthly) }),
    year: f.conditionalYearly === null ? year : t('{0} · 조건 충족 시 {1}', { 0: year, 1: money(f.conditionalYearly) }),
  };
}

/**
 * 지금보다 한 달에 얼마나 (화면에 보이는 평소 한 달끼리). 양수 = 아낌. 한쪽이라도 모르면 null.
 * 서버의 deltaMonthlyUsd 는 정가끼리라 늘 받는 할인이 있으면 화면의 두 숫자 차이와 다르다
 */
export function monthlyChange(source: Pick<EnvCostView, 'projection'>, target: Pick<MoveCostTarget, 'projection'>): number | null {
  if (!source.projection || !target.projection) return null;
  return round2(figuresOf(source.projection).monthly - figuresOf(target.projection).monthly);
}

export function changeText(delta: number): string {
  if (Math.abs(delta) < CENT) return t('지금과 같음');
  return delta > 0 ? t('월 {0} 아낌', { 0: money(delta) }) : t('월 {0} 더 듦', { 0: money(-delta) });
}

// ---- 줄 묶기 ----

export const GROUP_ORDER: readonly CostGroup[] = ['cluster', 'compute', 'database', 'storage', 'network', 'fixed'];
export const GROUP_LABEL: Record<CostGroup, string> = {
  cluster: t('클러스터'),
  compute: t('노드'),
  database: 'DB',
  storage: t('스토리지'),
  network: t('네트워크'),
  fixed: t('고정비'),
};

export interface LineGroup {
  group: string;
  label: string;
  /** 묶음 소계 */
  monthlyUsd: number;
  /** 금액이 큰 줄부터 */
  lines: CostLine[];
}

/** 줄을 묶음(클러스터·노드·DB·…)으로. 묶음 순서는 고정이고, 모르는 묶음이 오면 끝에 이름 그대로 둔다 (합계에서 빠지지 않게) */
export function lineGroups(lines: readonly CostLine[]): LineGroup[] {
  const order: string[] = [...GROUP_ORDER, ...new Set(lines.map((line) => line.group).filter((group) => !GROUP_ORDER.includes(group)))];
  return order
    .map((group) => {
      const mine = lines.filter((line) => line.group === group).sort((a, b) => b.monthlyUsd - a.monthlyUsd);
      return {
        group,
        label: GROUP_LABEL[group as CostGroup] ?? group,
        monthlyUsd: round2(mine.reduce((sum, line) => sum + line.monthlyUsd, 0)),
        lines: mine,
      };
    })
    .filter((group) => group.lines.length > 0);
}

// ---- 근거 표시 ----

type Tag = { label: string; tone: BadgeTone };

/** 단가 출처 종류 */
export const PRICE_SOURCE: Record<CostPriceRef['sourceKind'], Tag> = {
  official_api: { label: t('공식 API'), tone: 'success' },
  official_page: { label: t('공식 페이지'), tone: 'info' },
  secondary: { label: t('2차 자료'), tone: 'neutral' },
  assumption: { label: t('단가 가정'), tone: 'warning' },
};

/** 수량 근거 꼬리표. 실자원 조회·출발 대응은 서버 문장이 이미 말하므로, 재지 않고 정한 값(가정)만 꼬리표를 단다 */
export const basisTag = (kind: CostBasis['kind']): Tag | null => (kind === 'assumption' ? { label: t('수량 가정'), tone: 'warning' } : null);

/** 단가 출처 한 줄. 서버 출처 글에 확인 날짜가 이미 있으면 다시 붙이지 않는다 */
export function sourceLine(price: Pick<CostPriceRef, 'source' | 'fetchedAt'>): string {
  const day = price.fetchedAt.slice(0, 10);
  return price.source.includes(day) ? price.source : `${price.source} · ${t('{0} 확인', { 0: day })}`;
}

/** 근거 문장에 이미 나온 이름은 다시 쓰지 않는다 */
export const extraRefs = (basis: Pick<CostBasis, 'text' | 'refs'>) => basis.refs.filter((ref) => !basis.text.includes(ref));

// ---- 프로모션 ----

export const PROMO_STATUS: Record<CostPromotion['status'], Tag> = {
  applied: { label: t('적용됨'), tone: 'success' },
  conditional: { label: t('조건부'), tone: 'warning' },
  not_applicable: { label: t('해당 없음'), tone: 'neutral' },
};

export interface PromoBuckets {
  /** 늘 금액에 넣은 것 (예: GKE 무료 등급) */
  applied: CostPromotion[];
  /** 조건을 채우면 금액이 내려가는 것 (예: 새 결제 계정 크레딧). "조건 충족 시" 금액에 들어 있다 */
  conditional: CostPromotion[];
  /** 신청·심사가 필요하거나 금액이 정해지지 않은 것. 금액에 넣지 않고 조건과 출처만 */
  request: CostPromotion[];
  /** 이 견적과 상관없는 것. 이유만 */
  notApplicable: CostPromotion[];
}

export function promoBuckets(promotions: readonly CostPromotion[]): PromoBuckets {
  const buckets: PromoBuckets = { applied: [], conditional: [], request: [], notApplicable: [] };
  for (const promo of promotions) {
    if (promo.status === 'applied') buckets.applied.push(promo);
    else if (promo.status === 'not_applicable') buckets.notApplicable.push(promo);
    else if (promo.firstYearUsd > CENT) buckets.conditional.push(promo);
    else buckets.request.push(promo);
  }
  return buckets;
}

/** 프로모션 줄 오른쪽 금액 */
export function promoAmount(promo: Pick<CostPromotion, 'status' | 'firstYearUsd'>): string {
  if (promo.status === 'not_applicable') return t('금액 없음');
  if (promo.firstYearUsd <= CENT) return t('금액에 넣지 않음');
  return t('1년 {0}', { 0: money(-promo.firstYearUsd) });
}

/** 프로모션 카드 머리줄 오른쪽 */
export function promoSummary(promotions: readonly CostPromotion[]): string {
  const b = promoBuckets(promotions);
  if (promotions.length === 0) return t('없음');
  const parts = [
    b.applied.length > 0 ? t('적용 {0}', { 0: b.applied.length }) : null,
    b.conditional.length + b.request.length > 0 ? t('조건부 {0}', { 0: b.conditional.length + b.request.length }) : null,
    b.notApplicable.length > 0 ? t('해당 없음 {0}', { 0: b.notApplicable.length }) : null,
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

// ---- 요청 ----

/** POST /cost/move 본문. 도착은 서버 한도(10개)까지, 범위가 비었으면(자동으로 고름) 칸을 싣지 않는다 */
export function moveCostBody(targetEnvIds: readonly string[], scope: SourceScope): MoveCostRequest {
  const ids = [...new Set(targetEnvIds)].slice(0, 10);
  return Object.keys(scope).length > 0 ? { targetEnvIds: ids, sourceScope: scope } : { targetEnvIds: ids };
}

/**
 * 같은 열쇠의 요청을 ms 동안 하나로 묶는다. 환경 목록 줄과 오른쪽 "월 비용" 카드가 같은 환경 비용을 함께 읽어서다.
 * 실패한 요청은 바로 잊는다 (다음 읽기가 다시 보낸다)
 */
export function shareRecent<T>(fetch: (key: string) => Promise<T>, ms: number, now: () => number = Date.now) {
  const recent = new Map<string, { at: number; promise: Promise<T> }>();
  return (key: string): Promise<T> => {
    const hit = recent.get(key);
    if (hit && now() - hit.at < ms) return hit.promise;
    const promise = fetch(key);
    recent.set(key, { at: now(), promise });
    promise.catch(() => {
      if (recent.get(key)?.promise === promise) recent.delete(key);
    });
    return promise;
  };
}

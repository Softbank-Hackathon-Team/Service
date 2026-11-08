import type { IconName } from '../../components/ui/Icon';
import type { ResourceCategory } from '../../lib/resourceMap';
import type { Judgement } from '../../lib/timelineDetail';
import type { MigrationStatus, PlanDoc, TimelineItem } from '../../lib/types';
import type { SpecRow } from './model';
import { KIND_LABEL, type AppSpecV2, type ComponentKindV2, type SpecRowV2 } from './specV2';
import { t } from '../../lib/i18n';

// 큰 카드 그림(명세 카드·자원 대응·롤백 원인)의 순수 판단. 화면은 이 결과를 상자·화살표로만 그린다. 시험은 test/migration-visuals.test.ts

// ---- 명세 카드: 칸을 요소(구성요소·진입·연결·점검)마다 한 카드로 묶는다 ----

export type SpecCardRow = { key: string; name: string; value: string; review: boolean; unread: boolean; prose: boolean };
export type SpecCard = { id: string; title: string; kind: string | null; icon: IconName; rows: SpecCardRow[]; review: number };

const KIND_ICON: Record<ComponentKindV2, IconName> = { service: 'box', job: 'refresh', postgres: 'database', cache: 'refresh', objectStore: 'download', queue: 'list' };

// "api · 이미지" → "이미지". 이름은 서버 키에서 화면이 만든 것이라 앞머리(요소 이름 · )를 떼어도 뜻이 남는다
const tail = (name: string) => {
  const parts = name.split(' · ');
  return parts.length > 1 ? parts.slice(1).join(' · ') : name;
};

/** v2 명세 칸 → 요소 카드. 구성요소는 명세 순서, 그 뒤 진입·연결·명세 점검. 카드 안은 확인할 칸이 먼저 */
export function specCardsV2(rows: readonly SpecRowV2[], spec: Pick<AppSpecV2, 'components'>): SpecCard[] {
  const cards = new Map<string, SpecCard>();
  const order: string[] = [];
  const card = (id: string, make: () => Omit<SpecCard, 'rows' | 'review'>) => {
    if (!cards.has(id)) {
      cards.set(id, { ...make(), rows: [], review: 0 });
      order.push(id);
    }
    return cards.get(id)!;
  };
  for (const row of rows) {
    const comp = /^components\.([a-z][a-z0-9-]{0,39})\./.exec(row.key);
    const entry = /^entry\.(.+?)\.(?:hostnames|routes)/.exec(row.key);
    const target = comp
      ? card(`c:${comp[1]}`, () => {
          const kind = spec.components.find((item) => item.id === comp[1])?.kind;
          return { id: `c:${comp[1]}`, title: comp[1]!, kind: kind ? (KIND_LABEL[kind] ?? kind) : null, icon: kind ? KIND_ICON[kind] ?? 'box' : 'box' };
        })
      : entry
        ? card(`e:${entry[1]}`, () => ({ id: `e:${entry[1]}`, title: entry[1]!, kind: t('진입'), icon: 'globe' }))
        : row.key.startsWith('links.')
          ? card('links', () => ({ id: 'links', title: t('연결'), kind: null, icon: 'link' }))
          : row.key.startsWith('check.')
            ? card('check', () => ({ id: 'check', title: t('명세 점검'), kind: null, icon: 'shield' }))
            : card('etc', () => ({ id: 'etc', title: t('그 밖'), kind: null, icon: 'list' }));
    target.rows.push({ key: row.key, name: comp || entry ? tail(row.name) : row.name, value: row.value, review: row.review, unread: row.unread, prose: row.prose });
    if (row.review) target.review += 1;
  }
  // 구성요소는 명세 순서, 나머지는 위 순서 (진입 → 연결 → 점검 → 그 밖)
  const rank = (id: string) => {
    if (id.startsWith('c:')) return spec.components.findIndex((item) => `c:${item.id}` === id);
    return spec.components.length + (id.startsWith('e:') ? 0 : id === 'links' ? 1 : id === 'check' ? 2 : 3);
  };
  return order
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => {
      const c = cards.get(id)!;
      return { ...c, rows: [...c.rows.filter((row) => row.review), ...c.rows.filter((row) => !row.review)] };
    });
}

const V1_GROUP: Record<string, { title: () => string; icon: IconName }> = {
  app: { title: () => t('앱'), icon: 'box' },
  service: { title: () => t('서비스'), icon: 'server' },
  database: { title: () => 'DB', icon: 'database' },
  ingress: { title: () => t('진입'), icon: 'globe' },
};

/** v1 명세 칸 → 카드 (경로 맨 앞 칸으로 묶는다) */
export function specCardsV1(rows: readonly SpecRow[]): SpecCard[] {
  const out: SpecCard[] = [];
  for (const row of rows) {
    const group = row.path.split('.')[0] ?? row.path;
    let card = out.find((item) => item.id === group);
    if (!card) {
      const known = V1_GROUP[group];
      card = { id: group, title: known ? known.title() : group, kind: null, icon: known?.icon ?? 'list', rows: [], review: 0 };
      out.push(card);
    }
    card.rows.push({ key: row.path, name: row.name, value: row.value, review: row.review, unread: false, prose: false });
    if (row.review) card.review += 1;
  }
  return out;
}

/** 확정을 누르면 카드를 하나씩 채운다. 카드 하나에 쓰는 시간: 많으면 짧게, 전체는 2초 안팎 */
export const sweepStepMs = (cards: number) => Math.round(Math.min(360, Math.max(140, 2200 / Math.max(1, cards))));

// ---- 자원 대응 ----

export const CATEGORY_ICON: Record<ResourceCategory, IconName> = {
  cluster: 'server', workload: 'box', database: 'database', ingress: 'globe', registry: 'download', secret: 'lock',
  identity: 'key', network: 'link', storage: 'list', cache: 'refresh', queue: 'list', boundary: 'minus',
};

// ---- 롤백 원인 ----

export type CauseMetric = {
  id: 'error' | 'latency';
  /** 도착에서 잰 값 */
  target: number;
  /** 같은 때 출발에서 잰 값 */
  source: number;
  /** 넘으면 되돌리는 선 (오류율 = 기준 %, 응답 시간 = 출발 p95 × 배수) */
  limit: number;
  over: boolean;
};

export type RollbackCause = {
  /** 롤백을 시작한 전이가 있던 상태 (트래픽 이동·컷오버·롤백 가능 창 …) */
  from: MigrationStatus | null;
  at: string | null;
  /** 워커가 지표로 되돌림 = auto, 사람이 버튼 = human */
  by: 'auto' | 'human';
  stepPct: number | null;
  samples: number | null;
  metrics: CauseMetric[];
};

const HUMAN_ACTORS = new Set(['api', 'user', 'human']);

/**
 * 롤백 원인 그림의 재료. 롤백으로 들어간 마지막 전이(into rolling_back)를 읽는다.
 * 판정이 있으면 기준과 비교한 지표 둘(오류율·응답 시간). 응답 시간을 재지 못한 판정이면 오류율만.
 */
export function rollbackCause(
  items: readonly TimelineItem[],
  judgement: Judgement | null,
  criteria: PlanDoc['rollbackCriteria'] | null | undefined,
  failureCode: string | null | undefined,
): RollbackCause {
  const move = [...items].reverse().find((item) => item.kind === 'transition' && item.to === 'rolling_back') ?? null;
  const by = !failureCode && (!move || HUMAN_ACTORS.has(move.actor) || !judgement) ? 'human' : 'auto';
  const metrics: CauseMetric[] = [];
  if (judgement && criteria) {
    metrics.push({
      id: 'error', target: judgement.targetErrorRatePct, source: judgement.sourceErrorRatePct, limit: criteria.errorRatePct,
      over: judgement.targetErrorRatePct > criteria.errorRatePct,
    });
    if (judgement.latencyMeasured !== false) {
      const limit = judgement.sourceP95Ms * criteria.p95Multiplier;
      metrics.push({ id: 'latency', target: judgement.targetP95Ms, source: judgement.sourceP95Ms, limit, over: judgement.targetP95Ms > limit });
    }
  }
  return {
    from: (move?.from as MigrationStatus | null | undefined) ?? null,
    at: move?.at ?? null,
    by,
    stepPct: judgement?.stepPct ?? null,
    samples: judgement?.samples ?? null,
    metrics,
  };
}

/** 지표 막대의 눈금 끝: 잰 값·출발·기준 중 가장 큰 값보다 조금 넉넉하게 (기준선이 막대 끝에 붙지 않게) */
export const metricScale = (m: Pick<CauseMetric, 'target' | 'source' | 'limit'>) => Math.max(m.target, m.source, m.limit) * 1.25 || 1;

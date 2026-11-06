import { useEffect, useRef, useState, type ReactNode } from 'react';
import { go } from '../../app/routes';
import { withTransition } from '../../app/transition';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { CodeValue } from '../../components/ui/CodeValue';
import { ActionPill, Badge, BarPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { aboutMigration } from '../../lib/events';
import { errorCode, errorText } from '../../lib/errors';
import { stopReasonOf } from '../../lib/failure';
import { is404, or404 } from '../../lib/http';
import { planResourceRows, runtimeChangeNote, specSubstituteRows } from '../../lib/resourceMap';
import { LABEL } from '../../lib/status';
import { failureDetail, lastPrecheckBounce } from '../../lib/timelineDetail';
import type { MigrationView, PlanAckKind, PrecheckItem } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { useAgentReview } from '../agent/AgentResult';
import { failureAnalysisOf } from '../agent/model';
import { costCaveats, costNote, costSummary, planCostCaveats, planCostSummary } from '../cost/model';
import {
  ackPlaces, ackState, approveLabel, autoStart, canReplan, failureChoices, pollMs, screenOf, signalCovers, specRows, stepGate, stepName, usd, type MigrationScreen, type RetryStage,
} from './model';
import { scopeLabel } from './source';
import { SecurityFold } from './SecurityCard';
import {
  accuracyView, boundaryRows, canConfirmSpec, confirmChunks, confirmLabel, firewallDecision, firewallRows, isFirewallBlock, specPatchBody, specRowsV2, specV2Of,
  type FirewallRow, type MigrationSpecViewV2, type SpecRowV2,
} from './specV2';
import { LeftoverFold, StopFold } from './EvidenceFolds';
import { DoneScreen, CleanupScreen, PausedScreen, RolledBackScreen, RollingBackScreen, RunningScreen, WindowScreen } from './RunScreens';
import { RequirementsFold, SourceFactsFold, VerdictFold } from './SecurityFolds';
import { SubstituteMap } from './SubstituteMap';
import { isSecItem, precheckLine, secAckLabel, type SecuritySpecV2 } from './securityV2';
import { ConfirmPill, Frame, useAction, useCostConsent, type ScreenProps } from './shared';
import s from '../common/page.module.css';
import { localeTag, t } from '../../lib/i18n';

const LEVEL: Record<PrecheckItem['level'], { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  block: { label: t('막힘'), tone: 'danger' },
  warn: { label: t('주의'), tone: 'warning' },
  info: { label: t('참고'), tone: 'neutral' },
};

function ImportingScreen({ migration, route }: ScreenProps) {
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta={t('구성 읽기')} title={t('운영 중인 앱을\n읽고 있습니다')} foot={t('읽기만 합니다. 아무것도 바꾸지 않습니다')} />
    </Frame>
  );
}

// DRAFT(ai): 큰 카드에는 확인할 칸을 3칸만 두고 나머지는 "외 N칸"으로 근거 카드에서 본다 (1280×720 에서 큰 카드가 잘리지 않는 수)
const HERO_REVIEW_ROWS = 3;

/** v2 값 한 칸. 읽지 못한 값(null)은 비워 두고 검토 표시만 한다. 설명 글(점검 문장·환경변수 출처)은 글자로, 값은 고정폭으로 */
function ValueV2({ row, className, max = 32 }: { row: SpecRowV2; className?: string; max?: number }) {
  if (row.unread || !row.value) return <span className={className} />;
  if (row.prose) return <span className={`${className ?? ''} t-body-sm`}>{row.value}</span>;
  return <CodeValue value={row.value} size={max < 32 ? 'sm' : 'md'} max={max} className={className} />;
}

const firewallReason = (row: FirewallRow) =>
  row.reason === 'unknown'
    ? t('출발 방화벽을 읽지 못했습니다')
    : row.reason === 'uncopyable'
      ? t('출발에서 허용하던 {0}은(는) 도착으로 옮길 수 없습니다', { 0: row.sources.join(', ') })
      : t('출발은 공개였지만 허용 주소가 없습니다');

function SpecScreen({ migration, route, onChanged }: ScreenProps) {
  const spec = usePoll(() => or404(api.migrationSpec(migration.id)), null, [migration.id, migration.version]);
  const timeline = usePoll(() => or404(api.timeline(migration.id)), null, [migration.id, migration.version]);
  // 그 사이 다른 판이 생겼으면(409 SPEC_VERSION_CONFLICT) 새 판을 다시 읽는다. 사람이 본 것과 다른 판을 확정하지 않는다
  const { busy, error, run } = useAction(onChanged, (reason) => {
    if (errorCode(reason) === 'SPEC_VERSION_CONFLICT') void spec.reload();
  });
  const view = spec.data;
  const v2 = view ? specV2Of(view) : null;
  const rows = view && !v2 ? specRows(view) : [];
  const rowsV2 = view && v2 ? specRowsV2(view) : [];
  const reviewCount = v2 ? v2.review.length : rows.filter((row) => row.review).length;
  const boundary = boundaryRows(view?.outOfBoundary);
  const accuracy = view?.accuracy ? accuracyView(view.accuracy) : null;
  const bounce = timeline.data ? lastPrecheckBounce(timeline.data.items) : null;
  const firewall = v2 ? firewallRows(v2.spec) : [];
  const blocks = bounce?.items.filter((item) => item.level === 'block' && (firewall.length > 0 || !isFirewallBlock(item.message))) ?? [];
  // 보안 판정 막힘으로 돌아왔으면 보안 요구사항 카드를 열어 둔다 (요구사항을 고쳐 풀리는 막힘이 있다: 허용 국가·키 소유)
  const secBlocked = blocks.some(isSecItem);
  const requirements = v2?.spec.security?.requirements ?? null;
  // 상품 대체 미리보기. 카드의 출발·도착 이름표(AWS·GCP)는 승인 화면과 같은 대응표 GET 에서 읽는다 (대체가 있을 때만)
  const substitutes = specSubstituteRows(view?.substitutions);
  const ends = usePoll(substitutes.length > 0 ? () => or404(api.planResources(migration.id)) : null, null, [migration.id, substitutes.length > 0]);

  // v2 판: 검토 칸을 PATCH confirm 으로 확인한 뒤(20개씩), 남은 칸이 없을 때만 POST /plan (T04 가 v2 검토 칸도 센다).
  // v1 판: 지금처럼 POST /plan 만 보낸다
  const confirm = async () => {
    if (!view) return;
    if (!v2) {
      await api.confirmSpec(migration.id);
      return;
    }
    let current: MigrationSpecViewV2 = view;
    for (const keys of confirmChunks(v2.review)) {
      current = await api.patchSpec(migration.id, specPatchBody(current, { confirm: keys }));
    }
    // 확인할 칸이 없는 AI 초안도 먼저 받아들인다. 서버 T04 는 받아들인 판만 세서, 초안 그대로 확정하면 "명세 없음"으로 막힌다
    if (current.source === 'ai_draft') current = await api.patchSpec(migration.id, specPatchBody(current, {}));
    // 확인한 뒤에도 검토 칸이 남았으면(그 사이 생긴 칸) 확정하지 않고 새 판을 보여 준다
    if ((current.needsReviewV2 ?? []).length > 0) {
      await spec.reload();
      return;
    }
    await api.confirmSpec(migration.id);
  };
  // 경계 밖 데이터 자원을 이 앱으로 끌어온다. 끌어온 자원은 새 검토 칸이 되어 확정 전에 한 번 더 본다
  // 아래 PATCH 셋도 확인처럼 specPatchBody 로 본문을 만든다 (AI 초안 판이면 acceptDraft 를 같이 실어야 서버가 받는다)
  const pull = (resource: string) =>
    run(async () => {
      if (!view) return;
      await api.patchSpec(migration.id, specPatchBody(view, { include: [resource] }));
      await spec.reload();
    });
  // 보안 요구사항 저장·지우기 (PATCH changes "security" 통째, null = 지움). 결과는 새 판 하나
  const saveSecurity = (value: SecuritySpecV2 | null) =>
    run(async () => {
      if (!view) return;
      await api.patchSpec(migration.id, specPatchBody(view, { changes: [{ path: 'security', value }] }));
      await spec.reload();
    });

  const decideFirewall = (subject: string) =>
    run(async () => {
      if (!view || !v2) return;
      await api.patchSpec(migration.id, specPatchBody(view, { changes: [{ path: 'posture', value: firewallDecision(v2.spec.posture, subject) }] }));
      await spec.reload();
    });

  const heroRows = v2 ? rowsV2.filter((row) => row.review) : [];
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={blocks.length > 0 ? 'stop' : 'run'}
        meta={blocks.length > 0 ? t('사전 점검에서 돌아옴') : t('명세 v{0}', { 0: view?.version ?? '' })}
        title={
          blocks.length > 0
            ? t('막힌 항목 {0}개를\n풀어야 합니다', { 0: blocks.length })
            : reviewCount > 0
              ? t('{0}칸을 확인하고\n확정해 주세요', { 0: reviewCount })
              : t('이 명세로\n옮길까요?')
        }
        foot={view?.source === 'ai_draft' ? t('AI가 추측한 초안입니다. 사람이 확정하기 전에는 계획에 쓰지 않습니다') : t('확정하면 사전 점검을 시작합니다')}
      >
        {blocks.map((item) => {
          const line = precheckLine(item);
          return (
            <div key={item.id} className={s.heroPanel}>
              <span className="t-label-md">{line.title}</span>
              {line.detail && <span className="t-body-sm">{line.detail}</span>}
              {item.fix && <span className="t-body-sm c-secondary">{item.fix}</span>}
            </div>
          );
        })}
        {blocks.length === 0 &&
          !v2 &&
          rows
            .filter((row) => row.review)
            .map((row) => (
              <div key={row.path} className={s.reviewRow}>
                <span className="t-label-md">{row.name}</span>
                <CodeValue value={row.value} size="md" max={32} className={s.rowValue} />
              </div>
            ))}
        {blocks.length === 0 &&
          heroRows.slice(0, HERO_REVIEW_ROWS).map((row) => (
            <div key={row.key} className={`${s.reviewRow} ${row.prose ? s.reviewRowStack : ''}`}>
              <span className="t-label-md">{row.name}</span>
              <ValueV2 row={row} className={s.rowValue} />
            </div>
          ))}
        {blocks.length === 0 && heroRows.length > HERO_REVIEW_ROWS && (
          <p className="t-body-md c-secondary">{t('외 {0}칸', { 0: heroRows.length - HERO_REVIEW_ROWS })}</p>
        )}
      </Hero>
      <Stack area="side">
        <FoldTile title={t('읽은 값')} summary={view ? t('{0}칸', { 0: v2 ? rowsV2.length : rows.length }) : t('읽는 중')}>
          {view && v2 ? (
            <ul className={s.rows}>
              {rowsV2.map((row) => (
                <li key={row.key}>
                  <div className={`${s.row} ${row.prose ? s.rowStack : ''}`}>
                    <span className={`${s.rowName} t-label-md ${row.review ? 'c-warning' : ''}`}>{row.name}</span>
                    <ValueV2 row={row} max={20} className={`${s.rowValue} c-secondary`} />
                  </div>
                  {row.provenance && <p className={`${s.rowCaption} t-caption c-tertiary`}>{row.provenance}</p>}
                </li>
              ))}
            </ul>
          ) : view ? (
            <ul className={s.rows}>
              {rows.map((row) => (
                <li key={row.path} className={s.row}>
                  <span className={`t-label-md ${row.review ? 'c-warning' : ''}`}>{row.name}</span>
                  <CodeValue value={row.value} className={`${s.rowValue} c-secondary`} />
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${s.note} t-body-sm c-secondary`}>{spec.loading ? t('명세를 읽고 있습니다.') : t('아직 명세가 없습니다.')}</p>
          )}
        </FoldTile>
        {firewall.length > 0 && (
          <FoldTile title={t('출발 방화벽')} summary={t('{0}개 정해야 함', { 0: firewall.length })}>
            <ul className={s.rows}>
              {firewall.map((row) => (
                <li key={row.subject}>
                  <div className={s.row}>
                    <span className="t-label-md c-warning">{row.subject}</span>
                  </div>
                  <p className={`${s.rowCaption} t-caption c-tertiary`}>{firewallReason(row)}</p>
                  <div className={s.rowAction}>
                    <BarPill label={row.kept.length > 0 ? t('허용 주소 {0}만 옮기기', { 0: row.kept.join(', ') }) : t('의존성 연결만 열기')} icon="check" onClick={busy ? undefined : () => void decideFirewall(row.subject)} />
                  </div>
                </li>
              ))}
            </ul>
            <p className={`${s.note} t-caption c-tertiary`}>{t('이 앱의 서비스가 쓰는 연결은 따로 엽니다. 도착으로 옮길 수 없는 허용 원본은 빼고, 허용 주소가 없는 공개 자원은 비공개로 둡니다.')}</p>
          </FoldTile>
        )}
        {substitutes.length > 0 && (
          <FoldTile title={t('상품 대체')} summary={t('{0}개', { 0: substitutes.length })}>
            <SubstituteMap rows={substitutes} source={ends.data?.source.provider ?? null} target={ends.data?.target.provider ?? null} />
          </FoldTile>
        )}
        {view && v2 && (
          <RequirementsFold
            key={`security-${secBlocked}`}
            requirements={requirements}
            version={view.version}
            busy={busy}
            defaultOpen={!requirements || secBlocked}
            onSave={(value) => void saveSecurity(value)}
          />
        )}
        {view && v2 && <SourceFactsFold facts={view.securityFacts} />}
        {accuracy && (
          <FoldTile title={t('가져오기 정확도')} summary={accuracy.summary} defaultOpen={false}>
            <ul className={s.rows}>
              {accuracy.rows.map((row) => (
                <li key={row.name} className={s.row}>
                  <span className="t-label-md">{row.name}</span>
                  <span className={`${s.rowValue} t-body-sm c-secondary`}>{row.value}</span>
                </li>
              ))}
              {accuracy.mismatches.map((row, index) => (
                <li key={`${index}:${row.name}`} className={s.row}>
                  <span className="t-label-md c-warning">{row.name}</span>
                  <span className={`${s.rowValue} t-body-sm c-secondary`}>{row.value || t('불일치')}</span>
                </li>
              ))}
            </ul>
            <p className={`${s.note} t-caption c-tertiary`}>{t('가져올 때 잰 값입니다. 명세를 고쳐도 다시 재지 않습니다.')}</p>
          </FoldTile>
        )}
        {boundary && (
          <FoldTile title={t('이 앱 밖 자원')} summary={boundary.length > 0 ? t('{0}개', { 0: boundary.length }) : t('없음')} defaultOpen={false}>
            {boundary.length > 0 ? (
              <>
                <ul className={s.rows}>
                  {boundary.map((item) => (
                    <li key={item.resource}>
                      <div className={s.row}>
                        <span className="t-label-md">{item.name}</span>
                        <span className={`${s.rowValue} t-caption c-tertiary`}>{item.kind}</span>
                      </div>
                      <p className={`${s.rowCaption} t-caption c-tertiary`}>{item.reason}</p>
                      {item.pullable && (
                        <div className={s.rowAction}>
                          <BarPill label={t('이 앱으로 가져오기')} icon="plus" onClick={busy ? undefined : () => void pull(item.resource)} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <p className={`${s.note} t-caption c-tertiary`}>{t('옮기지 않고 출발에 그대로 둡니다. DB·캐시·저장소·큐는 이 앱으로 가져올 수 있습니다.')}</p>
              </>
            ) : (
              <p className={`${s.note} t-body-sm c-secondary`}>{t('이 앱의 서비스·잡이 닿지 않는 자원이 없습니다.')}</p>
            )}
          </FoldTile>
        )}
        <ActionRow notice={error}>
          <ConfirmPill label={t('취소')} confirmLabel={t('마이그레이션 취소')} icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          <ActionPill
            label={v2 ? confirmLabel(busy, reviewCount, firewall.length) : busy ? t('보내는 중') : t('명세 확정')}
            icon="check"
            disabled={busy || !view || !canConfirmSpec(firewall.length)}
            onClick={() => void run(confirm)}
          />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function PreparingScreen({ migration, route }: ScreenProps) {
  const checking = migration.status === 'prechecking';
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="run"
        meta={LABEL[migration.status]}
        title={checking ? t('이 앱을\n옮길 수 있는지 봅니다') : t('계획서를\n만들고 있습니다')}
        foot={t('끝나면 계획서와 승인 버튼이 나옵니다')}
      />
    </Frame>
  );
}

// 승인 확인 항목 종류 (contracts PlanAckKind). 항목 글은 서버가 쓴 문장 그대로 보여 주고, 종류는 작게 붙인다
const ACK_KIND: Record<PlanAckKind, string> = {
  cost: t('비용'),
  failure_cost_policy: t('실패했을 때 비용'),
  runtime_change: t('실행 방식 바뀜'),
  build: t('도착에서 이미지 빌드'),
  precheck_warn: t('사전 점검 주의'),
  low_confidence: t('낮은 신뢰도'),
  tls_relaxed: t('평문 DB 연결'),
  host_access: t('노드 직접 사용'),
  public_bucket: t('공개 버킷'),
  provision_reuse: t('있는 자원 다시 씀'),
  env_layer_create: t('도착 클러스터 새로 만듦'),
  substitute: t('상품 대체'),
};

// 승인·시작이 이 코드로 막히면 계획서가 바뀌었거나 시간이 지난 것이다 → 계획서를 다시 읽고 체크는 새 지문에서 처음부터
const PLAN_CHANGED = ['PLAN_HASH_MISMATCH', 'PLAN_SUPERSEDED', 'ACKS_MISSING', 'PLAN_EXPIRED'];
const NO_TICKS: ReadonlySet<string> = new Set();

function ApproveScreen({ migration, route, onChanged }: ScreenProps) {
  const plan = usePoll(() => api.latestPlan(migration.id), null, [migration.id, migration.version]);
  const cost = usePoll(() => or404(api.migrationCost(migration.id)), null, [migration.id]);
  const resources = usePoll(() => or404(api.planResources(migration.id)), null, [migration.id]);
  const { busy, error, run } = useAction(
    () => {
      onChanged();
      void plan.reload();
    },
    (reason) => {
      if (!PLAN_CHANGED.includes(errorCode(reason) ?? '')) return;
      onChanged();
      void plan.reload();
    },
  );
  const doc = plan.data;
  // 체크는 계획 지문에 묶는다. 계획서가 바뀌면(새 지문) 처음부터 다시 체크한다
  const [ticked, setTicked] = useState<{ hash: string | null; ids: ReadonlySet<string> }>({ hash: null, ids: NO_TICKS });
  const ticks = doc && ticked.hash === doc.planHash ? ticked.ids : NO_TICKS;
  const acks = ackState(doc?.acknowledgements, ticks);
  const tick = (id: string, on: boolean) => {
    if (!doc) return;
    const next = new Set(ticks);
    if (on) next.add(id);
    else next.delete(id);
    setTicked({ hash: doc.planHash, ids: next });
  };
  const planCost = doc?.costSummary;
  const pair = cost.data?.pair;
  // 보안 판정(SEC:*)은 따로 단계별 카드로 본다. 사전 점검 카드에는 나머지 점검만
  const checks = doc?.precheck.filter((item) => !isSecItem(item)) ?? [];
  const warns = checks.filter((item) => item.level !== 'info').length;
  const expired = doc ? Date.parse(doc.expiresAt) <= Date.now() : false;
  const mapped = planResourceRows(resources.data);
  // 확인 항목마다 확인하는 자리는 하나다: 상품 대체는 큰 카드의 대응 줄, 나머지는 "승인 전에 확인" 목록. 승인 버튼은 둘을 합쳐 센다(acks)
  const places = ackPlaces(doc?.acknowledgements);
  const listLeft = places.list.filter((ack) => !ticks.has(ack.id)).length;
  // 상품 대체가 있으면 큰 카드 본문은 대응 줄이 차지하고, 계획 지문은 머리줄 오른쪽 끝으로 올린다
  const substituting = places.substitutes.length > 0;
  const hash = doc && <CodeValue value={doc.planHash} chip max={substituting ? 24 : 32} />;

  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={expired ? 'stop' : 'run'}
        meta={t('계획서')}
        title={expired ? t('승인 시간이\n지났습니다') : acks.missing.length > 0 ? t('확인할 것 {0}개를 보고\n승인해 주세요', { 0: acks.missing.length }) : t('승인하면 이대로\n바로 실행합니다')}
        foot={doc ? t('유효 시각 {0}', { 0: new Date(doc.expiresAt).toLocaleString(localeTag(), { hour12: false }) }) : undefined}
        action={substituting && hash}
      >
        {substituting && (
          <SubstituteMap
            rows={places.substitutes}
            source={resources.data?.source.provider ?? null}
            target={resources.data?.target.provider ?? null}
            confirm={{ checked: ticks, disabled: busy || expired, onToggle: (id) => tick(id, !ticks.has(id)) }}
          />
        )}
        {!substituting && hash}
        {doc && (
          <p className="t-body-md c-secondary">
            {t('오류율이 {0}%를 넘거나 응답 시간이 {1}배를 넘으면 자동으로 되돌립니다', { 0: doc.rollbackCriteria.errorRatePct, 1: doc.rollbackCriteria.p95Multiplier })}
          </p>
        )}
      </Hero>
      <Stack area="side">
        {doc && places.list.length > 0 && (
          <FoldTile title={t('승인 전에 확인')} summary={listLeft > 0 ? t('{0}개 남음', { 0: listLeft }) : t('모두 확인함')}>
            <ul className={s.rows}>
              {places.list.map((ack) => (
                <li key={ack.id}>
                  <label className={`${s.ack} t-body-sm`}>
                    <input type="checkbox" checked={ticks.has(ack.id)} disabled={busy || expired} onChange={(event) => tick(ack.id, event.target.checked)} />
                    <span className={s.ackText}>
                      <span className="t-caption c-tertiary">{secAckLabel(ack) ?? ACK_KIND[ack.kind] ?? ack.kind}</span>
                      <span>{ack.text}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </FoldTile>
        )}
        <FoldTile title={t('월 비용')} summary={planCost ? planCostSummary(planCost) : cost.data ? costSummary(cost.data) : t('읽는 중')}>
          <div className={s.costLine}>
            <span className="t-metric-lg">{usd(planCost ? planCost.monthlySource : pair?.sourceMonthlyUsd)}</span>
            <Icon name="arrow-right" />
            <span className="t-metric-lg">{usd(planCost ? planCost.monthlyTarget : pair?.targetMonthlyUsd)}</span>
          </div>
          {(planCost ? planCostCaveats(planCost) : cost.data ? costCaveats(cost.data) : []).map((line) => (
            <p key={line} className={`${s.note} t-body-sm c-warning`}>{line}</p>
          ))}
          <p className={`${s.note} t-body-sm c-secondary`}>{costNote(planCost?.priceAsOf)}</p>
          <div className={s.note}>
            <BarPill label={t('비용 자세히')} icon="chevron" onClick={() => go(`migrations/${migration.id}/cost`)} />
          </div>
        </FoldTile>
        <FoldTile title={t('실행 단계')} summary={doc ? t('{0}단계', { 0: doc.steps.length }) : t('읽는 중')}>
          <ul className={s.rows}>
            {doc?.steps.map((step) => (
              <li key={step.id} className={s.row}>
                <span className="t-label-md">{stepName(step.id)}</span>
                <span className={`${s.rowValue} t-caption c-tertiary`}>{stepGate(step)}</span>
              </li>
            ))}
          </ul>
        </FoldTile>
        <FoldTile key={`precheck-${warns > 0}`} title={t('사전 점검')} summary={warns > 0 ? t('확인 {0}건', { 0: warns }) : t('{0}건', { 0: checks.length })} defaultOpen={warns > 0}>
          <ul className={s.rows}>
            {checks.map((item) => (
              <li key={item.id} className={s.row}>
                <span className="t-body-sm">{item.message}</span>
                <Badge tone={LEVEL[item.level].tone}>{LEVEL[item.level].label}</Badge>
              </li>
            ))}
          </ul>
        </FoldTile>
        {doc && <VerdictFold items={doc.precheck} />}
        <FoldTile
          title={t('자원 대응')}
          summary={resources.data ? t('{0}개{1}', { 0: mapped.listed.length, 1: [
            substituting ? t(' · 상품 대체 {0}', { 0: places.substitutes.length }) : '',
            mapped.runtimeChanges > 0 ? t(' · 실행 방식 바뀜 {0}', { 0: mapped.runtimeChanges }) : '',
          ].join('') }) : ''}
          defaultOpen={false}
        >
          <ul className={s.rows}>
            {mapped.listed.map(({ key, row }) => (
              <li key={key}>
                <div className={s.row}>
                  <span className="t-label-md">{row.label}</span>
                  <span className={`${s.rowValue} t-caption c-tertiary`}>
                    {row.source?.service ?? t('없음')} → {row.target?.service ?? t('없음')}
                  </span>
                </div>
                {runtimeChangeNote(row) && <p className={`${s.rowCaption} t-caption c-warning`}>{runtimeChangeNote(row)}</p>}
              </li>
            ))}
          </ul>
          {/* 경계 밖 자원은 옮기는 자원이 아니라 "건드리지 않는 것" 안내라 표 밖에 한 줄로 둔다 */}
          {mapped.boundary && (
            <p className={`${s.note} t-caption c-tertiary`}>
              {mapped.boundary.label} · {mapped.boundary.afterSource ?? t('옮기지 않음')}
            </p>
          )}
        </FoldTile>
        <SecurityFold migration={migration} />
        <ActionRow notice={error ?? (plan.error != null && !doc ? errorText(plan.error) : null)}>
          <ConfirmPill label={t('취소')} confirmLabel={t('마이그레이션 취소')} icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          {doc && <ConfirmPill label={t('거절')} confirmLabel={t('계획 거절')} icon="ban" disabled={busy} onConfirm={() => void run(() => api.decide(doc.planId, 'reject', doc.planHash))} />}
          <ActionPill
            label={approveLabel({ busy, expired, missing: acks.missing.length })}
            icon="check"
            disabled={busy || !doc || expired || !acks.ready}
            onClick={() =>
              doc &&
              void run(async () => {
                // 승인하면 바로 실행을 시작한다(버튼 한 번). 시작이 막히면 승인은 그대로 두고 실행 대기 화면이 이유를 이어 받는다
                autoStart.begin(migration.id);
                let blockedBy: string | null = null;
                try {
                  await api.decide(doc.planId, 'approve', doc.planHash, acks.ids);
                  try {
                    await api.start(migration.id, doc.planHash);
                  } catch (reason) {
                    blockedBy = errorCode(reason) ?? 'START_FAILED';
                    throw reason;
                  }
                } finally {
                  autoStart.end(migration.id, blockedBy);
                  if (blockedBy) onChanged();
                }
              })
            }
          />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function ApprovedScreen({ migration, route, onChanged }: ScreenProps) {
  const plan = usePoll(() => or404(api.latestPlan(migration.id)), null, [migration.id]);
  const { busy, error, code, run } = useAction(onChanged, (reason) => {
    if (errorCode(reason) === 'PLAN_HASH_MISMATCH') void plan.reload();
  });
  const doc = plan.data;
  const expired = doc ? Date.parse(doc.expiresAt) <= Date.now() : false;
  // 승인 화면이 승인하고 바로 시작하다 막혔으면 그 이유를 이어 받는다. 이 화면에서 다시 누르면 그 결과를 본다
  // TENANT_BUSY: 회사 동시 진행 상한. 이전은 승인 상태 그대로라 계획이 유효한 동안 다시 시작할 수 있다
  // ENV_BUSY: 다른 이전이 같은 환경을 쓰는 중
  const blockedBy = code ?? (busy || error ? null : autoStart.blockedCode(migration.id));
  const waiting = blockedBy === 'TENANT_BUSY' ? 'tenant' : blockedBy === 'ENV_BUSY' ? 'env' : null;
  const until = doc ? new Date(doc.expiresAt).toLocaleString(localeTag(), { hour12: false }) : null;
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={waiting ? 'stop' : 'run'}
        meta={waiting === 'tenant' ? t('동시 진행 상한') : waiting === 'env' ? t('환경 사용 중') : t('승인됨')}
        title={
          waiting === 'tenant'
            ? t('진행 중인 마이그레이션이 많아\n아직 시작하지 않았습니다')
            : waiting === 'env'
              ? t('다른 마이그레이션이\n환경을 쓰고 있습니다')
              : t('승인했습니다.\n실행을 시작해 주세요')
        }
        foot={
          waiting === 'tenant'
            ? expired
              ? t('계획 유효 시간이 지나 다시 시작할 수 없습니다')
              : t('승인은 그대로입니다. {0}까지 다시 시작할 수 있습니다', { 0: until ?? t('유효 시각') })
            : t('이 지문의 계획만 실행합니다')
        }
      >
        {doc && <CodeValue value={doc.planHash} chip max={32} />}
      </Hero>
      <Stack area="side">
        <SecurityFold migration={migration} />
        <ActionRow notice={waiting ? null : error}>
          <ConfirmPill label={t('취소')} confirmLabel={t('마이그레이션 취소')} icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          {!(waiting && expired) && (
            <ActionPill
              label={busy ? t('보내는 중') : waiting ? t('다시 시작') : t('실행 시작')}
              icon="play"
              disabled={busy || plan.loading}
              onClick={() => void run(() => api.start(migration.id, doc?.planHash))}
            />
          )}
        </ActionRow>
      </Stack>
    </Frame>
  );
}

const STOPPED: Record<'rejected' | 'stale', { meta: string; title: string; foot: string; next: string }> = {
  rejected: {
    meta: t('거절'),
    title: t('고객 환경에는\n아무것도 안 바꿨습니다'),
    foot: t('거절한 사람을 감사 기록에 남겼습니다'),
    next: t('같은 명세로 계획을 다시 만들거나, 명세부터 고칩니다. 그만두려면 이 마이그레이션을 끝냅니다.'),
  },
  stale: {
    meta: t('낡은 계획'),
    title: t('승인 시간이\n지났습니다'),
    foot: t('본 것과 다른 내용이 실행되지 않도록 막았습니다'),
    next: t('계획을 다시 만들어 새 계획서로 승인합니다. 그만두려면 이 마이그레이션을 끝냅니다.'),
  },
};

function StoppedScreen({ migration, route, onChanged, kind }: ScreenProps & { kind: 'rejected' | 'stale' }) {
  const { busy, error, run } = useAction(onChanged);
  const copy = STOPPED[kind];
  const replan = canReplan(migration);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="stop" meta={copy.meta} title={copy.title} foot={copy.foot} />
      <Stack area="side">
        <FoldTile title={t('다음에 할 일')}>
          <p className={`${s.note} t-body-md c-secondary`}>{replan ? copy.next : t('이 마이그레이션을 끝내고 새로 시작해 주세요.')}</p>
        </FoldTile>
        <SecurityFold migration={migration} />
        <ActionRow notice={error}>
          {replan ? (
            <>
              <ConfirmPill label={t('이 마이그레이션 끝내기')} confirmLabel={t('마이그레이션 끝내기')} icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
              {/* TODO(human): 거절 뒤 주 행동을 "계획 다시 만들기"로 둘지 "명세부터 고치기"로 둘지. 지금은 다시 계획하기가 주 행동 */}
              {kind === 'rejected' && (
                <BarPill label={t('명세부터 고치기')} icon="list" onClick={busy ? undefined : () => void run(() => api.reopenSpec(migration.id))} />
              )}
              <ActionPill label={busy ? t('보내는 중') : t('계획 다시 만들기')} icon="refresh" disabled={busy} onClick={() => void run(() => api.replan(migration.id))} />
            </>
          ) : (
            <ActionPill label={busy ? t('보내는 중') : t('이 마이그레이션 끝내기')} icon="x" disabled={busy} onClick={() => void run(() => api.cancel(migration.id))} />
          )}
        </ActionRow>
      </Stack>
    </Frame>
  );
}

// 실패 지점별 "다시 시도" 글자와 큰 카드 아래 한 줄. failure-decision retry 가 그 단계 작업을 다시 넣는다 (apps/api control.ts RETRY_QUEUE)
const RETRY: Record<RetryStage, { label: string; foot: string }> = {
  importing: { label: t('다시 가져오기'), foot: t('출발 환경을 고친 뒤 다시 가져오거나, 끝내고 범위를 바꿔 새로 만듭니다') },
  prechecking: { label: t('다시 점검'), foot: t('고친 뒤 사전 점검부터 다시 합니다') },
  planning: { label: t('계획 다시 만들기'), foot: t('계획을 다시 만들면 승인부터 다시 합니다') },
  provisioning: { label: t('자원 만들기 다시 시도'), foot: t('승인한 계획 그대로 도착 자원 만들기를 다시 합니다') },
};

function FailedScreen({ migration, route, onChanged }: ScreenProps) {
  const { busy, error, code, run } = useAction(onChanged);
  const consent = useCostConsent(code);
  const review = useAgentReview(migration.id);
  const analysis = failureAnalysisOf(review.data);
  // 서버가 실패 전이에 남긴 이유 (감사 detail.error). 사유 코드 문장만으로는 무엇을 고칠지 모를 때가 많다
  const timeline = usePoll(() => or404(api.timeline(migration.id)), null, [migration.id, migration.version]);
  const why = timeline.data ? failureDetail(timeline.data.items) : null;
  const [cleaned, setCleaned] = useState(false);
  const reason = stopReasonOf(migration.failureCode, migration.status);
  // 가져오기·점검·계획·자원 만들기에서 실패했으면 그 단계부터 다시 할 수 있다. 아니면 지금처럼 정리 확인 뒤 끝내는 길만
  const { retry, nothingMade } = failureChoices(migration);
  // DRAFT(ai): 만든 자원이 없는 실패(가져오기·점검·계획)는 끝내고 새 마이그레이션 화면으로 보낸다. 출발 범위를 바꿔 다시 만드는 것이 다음 할 일이다
  const endAndStartOver = () =>
    run(async () => {
      await api.failureDecision(migration.id, 'rollback');
      go('migrations/new');
    });
  const stop = reason && (
    <StopFold
      key={analysis ? 'analysis' : 'plain'}
      migration={migration}
      reason={reason}
      into="failed"
      hint={false}
      defaultOpen={analysis !== null}
      analysis={analysis}
    />
  );
  // 만든 자원이 없는 실패는 정리할 것이 없어 "정리했습니다" 확인을 두지 않는다
  const leftover = nothingMade ? null : (
    <LeftoverFold migration={migration} title={t('끝내기 전에')}>
      <label className={`${s.check} t-body-md`}>
        <input type="checkbox" checked={cleaned} onChange={(event) => setCleaned(event.target.checked)} />
        {t('남은 자원을 정리했습니다')}
      </label>
    </LeftoverFold>
  );
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="stop"
        meta={migration.failedAtStatus ? t('{0}에서 실패', { 0: LABEL[migration.failedAtStatus] }) : t('실패')}
        title={reason?.title ?? t('작업이\n끝나지 못했습니다')}
        foot={retry ? RETRY[retry].foot : t('남은 자원을 직접 정리한 뒤 이 마이그레이션을 끝냅니다')}
      >
        {(reason || why) && (
          <div className={s.heroPanel}>
            {reason && <span className="t-body-md">{reason.hint}</span>}
            {/* 서버 글은 데이터로만 그린다 (React 가 글자로 넣는다) */}
            {why && <span className="t-body-sm c-secondary">{t('서버가 남긴 이유: {0}', { 0: why })}</span>}
          </div>
        )}
      </Hero>
      <Stack area="side">
        {retry ? stop : leftover}
        {retry ? leftover : stop}
        <SecurityFold migration={migration} />
        <ActionRow notice={retry ? consent.notice(error) : error} before={retry ? consent.check : null}>
          {retry ? (
            <>
              {nothingMade ? (
                <ConfirmPill label={t('끝내고 새로 만들기')} confirmLabel={t('이 마이그레이션 끝내기')} icon="x" disabled={busy} onConfirm={() => void endAndStartOver()} />
              ) : (
                cleaned && (
                  <ConfirmPill label={t('이 마이그레이션 끝내기')} confirmLabel={t('정리했고 끝내기')} icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id, true))} />
                )
              )}
              <ActionPill
                label={busy ? t('보내는 중') : consent.accept ? t('고객 부담으로 다시 시도') : RETRY[retry].label}
                icon="refresh"
                disabled={busy || consent.waiting}
                onClick={() => void run(() => api.failureDecision(migration.id, 'retry', consent.accept))}
              />
            </>
          ) : (
            <ActionPill label={busy ? t('보내는 중') : t('이 마이그레이션 끝내기')} icon="x" disabled={busy || !cleaned} onClick={() => void run(() => api.cancel(migration.id, true))} />
          )}
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function CancelledScreen({ migration, route }: ScreenProps) {
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta={t('취소')} title={t('이 마이그레이션은\n여기서 끝났습니다')} foot={t('환경 잠금을 풀었습니다')} />
      <Stack area="side">
        <LeftoverFold migration={migration} title={t('도착에 남은 자원')} />
        <SecurityFold migration={migration} />
      </Stack>
    </Frame>
  );
}

/** 승인하고 바로 시작하는 사이에 잠깐 보이는 approved 는 승인 화면에 둔다 (시작이 끝나면 실행 화면으로) */
const screenFor = (migration: MigrationView): MigrationScreen =>
  migration.status === 'approved' && autoStart.isStarting(migration.id) ? 'approve' : screenOf(migration.status);

const SCREENS: Record<Exclude<MigrationScreen, 'rejected' | 'stale'>, (props: ScreenProps) => ReactNode> = {
  importing: ImportingScreen,
  spec: SpecScreen,
  preparing: PreparingScreen,
  approve: ApproveScreen,
  approved: ApprovedScreen,
  failed: FailedScreen,
  cancelled: CancelledScreen,
  running: RunningScreen,
  window: WindowScreen,
  paused: PausedScreen,
  rollingBack: RollingBackScreen,
  rolledBack: RolledBackScreen,
  cleanup: CleanupScreen,
  done: DoneScreen,
};

export function MigrationPage({ id }: { id: string }) {
  const [status, setStatus] = useState<MigrationView['status'] | undefined>();
  // 워커 단계는 신호가 살아 있어도 빠른 간격 그대로 (signalCovers). 사람 차례만 신호에 맡기고 간격을 늘린다
  const poll = usePoll(() => api.getMigration(id), pollMs(status), [id], {
    keepOnError: false,
    signal: aboutMigration(id),
    liveFloor: signalCovers(status),
  });
  const envs = usePoll(api.listEnvironments, null, []);

  // 화면이 바뀔 때만 카드를 움직인다. 같은 화면 안의 갱신은 그대로 둔다.
  const [shown, setShown] = useState<MigrationView | null>(null);
  const shownScreen = useRef<MigrationScreen | null>(null);
  useEffect(() => {
    const next = poll.data;
    if (!next) return;
    setStatus(next.status);
    const screen = screenFor(next);
    // 처음 읽은 화면도 전환으로 들인다. 읽는 동안은 근거 칸이 없어서, 근거 칸이 있는 화면이면 칸이 열리는 것이 보인다
    const moved = shownScreen.current !== screen;
    shownScreen.current = screen;
    if (moved) withTransition(() => setShown(next));
    else setShown(next);
  }, [poll.data]);

  if (!shown) {
    const missing = is404(poll.error);
    return (
      <Frame route={t('마이그레이션')}>
        <Hero
          tone={poll.error ? 'stop' : 'run'}
          meta={t('마이그레이션')}
          title={poll.error ? (missing ? t('이 마이그레이션을\n찾을 수 없습니다') : t('마이그레이션을\n읽지 못했습니다')) : t('마이그레이션을\n읽고 있습니다')}
        />
      </Frame>
    );
  }

  const name = (envId: string) => envs.data?.find((env) => env.id === envId)?.name ?? envId.slice(0, 8);
  const props: ScreenProps = {
    migration: shown,
    // 출발 범위를 골라 만든 이전은 무엇을 옮기는지 앞에 붙인다 (비었으면 자동으로 고른 것이라 붙이지 않음)
    route: `${shown.sourceScope && Object.keys(shown.sourceScope).length > 0 ? `${scopeLabel(shown.sourceScope)} · ` : ''}${name(shown.sourceEnvId)} → ${name(shown.targetEnvId)}`,
    onChanged: () => void poll.reload(),
  };
  const screen = screenFor(shown);
  if (screen === 'rejected' || screen === 'stale') return <StoppedScreen {...props} kind={screen} />;
  const Screen = SCREENS[screen];
  return <Screen {...props} />;
}

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
import { planResourceRows, runtimeChangeNote } from '../../lib/resourceMap';
import { LABEL } from '../../lib/status';
import { lastPrecheckBounce } from '../../lib/timelineDetail';
import type { MigrationView, PlanAckKind, PrecheckItem } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { useAgentReview } from '../agent/AgentResult';
import { failureAnalysisOf } from '../agent/model';
import { costCaveats, costNote, costSummary, planCostCaveats, planCostSummary } from '../cost/model';
import {
  ackState, approveLabel, canReplan, pollMs, screenOf, signalCovers, specRows, stepGate, stepName, usd, type MigrationScreen,
} from './model';
import {
  accuracyView, boundaryRows, confirmChunks, confirmLabel, specRowsV2, specV2Of, type MigrationSpecViewV2, type SpecRowV2,
} from './specV2';
import { LeftoverFold, StopFold } from './EvidenceFolds';
import { DoneScreen, CleanupScreen, PausedScreen, RolledBackScreen, RollingBackScreen, RunningScreen, WindowScreen } from './RunScreens';
import { RequirementsFold, SourceFactsFold, VerdictFold } from './SecurityFolds';
import { isSecItem, precheckLine, secAckLabel, type SecuritySpecV2 } from './securityV2';
import { ConfirmPill, Frame, useAction, useCostConsent, type ScreenProps } from './shared';
import s from '../common/page.module.css';

const LEVEL: Record<PrecheckItem['level'], { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  block: { label: '막힘', tone: 'danger' },
  warn: { label: '주의', tone: 'warning' },
  info: { label: '참고', tone: 'neutral' },
};

function ImportingScreen({ migration, route }: ScreenProps) {
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta="구성 읽기" title={'운영 중인 앱을\n읽고 있습니다'} foot="읽기만 합니다. 아무것도 바꾸지 않습니다" />
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
  const blocks = bounce?.items.filter((item) => item.level === 'block') ?? [];
  // 보안 판정 막힘으로 돌아왔으면 보안 요구사항 카드를 열어 둔다 (요구사항을 고쳐 풀리는 막힘이 있다: 허용 국가·키 소유)
  const secBlocked = blocks.some(isSecItem);
  const requirements = v2?.spec.security?.requirements ?? null;

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
      current = await api.patchSpec(migration.id, {
        baseVersion: current.version,
        confirm: keys,
        ...(current.source === 'ai_draft' ? { acceptDraft: current.version } : {}),
      });
    }
    // 확인한 뒤에도 검토 칸이 남았으면(그 사이 생긴 칸) 확정하지 않고 새 판을 보여 준다
    if ((current.needsReviewV2 ?? []).length > 0) {
      await spec.reload();
      return;
    }
    await api.confirmSpec(migration.id);
  };
  // 경계 밖 데이터 자원을 이 앱으로 끌어온다. 끌어온 자원은 새 검토 칸이 되어 확정 전에 한 번 더 본다
  const pull = (resource: string) =>
    run(async () => {
      if (!view) return;
      await api.patchSpec(migration.id, { baseVersion: view.version, include: [resource] });
      await spec.reload();
    });
  // 보안 요구사항 저장·지우기 (PATCH changes "security" 통째, null = 지움). 결과는 새 판 하나
  const saveSecurity = (value: SecuritySpecV2 | null) =>
    run(async () => {
      if (!view) return;
      await api.patchSpec(migration.id, { baseVersion: view.version, changes: [{ path: 'security', value }] });
      await spec.reload();
    });

  const heroRows = v2 ? rowsV2.filter((row) => row.review) : [];
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={blocks.length > 0 ? 'stop' : 'run'}
        meta={blocks.length > 0 ? '사전 점검에서 돌아옴' : `명세 v${view?.version ?? ''}`}
        title={
          blocks.length > 0
            ? `막힌 항목 ${blocks.length}개를\n풀어야 합니다`
            : reviewCount > 0
              ? `${reviewCount}칸을 확인하고\n확정해 주세요`
              : '이 명세로\n옮길까요?'
        }
        foot={view?.source === 'ai_draft' ? 'AI가 추측한 초안입니다. 사람이 확정하기 전에는 계획에 쓰지 않습니다' : '확정하면 사전 점검을 시작합니다'}
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
          <p className="t-body-md c-secondary">외 {heroRows.length - HERO_REVIEW_ROWS}칸</p>
        )}
      </Hero>
      <Stack area="side">
        <FoldTile title="읽은 값" summary={view ? `${v2 ? rowsV2.length : rows.length}칸` : '읽는 중'}>
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
            <p className={`${s.note} t-body-sm c-secondary`}>{spec.loading ? '명세를 읽고 있습니다.' : '아직 명세가 없습니다.'}</p>
          )}
        </FoldTile>
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
          <FoldTile title="가져오기 정확도" summary={accuracy.summary} defaultOpen={false}>
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
                  <span className={`${s.rowValue} t-body-sm c-secondary`}>{row.value || '불일치'}</span>
                </li>
              ))}
            </ul>
            <p className={`${s.note} t-caption c-tertiary`}>가져올 때 잰 값입니다. 명세를 고쳐도 다시 재지 않습니다.</p>
          </FoldTile>
        )}
        {boundary && (
          <FoldTile title="이 앱 밖 자원" summary={boundary.length > 0 ? `${boundary.length}개` : '없음'} defaultOpen={false}>
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
                          <BarPill label="이 앱으로 가져오기" icon="plus" onClick={busy ? undefined : () => void pull(item.resource)} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <p className={`${s.note} t-caption c-tertiary`}>옮기지 않고 출발에 그대로 둡니다. DB·캐시·저장소·큐는 이 앱으로 가져올 수 있습니다.</p>
              </>
            ) : (
              <p className={`${s.note} t-body-sm c-secondary`}>이 앱의 서비스·잡이 닿지 않는 자원이 없습니다.</p>
            )}
          </FoldTile>
        )}
        <ActionRow notice={error}>
          <ConfirmPill label="취소" confirmLabel="이전 취소" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          <ActionPill label={v2 ? confirmLabel(busy, reviewCount) : busy ? '보내는 중' : '명세 확정'} icon="check" disabled={busy || !view} onClick={() => void run(confirm)} />
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
        title={checking ? '이 앱을\n옮길 수 있는지 봅니다' : '계획서를\n만들고 있습니다'}
        foot="끝나면 계획서와 승인 버튼이 나옵니다"
      />
    </Frame>
  );
}

// 승인 확인 항목 종류 (contracts PlanAckKind). 항목 글은 서버가 쓴 문장 그대로 보여 주고, 종류는 작게 붙인다
const ACK_KIND: Record<PlanAckKind, string> = {
  cost: '비용',
  failure_cost_policy: '실패했을 때 비용',
  runtime_change: '실행 방식 바뀜',
  build: '도착에서 이미지 빌드',
  precheck_warn: '사전 점검 주의',
  low_confidence: '낮은 신뢰도',
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

  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={expired ? 'stop' : 'run'}
        meta="계획서"
        title={expired ? '승인 시간이\n지났습니다' : acks.missing.length > 0 ? `확인할 것 ${acks.missing.length}개를 보고\n승인해 주세요` : '승인하면\n이대로만 실행합니다'}
        foot={doc ? `유효 시각 ${new Date(doc.expiresAt).toLocaleString('ko-KR', { hour12: false })}` : undefined}
      >
        {doc && <CodeValue value={doc.planHash} chip max={32} />}
        {doc && (
          <p className="t-body-md c-secondary">
            오류율이 {doc.rollbackCriteria.errorRatePct}%를 넘거나 응답 시간이 {doc.rollbackCriteria.p95Multiplier}배를 넘으면 자동으로 되돌립니다
          </p>
        )}
      </Hero>
      <Stack area="side">
        {doc && acks.total > 0 && (
          <FoldTile title="승인 전에 확인" summary={acks.missing.length > 0 ? `${acks.missing.length}개 남음` : '모두 확인함'}>
            <ul className={s.rows}>
              {(doc.acknowledgements ?? []).map((ack) => (
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
        <FoldTile title="월 비용" summary={planCost ? planCostSummary(planCost) : cost.data ? costSummary(cost.data) : '읽는 중'}>
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
            <BarPill label="비용 자세히" icon="chevron" onClick={() => go(`migrations/${migration.id}/cost`)} />
          </div>
        </FoldTile>
        <FoldTile title="실행 단계" summary={doc ? `${doc.steps.length}단계` : '읽는 중'}>
          <ul className={s.rows}>
            {doc?.steps.map((step) => (
              <li key={step.id} className={s.row}>
                <span className="t-label-md">{stepName(step.id)}</span>
                <span className={`${s.rowValue} t-caption c-tertiary`}>{stepGate(step)}</span>
              </li>
            ))}
          </ul>
        </FoldTile>
        <FoldTile key={`precheck-${warns > 0}`} title="사전 점검" summary={warns > 0 ? `확인 ${warns}건` : `${checks.length}건`} defaultOpen={warns > 0}>
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
          title="자원 대응"
          summary={resources.data ? `${mapped.listed.length}개${mapped.runtimeChanges > 0 ? ` · 실행 방식 바뀜 ${mapped.runtimeChanges}` : ''}` : ''}
          defaultOpen={false}
        >
          <ul className={s.rows}>
            {mapped.listed.map(({ key, row }) => (
              <li key={key}>
                <div className={s.row}>
                  <span className="t-label-md">{row.label}</span>
                  <span className={`${s.rowValue} t-caption c-tertiary`}>
                    {row.source?.service ?? '없음'} → {row.target?.service ?? '없음'}
                  </span>
                </div>
                {runtimeChangeNote(row) && <p className={`${s.rowCaption} t-caption c-warning`}>{runtimeChangeNote(row)}</p>}
              </li>
            ))}
          </ul>
          {/* 경계 밖 자원은 옮기는 자원이 아니라 "건드리지 않는 것" 안내라 표 밖에 한 줄로 둔다 */}
          {mapped.boundary && (
            <p className={`${s.note} t-caption c-tertiary`}>
              {mapped.boundary.label} · {mapped.boundary.afterSource ?? '옮기지 않음'}
            </p>
          )}
        </FoldTile>
        <ActionRow notice={error ?? (plan.error != null && !doc ? errorText(plan.error) : null)}>
          <ConfirmPill label="취소" confirmLabel="이전 취소" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          {doc && <ConfirmPill label="거절" confirmLabel="계획 거절" icon="ban" disabled={busy} onConfirm={() => void run(() => api.decide(doc.planId, 'reject', doc.planHash))} />}
          <ActionPill
            label={approveLabel({ busy, expired, missing: acks.missing.length })}
            icon="check"
            disabled={busy || !doc || expired || !acks.ready}
            onClick={() => doc && void run(() => api.decide(doc.planId, 'approve', doc.planHash, acks.ids))}
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
  // TENANT_BUSY: 회사 동시 진행 상한. 이전은 승인 상태 그대로라 계획이 유효한 동안 다시 시작할 수 있다
  // ENV_BUSY: 다른 이전이 같은 환경을 쓰는 중
  const waiting = code === 'TENANT_BUSY' ? 'tenant' : code === 'ENV_BUSY' ? 'env' : null;
  const until = doc ? new Date(doc.expiresAt).toLocaleString('ko-KR', { hour12: false }) : null;
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={waiting ? 'stop' : 'run'}
        meta={waiting === 'tenant' ? '동시 진행 상한' : waiting === 'env' ? '환경 사용 중' : '승인됨'}
        title={
          waiting === 'tenant'
            ? '진행 중인 이전이 많아\n아직 시작하지 않았습니다'
            : waiting === 'env'
              ? '다른 이전이\n환경을 쓰고 있습니다'
              : '승인했습니다.\n버튼 하나만 남았습니다'
        }
        foot={
          waiting === 'tenant'
            ? expired
              ? '계획 유효 시간이 지나 다시 시작할 수 없습니다'
              : `승인은 그대로입니다. ${until ?? '유효 시각'}까지 다시 시작할 수 있습니다`
            : '이 지문의 계획만 실행합니다'
        }
      >
        {doc && <CodeValue value={doc.planHash} chip max={32} />}
      </Hero>
      <Stack area="side">
        <ActionRow notice={waiting ? null : error}>
          <ConfirmPill label="취소" confirmLabel="이전 취소" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          {!(waiting && expired) && (
            <ActionPill
              label={busy ? '보내는 중' : waiting ? '다시 시작' : '실행 시작'}
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
    meta: '거절',
    title: '고객 환경에는\n아무것도 안 바꿨습니다',
    foot: '거절한 사람을 감사 기록에 남겼습니다',
    next: '같은 명세로 계획을 다시 만들거나, 명세부터 고칩니다. 그만두려면 이 이전을 끝냅니다.',
  },
  stale: {
    meta: '낡은 계획',
    title: '승인 시간이\n지났습니다',
    foot: '본 것과 다른 내용이 실행되지 않도록 막았습니다',
    next: '계획을 다시 만들어 새 계획서로 승인합니다. 그만두려면 이 이전을 끝냅니다.',
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
        <FoldTile title="다음에 할 일">
          <p className={`${s.note} t-body-md c-secondary`}>{replan ? copy.next : '이 이전을 끝내고 새로 시작해 주세요.'}</p>
        </FoldTile>
        <ActionRow notice={error}>
          {replan ? (
            <>
              <ConfirmPill label="이 이전 끝내기" confirmLabel="이전 끝내기" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
              {/* TODO(human): 거절 뒤 주 행동을 "계획 다시 만들기"로 둘지 "명세부터 고치기"로 둘지. 지금은 다시 계획하기가 주 행동 */}
              {kind === 'rejected' && (
                <BarPill label="명세부터 고치기" icon="list" onClick={busy ? undefined : () => void run(() => api.reopenSpec(migration.id))} />
              )}
              <ActionPill label={busy ? '보내는 중' : '계획 다시 만들기'} icon="refresh" disabled={busy} onClick={() => void run(() => api.replan(migration.id))} />
            </>
          ) : (
            <ActionPill label={busy ? '보내는 중' : '이 이전 끝내기'} icon="x" disabled={busy} onClick={() => void run(() => api.cancel(migration.id))} />
          )}
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function FailedScreen({ migration, route, onChanged }: ScreenProps) {
  const { busy, error, code, run } = useAction(onChanged);
  const consent = useCostConsent(code);
  const review = useAgentReview(migration.id);
  const analysis = failureAnalysisOf(review.data);
  const [cleaned, setCleaned] = useState(false);
  const reason = stopReasonOf(migration.failureCode, migration.status);
  // 실패 지점이 planning·provisioning 이면 계획을 다시 만들 수 있다. 아니면 지금처럼 정리 확인 뒤 끝내는 길만
  const replan = canReplan(migration);
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
  const leftover = (
    <LeftoverFold migration={migration} title="끝내기 전에">
      <label className={`${s.check} t-body-md`}>
        <input type="checkbox" checked={cleaned} onChange={(event) => setCleaned(event.target.checked)} />
        남은 자원을 정리했습니다
      </label>
    </LeftoverFold>
  );
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="stop"
        meta={migration.failedAtStatus ? `${LABEL[migration.failedAtStatus]}에서 실패` : '실패'}
        title={reason?.title ?? '작업이\n끝나지 못했습니다'}
        foot={replan ? '계획을 다시 만들면 승인부터 다시 합니다' : '남은 자원을 직접 정리한 뒤 이 이전을 끝냅니다'}
      >
        {reason && (
          <div className={s.heroPanel}>
            <span className="t-body-md">{reason.hint}</span>
          </div>
        )}
      </Hero>
      <Stack area="side">
        {replan ? stop : leftover}
        {replan ? leftover : stop}
        <ActionRow notice={replan ? consent.notice(error) : error} before={replan ? consent.check : null}>
          {replan ? (
            <>
              {cleaned && (
                <ConfirmPill label="이 이전 끝내기" confirmLabel="정리했고 끝내기" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id, true))} />
              )}
              <ActionPill
                label={busy ? '보내는 중' : consent.accept ? '고객 부담으로 다시 계획' : '계획 다시 만들기'}
                icon="refresh"
                disabled={busy || consent.waiting}
                onClick={() => void run(() => api.replan(migration.id, consent.accept))}
              />
            </>
          ) : (
            <ActionPill label={busy ? '보내는 중' : '이 이전 끝내기'} icon="x" disabled={busy || !cleaned} onClick={() => void run(() => api.cancel(migration.id, true))} />
          )}
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function CancelledScreen({ migration, route }: ScreenProps) {
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta="취소" title={'이 이전은\n여기서 끝났습니다'} foot="환경 잠금을 풀었습니다" />
      <Stack area="side">
        <LeftoverFold migration={migration} title="도착에 남은 자원" />
      </Stack>
    </Frame>
  );
}

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
    const screen = screenOf(next.status);
    // 처음 읽은 화면도 전환으로 들인다. 읽는 동안은 근거 칸이 없어서, 근거 칸이 있는 화면이면 칸이 열리는 것이 보인다
    const moved = shownScreen.current !== screen;
    shownScreen.current = screen;
    if (moved) withTransition(() => setShown(next));
    else setShown(next);
  }, [poll.data]);

  if (!shown) {
    const missing = is404(poll.error);
    return (
      <Frame route="이전">
        <Hero
          tone={poll.error ? 'stop' : 'run'}
          meta="이전"
          title={poll.error ? (missing ? '이 이전을\n찾을 수 없습니다' : '이전을\n읽지 못했습니다') : '이전을\n읽고 있습니다'}
        />
      </Frame>
    );
  }

  const name = (envId: string) => envs.data?.find((env) => env.id === envId)?.name ?? envId.slice(0, 8);
  const props: ScreenProps = {
    migration: shown,
    route: `${name(shown.sourceEnvId)} → ${name(shown.targetEnvId)}`,
    onChanged: () => void poll.reload(),
  };
  const screen = screenOf(shown.status);
  if (screen === 'rejected' || screen === 'stale') return <StoppedScreen {...props} kind={screen} />;
  const Screen = SCREENS[screen];
  return <Screen {...props} />;
}

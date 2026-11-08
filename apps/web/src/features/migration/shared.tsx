import { Children, createContext, isValidElement, useContext, useState, type ReactNode } from 'react';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, CardGrid, Dock, SkeletonTile, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { Checklist } from '../../components/ui/Checklist';
import { BarPill } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { errorCode, errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { isTerminal } from '../../lib/status';
import type { MigrationStatus, MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { ShellLayout } from '../shell/ShellLayout';
import { migrationSteps, needsStepAnchor, stepAnchorFrom, type StepEntry } from './model';
import { rehearsalStepDetail } from './rehearsal';
import { useRehearsal } from './RehearsalFold';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

// 이전 한 건 화면의 벤토 (11/08 사용자 결정, 화면 묶음마다 "오른쪽 격자"를 고름). 모퉁이는 늘 같다:
//   큰 카드 = 왼쪽 열 전체(왼쪽 위 모퉁이), 진행 단계 = 오른쪽 위, 행동 버튼 = 오른쪽 아래(진행 단계 밑).
//   그 사이 가운데 열은 근거 카드 격자: 첫 카드는 가로 전체, 그다음은 두 장씩, 홀로 남은 마지막 카드는 가로 전체 (tiles CardGrid).
//   ┌ hero ┬ grid ┬ steps ┐
//   └ hero ┴ grid ┴ dock  ┘
// 카드는 접지 않는 고정 타일이고 넘치면 카드 안만 스크롤한다. 화면 전체는 스크롤하지 않는다.
// 화면(Screen)은 예전처럼 Hero 와 <Stack area="side"> 하나(근거 카드들 + ActionRow)만 그리고, 나누는 것은 Frame 이 한다
const STACK_ORDER = ['hero', 'steps', 'grid', 'dock'];
const WITH_GRID: BentoLayout = { columns: ['major', 'fill', 'rail'], areas: ['hero grid steps', 'hero grid dock'], rows: 'minmax(0, 1fr) auto', stack: STACK_ORDER };
const HERO_ONLY: BentoLayout = { columns: ['fill', 'rail'], areas: ['hero steps', 'hero dock'], rows: 'minmax(0, 1fr) auto', stack: STACK_ORDER };

/** 화면의 자식을 벤토 칸으로 나눈다: 근거 카드 묶음(Stack area="side")의 카드는 격자로, ActionRow 는 dock 으로 */
function splitScreen(children: ReactNode) {
  const items = Children.toArray(children);
  const side = items.find((item) => isValidElement<{ area?: string }>(item) && item.type === Stack && item.props.area === 'side');
  const inner = isValidElement<{ children?: ReactNode }>(side) ? Children.toArray(side.props.children) : [];
  const isDock = (item: ReactNode) => isValidElement(item) && item.type === ActionRow;
  return { rest: items.filter((item) => item !== side), cards: inner.filter((item) => !isDock(item)), dock: inner.filter(isDock) };
}

/** 지난 단계 다시 보기. at: 다시 보는 칸의 상태, back: 지금 단계로 돌아간다 */
export type PastView = { at: MigrationStatus; back: () => void };

export type ScreenProps = {
  migration: MigrationView;
  route: string;
  onChanged: () => void;
  /**
   * 진행 단계 카드에서 끝난 칸(파란 체크)을 눌러 그 단계 화면을 다시 보는 중.
   * 화면은 끝낸 말로 쓰고 행동 버튼을 두지 않는다. 값은 지금 서버 값 그대로다 (그때 값을 따로 남기지 않는다)
   */
  past?: PastView;
};

/** 진행 단계 카드가 지난 단계 보기를 여닫는 자리 (MigrationPage 가 준다). viewing: 다시 보는 칸, null 이면 지금 단계 */
export const StepsView = createContext<{ viewing: MigrationStatus | null; open: (at: MigrationStatus | null) => void } | null>(null);

/** 지난 단계 화면의 큰 카드 머리줄. 앞에 "지난 단계"를 붙이고, ← 는 앞 화면이 아니라 지금 단계로 돌아간다 */
export const pastHero = (past: PastView | undefined, meta: string) =>
  past ? { meta: t('지난 단계 · {0}', { 0: meta }), back: past.back } : { meta };

/** 실행 전·실행 두 묶음을 한 목록으로. 지금 묶음이 아닌 쪽은 모두 끝남(앞 묶음) 또는 모두 대기(뒤 묶음)로 온다 */
const allSteps = (migration: MigrationView, anchor: MigrationStatus | null, notes: Parameters<typeof migrationSteps>[2]) => [
  ...migrationSteps(migration, anchor, notes, 'prepare'),
  ...migrationSteps(migration, anchor, notes, 'run'),
];

/**
 * 진행 단계 카드. 접지 않고 항상 오른쪽 위에 보인다. 실행 전(구성 읽기~계획 승인)과 실행(자원 생성~정리)을 나누지 않고 한 목록으로.
 * 끝난 칸을 누르면 그 단계 화면을 다시 보고, 지금 칸을 누르면 지금 단계로 돌아온다
 */
function StepsTile({ migration }: { migration: MigrationView }) {
  const located = needsStepAnchor(migration);
  const timeline = usePoll(
    located ? () => or404(api.timeline(migration.id)) : null,
    located && !isTerminal(migration.status) ? 5000 : null,
    [migration.id, migration.version, located],
  );
  const anchor = timeline.data ? stepAnchorFrom(timeline.data.items, migration.status) : null;
  // 앱 배포 칸에 리허설 한 마디 (리허설 중·통과·건너뜀·멈춤). 배포 단계 전에는 읽지 않는다
  const rehearsal = useRehearsal(migration);
  const deploying = rehearsal.loading ? undefined : rehearsalStepDetail(rehearsal.run, rehearsal.stale, migration.status);
  const view = useContext(StepsView);
  const viewing = view?.viewing ?? null;
  const select = (step: StepEntry) => {
    if (!view) return undefined;
    // 보고 있는 지난 칸을 한 번 더 누르면 지금 단계로 돌아간다
    if (step.status === 'done') return () => view.open(step.at === viewing ? null : step.at);
    return viewing && step.status !== 'pending' ? () => view.open(null) : undefined;
  };
  return (
    <Tile area="steps" compact scroll>
      <TileHeader title={t('진행 단계')} />
      <Checklist
        items={allSteps(migration, anchor, deploying ? { deploying } : {}).map((step) => ({
          ...step,
          selected: step.at === viewing,
          onSelect: select(step),
        }))}
      />
    </Tile>
  );
}

type FrameProps = {
  route: string;
  migration?: MigrationView;
  children: ReactNode;
};

export function Frame({ route, migration, children }: FrameProps) {
  const { rest, cards, dock } = splitScreen(children);
  return (
    <ShellLayout layout={cards.length > 0 ? WITH_GRID : HERO_ONLY} barLeft={<BarPill label={route} />}>
      {rest}
      {cards.length > 0 && <CardGrid area="grid">{cards}</CardGrid>}
      {dock.length > 0 && <Dock area="dock">{dock}</Dock>}
      {migration ? (
        <StepsTile migration={migration} />
      ) : (
        <SkeletonTile area="steps" title={t('진행 단계')} rows={8} />
      )}
    </ShellLayout>
  );
}

/**
 * 버튼 동작을 묶는다. 실패하면 문장을 보이고, 성공하면 상태를 다시 읽는다.
 * code 는 마지막 실패의 서버 오류 코드다 (화면이 다음 행동을 고를 때: TENANT_BUSY → 다시 시작 등).
 * onFailed 는 실패 때 한 번 부른다 (계획서가 바뀌었으면 다시 읽기 등).
 */
export function useAction(onChanged: () => void, onFailed?: (reason: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setCode(null);
    try {
      await action();
      onChanged();
    } catch (reason) {
      setError(errorText(reason));
      setCode(errorCode(reason));
      onFailed?.(reason);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, code, run };
}

/**
 * TODO(human): 고객 비용 동의 문구와 방식(체크 한 번이면 되는지, 누가 동의할 수 있는지)은 사람이 정한다. 지금은 체크 한 줄
 * 재시도 비용 동의 (서버 core retry-budget.ts). 플랫폼이 부담하는 재시도 횟수를 넘으면 서버가 409 RETRY_BUDGET_EXHAUSTED 를 준다.
 * 그때만 동의 체크를 보이고, 체크하면 같은 요청을 acceptCustomerCost:true 로 다시 보낸다. 다시 계획하기·실패 재시도·재개가 같이 쓴다.
 */
export function useCostConsent(code: string | null) {
  const [asked, setAsked] = useState(false);
  const [agreed, setAgreed] = useState(false);
  if (code === 'RETRY_BUDGET_EXHAUSTED' && !asked) setAsked(true);
  const check = asked ? (
    <label className={`${s.resumeCheck} t-body-md`}>
      <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
      {t('무료 재시도를 다 썼습니다. 이번 재시도 비용은 고객이 부담합니다')}
    </label>
  ) : null;
  return {
    /** 동의를 물어야 하는데 아직 체크하지 않음 */
    waiting: asked && !agreed,
    /** 다음 요청에 실을 값 */
    accept: asked && agreed ? true : undefined,
    check,
    /** 동의를 묻는 동안은 빨간 알림 대신 체크 한 줄로 말한다 */
    notice: (error: string | null) => (asked && code === 'RETRY_BUDGET_EXHAUSTED' ? null : error),
  };
}

/**
 * 되돌리기 어려운 보조 행동. 한 번 더 눌러야 실행한다.
 * 묻는 동안(data-asking)은 행동 줄의 다른 작은 버튼이 비켜서 줄이 한 줄로 남는다 (tiles.module.css .actionRow)
 * TODO(human): 서버는 거절(POST /plans/:id/approvals)·롤백·취소·재개에 선택 칸 reason(500자)을 받아 감사 기록에 남긴다.
 *   화면은 아직 보내지 않는다. 이유 입력을 둘지, 둔다면 어느 행동에서 필수로 할지는 사람이 정한다.
 */
export function ConfirmPill({ label, confirmLabel, icon, tone, disabled, onConfirm }: { label: string; confirmLabel: string; icon: 'x' | 'ban' | 'rollback'; tone?: 'danger'; disabled?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <BarPill label={label} icon={icon} tone={tone} onClick={disabled ? undefined : () => setAsking(true)} />;
  return (
    <span className={s.confirm} data-asking>
      <BarPill label={confirmLabel} icon={icon} tone="danger" onClick={onConfirm} />
      <BarPill label={t('그만두기')} onClick={() => setAsking(false)} />
    </span>
  );
}


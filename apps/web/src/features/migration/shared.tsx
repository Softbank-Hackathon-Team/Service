import { useState, type ReactNode } from 'react';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { SkeletonTile, Tile, TileHeader } from '../../components/layout/tiles';
import { Checklist } from '../../components/ui/Checklist';
import { BarPill } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { errorCode, errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { isTerminal } from '../../lib/status';
import type { MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { ShellLayout } from '../shell/ShellLayout';
import { migrationSteps, needsStepAnchor, stepAnchorFrom } from './model';
import { rehearsalStepDetail } from './rehearsal';
import { useRehearsal } from './RehearsalFold';
import s from '../common/page.module.css';

// 큰 카드 다음으로 중요한 것이 진행 단계라서, 어느 화면이든 바로 옆 칸을 그대로 차지한다.
// 근거 칸이 없는 상태에서도 칸은 비워 둔 채 그대로 두어, 상태가 바뀔 때 진행 단계가 옮겨 다니지 않는다.
const LAYOUT: BentoLayout = { columns: ['fill', 'narrow', 'side'], areas: 'hero steps side' };

export type ScreenProps = {
  migration: MigrationView;
  route: string;
  onChanged: () => void;
};

/** 진행 단계 카드. 접지 않고 항상 보인다. */
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
  const deploying = rehearsalStepDetail(rehearsal.run, rehearsal.stale);
  return (
    <Tile area="steps" compact scroll>
      <TileHeader title="진행 단계" />
      <Checklist items={migrationSteps(migration, anchor, deploying ? { deploying } : {})} />
    </Tile>
  );
}

type FrameProps = {
  route: string;
  migration?: MigrationView;
  children: ReactNode;
};

export function Frame({ route, migration, children }: FrameProps) {
  return (
    <ShellLayout layout={LAYOUT} barLeft={<BarPill label={route} />}>
      {children}
      {migration ? (
        <StepsTile migration={migration} />
      ) : (
        <SkeletonTile area="steps" title="진행 단계" rows={8} />
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
 * 그때만 동의 체크를 보이고, 체크하면 같은 요청을 acceptCustomerCost:true 로 다시 보낸다. 다시 계획하기·재개가 같이 쓴다.
 */
export function useCostConsent(code: string | null) {
  const [asked, setAsked] = useState(false);
  const [agreed, setAgreed] = useState(false);
  if (code === 'RETRY_BUDGET_EXHAUSTED' && !asked) setAsked(true);
  const check = asked ? (
    <label className={`${s.resumeCheck} t-body-md`}>
      <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
      무료 재시도를 다 썼습니다. 이번 재시도 비용은 고객이 부담합니다
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
 * TODO(human): 서버는 거절(POST /plans/:id/approvals)·롤백·취소·재개에 선택 칸 reason(500자)을 받아 감사 기록에 남긴다.
 *   화면은 아직 보내지 않는다. 이유 입력을 둘지, 둔다면 어느 행동에서 필수로 할지는 사람이 정한다.
 */
export function ConfirmPill({ label, confirmLabel, icon, tone, disabled, onConfirm }: { label: string; confirmLabel: string; icon: 'x' | 'ban' | 'rollback'; tone?: 'danger'; disabled?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <BarPill label={label} icon={icon} tone={tone} onClick={disabled ? undefined : () => setAsking(true)} />;
  return (
    <span className={s.confirm}>
      <BarPill label={confirmLabel} icon={icon} tone="danger" onClick={onConfirm} />
      <BarPill label="그만두기" onClick={() => setAsking(false)} />
    </span>
  );
}


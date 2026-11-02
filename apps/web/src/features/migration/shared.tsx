import { useState, type ReactNode } from 'react';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { SkeletonTile, Tile, TileHeader } from '../../components/layout/tiles';
import { Checklist } from '../../components/ui/Checklist';
import { BarPill } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { isTerminal } from '../../lib/status';
import type { MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { ShellLayout } from '../shell/ShellLayout';
import { migrationSteps, needsStepAnchor, stepAnchorFrom } from './model';
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
  return (
    <Tile area="steps" compact scroll>
      <TileHeader title="진행 단계" />
      <Checklist items={migrationSteps(migration, anchor)} />
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

/** 버튼 동작을 묶는다. 실패하면 문장을 보이고, 성공하면 상태를 다시 읽는다. */
export function useAction(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
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


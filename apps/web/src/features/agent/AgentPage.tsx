import { useState } from 'react';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, SkeletonTile, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { ActionPill, Badge, BarPill } from '../../components/ui/controls';
import { Timeline, type TimelineEntry } from '../../components/ui/Timeline';
import { api } from '../../lib/api';
import { useAction } from '../migration/shared';
import { ShellLayout } from '../shell/ShellLayout';
import { useChosenMigration } from '../shell/useChosenMigration';
import { agentSummary, isRunning, RemediateBody, useAgentReview } from './AgentResult';
import { agentBlock, spendRows, spendText } from './model';
import s from '../common/page.module.css';

const LAYOUT: BentoLayout = { columns: ['fill', 'side', 'side'], areas: 'hero steps side' };

const TOOL_LABEL: Record<string, string> = {
  sandbox_get: '샌드박스 상태 보기',
  sandbox_logs: '로그 읽기',
  repo_read: '배포 파일 읽기',
  repo_edit: '배포 파일 고치기',
  sandbox_apply: '샌드박스에 적용',
  run_check: '안정성 확인',
  finish: '결론',
};
const RISK = { high: { label: '높음', tone: 'danger' }, medium: { label: '중간', tone: 'warning' }, low: { label: '낮음', tone: 'neutral' } } as const;

function AgentBody({ migrationId }: { migrationId: string }) {
  const review = useAgentReview(migrationId);
  const { busy, error, run } = useAction(() => void review.reload());
  const [task, setTask] = useState('');
  const view = review.data ?? null;
  const result = view?.remediate ?? null;
  const draft = view?.specDraft ?? null;
  const running = isRunning(result);
  const block = agentBlock(view?.llm);
  const blocked = block !== null;
  const spend = view?.llm?.spend;
  const steps: TimelineEntry[] = (result?.steps ?? []).map((step) => ({
    kind: step.ok ? 'tool' : 'denied',
    title: TOOL_LABEL[step.tool] ?? step.tool,
    detail: step.note,
    time: `${step.seq}`,
  }));
  const title = block
    ? block.title
    : running
      ? '샌드박스에서\n점검하고 있습니다'
      : result?.outcome === 'proposed'
        ? '수정안을\n찾았습니다'
        : result?.outcome === 'no_change'
          ? '고칠 것을\n찾지 못했습니다'
          : result?.outcome === 'gave_up'
            ? '원인을\n찾지 못했습니다'
            : '격리된 곳에서\n점검하고 제안합니다';
  return (
    <>
      <Hero tone={blocked ? 'stop' : 'run'} meta="AI 에이전트" title={title} foot="운영 환경은 읽지 않습니다. 적용은 사람이 합니다" />
      <Tile area="steps" compact scroll>
        <TileHeader title="에이전트가 한 일" />
        {steps.length > 0 ? <Timeline items={steps} /> : <p className="t-body-sm c-tertiary">아직 돌린 기록이 없습니다.</p>}
      </Tile>
      <Stack area="side">
        <FoldTile title="장애 점검 결과" summary={agentSummary(result)}>
          <div className={s.agent}>
            <RemediateBody view={view} />
          </div>
        </FoldTile>
        <FoldTile title="명세 초안" summary={draft ? `위험 ${draft.risks.length}건` : '아직 없음'} defaultOpen={false}>
          <div className={s.agent}>
            {draft?.risks.map((risk) => (
              <div key={risk.id} className={s.formRow}>
                <span className="t-body-sm">{risk.title}</span>
                <Badge tone={RISK[risk.level].tone}>{RISK[risk.level].label}</Badge>
              </div>
            ))}
            {draft?.planExplanation && <p className="t-body-sm c-secondary">{draft.planExplanation}</p>}
            <div>
              <BarPill label="명세 초안 다시 만들기" icon="refresh" onClick={busy || blocked ? undefined : () => void run(() => api.agentRun(migrationId, undefined, 'spec_draft'))} />
            </div>
          </div>
        </FoldTile>
        {spend && (
          <FoldTile key={`spend-${spend.exceeded}`} title="AI 지출" summary={spendText(spend)} defaultOpen={spend.exceeded}>
            <ul className={s.rows}>
              {spendRows(spend).map((row) => (
                <li key={row.name} className={s.row}>
                  <span className="t-label-md">{row.name}</span>
                  <span className={`${s.rowValue} t-code-sm c-secondary`}>{row.value}</span>
                </li>
              ))}
            </ul>
            <p className={`${s.note} t-caption c-tertiary`}>실제 AI 호출로 낸 추정 금액입니다. 상한에 닿으면 서버가 새 점검을 받지 않습니다.</p>
          </FoldTile>
        )}
        <FoldTile title="점검 지시" summary="선택" defaultOpen={false}>
          <div className={s.form}>
            <textarea
              className={`${s.textarea} t-body-md`}
              aria-label="점검 지시"
              maxLength={2000}
              value={task}
              placeholder="예: 도착 쪽 앱이 502를 냅니다. 원인을 찾아 주세요."
              onChange={(event) => setTask(event.target.value)}
            />
          </div>
        </FoldTile>
        <ActionRow notice={error}>
          <ActionPill
            label={block ? block.button : busy || running ? '점검 중' : result ? '다시 점검' : '수정안 받기'}
            icon="bot"
            disabled={busy || running || blocked}
            onClick={() => void run(() => api.agentRun(migrationId, task.trim() || undefined))}
          />
        </ActionRow>
      </Stack>
    </>
  );
}

export function AgentPage({ id }: { id: string | null }) {
  const { chosen, picker, loading } = useChosenMigration('agent', id);
  if (!chosen) {
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta="AI 에이전트" title={loading ? '이전을\n읽고 있습니다' : '점검할 이전이\n없습니다'} />
        {loading && <SkeletonTile area="steps" title="에이전트가 한 일" rows={6} />}
      </ShellLayout>
    );
  }
  return (
    <ShellLayout layout={LAYOUT} barLeft={picker}>
      <AgentBody key={chosen.id} migrationId={chosen.id} />
    </ShellLayout>
  );
}

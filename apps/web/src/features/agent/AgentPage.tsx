import { useState } from 'react';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, SkeletonTile, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { ActionPill, Badge, BarPill } from '../../components/ui/controls';
import { Timeline } from '../../components/ui/Timeline';
import { api } from '../../lib/api';
import { useAction } from '../migration/shared';
import { ShellLayout } from '../shell/ShellLayout';
import { useChosenMigration } from '../shell/useChosenMigration';
import { agentSummary, isRunning, RemediateBody, useAgentReview } from './AgentResult';
import { agentBlock, agentStepEntry, spendRows, spendText } from './model';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

// 고를 마이그레이션이 없으면 큰 카드 하나만 (옆 칸을 비워 두지 않는다)
const EMPTY: BentoLayout = { columns: ['fill'], areas: 'hero' };
const LAYOUT: BentoLayout = { columns: ['fill', 'side', 'side'], areas: 'hero steps side' };

const RISK = { high: { label: t('높음'), tone: 'danger' }, medium: { label: t('중간'), tone: 'warning' }, low: { label: t('낮음'), tone: 'neutral' } } as const;

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
  const steps = (result?.steps ?? []).map(agentStepEntry);
  const title = block
    ? block.title
    : running
      ? t('샌드박스에서\n점검하고 있습니다')
      : result?.outcome === 'proposed'
        ? t('수정안을\n찾았습니다')
        : result?.outcome === 'no_change'
          ? t('고칠 것을\n찾지 못했습니다')
          : result?.outcome === 'gave_up'
            ? t('원인을\n찾지 못했습니다')
            : t('격리된 곳에서\n점검하고 제안합니다');
  return (
    <>
      <Hero tone={blocked ? 'stop' : 'run'} meta={t('AI 에이전트')} title={title} foot={t('운영 환경은 읽지 않습니다. 적용은 사람이 합니다')} />
      <Tile area="steps" compact scroll>
        <TileHeader title={t('에이전트가 한 일')} />
        {steps.length > 0 ? <Timeline items={steps} /> : <p className="t-body-sm c-tertiary">{t('아직 돌린 기록이 없습니다.')}</p>}
      </Tile>
      <Stack area="side">
        <FoldTile title={t('장애 점검 결과')} summary={agentSummary(result)}>
          <div className={s.agent}>
            <RemediateBody view={view} />
          </div>
        </FoldTile>
        <FoldTile title={t('명세 초안')} summary={draft ? t('위험 {0}건', { 0: draft.risks.length }) : t('아직 없음')} defaultOpen={false}>
          <div className={s.agent}>
            {draft?.risks.map((risk) => (
              <div key={risk.id} className={s.formRow}>
                <span className="t-body-sm">{risk.title}</span>
                <Badge tone={RISK[risk.level].tone}>{RISK[risk.level].label}</Badge>
              </div>
            ))}
            {draft?.planExplanation && <p className="t-body-sm c-secondary">{draft.planExplanation}</p>}
            <div>
              <BarPill label={t('명세 초안 다시 만들기')} icon="refresh" onClick={busy || blocked ? undefined : () => void run(() => api.agentRun(migrationId, undefined, 'spec_draft'))} />
            </div>
          </div>
        </FoldTile>
        {spend && (
          <FoldTile key={`spend-${spend.exceeded}`} title={t('AI 지출')} summary={spendText(spend)} defaultOpen={spend.exceeded}>
            <ul className={s.rows}>
              {spendRows(spend).map((row) => (
                <li key={row.name} className={s.row}>
                  <span className="t-label-md">{row.name}</span>
                  <span className={`${s.rowValue} t-code-sm c-secondary`}>{row.value}</span>
                </li>
              ))}
            </ul>
            <p className={`${s.note} t-caption c-tertiary`}>{t('실제 AI 호출로 낸 추정 금액입니다. 상한에 닿으면 서버가 새 점검을 받지 않습니다.')}</p>
          </FoldTile>
        )}
        <FoldTile title={t('점검 지시')} summary={t('선택')} defaultOpen={false}>
          <div className={s.form}>
            <textarea
              className={`${s.textarea} t-body-md`}
              aria-label={t('점검 지시')}
              maxLength={2000}
              value={task}
              placeholder={t('예: 도착 쪽 앱이 502를 냅니다. 원인을 찾아 주세요.')}
              onChange={(event) => setTask(event.target.value)}
            />
          </div>
        </FoldTile>
        <ActionRow notice={error}>
          <ActionPill
            label={block ? block.button : busy || running ? t('점검 중') : result ? t('다시 점검') : t('수정안 받기')}
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
      <ShellLayout layout={loading ? LAYOUT : EMPTY}>
        <Hero tone="run" meta={t('AI 에이전트')} title={loading ? t('마이그레이션을\n읽고 있습니다') : t('점검할 마이그레이션이\n없습니다')} />
        {loading && <SkeletonTile area="steps" title={t('에이전트가 한 일')} rows={6} />}
      </ShellLayout>
    );
  }
  return (
    <ShellLayout layout={LAYOUT} barLeft={picker}>
      <AgentBody key={chosen.id} migrationId={chosen.id} />
    </ShellLayout>
  );
}

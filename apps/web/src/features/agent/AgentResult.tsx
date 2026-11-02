import { FoldTile } from '../../components/layout/tiles';
import { Badge, BarPill } from '../../components/ui/controls';
import type { AgentLlm, AgentReview, RemediateReview } from '../../lib/agent-review-types';
import { api } from '../../lib/api';
import { or404 } from '../../lib/http';
import { usePoll } from '../../lib/usePoll';
import { useAction } from '../migration/shared';
import s from '../common/page.module.css';

export const OUTCOME: Record<NonNullable<RemediateReview['outcome']>, { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
  proposed: { label: '수정안 있음', tone: 'success' },
  no_change: { label: '고칠 것 없음', tone: 'neutral' },
  gave_up: { label: '원인 못 찾음', tone: 'warning' },
};

export function llmNote(llm: AgentLlm | undefined) {
  if (llm?.state === 'key_missing') return 'AI 키가 없어 점검을 돌릴 수 없습니다.';
  if (llm?.state === 'fake') return '시험용 가짜 AI 결과입니다.';
  return null;
}

export const isRunning = (result: RemediateReview | null | undefined) => result?.status === 'queued' || result?.status === 'running';

export function useAgentReview(migrationId: string) {
  return usePoll<AgentReview | null>(() => or404(api.agentReview(migrationId)), 5000, [migrationId]);
}

export function RemediateBody({ view }: { view: AgentReview | null }) {
  const result = view?.remediate ?? null;
  const note = llmNote(view?.llm);
  return (
    <>
      {note && <p className="t-body-sm c-secondary">{note}</p>}
      {result?.source === 'stub' && <Badge tone="warning">시험용 결과</Badge>}
      {result?.title && <p className="t-label-md">{result.title}</p>}
      {result?.rationale && <p className="t-body-sm c-secondary">{result.rationale}</p>}
      {result?.status === 'failed' && result.reason && <p className="t-body-sm c-danger">{result.reason}</p>}
      {result?.gate && !result.gate.ok && <p className="t-body-sm c-danger">안전 검사를 통과하지 못했습니다: {result.gate.violations.join(', ')}</p>}
      {result && result.checked.length > 0 && (
        <div>
          <p className="t-label-sm c-tertiary">확인한 것</p>
          <ul className="t-body-sm c-secondary">
            {result.checked.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {result && result.notDone.length > 0 && (
        <div>
          <p className="t-label-sm c-warning">사람이 확인할 것</p>
          <ul className="t-body-sm c-secondary">
            {result.notDone.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function agentSummary(result: RemediateReview | null | undefined) {
  if (isRunning(result)) return '점검 중';
  if (result?.outcome) return OUTCOME[result.outcome].label;
  return result?.status === 'failed' ? '점검 실패' : '아직 없음';
}

/** 멈춘 이전 화면에 끼우는 수정안 카드. */
export function AgentFold({ migrationId }: { migrationId: string }) {
  const review = useAgentReview(migrationId);
  const { busy, error, run } = useAction(() => void review.reload());
  const view = review.data ?? null;
  const result = view?.remediate ?? null;
  const running = isRunning(result);
  const blocked = view?.llm?.state === 'key_missing';
  return (
    <FoldTile title="에이전트 수정안" summary={agentSummary(result)}>
      <div className={s.agent}>
        <RemediateBody view={view} />
        {error && <p className="t-body-sm c-danger">{error}</p>}
        <div>
          <BarPill
            label={busy || running ? '점검 중' : result ? '다시 점검' : '수정안 받기'}
            icon="bot"
            onClick={busy || running || blocked ? undefined : () => void run(() => api.agentRun(migrationId))}
          />
        </div>
        <p className="t-caption c-tertiary">수정안을 적용하는 것은 사람입니다. 적용한 뒤 이전을 재개해 주세요.</p>
      </div>
    </FoldTile>
  );
}

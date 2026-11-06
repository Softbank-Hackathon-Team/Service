import { FoldTile } from '../../components/layout/tiles';
import { Badge, BarPill } from '../../components/ui/controls';
import type { AgentLlm, AgentReview, RemediateReview } from '../../lib/agent-review-types';
import { api } from '../../lib/api';
import { or404 } from '../../lib/http';
import { usePoll } from '../../lib/usePoll';
import { useAction } from '../migration/shared';
import { agentBlock, agentReasonText, OUTCOME, sandboxNote } from './model';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

export function llmNote(llm: AgentLlm | undefined) {
  const block = agentBlock(llm);
  if (block) return block.note;
  if (llm?.state === 'fake') return t('시험용 가짜 AI 결과입니다.');
  return null;
}

export const isRunning = (result: RemediateReview | null | undefined) => result?.status === 'queued' || result?.status === 'running';

export function useAgentReview(migrationId: string) {
  return usePoll<AgentReview | null>(() => or404(api.agentReview(migrationId)), 5000, [migrationId]);
}

export function RemediateBody({ view }: { view: AgentReview | null }) {
  const result = view?.remediate ?? null;
  const note = llmNote(view?.llm);
  const unverified = sandboxNote(result);
  return (
    <>
      {note && <p className="t-body-sm c-secondary">{note}</p>}
      {result?.source === 'stub' && <Badge tone="warning">{t('시험용 결과')}</Badge>}
      {result?.title && <p className="t-label-md">{result.title}</p>}
      {result?.rationale && <p className="t-body-sm c-secondary">{result.rationale}</p>}
      {result?.status === 'failed' && result.reason && <p className="t-body-sm c-danger">{agentReasonText(result.reason)}</p>}
      {unverified && <p className="t-body-sm c-warning">{unverified}</p>}
      {result?.gate && !result.gate.ok && <p className="t-body-sm c-danger">{t('안전 검사를 통과하지 못했습니다: {0}', { 0: result.gate.violations.join(', ') })}</p>}
      {result && result.checked.length > 0 && (
        <div>
          <p className="t-label-sm c-tertiary">{t('확인한 것')}</p>
          <ul className="t-body-sm c-secondary">
            {result.checked.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {result && result.notDone.length > 0 && (
        <div>
          <p className="t-label-sm c-warning">{t('사람이 확인할 것')}</p>
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
  if (isRunning(result)) return t('점검 중');
  if (result?.outcome) return OUTCOME[result.outcome].label;
  return result?.status === 'failed' ? t('점검 실패') : t('아직 없음');
}

/** 멈춘 이전 화면에 끼우는 수정안 카드. 같은 화면의 멈춘 이유 카드도 실패 분석을 쓰므로 읽기는 화면이 한 번만 한다. */
export function AgentFold({ migrationId, review }: { migrationId: string; review: ReturnType<typeof useAgentReview> }) {
  const { busy, error, run } = useAction(() => void review.reload());
  const view = review.data ?? null;
  const result = view?.remediate ?? null;
  const running = isRunning(result);
  const block = agentBlock(view?.llm);
  const blocked = block !== null;
  return (
    <FoldTile title={t('에이전트 수정안')} summary={agentSummary(result)}>
      <div className={s.agent}>
        <RemediateBody view={view} />
        {error && <p className="t-body-sm c-danger">{error}</p>}
        <div>
          <BarPill
            label={block ? block.button : busy || running ? t('점검 중') : result ? t('다시 점검') : t('수정안 받기')}
            icon="bot"
            onClick={busy || running || blocked ? undefined : () => void run(() => api.agentRun(migrationId))}
          />
        </div>
        <p className="t-caption c-tertiary">{t('수정안을 적용하는 것은 사람입니다. 적용한 뒤 마이그레이션을 재개해 주세요.')}</p>
      </div>
    </FoldTile>
  );
}

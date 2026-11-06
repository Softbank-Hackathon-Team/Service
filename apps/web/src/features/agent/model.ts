import type { TimelineEntry } from '../../components/ui/Timeline';
import type { AgentLlm, AgentLlmSpend, AgentReview, AgentStep, FailureAnalysis, RemediateReview } from '../../lib/agent-review-types';
import { t } from '../../lib/i18n';

// AI 점검을 지금 돌릴 수 없는 이유 (서버 apps/api/src/routes/agent-review.ts 와 같은 규칙).
//   key_missing → 409 LLM_KEY_MISSING, spend.exceeded → 409 LLM_BUDGET_EXCEEDED. 둘 다 큐에 넣기 전에 서버가 막는다
export type AgentBlock = { title: string; button: string; note: string };

export function agentBlock(llm: AgentLlm | undefined): AgentBlock | null {
  if (llm?.state === 'key_missing') return { title: t('AI 키가 없어\n돌릴 수 없습니다'), button: t('AI 키가 없습니다'), note: t('AI 키가 없어 점검을 돌릴 수 없습니다.') };
  if (llm?.spend?.exceeded) return { title: t('AI 지출 상한에\n닿았습니다'), button: t('AI 지출 상한에 닿았습니다'), note: t('이번 회차 AI 지출이 상한에 닿아 점검을 돌릴 수 없습니다.') };
  return null;
}

const TOOL_LABEL: Record<string, string> = {
  sandbox_get: t('샌드박스 상태 보기'),
  sandbox_logs: t('로그 읽기'),
  repo_read: t('배포 파일 읽기'),
  repo_edit: t('배포 파일 고치기'),
  sandbox_apply: t('샌드박스에 적용'),
  run_check: t('안정성 확인'),
  finish: t('결론'),
};
export const OUTCOME: Record<NonNullable<RemediateReview['outcome']>, { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
  proposed: { label: t('수정안 있음'), tone: 'success' },
  no_change: { label: t('고칠 것 없음'), tone: 'neutral' },
  gave_up: { label: t('원인 못 찾음'), tone: 'warning' },
};
const CHECK: Record<string, Pick<TimelineEntry, 'kind' | 'detail'> | undefined> = {
  check_ok: { kind: 'pass', detail: t('점검 통과') },
  check_bad: { kind: 'fail', detail: t('점검 실패') },
};

/**
 * 에이전트 단계 한 줄. step.ok 는 "도구 호출이 허용됐나"라서, run_check 의 통과·실패는 note(check_ok·check_bad)로 가른다.
 * finish 의 note 는 결론 코드(proposed …)라 사람 말로 (packages/agent loop.ts)
 */
export function agentStepEntry(step: AgentStep): TimelineEntry {
  const check = step.tool === 'run_check' ? CHECK[step.note] : undefined;
  const outcome = step.tool === 'finish' ? OUTCOME[step.note as keyof typeof OUTCOME]?.label : undefined;
  return {
    kind: check?.kind ?? (step.ok ? 'tool' : 'denied'),
    title: TOOL_LABEL[step.tool] ?? step.tool,
    detail: check?.detail ?? outcome ?? step.note,
    time: `${step.seq}`,
  };
}

const dollars = (usd: number) => `$${usd < 1 ? usd.toFixed(2) : usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** 카드 머리줄 오른쪽: 이번 회차 이 회사 지출 / 상한 */
export const spendText = (spend: Pick<AgentLlmSpend, 'usd' | 'budgetUsd'>) => `${dollars(spend.usd)} / ${dollars(spend.budgetUsd)}`;

/** 지출 카드의 줄. 모든 회사 합(전체 상한)은 서버가 줄 때만 쓴다. */
export function spendRows(spend: AgentLlmSpend): { name: string; value: string }[] {
  return [
    { name: t('회차'), value: spend.round },
    { name: t('AI 호출'), value: t('{0}번', { 0: spend.calls.toLocaleString('en-US') }) },
    { name: t('이 회사 지출'), value: spendText(spend) },
    ...(spend.totalUsd !== undefined && spend.globalUsd !== undefined
      ? [{ name: t('모든 회사 합'), value: `${dollars(spend.totalUsd)} / ${dollars(spend.globalUsd)}` }]
      : []),
  ];
}

/**
 * 실패 원인 분석 (agent-review 의 failureAnalysis, PA5a). 끝난 분석이 있을 때만 돌려준다.
 * 칸이 없거나 아직 안 끝났으면(analysis null) null: 화면은 "분석 중"이라고 말하지 않고 아무것도 그리지 않는다.
 */
export function failureAnalysisOf(review: AgentReview | null | undefined): FailureAnalysis | null {
  return review?.failureAnalysis?.analysis ?? null;
}

/** 분석 머리말 한 줄. AI 가 낸 추정이라는 것과 확신 정도, 그대로 다시 해도 될지(retryable)를 함께 적는다. */
export const analysisCaption = (analysis: Pick<FailureAnalysis, 'confidence' | 'retryable'>) =>
  t('AI 추정 · 확신 {0}%{1}', { 0: Math.round(analysis.confidence * 100), 1: analysis.retryable ? t(' · 고치지 않고 다시 해도 될 것으로 봄') : '' });

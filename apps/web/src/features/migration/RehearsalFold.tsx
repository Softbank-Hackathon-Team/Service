import type { ReactNode } from 'react';
import { FoldTile } from '../../components/layout/tiles';
import { Checklist } from '../../components/ui/Checklist';
import { CodeValue } from '../../components/ui/CodeValue';
import { api } from '../../lib/api';
import { stopReasonOf } from '../../lib/failure';
import { or404 } from '../../lib/http';
import type { RehearsalRun } from '../../lib/rehearsal-types';
import type { MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import {
  BORROW_TEXT,
  FIDELITY_LABEL,
  ISOLATION_TEXT,
  SKIP_TEXT,
  STALE_TEXT,
  checkEntries,
  deadlineLabel,
  elapsedSec,
  fidelityGroups,
  formatSec,
  isStaleRun,
  isolationLine,
  phaseEntries,
  rehearsalPollMs,
  rehearsalRelevant,
  rehearsalState,
  rehearsalSummary,
  remainingSec,
} from './rehearsal';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

/** 이 이전의 리허설 줄과 지난 시도인지. 배포 단계에 닿기 전에는 부르지 않는다. 서버에 경로가 없으면(404) 줄 없음으로 본다. */
export function useRehearsal(migration: MigrationView) {
  const relevant = rehearsalRelevant(migration);
  const poll = usePoll(
    relevant ? () => or404(api.rehearsal(migration.id)) : null,
    relevant ? rehearsalPollMs(migration.status) : null,
    [migration.id, migration.status, relevant],
  );
  const run = poll.data?.run ?? null;
  return { run, stale: isStaleRun(run), loading: relevant && poll.loading };
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li className={s.row}>
      <span className="t-label-md">{name}</span>
      <span className={`${s.rowValue} t-caption c-secondary`}>{children}</span>
    </li>
  );
}

/** 충실도 표를 그대로 보인다. 같게 / 바꿔서 / 못 본 것 세 묶음, 줄마다 실제·리허설·이유. */
function FidelityFold({ run, defaultOpen }: { run: RehearsalRun; defaultOpen: boolean }) {
  const matrix = run.result?.fidelity ?? run.fidelity;
  const groups = fidelityGroups(matrix);
  if (groups.length === 0) return null;
  const count = (status: string) => groups.find((group) => group.status === status)?.items.length ?? 0;
  return (
    <FoldTile title={t('충실도')} summary={t('같음 {0} · 바꿈 {1} · 못 봄 {2}', { 0: count('identical'), 1: count('substituted'), 2: count('not_checked') })} defaultOpen={defaultOpen}>
      {groups.map((group) => (
        <div key={group.status}>
          <p className={`${s.note} t-label-sm c-tertiary`}>{group.title}</p>
          <ul className={s.rows}>
            {group.items.map((item) => (
              <li key={item.id} className={s.stackRow}>
                <span className={s.formRow}>
                  <span className="t-label-md">{FIDELITY_LABEL[item.id] ?? item.id}</span>
                  <span className={`${s.rowValue} t-caption c-secondary`}>
                    {item.status === 'substituted' ? `${item.real} → ${item.sandbox}` : item.status === 'identical' ? item.real : t('리허설에서 안 봄')}
                  </span>
                </span>
                {item.reason && <span className="t-caption c-tertiary">{item.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </FoldTile>
  );
}

/**
 * 리허설 카드와 충실도 카드. 줄이 없으면 아무것도 그리지 않는다.
 * 결론(통과·멈춤)은 진행 단계 카드와 큰 카드가 말하고, 여기에는 샌드박스·단계·검사·격리·충실도 근거를 둔다.
 */
export function RehearsalFolds({ migration, run, stale, defaultOpen }: { migration: MigrationView; run: RehearsalRun | null; stale: boolean; defaultOpen: boolean }) {
  if (!run || !rehearsalRelevant(migration)) return null;
  const state = rehearsalState(run, stale);
  // 지난 시도의 줄도 내용은 그대로 보인다. 머리 문장으로 지금 판정이 아니라고 먼저 말한다
  const result = run.result;
  const past = stale ? rehearsalState(run) : null;
  const sandbox = run.sandboxName ?? result?.sandbox.name ?? null;
  const left = remainingSec(run);
  const checks = result ? checkEntries(result) : null;
  const moving = !stale && (state === 'running' || state === 'waiting');
  return (
    <>
      <FoldTile title={t('리허설')} summary={rehearsalSummary(run, stale)} defaultOpen={defaultOpen}>
        {state === 'skipped' && run.skip && <p className={`${s.note} t-body-sm c-secondary`}>{SKIP_TEXT[run.skip]}</p>}
        {stale && (
          <p className={`${s.note} t-body-sm c-secondary`}>
            {t('{0} 그때 결과: {1}{2}', { 0: STALE_TEXT, 1: rehearsalSummary(run), 2: run.failureCode ? ` (${stopReasonOf(run.failureCode, 'paused')?.label ?? run.failureCode})` : '' })}
          </p>
        )}
        {moving && (
          <div className={s.agent}>
            <Checklist items={phaseEntries(run)} />
          </div>
        )}
        {(past ?? state) !== 'skipped' && (
          <ul className={s.rows}>
            {sandbox && (
              <li className={s.row}>
                <span className="t-label-md">{t('샌드박스')}</span>
                <CodeValue value={sandbox} className={s.rowValue} />
              </li>
            )}
            <Row name={moving ? t('지금까지') : t('걸린 시간')}>{formatSec(elapsedSec(run))}</Row>
            {left !== null && !stale && deadlineLabel(run) && <Row name={deadlineLabel(run)!}>{t('{0} 남음', { 0: formatSec(left) })}</Row>}
            {state === 'reused' && <Row name={t('재사용')}>{t('같은 계획·같은 묶음의 앞선 통과')}</Row>}
            {result && <Row name={t('격리')}>{isolationLine(result.sandbox)}</Row>}
            {result && <Row name={t('샌드박스 쿠버네티스')}>{result.sandbox.k8sVersion}</Row>}
            {result && !result.deleted && <Row name={t('지우기')}>{t('아직 남음 · 청소가 지웁니다')}</Row>}
          </ul>
        )}
        {checks && checks.failed.length > 0 && (
          <ul className={s.rows}>
            {checks.failed.map((check) => (
              <li key={check.label} className={s.stackRow}>
                <span className="t-label-md c-danger">✕ {check.label}</span>
                {check.detail && <span className="t-caption c-secondary">{check.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {/* 지난 시도의 기록은 판정을 가른 실패만 남기고, 통과한 검사 목록은 그리지 않는다 */}
        {checks && !stale && checks.items.length > 0 && (
          <div className={s.agent}>
            <Checklist items={checks.items} />
            {checks.more > 0 && <span className="t-caption c-tertiary">{t('검사 {0}개 더', { 0: checks.more })}</span>}
          </div>
        )}
        {result && result.warnings.length > 0 && (
          <ul className={s.rows}>
            {result.warnings.slice(0, 3).map((warning) => (
              <li key={warning} className={`${s.note} t-caption c-warning`}>
                {warning}
              </li>
            ))}
          </ul>
        )}
        {state !== 'skipped' && (
          <>
            <p className={`${s.note} t-body-sm c-secondary`}>{ISOLATION_TEXT}</p>
            <p className={`${s.note} t-caption c-tertiary`}>{BORROW_TEXT}</p>
          </>
        )}
      </FoldTile>
      {(past ?? state) !== 'skipped' && <FidelityFold run={run} defaultOpen={defaultOpen && !stale && (state === 'failed' || state === 'error')} />}
    </>
  );
}

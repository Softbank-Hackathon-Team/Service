import type { ReactNode } from 'react';
import { FoldTile } from '../../components/layout/tiles';
import { Checklist } from '../../components/ui/Checklist';
import { CodeValue } from '../../components/ui/CodeValue';
import { api } from '../../lib/api';
import { or404 } from '../../lib/http';
import type { RehearsalRun } from '../../lib/rehearsal-types';
import type { MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import {
  BORROW_TEXT,
  FIDELITY_LABEL,
  ISOLATION_TEXT,
  SKIP_TEXT,
  checkEntries,
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

/** 이 이전의 리허설 줄과 지난 시도인지. 배포 단계에 닿기 전에는 부르지 않는다. 서버에 경로가 없으면(404) 줄 없음으로 본다. */
export function useRehearsal(migration: MigrationView) {
  const relevant = rehearsalRelevant(migration);
  const poll = usePoll(
    relevant ? () => or404(api.rehearsal(migration.id)) : null,
    relevant ? rehearsalPollMs(migration.status) : null,
    [migration.id, migration.status, relevant],
  );
  const run = poll.data?.run ?? null;
  return { run, stale: run ? isStaleRun(run, migration) : false, loading: relevant && poll.loading };
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
    <FoldTile title="충실도" summary={`같음 ${count('identical')} · 바꿈 ${count('substituted')} · 못 봄 ${count('not_checked')}`} defaultOpen={defaultOpen}>
      {groups.map((group) => (
        <div key={group.status}>
          <p className={`${s.note} t-label-sm c-tertiary`}>{group.title}</p>
          <ul className={s.rows}>
            {group.items.map((item) => (
              <li key={item.id} className={s.stackRow}>
                <span className={s.formRow}>
                  <span className="t-label-md">{FIDELITY_LABEL[item.id] ?? item.id}</span>
                  <span className={`${s.rowValue} t-caption c-secondary`}>
                    {item.status === 'substituted' ? `${item.real} → ${item.sandbox}` : item.status === 'identical' ? item.real : '리허설에서 안 봄'}
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
  const result = stale ? null : run.result;
  const sandbox = run.sandboxName ?? result?.sandbox.name ?? null;
  const left = remainingSec(run);
  const checks = result ? checkEntries(result) : null;
  const moving = state === 'running' || state === 'waiting';
  return (
    <>
      <FoldTile title="리허설" summary={rehearsalSummary(run, stale)} defaultOpen={defaultOpen}>
        {state === 'skipped' && run.skip && <p className={`${s.note} t-body-sm c-secondary`}>{SKIP_TEXT[run.skip]}</p>}
        {state === 'stale' && <p className={`${s.note} t-body-sm c-secondary`}>지난 시도는 멈췄습니다. 새 샌드박스에서 처음부터 다시 돕니다.</p>}
        {moving && (
          <div className={s.agent}>
            <Checklist items={phaseEntries(run)} />
          </div>
        )}
        {state !== 'skipped' && (
          <ul className={s.rows}>
            {sandbox && (
              <li className={s.row}>
                <span className="t-label-md">샌드박스</span>
                <CodeValue value={sandbox} className={s.rowValue} />
              </li>
            )}
            {!stale && <Row name={moving ? '지금까지' : '걸린 시간'}>{formatSec(elapsedSec(run))}</Row>}
            {left !== null && <Row name="남은 기한">{formatSec(left)}</Row>}
            {state === 'reused' && <Row name="재사용">같은 계획·같은 묶음의 앞선 통과</Row>}
            {result && <Row name="격리">{isolationLine(result.sandbox)}</Row>}
            {result && <Row name="샌드박스 쿠버네티스">{result.sandbox.k8sVersion}</Row>}
            {result && !result.deleted && <Row name="지우기">아직 남음 · 청소가 지웁니다</Row>}
          </ul>
        )}
        {checks && (
          <div className={s.agent}>
            <Checklist items={checks.items} />
            {checks.more > 0 && <span className="t-caption c-tertiary">검사 {checks.more}개 더 · 모두 통과 또는 참고</span>}
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
      {!stale && <FidelityFold run={run} defaultOpen={defaultOpen && (state === 'failed' || state === 'error')} />}
    </>
  );
}

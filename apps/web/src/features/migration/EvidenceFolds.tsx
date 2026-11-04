import type { ReactNode } from 'react';
import { FoldTile } from '../../components/layout/tiles';
import { CodeValue } from '../../components/ui/CodeValue';
import { api } from '../../lib/api';
import type { FailureAnalysis } from '../../lib/agent-review-types';
import type { StopReason } from '../../lib/failure';
import { or404 } from '../../lib/http';
import { isTerminal } from '../../lib/status';
import { stopEvidence } from '../../lib/timelineDetail';
import type { MigrationStatus, MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { analysisCaption } from '../agent/model';
import { judgementRows, leftoversOf, leftoverValue, trafficReportRows } from './model';
import s from '../common/page.module.css';

type StopFoldProps = {
  migration: MigrationView;
  reason: StopReason;
  /** 타임라인에서 근거를 찾을 전이의 도착 상태. 롤백 완료는 롤백을 시작한 전이(rolling_back)를 본다 */
  into: MigrationStatus;
  /** 큰 카드가 이미 같은 문장을 쓰면 끈다 */
  hint?: boolean;
  defaultOpen?: boolean;
  /** AI 실패 원인 분석 (끝난 것만). 없으면 아무것도 그리지 않는다 */
  analysis?: FailureAnalysis | null;
};

/**
 * 멈춘 이유의 근거. 큰 카드는 사람 말로 결론만 말하고, 판정 숫자·규칙 번호·사유 코드는 여기 접어 둔다.
 * 트래픽 판정은 워커가 멈춘 전이에 남긴 마지막 판정이고, 기준은 승인한 계획서의 되돌림 기준이다.
 */
export function StopFold({ migration, reason, into, hint = true, defaultOpen = true, analysis = null }: StopFoldProps) {
  const live = !isTerminal(migration.status);
  const timeline = usePoll(() => or404(api.timeline(migration.id)), live ? 5000 : null, [migration.id, migration.version]);
  const plan = usePoll(() => or404(api.latestPlan(migration.id)), null, [migration.id]);
  const evidence = timeline.data ? stopEvidence(timeline.data.items, into) : null;
  const rows = evidence?.judgement ? judgementRows(evidence.judgement, plan.data?.rollbackCriteria) : [];
  return (
    <FoldTile title="멈춘 이유" summary={reason.label} defaultOpen={defaultOpen}>
      {hint && <p className={`${s.note} t-body-sm c-secondary`}>{reason.hint}</p>}
      <ul className={s.rows}>
        {rows.map((row) => (
          <li key={row.name} className={s.row}>
            <span className="t-label-md">{row.name}</span>
            <span className={`${s.rowValue} t-code-sm c-secondary`}>{row.value}</span>
          </li>
        ))}
        {evidence?.rule && (
          <li className={s.row}>
            <span className="t-label-md">가드레일 규칙</span>
            <CodeValue value={evidence.rule} className={s.rowValue} />
          </li>
        )}
        {migration.failureCode && (
          <li className={s.row}>
            <span className="t-label-md">사유 코드</span>
            <CodeValue value={migration.failureCode} className={s.rowValue} />
          </li>
        )}
      </ul>
      {analysis && (
        <div className={s.agent}>
          <p className="t-caption c-tertiary">{analysisCaption(analysis)}</p>
          <p className="t-body-sm">{analysis.cause}</p>
          {analysis.fix.length > 0 && (
            <div>
              <p className="t-label-sm c-tertiary">고칠 것</p>
              <ul className="t-body-sm c-secondary">
                {analysis.fix.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
          {analysis.evidence.length > 0 && (
            <div>
              <p className="t-label-sm c-tertiary">근거</p>
              <ul className="t-body-sm c-secondary">
                {analysis.evidence.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </FoldTile>
  );
}

/** 트래픽을 옮기는 동안 내린 판정 요약 (증적 리포트의 traffic). 끊김 없이 옮겼는지, 어디서 나빠졌는지의 근거다. */
export function TrafficReportFold({ migration }: { migration: MigrationView }) {
  const report = usePoll(() => or404(api.report(migration.id)), isTerminal(migration.status) ? null : 10_000, [migration.id]);
  const traffic = report.data?.traffic ?? null;
  const rows = traffic ? trafficReportRows(traffic) : [];
  return (
    <FoldTile title="전환 판정" summary={traffic ? (traffic.bad > 0 ? `나쁨 ${traffic.bad}번` : `판정 ${traffic.judgements}번 · 나쁨 없음`) : '아직 없음'} defaultOpen={false}>
      {rows.length > 0 ? (
        <ul className={s.rows}>
          {rows.map((row) => (
            <li key={row.name} className={s.row}>
              <span className="t-label-md">{row.name}</span>
              <span className={`${s.rowValue} t-code-sm c-secondary`}>{row.value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`${s.note} t-body-sm c-tertiary`}>{report.loading ? '리포트를 읽고 있습니다.' : '트래픽을 옮긴 기록이 없습니다.'}</p>
      )}
    </FoldTile>
  );
}

type LeftoverFoldProps = {
  migration: MigrationView;
  title: string;
  defaultOpen?: boolean;
  children?: ReactNode;
};

/**
 * 도착 환경에 남은 이 이전의 자원. 서버가 도착 환경 재고(GET /environments/:id/inventory)에서
 * 이전 상태와 감사 기록으로 낸 목록이라, 클라우드에서 직접 센 값이 아니라고 함께 적는다.
 */
export function LeftoverFold({ migration, title, defaultOpen = true, children }: LeftoverFoldProps) {
  const inventory = usePoll(() => or404(api.envInventory(migration.targetEnvId)), null, [migration.targetEnvId, migration.version]);
  const left = inventory.data ? leftoversOf(inventory.data.apps, migration.id) : null;
  const summary = inventory.loading ? '확인 중' : left === null ? '모름' : left.length > 0 ? `남은 자원 ${left.length}개` : '남은 자원 없음';
  return (
    <FoldTile title={title} summary={summary} defaultOpen={defaultOpen}>
      {left && left.length > 0 ? (
        <>
          <ul className={s.rows}>
            {left.map((resource) => (
              <li key={`${resource.type}-${resource.label}`} className={s.row}>
                <span className="t-label-md">{resource.label}</span>
                <span className={`${s.rowValue} t-caption ${resource.state === 'left' ? 'c-warning' : 'c-tertiary'}`}>{leftoverValue(resource)}</span>
              </li>
            ))}
          </ul>
          <p className={`${s.note} t-caption c-tertiary`}>마이그레이션 상태와 감사 기록으로 낸 목록입니다. 클라우드에서 직접 센 값은 아닙니다.</p>
        </>
      ) : (
        <p className={`${s.note} t-body-sm c-secondary`}>
          {inventory.loading ? '도착 환경을 읽고 있습니다.' : left === null ? '도착 환경 재고에서 이 마이그레이션을 찾지 못했습니다.' : '서버 기록으로는 도착에 남은 자원이 없습니다.'}
        </p>
      )}
      {children}
    </FoldTile>
  );
}

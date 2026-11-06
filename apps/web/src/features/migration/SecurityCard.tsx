import { useState } from 'react';
import { FoldTile } from '../../components/layout/tiles';
import { Badge } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { SecurityDot, SecurityLegend } from '../../components/ui/Security';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import type { LedgerRow, LiveCheckState, RegressionChange, SecArea, SecState, SecurityView } from '../../lib/security-types';
import { isTerminal } from '../../lib/status';
import type { MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { Section } from '../common/Section';
import { controlRows, ledgerOrder, ledgerSummary, securityCardSummary, securityHeadline, threatsFrom, type Threat } from '../security/model';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

// 이전 한 건의 보안. 예전에는 상단 "보안" 탭에서 이전을 골라야 보였다. 이제 계획 승인부터 이전 화면 근거 칸에 작은 카드로 나오고,
// 펼치면 그 탭이 보이던 것(요약 숫자·통제 표·옮긴 뒤 달라지는 것·가드레일·위협·임시 권한·실제 점검·항목별 근거)을 모두 본다.
// 서버: GET /migrations/:id/security, …/security/regression, POST …/security/check, 계획서 되돌림 기준, 리포트 거부 기록, 환경 Agent 보고

const AREA: Record<SecArea, string> = { temp_credentials: t('임시 자격'), least_privilege: t('최소 권한'), audit: t('감사 기록'), secrets: t('비밀값'), runtime: t('런타임'), controls: t('통제') };
const STATE: Record<SecState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ok: { label: t('지켜짐'), tone: 'success' }, warn: { label: t('약점'), tone: 'warning' }, fail: { label: t('위반'), tone: 'danger' }, not_implemented: { label: t('미구현'), tone: 'neutral' }, n_a: { label: t('해당 없음'), tone: 'neutral' },
};
const LIVE: Record<LiveCheckState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  pass: { label: t('통과'), tone: 'success' }, warn: { label: t('약점'), tone: 'warning' }, fail: { label: t('위반'), tone: 'danger' }, unavailable: { label: t('못 읽음'), tone: 'neutral' }, n_a: { label: t('해당 없음'), tone: 'neutral' },
};
const CHANGE: Record<RegressionChange, { label: string; tone: 'success' | 'danger' | 'neutral' }> = {
  worse: { label: t('나빠짐'), tone: 'danger' }, better: { label: t('좋아짐'), tone: 'success' }, same: { label: t('같음'), tone: 'neutral' }, unknown: { label: t('비교 불가'), tone: 'neutral' },
};
const ORDER: RegressionChange[] = ['worse', 'unknown', 'better', 'same'];
const SEVERITY: Record<string, string> = { critical: t('치명'), high: t('높음'), medium: t('중간'), low: t('낮음'), info: t('참고') };
const PURPOSE: Record<LedgerRow['purpose'], string> = { observe: t('관찰'), operate: t('실행') };
const LEDGER_STATUS: Record<LedgerRow['status'], string> = { active: t('쓰는 중'), revoke_requested: t('회수 요청'), revoked: t('회수됨'), expired: t('만료됨') };

const minutes = (sec: number) => (sec % 60 === 0 ? t('{0}분', { 0: sec / 60 }) : t('{0}초', { 0: sec }));

type DetailProps = {
  migration: MigrationView;
  view: SecurityView | null;
  reading: boolean;
  threats: Threat[];
  stoppedByRule: boolean;
  onChecked: () => void;
};

/** 펼쳤을 때만 그린다. 계획서·리포트·회귀는 이때 읽는다. */
function SecurityDetail({ migration, view, reading, threats, stoppedByRule, onChecked }: DetailProps) {
  const live = !isTerminal(migration.status);
  const regression = usePoll(() => or404(api.securityRegression(migration.id)), live ? 10_000 : null, [migration.id]);
  const plan = usePoll(() => or404(api.latestPlan(migration.id)), null, [migration.id, migration.version]);
  const report = usePoll(() => or404(api.report(migration.id)), live ? 10_000 : null, [migration.id]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await api.securityCheck(migration.id);
      onChecked();
      void regression.reload();
    } catch (reason) {
      setCheckError(errorText(reason));
    } finally {
      setChecking(false);
    }
  };

  const compare = regression.data ?? null;
  const headline = securityHeadline(view, compare);
  const controls = view?.controlMatrix ? controlRows(view.controlMatrix) : [];
  const changes = [...(compare?.items ?? [])].sort((a, b) => ORDER.indexOf(a.change) - ORDER.indexOf(b.change));
  const incidents = report.data?.incidents.filter((item) => item.result === 'denied') ?? [];
  const ledger = view?.ledger ?? null;
  const count = ledger ? ledgerSummary(ledger) : null;
  const areas = Object.keys(AREA) as SecArea[];

  return (
    <div className={s.secDetail}>
      <p className={`${s.note} t-body-md ${headline.stop ? 'c-danger' : 'c-secondary'}`}>{headline.title.replace('\n', ' ')}</p>
      {view && (
        <ul className={`${s.heroStats} ${s.secStats}`}>
          <li><span className="t-metric-lg">{view.summary.ok}</span><span className="t-caption c-tertiary">{t('지켜짐')}</span></li>
          <li><span className="t-metric-lg">{view.summary.warn}</span><span className="t-caption c-tertiary">{t('약점')}</span></li>
          <li><span className="t-metric-lg">{view.summary.fail}</span><span className="t-caption c-tertiary">{t('위반')}</span></li>
          <li><span className="t-metric-lg">{view.summary.notImplemented}</span><span className="t-caption c-tertiary">{t('미구현')}</span></li>
        </ul>
      )}

      <Section title={t('통제 표')} summary={controls.length > 0 ? t('{0}개 · 출발·도착', { 0: controls.length }) : reading ? t('읽는 중') : t('없음')} defaultOpen>
        <div className={`${s.matrixRow} t-caption c-tertiary`}>
          <span>{t('통제')}</span>
          <span className={s.matrixCell}>{t('출발')}</span>
          <span className={s.matrixCell}>{t('도착')}</span>
        </div>
        {controls.map((control) => (
          <div key={control.id} className={s.matrixRow}>
            <span className="t-body-sm" title={control.reason || undefined}>{control.title}</span>
            <span className={s.matrixCell}><SecurityDot status={control.source} /></span>
            <span className={s.matrixCell}><SecurityDot status={control.target} /></span>
          </div>
        ))}
        {!reading && controls.length === 0 && <p className="t-body-sm c-tertiary">{t('아직 통제 표가 없습니다.')}</p>}
        <SecurityLegend />
      </Section>

      <Section title={t('옮긴 뒤 달라지는 것')} summary={compare?.verdict === 'unavailable' || !compare ? t('비교 전') : t('나빠짐 {0}', { 0: compare.summary.worse })} defaultOpen={compare?.verdict === 'regressed'}>
        {changes.length > 0 ? (
          <ul className={s.rows}>
            {changes.map((item) => (
              <li key={item.key} className={s.row}>
                <span className="t-body-sm" title={item.afterEvidence ?? undefined}>{item.title}</span>
                <Badge tone={CHANGE[item.change].tone}>{CHANGE[item.change].label}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`${s.note} t-body-sm c-tertiary`}>{t('출발과 도착을 한 번씩 점검하면 비교합니다. 아래 "지금 점검"이 두 쪽을 함께 점검합니다.')}</p>
        )}
      </Section>

      <Section title={t('가드레일')} summary={stoppedByRule ? t('멈춤') : live ? t('감시 중') : t('끝남')} defaultOpen={stoppedByRule || incidents.length > 0}>
        <div className={s.agent}>
          {stoppedByRule && <p className="t-body-sm c-danger">{t('가드레일이 이 마이그레이션을 멈췄습니다.')}</p>}
          {plan.data ? (
            <p className="t-body-sm c-secondary">
              {t('오류율 {0}% 초과 또는 응답 시간 {1}배 초과가 {2}초 창에서 보이면 되돌립니다.', { 0: plan.data.rollbackCriteria.errorRatePct, 1: plan.data.rollbackCriteria.p95Multiplier, 2: plan.data.rollbackCriteria.windowSec })}
            </p>
          ) : (
            <p className="t-body-sm c-tertiary">{t('계획서가 생기면 되돌림 기준이 보입니다.')}</p>
          )}
          {incidents.map((item) => (
            <div key={item.seq} className={s.formRow}>
              <span className="t-body-sm">{item.note || item.action}</span>
              <Badge tone="warning">{t('거부')}</Badge>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('위협')} summary={t('{0}건', { 0: threats.length })} defaultOpen={threats.length > 0}>
        {threats.length > 0 ? (
          <ul className={s.rows}>
            {threats.map((threat) => (
              <li key={threat.key} className={s.row}>
                <span className="t-body-sm" title={threat.evidence || undefined}>{threat.title}</span>
                <Badge tone={/high|critical/i.test(threat.severity) ? 'danger' : 'warning'}>{SEVERITY[threat.severity] ?? threat.severity}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`${s.note} t-body-sm c-tertiary`}>{t('Agent가 보낸 위협 보고가 없습니다.')}</p>
        )}
      </Section>

      <Section
        title={t('임시 권한')}
        summary={!count ? (reading ? t('읽는 중') : t('장부 없음')) : count.stale > 0 ? t('만료됐는데 남음 {0}', { 0: count.stale }) : t('쓰는 중 {0} · 끝남 {1}', { 0: count.live, 1: count.closed })}
        defaultOpen={(count?.stale ?? 0) > 0}
      >
        {ledger && ledger.length > 0 ? (
          <ul className={s.rows}>
            {ledgerOrder(ledger).map((row) => (
              <li key={row.credentialRef} className={s.row}>
                <span className="t-label-md">
                  {t('{0} 역할{1}', { 0: PURPOSE[row.purpose], 1: (row.step ?? row.stage) ? ` · ${row.step ?? row.stage}` : '' })}
                </span>
                <span className={`${s.rowValue} t-caption ${row.expiredButActive ? 'c-warning' : 'c-tertiary'}`}>
                  {row.expiredButActive ? t('만료됐는데 남음') : LEDGER_STATUS[row.status]} · {minutes(row.ttlSec)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`${s.note} t-body-sm c-tertiary`}>{ledger ? t('아직 빌린 임시 권한이 없습니다.') : t('서버에 임시 권한 장부가 아직 없습니다.')}</p>
        )}
      </Section>

      <Section title={t('실제 점검')} summary={view?.live ? t('{0}개 환경', { 0: view.live.length }) : t('꺼짐')}>
        <div className={s.agent}>
          {view?.live?.map((side) => (
            <div key={side.side}>
              <p className="t-label-sm c-tertiary">
                {side.side === 'source' ? t('출발') : t('도착')} {side.provider}
                {side.reason ? ` · ${side.reason}` : ''}
              </p>
              {side.checks.map((item) => (
                <div key={item.key} className={s.formRow}>
                  <span className="t-body-sm" title={item.evidence}>{item.title}</span>
                  <Badge tone={LIVE[item.state].tone}>{LIVE[item.state].label}</Badge>
                </div>
              ))}
            </div>
          ))}
          {(!view?.live || view.live.length === 0) && <p className="t-body-sm c-tertiary">{t('서버가 실제 점검을 꺼 두었거나 아직 결과가 없습니다.')}</p>}
        </div>
      </Section>

      <Section title={t('항목별 근거')} summary={t('{0}줄', { 0: view?.rows.length ?? 0 })}>
        <div className={s.agent}>
          {areas.map((area) => {
            const rows = view?.rows.filter((row) => row.area === area && row.state !== 'n_a') ?? [];
            if (rows.length === 0) return null;
            return (
              <div key={area}>
                <p className="t-label-sm c-tertiary">{AREA[area]}</p>
                {rows.map((row) => (
                  <div key={row.id} className={s.formRow}>
                    <span className="t-body-sm" title={row.value}>{row.item}</span>
                    <Badge tone={STATE[row.state].tone}>{STATE[row.state].label}</Badge>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </Section>

      <div className={s.secFoot}>
        <span className="t-caption c-tertiary">{t('서버가 확인한 값만 보여 줍니다. 값이 없는 칸은 미구현입니다.')}</span>
        <button type="button" className={s.linkPill} disabled={checking} onClick={() => void check()}>
          <Icon name="shield" />
          <span className="t-label-md">{checking ? t('점검 중') : t('지금 점검')}</span>
        </button>
        {checkError && <p className={`${s.error} t-body-sm`}>{checkError}</p>}
      </div>
    </div>
  );
}

/**
 * 근거 칸의 "보안" 카드. 접힌 채로는 머리줄에 요약만, 펼치면 예전 보안 탭의 내용을 모두 본다.
 * 가드레일 멈춤·위협·만료됐는데 남은 권한이 있으면 스스로 펼친다. 계획 승인부터 이전이 끝날 때까지 나온다.
 */
export function SecurityFold({ migration }: { migration: MigrationView }) {
  const live = !isTerminal(migration.status);
  const view = usePoll(() => or404(api.security(migration.id)), live ? 10_000 : null, [migration.id]);
  const reports = usePoll(
    () => Promise.all([migration.sourceEnvId, migration.targetEnvId].map((env) => or404(api.agentReports(env)))),
    live ? 15_000 : null,
    [migration.id],
  );
  const threats = threatsFrom(reports.data ?? []);
  const stoppedByRule = migration.status === 'paused' && !migration.failureCode;
  const reading = !view.data && view.loading;
  const { summary, open } = securityCardSummary({ view: view.data ?? null, threats: threats.length, stoppedByRule, reading });
  return (
    <FoldTile key={`security-${open}`} title={t('보안')} summary={summary} defaultOpen={open}>
      <SecurityDetail
        migration={migration}
        view={view.data ?? null}
        reading={reading}
        threats={threats}
        stoppedByRule={stoppedByRule}
        onChecked={() => void view.reload()}
      />
    </FoldTile>
  );
}

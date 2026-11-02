import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, SkeletonTile, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { SkeletonRows, SkeletonStats } from '../../components/ui/Skeleton';
import { ActionPill, Badge } from '../../components/ui/controls';
import { SecurityDot, SecurityLegend } from '../../components/ui/Security';
import { api } from '../../lib/api';
import { or404 } from '../../lib/http';
import type { LedgerRow, LiveCheckState, RegressionChange, SecArea, SecState } from '../../lib/security-types';
import { isTerminal } from '../../lib/status';
import type { MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { useAction } from '../migration/shared';
import { ShellLayout } from '../shell/ShellLayout';
import { useChosenMigration } from '../shell/useChosenMigration';
import { controlRows, ledgerOrder, ledgerSummary, securityHeadline, threatsFrom } from './model';
import s from '../common/page.module.css';

const LAYOUT: BentoLayout = { columns: ['fill', 'side', 'side'], areas: 'hero matrix side' };

const AREA: Record<SecArea, string> = { temp_credentials: '임시 자격', least_privilege: '최소 권한', audit: '감사 기록', secrets: '비밀값', runtime: '런타임', controls: '통제' };
const STATE: Record<SecState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ok: { label: '지켜짐', tone: 'success' }, warn: { label: '약점', tone: 'warning' }, fail: { label: '위반', tone: 'danger' }, not_implemented: { label: '미구현', tone: 'neutral' }, n_a: { label: '해당 없음', tone: 'neutral' },
};
const LIVE: Record<LiveCheckState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  pass: { label: '통과', tone: 'success' }, warn: { label: '약점', tone: 'warning' }, fail: { label: '위반', tone: 'danger' }, unavailable: { label: '못 읽음', tone: 'neutral' }, n_a: { label: '해당 없음', tone: 'neutral' },
};
const CHANGE: Record<RegressionChange, { label: string; tone: 'success' | 'danger' | 'neutral' }> = {
  worse: { label: '나빠짐', tone: 'danger' }, better: { label: '좋아짐', tone: 'success' }, same: { label: '같음', tone: 'neutral' }, unknown: { label: '비교 불가', tone: 'neutral' },
};
const ORDER: RegressionChange[] = ['worse', 'unknown', 'better', 'same'];
const SEVERITY: Record<string, string> = { critical: '치명', high: '높음', medium: '중간', low: '낮음', info: '참고' };
const PURPOSE: Record<LedgerRow['purpose'], string> = { observe: '관찰', operate: '실행' };
const LEDGER_STATUS: Record<LedgerRow['status'], string> = { active: '쓰는 중', revoke_requested: '회수 요청', revoked: '회수됨', expired: '만료됨' };

const minutes = (sec: number) => (sec % 60 === 0 ? `${sec / 60}분` : `${sec}초`);

/**
 * 임시 권한 장부. 고객 환경은 키가 아니라 단계마다 빌린 임시 역할로만 만진다는 약속의 근거다.
 * 만료 시각이 지났는데 회수 처리가 안 된 줄은 예외라 맨 위에 두고 카드를 펼친다.
 */
function LedgerFold({ rows, reading }: { rows: LedgerRow[] | null; reading: boolean }) {
  const count = rows ? ledgerSummary(rows) : null;
  const summary = !count ? (reading ? '읽는 중' : '장부 없음') : count.stale > 0 ? `만료됐는데 남음 ${count.stale}` : `쓰는 중 ${count.live} · 끝남 ${count.closed}`;
  return (
    <FoldTile key={`ledger-${(count?.stale ?? 0) > 0}`} title="임시 권한" summary={summary} defaultOpen={(count?.stale ?? 0) > 0}>
      {rows && rows.length > 0 ? (
        <ul className={s.rows}>
          {ledgerOrder(rows).map((row) => (
            <li key={row.credentialRef} className={s.row}>
              <span className="t-label-md">
                {PURPOSE[row.purpose]} 역할{(row.step ?? row.stage) ? ` · ${row.step ?? row.stage}` : ''}
              </span>
              <span className={`${s.rowValue} t-caption ${row.expiredButActive ? 'c-warning' : 'c-tertiary'}`}>
                {row.expiredButActive ? '만료됐는데 남음' : LEDGER_STATUS[row.status]} · {minutes(row.ttlSec)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`${s.note} t-body-sm c-tertiary`}>{rows ? '아직 빌린 임시 권한이 없습니다.' : '서버에 임시 권한 장부가 아직 없습니다.'}</p>
      )}
    </FoldTile>
  );
}

function SecurityBody({ migration }: { migration: MigrationView }) {
  const live = !isTerminal(migration.status);
  const view = usePoll(() => or404(api.security(migration.id)), live ? 5000 : null, [migration.id]);
  const regression = usePoll(() => or404(api.securityRegression(migration.id)), live ? 10_000 : null, [migration.id]);
  const plan = usePoll(() => or404(api.latestPlan(migration.id)), null, [migration.id, migration.version]);
  const report = usePoll(() => or404(api.report(migration.id)), live ? 10_000 : null, [migration.id]);
  const reports = usePoll(
    () => Promise.all([migration.sourceEnvId, migration.targetEnvId].map((env) => or404(api.agentReports(env)))),
    live ? 15_000 : null,
    [migration.id],
  );
  const { busy, error, run } = useAction(() => {
    void view.reload();
    void regression.reload();
  });
  const data = view.data ?? null;
  const compare = regression.data ?? null;
  const reading = !data && view.loading;
  const headline = !data && !reading ? { stop: false, title: '아직 보안 표가\n없습니다' } : securityHeadline(data, compare);
  const controls = data?.controlMatrix ? controlRows(data.controlMatrix) : [];
  const threats = threatsFrom(reports.data ?? []);
  const items = [...(compare?.items ?? [])].sort((a, b) => ORDER.indexOf(a.change) - ORDER.indexOf(b.change));
  const incidents = report.data?.incidents.filter((item) => item.result === 'denied') ?? [];
  const byRule = migration.status === 'paused' && !migration.failureCode;
  const areas = Object.keys(AREA) as SecArea[];

  return (
    <>
      <Hero tone={headline.stop ? 'stop' : 'run'} meta="이전 보안" title={headline.title} foot="서버가 확인한 값만 보여 줍니다. 값이 없는 칸은 미구현으로 표시합니다">
        {reading && <SkeletonStats count={4} />}
        {data && (
          <ul className={`${s.heroStats} ${headline.stop ? s.onAlert : ''}`}>
            <li><span className="t-metric-lg">{data.summary.ok}</span><span className="t-caption">지켜짐</span></li>
            <li><span className="t-metric-lg">{data.summary.warn}</span><span className="t-caption">약점</span></li>
            <li><span className="t-metric-lg">{data.summary.fail}</span><span className="t-caption">위반</span></li>
            <li><span className="t-metric-lg">{data.summary.notImplemented}</span><span className="t-caption">미구현</span></li>
          </ul>
        )}
      </Hero>
      <Tile area="matrix" compact scroll>
        <TileHeader title="통제 표" />
        <div className={`${s.matrixRow} t-caption c-tertiary`}>
          <span>통제</span>
          <span className={s.matrixCell}>출발</span>
          <span className={s.matrixCell}>도착</span>
        </div>
        {controls.map((control) => (
          <div key={control.id} className={s.matrixRow}>
            <span className="t-body-sm" title={control.reason || undefined}>{control.title}</span>
            <span className={s.matrixCell}><SecurityDot status={control.source} /></span>
            <span className={s.matrixCell}><SecurityDot status={control.target} /></span>
          </div>
        ))}
        {reading && <SkeletonRows count={8} />}
        {!reading && controls.length === 0 && <p className="t-body-sm c-tertiary">아직 통제 표가 없습니다.</p>}
        <SecurityLegend />
      </Tile>
      <Stack area="side">
        <FoldTile title="옮긴 뒤 달라지는 것" summary={compare?.verdict === 'unavailable' || !compare ? '비교 전' : `나빠짐 ${compare.summary.worse}`}>
          {items.length > 0 ? (
            <ul className={s.rows}>
              {items.map((item) => (
                <li key={item.key} className={s.row}>
                  <span className="t-body-sm" title={item.afterEvidence ?? undefined}>{item.title}</span>
                  <Badge tone={CHANGE[item.change].tone}>{CHANGE[item.change].label}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${s.note} t-body-sm c-tertiary`}>출발과 도착을 한 번씩 점검하면 비교합니다.</p>
          )}
        </FoldTile>
        <FoldTile key={`guard-${byRule || incidents.length > 0}`} title="가드레일" summary={byRule ? '멈춤' : live ? '감시 중' : '끝남'} defaultOpen={byRule || incidents.length > 0}>
          <div className={s.agent}>
            {byRule && <p className="t-body-sm c-danger">가드레일이 이 이전을 멈췄습니다.</p>}
            {plan.data && (
              <p className="t-body-sm c-secondary">
                오류율 {plan.data.rollbackCriteria.errorRatePct}% 초과 또는 응답 시간 {plan.data.rollbackCriteria.p95Multiplier}배 초과가 {plan.data.rollbackCriteria.windowSec}초 창에서 보이면 되돌립니다.
              </p>
            )}
            {incidents.map((item) => (
              <div key={item.seq} className={s.formRow}>
                <span className="t-body-sm">{item.note || item.action}</span>
                <Badge tone="warning">거부</Badge>
              </div>
            ))}
          </div>
        </FoldTile>
        <FoldTile key={`threat-${threats.length > 0}`} title="위협" summary={`${threats.length}건`} defaultOpen={threats.length > 0}>
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
            <p className={`${s.note} t-body-sm c-tertiary`}>Agent가 보낸 위협 보고가 없습니다.</p>
          )}
        </FoldTile>
        <LedgerFold rows={data?.ledger ?? null} reading={reading} />
        <FoldTile title="실제 점검" summary={data?.live ? `${data.live.length}개 환경` : '꺼짐'} defaultOpen={false}>
          <div className={s.agent}>
            {data?.live?.map((side) => (
              <div key={side.side}>
                <p className="t-label-sm c-tertiary">
                  {side.side === 'source' ? '출발' : '도착'} {side.provider}
                  {side.reason ? ` · ${side.reason}` : ''}
                </p>
                {side.checks.map((check) => (
                  <div key={check.key} className={s.formRow}>
                    <span className="t-body-sm" title={check.evidence}>{check.title}</span>
                    <Badge tone={LIVE[check.state].tone}>{LIVE[check.state].label}</Badge>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </FoldTile>
        <FoldTile title="항목별 근거" summary={`${data?.rows.length ?? 0}줄`} defaultOpen={false}>
          <div className={s.agent}>
            {areas.map((area) => {
              const rows = data?.rows.filter((row) => row.area === area && row.state !== 'n_a') ?? [];
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
        </FoldTile>
        <ActionRow notice={error}>
          <ActionPill label={busy ? '점검 중' : '지금 점검'} icon="shield" disabled={busy} onClick={() => void run(() => api.securityCheck(migration.id))} />
        </ActionRow>
      </Stack>
    </>
  );
}

export function SecurityPage({ id }: { id: string | null }) {
  const { chosen, picker, loading } = useChosenMigration('security', id);
  if (!chosen) {
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta="이전 보안" title={loading ? '이전을\n읽고 있습니다' : '확인할 이전이\n없습니다'} />
        {loading && <SkeletonTile area="matrix" title="통제 표" rows={8} />}
      </ShellLayout>
    );
  }
  return (
    <ShellLayout layout={LAYOUT} barLeft={picker}>
      <SecurityBody key={chosen.id} migration={chosen} />
    </ShellLayout>
  );
}

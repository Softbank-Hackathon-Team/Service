import { useState } from 'react';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { ActionPill, Badge } from '../../components/ui/controls';
import { Timeline, type TimelineEntry } from '../../components/ui/Timeline';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { isTerminal, LABEL } from '../../lib/status';
import type { MigrationStatus, MigrationView, TimelineItem } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { ShellLayout } from '../shell/ShellLayout';
import { useChosenMigration } from '../shell/useChosenMigration';
import s from '../common/page.module.css';

const LAYOUT: BentoLayout = { columns: '460fr 480fr 432fr', rows: 'minmax(0, 1fr)', areas: ['hero log side'] };
const EMPTY: BentoLayout = { columns: '1fr', rows: 'minmax(0, 1fr)', areas: ['hero'] };

const time = (iso: string) => new Date(iso).toTimeString().slice(0, 8);
const statusName = (value: string | null) => (value && value in LABEL ? LABEL[value as MigrationStatus] : value ?? '');

/** 감사 줄을 화면 줄로 바꾼다. 거부된 호출도 지우지 않고 남긴다. */
export function auditEntry(item: TimelineItem): TimelineEntry {
  const denied = item.result !== 'ok' || Boolean(item.failureCode);
  const human = !['worker', 'system'].includes(item.actor);
  return {
    kind: denied ? 'denied' : human ? 'human' : 'system',
    title: item.kind === 'transition' ? `${statusName(item.from)} → ${statusName(item.to)}` : item.action,
    detail: [human ? item.actor : item.actor === 'worker' ? '워커' : '시스템', item.failureCode].filter(Boolean).join(' · '),
    time: time(item.at),
  };
}

function AuditBody({ migration }: { migration: MigrationView }) {
  const live = !isTerminal(migration.status);
  const report = usePoll(() => or404(api.report(migration.id)), live ? 10_000 : null, [migration.id]);
  const timeline = usePoll(() => or404(api.timeline(migration.id)), live ? 5_000 : null, [migration.id]);
  const [error, setError] = useState<string | null>(null);
  const data = report.data ?? null;
  const entries = [...(timeline.data?.items ?? [])].reverse().map(auditEntry);
  const broken = data ? !data.integrity.ok : false;
  const open = async () => {
    setError(null);
    try {
      const url = URL.createObjectURL(new Blob([await api.reportHtml(migration.id)], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  return (
    <>
      <Hero
        tone={broken ? 'stop' : 'run'}
        meta="감사 기록"
        title={!data ? '감사 기록을\n읽고 있습니다' : broken ? '감사 기록이\n끊겼습니다' : '감사 기록이\n온전합니다'}
        foot="줄마다 앞 줄의 지문을 품습니다. 한 줄이라도 고치면 여기서 드러납니다"
      >
        {data && (
          <ul className={`${s.heroStats} ${broken ? s.onAlert : ''}`}>
            <li><span className="t-metric-lg">{data.integrity.checked}</span><span className="t-caption">검증한 줄</span></li>
            <li><span className="t-metric-lg">{data.summary.transitions}</span><span className="t-caption">상태 이동</span></li>
            <li><span className="t-metric-lg">{data.summary.deniedOrError}</span><span className="t-caption">거부·오류</span></li>
          </ul>
        )}
        {data?.integrity.brokenAtSeq != null && <code className={`${s.code} t-code-md`}>{data.integrity.brokenAtSeq}번 줄 · {data.integrity.reason}</code>}
      </Hero>
      <Tile area="log" compact scroll>
        <TileHeader title="타임라인" />
        {entries.length > 0 ? <Timeline items={entries} /> : <p className="t-body-sm c-tertiary">아직 기록이 없습니다.</p>}
      </Tile>
      <Stack area="side">
        <FoldTile title="승인 기록" summary={`${data?.approvals.length ?? 0}건`}>
          {data && data.approvals.length > 0 ? (
            <ul className={s.rows}>
              {data.approvals.map((item) => (
                <li key={`${item.planId}-${item.at}`} className={s.row}>
                  <span className="t-body-sm">{item.decision === 'approve' ? '승인' : '거절'} · {item.approvedBy}</span>
                  <Badge tone={item.hashMatches ? 'success' : 'danger'}>{item.hashMatches ? '지문 일치' : '지문 다름'}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${s.note} t-body-sm c-tertiary`}>아직 승인 기록이 없습니다.</p>
          )}
        </FoldTile>
        <FoldTile key={`incident-${(data?.incidents.length ?? 0) > 0}`} title="거부·오류" summary={`${data?.incidents.length ?? 0}건`} defaultOpen={(data?.incidents.length ?? 0) > 0}>
          {data && data.incidents.length > 0 ? (
            <ul className={s.rows}>
              {data.incidents.map((item) => (
                <li key={item.seq} className={s.row}>
                  <span className="t-body-sm">{item.note || item.action}</span>
                  <Badge tone={item.result === 'denied' ? 'warning' : 'danger'}>{item.result === 'denied' ? '거부' : '오류'}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${s.note} t-body-sm c-tertiary`}>거부되거나 실패한 기록이 없습니다.</p>
          )}
        </FoldTile>
        {data && data.gaps.length > 0 && (
          <FoldTile title="리포트에 비어 있는 것" summary={`${data.gaps.length}건`} defaultOpen={false}>
            <ul className={`${s.note} t-body-sm c-secondary`}>
              {data.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </FoldTile>
        )}
        <ActionRow notice={error}>
          <ActionPill label="증적 리포트" icon="download" onClick={() => void open()} />
        </ActionRow>
      </Stack>
    </>
  );
}

export function AuditPage({ id }: { id: string | null }) {
  const { chosen, picker, loading } = useChosenMigration('audit', id);
  if (!chosen) {
    return (
      <ShellLayout layout={EMPTY}>
        <Hero tone="run" meta="감사 기록" title={loading ? '이전을\n읽고 있습니다' : '확인할 이전이\n없습니다'} />
      </ShellLayout>
    );
  }
  return (
    <ShellLayout layout={LAYOUT} barLeft={picker}>
      <AuditBody key={chosen.id} migration={chosen} />
    </ShellLayout>
  );
}

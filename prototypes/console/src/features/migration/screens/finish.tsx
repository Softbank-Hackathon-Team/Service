import { useState } from 'react';
import type { BentoLayout } from '../../../components/layout/ConsoleLayout';
import { Hero, StatTile, Tile, TileHeader } from '../../../components/layout/tiles';
import { ActionPill, Badge, BarPill } from '../../../components/ui/controls';
import { Timeline } from '../../../components/ui/Timeline';
import { TrafficBar } from '../../../components/ui/TrafficBar';
import { FAILED_INFO, okCount, RUN_LOG } from '../mock';
import { routeLabel, ScreenLayout, useSecurity, type ScreenProps } from './shared';
import s from './screens.module.css';

const REPORT_FORMATS = ['json', 'md', 'html'] as const;
type ReportFormat = (typeof REPORT_FORMATS)[number];

/** 실제로는 GET /migrations/:id/report를 받는다. 지금은 예시 기록으로 파일만 만들어 준다. */
function downloadReport(format: ReportFormat) {
  const lines = RUN_LOG.map((entry) => `${entry.time} ${entry.title}: ${entry.detail}`);
  const body =
    format === 'json'
      ? JSON.stringify(RUN_LOG, null, 2)
      : format === 'md'
        ? ['# 증적 리포트 (예시)', '', ...lines.map((line) => `- ${line}`)].join('\n')
        : `<!doctype html><meta charset="utf-8"><h1>증적 리포트 (예시)</h1><ul>${lines.map((line) => `<li>${line}</li>`).join('')}</ul>`;
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `report-example.${format}`;
  link.click();
  URL.revokeObjectURL(url);
}

const DONE: BentoLayout = {
  columns: '380fr 380fr 306fr 306fr',
  rows: '1fr 1fr 1fr',
  areas: ['hero hero failed writes', 'hero hero loss temp', 'hero hero lease security'],
};

export function DoneScreen({ flow }: ScreenProps) {
  const { source, target } = flow.state;
  const { rows } = useSecurity(flow);
  return (
    <ScreenLayout
      flow={flow}
      layout={DONE}
      barLeft={<BarPill label={routeLabel(flow)} />}
      barRight={<BarPill label="증적 리포트" icon="download" onClick={() => downloadReport('html')} />}
      headline="이전을 끝냈습니다"
      sub="오른쪽 수치는 이번 이전의 기록에서 가져온 값입니다."
      actions={<ActionPill label="새 이전 시작" onClick={flow.newMigration} />}
    >
      <Hero
        tone="done"
        meta="완료"
        step="10"
        title={`${source}에서 ${target}로\n멈추지 않고 옮겼습니다`}
        foot="누가 무엇을 승인했고 무엇이 실행됐는지 리포트로 남습니다"
      >
        <TrafficBar source={source} target={target} targetPercent={100} />
      </Hero>
      <StatTile area="failed" icon="check" value="0" unit="건" label="실패 요청" />
      <StatTile area="writes" icon="pause" value="3.2" unit="초" label="쓰기 멈춤" />
      <StatTile area="loss" icon="shield" value="0" unit="건" label="데이터 손실" />
      <StatTile area="temp" icon="server" value="0" unit="개" label="남은 임시 자원" />
      <StatTile area="lease" icon="lock" value="회수" label="빌린 변경 권한" />
      <StatTile
        area="security"
        icon="matrix"
        value={`${okCount(rows, target)}`}
        unit={`/ ${rows.length}`}
        label={`보안 통과, 이전 전 ${okCount(rows, source)}`}
       
      />
    </ScreenLayout>
  );
}

const ROLLED_BACK: BentoLayout = {
  columns: '780fr 296fr 296fr',
  rows: '1fr 1fr',
  areas: ['hero reason reason', 'hero failed loss'],
};

export function RolledBackScreen({ flow }: ScreenProps) {
  const { source, target, rollbackCause } = flow.state;
  const [reason, setReason] = useState('');
  const needsReason = rollbackCause !== 'manual' && reason.trim() === '';
  return (
    <ScreenLayout
      flow={flow}
      layout={ROLLED_BACK}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="계획을 다시 만드세요"
      sub={`같은 이전을 이어서 하지 않고 새 계획부터 시작합니다. ${target}는 원인 조사를 위해 남겨 뒀습니다.`}
      actions={
        <ActionPill
          label="계획 다시 만들기"
          icon="refresh"
          disabled={needsReason}
          onClick={() => flow.go('spec', { replicas: { ...flow.state.replicas, confirmed: false }, resources: { ...flow.state.resources, confirmed: false } })}
        />
      }
    >
      <Hero tone="run" meta="롤백 완료" step="←" title={`트래픽을 모두\n${source}로 되돌렸습니다`}>
        <TrafficBar source={source} target={target} targetPercent={0} />
      </Hero>
      <Tile area="reason">
        <TileHeader title={rollbackCause === 'manual' ? '원인 메모 (선택)' : '원인 한 줄 (필수)'} />
        <textarea
          className={s.textarea}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="원인을 적기 전에는 자동 롤백 뒤 다시 시작할 수 없습니다"
        />
      </Tile>
      <StatTile area="failed" icon="check" value="0" unit="건" label="되돌리는 동안 실패한 요청" />
      <StatTile area="loss" icon="shield" value="0" unit="건" label="데이터 손실" />
    </ScreenLayout>
  );
}

const FAILED: BentoLayout = {
  columns: '780fr 592fr',
  rows: '1fr',
  areas: ['hero left'],
};

export function FailedScreen({ flow }: ScreenProps) {
  const { cleanupConfirmed } = flow.state;
  return (
    <ScreenLayout
      flow={flow}
      layout={FAILED}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="이전이 실패했습니다"
      sub="남은 자원을 정리했다고 확인해야 취소할 수 있습니다. 자원을 만들기 전 실패라면 다시 계획할 수 있습니다."
      actions={
        <>
          <BarPill label="취소" icon="x" onClick={cleanupConfirmed ? () => flow.go('cancelled') : undefined} />
          <ActionPill label="계획 다시 만들기" icon="refresh" onClick={flow.confirmSpec} />
        </>
      }
    >
      <Hero tone="stop" meta={`${FAILED_INFO.at}에서 실패`} step="!" title={'작업이\n끝나지 못했습니다'} foot={FAILED_INFO.detail}>
        <code className={`${s.causeCode} t-code-md`}>{FAILED_INFO.code}</code>
      </Hero>
      <Tile area="left" spread>
        <TileHeader title="남아 있을 수 있는 자원" action={<Badge tone="warning">{FAILED_INFO.leftovers.length}개</Badge>} />
        <ul className={s.plainList}>
          {FAILED_INFO.leftovers.map((item) => (
            <li key={item} className="t-body-md">
              {item}
            </li>
          ))}
        </ul>
        <label className={`${s.confirmRow} t-body-md`}>
          <input
            type="checkbox"
            checked={cleanupConfirmed}
            onChange={(event) => flow.patch({ cleanupConfirmed: event.target.checked })}
          />
          남은 자원을 직접 정리했습니다
        </label>
      </Tile>
    </ScreenLayout>
  );
}

const CANCELLED: BentoLayout = { columns: '1fr', rows: '1fr', areas: ['hero'] };

export function CancelledScreen({ flow }: ScreenProps) {
  return (
    <ScreenLayout
      flow={flow}
      layout={CANCELLED}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="이전을 취소했습니다"
      sub="환경 잠금을 풀었습니다. 취소한 사람과 이유는 감사 기록에 남습니다."
      actions={<ActionPill label="대시보드로" onClick={() => flow.go('dashboard')} />}
    >
      <Hero tone="run" meta="취소" step="×" title={'이 이전은\n여기서 끝났습니다'} />
    </ScreenLayout>
  );
}

const LOG: BentoLayout = {
  columns: '880fr 492fr',
  rows: '1fr 1fr',
  areas: ['log chain', 'log report'],
};

export function LogScreen({ flow }: ScreenProps) {
  return (
    <ScreenLayout flow={flow} layout={LOG} barLeft={<BarPill label={routeLabel(flow)} />}>
      <Tile area="log" scroll>
        <TileHeader title="이번 이전의 기록. 거부된 호출도 지우지 않습니다." />
        <div className={s.logList}>
          <Timeline items={RUN_LOG} />
        </div>
      </Tile>
      <Tile area="chain" spread>
        <TileHeader title="기록 무결성" action={<Badge tone="success">끊김 없음</Badge>} />
        <p className={s.summaryValue}>
          <span className="t-metric-xl">{RUN_LOG.length}</span>
          <span className="t-h3 c-secondary">줄 검증</span>
        </p>
        <p className="t-body-sm c-secondary">중간에 지우거나 고치면 다시 계산할 때 드러납니다.</p>
      </Tile>
      <Tile area="report" spread>
        <TileHeader title="증적 리포트" />
        <p className="t-body-sm c-secondary">승인 지문과 타임라인을 한 문서로 묶습니다.</p>
        <div className={s.optionRow}>
          {REPORT_FORMATS.map((format) => (
            <BarPill key={format} label={format.toUpperCase()} icon="download" onClick={() => downloadReport(format)} />
          ))}
        </div>
      </Tile>
    </ScreenLayout>
  );
}

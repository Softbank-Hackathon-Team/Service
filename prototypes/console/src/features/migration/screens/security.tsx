import { useState } from 'react';
import type { BentoLayout } from '../../../components/layout/ConsoleLayout';
import { StatTile, Tile, TileHeader } from '../../../components/layout/tiles';
import { Badge, BarPill, NavPills } from '../../../components/ui/controls';
import { SecurityCell, STATUS_LABEL } from '../../../components/ui/Security';
import {
  attestKey,
  CELL_BLIND_SPOT,
  ENVS,
  GUARDRAIL_STAGES,
  regressions,
  THREATS,
  type EnvId,
} from '../mock';
import { routeLabel, ScreenLayout, useSecurity, type ScreenProps } from './shared';
import s from './screens.module.css';

const SECTIONS = [
  { id: 'security', label: '보안 표' },
  { id: 'threats', label: '위협' },
  { id: 'guardrails', label: '가드레일' },
];

function SectionTabs({ flow }: ScreenProps) {
  return <NavPills items={SECTIONS} current={flow.screen} onSelect={(id) => flow.go(id as 'security')} />;
}

const MATRIX: BentoLayout = { columns: '1fr', rows: 'auto 1fr', areas: ['compare', 'panel'] };
const MATRIX_WITH_CELL: BentoLayout = {
  columns: '980fr 372fr',
  rows: 'auto 1fr',
  areas: ['compare evidence', 'panel evidence'],
};

export function SecurityScreen({ flow }: ScreenProps) {
  const { rows } = useSecurity(flow);
  const { source, target, attested } = flow.state;
  const [cell, setCell] = useState<{ controlId: string; env: EnvId } | null>(null);
  const backward = regressions(rows, source, target);
  const role = (env: EnvId) => (env === source ? ' · 출발' : env === target ? ' · 도착' : '');
  const selected = cell && rows.find((row) => row.id === cell.controlId);
  const selectedStatus = selected && cell ? selected.byEnv[cell.env] : null;
  return (
    <ScreenLayout
      flow={flow}
      layout={selected ? MATRIX_WITH_CELL : MATRIX}
      barLeft={<SectionTabs flow={flow} />}
    >
      <Tile area="compare">
        <div className={s.matrixHead}>
          <h1 className="t-h1">통제 {rows.length}개 × 환경 {ENVS.length}개</h1>
          <span className={s.compareResult}>
            <span className="t-body-md c-secondary">
              {source} → {target} 전후 비교
            </span>
            <Badge tone={backward.length > 0 ? 'danger' : 'success'}>후퇴 {backward.length}개</Badge>
            {backward.length > 0 && <span className="t-code-sm">{backward.map((row) => row.id).join(', ')}</span>}
          </span>
        </div>
      </Tile>
      <Tile area="panel">
        <div className={s.matrixWrap}>
          <table className={s.matrix}>
            <thead>
              <tr className="t-label-md c-secondary">
                <th scope="col" className={s.matrixRule}>
                  통제
                </th>
                {ENVS.map((env) => (
                  <th key={env} scope="col" className={s.matrixEnv}>
                    {env}
                    {role(env)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <span className={s.ruleName}>
                      <span className="t-label-md">{row.name}</span>
                      <span className="t-caption c-tertiary">{row.id}</span>
                    </span>
                  </th>
                  {ENVS.map((env) => (
                    <td key={env}>
                      <button
                        type="button"
                        className={s.cellButton}
                        aria-label={`${row.id} ${env} 근거 보기`}
                        aria-pressed={cell?.controlId === row.id && cell.env === env}
                        onClick={() => setCell({ controlId: row.id, env })}
                      >
                        <SecurityCell status={row.byEnv[env]} />
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>
      {selected && cell && selectedStatus && (
        <Tile area="evidence" scroll>
          <TileHeader title={`${selected.id} · ${cell.env}`} action={<BarPillClose onClick={() => setCell(null)} />} />
          <h2 className="t-h2">{selected.name}</h2>
          <div className={s.evidenceStatus}>
            <SecurityCell status={selectedStatus} />
          </div>
          <ul className={s.plainList}>
            <li className={s.stackedRow}>
              <span className="t-label-md">검사 도구</span>
              <span className="t-body-sm c-secondary">{selected.tools}</span>
            </li>
            <li className={s.stackedRow}>
              <span className="t-label-md">근거</span>
              <span className="t-body-sm c-secondary">
                {selectedStatus === 'unknown'
                  ? '결과가 없거나 30분이 넘었습니다.'
                  : selectedStatus === 'na'
                    ? '이 환경에는 검사가 없습니다.'
                    : selectedStatus === 'attested'
                      ? '사람이 확인했습니다. 24시간 유효합니다.'
                      : `최근 결과 ${STATUS_LABEL[selectedStatus]}. 검사 5개 중 5개가 결과를 냈습니다.`}
              </span>
            </li>
            {selected.id === 'VIO-04' && (
              <li className={s.stackedRow}>
                <span className="t-label-md">이 환경의 눈이 못 보는 것</span>
                <span className="t-body-sm c-secondary">{CELL_BLIND_SPOT[cell.env]}</span>
              </li>
            )}
          </ul>
          {selectedStatus === 'unknown' && (
            <BarPill
              label={attested[attestKey(selected.id, cell.env)] ? '확인함' : '사람이 직접 확인'}
              icon="user-check"
              onClick={() => flow.attest(attestKey(selected.id, cell.env))}
            />
          )}
        </Tile>
      )}
    </ScreenLayout>
  );
}

function BarPillClose({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={`${s.closeButton} t-label-sm`} onClick={onClick}>
      닫기
    </button>
  );
}

const THREATS_LAYOUT: BentoLayout = {
  columns: '980fr 372fr',
  rows: '1fr 1fr',
  areas: ['list active', 'list eyes'],
};

export function ThreatsScreen({ flow }: ScreenProps) {
  const { acknowledged } = flow.state;
  const active = THREATS.filter((threat) => !acknowledged[threat.id]).length;
  return (
    <ScreenLayout flow={flow} layout={THREATS_LAYOUT} barLeft={<SectionTabs flow={flow} />}>
      <Tile area="list" scroll>
        <TileHeader title="세 환경의 위협 알림" />
        <ul className={s.plainList}>
          {THREATS.map((threat) => {
            const done = acknowledged[threat.id];
            return (
              <li key={threat.id} className={s.threatRow}>
                <div className={s.stackedRow}>
                  <span className="t-label-md">{threat.title}</span>
                  <span className="t-caption c-tertiary">
                    {threat.env} · {threat.source} · {threat.time}
                  </span>
                </div>
                <Badge tone={threat.severity === '높음' ? 'danger' : 'warning'}>{threat.severity}</Badge>
                <button
                  type="button"
                  className={`${s.fieldConfirm} ${done ? s.fieldConfirmed : ""} t-label-md`}
                  disabled={done}
                  onClick={() => flow.acknowledge(threat.id)}
                >
                  {done ? '확인함' : '봤습니다'}
                </button>
              </li>
            );
          })}
        </ul>
      </Tile>
      <StatTile area="active" icon="alert" value={`${active}`} unit="건" label="확인하지 않은 위협" />
      <Tile area="eyes" spread>
        <TileHeader title="환경마다 눈이 다릅니다" />
        <p className="t-body-sm c-secondary">목적은 같고 탐지 범위가 다릅니다. VIO-04 칸에서 범위를 볼 수 있습니다.</p>
      </Tile>
    </ScreenLayout>
  );
}

const GUARDRAILS: BentoLayout = {
  columns: 'repeat(4, 1fr)',
  rows: '1fr auto',
  areas: ['stage0 stage1 stage2 stage3', 'detect restore exposure exposure'],
};

export function GuardrailsScreen({ flow }: ScreenProps) {
  const tripped = !flow.state.guardrailCleared && flow.state.migrationScreen !== 'connect';
  return (
    <ScreenLayout flow={flow} layout={GUARDRAILS} barLeft={<SectionTabs flow={flow} />} barRight={<BarPill label={routeLabel(flow)} />}>
      {GUARDRAIL_STAGES.map((stage, index) => (
        <Tile key={stage.name} area={`stage${index}`}>
          <TileHeader
            title={`${index + 1}. ${stage.name}`}
            action={
              <Badge tone={stage.state === 'done' ? 'success' : stage.state === 'active' ? (tripped ? 'danger' : 'info') : 'neutral'}>
                {stage.state === 'done' ? '통과' : stage.state === 'active' ? (tripped ? '걸림' : '켜짐') : '대기'}
              </Badge>
            }
          />
          <ul className={s.plainList}>
            {stage.rules.map((rule) => {
              const hit = tripped && rule.control === 'VIO-01' && stage.state === 'active';
              return (
                <li key={rule.name} className={s.stackedRow}>
                  <span className={`t-label-md ${hit ? 'c-danger' : ''}`}>{rule.name}</span>
                  <span className="t-caption c-tertiary">
                    {rule.control} · {rule.layer}
                  </span>
                </li>
              );
            })}
          </ul>
        </Tile>
      ))}
      <StatTile area="detect" icon="alert" value="8" unit="초" label="탐지" />
      <StatTile area="restore" icon="pause" value="-" label="사람이 되돌림" />
      <Tile area="exposure" spread>
        <TileHeader title="걸리면 하는 일" />
        <p className="t-body-md c-secondary">이전을 멈추고 알립니다. 되돌리는 것은 사람이 합니다.</p>
      </Tile>
    </ScreenLayout>
  );
}

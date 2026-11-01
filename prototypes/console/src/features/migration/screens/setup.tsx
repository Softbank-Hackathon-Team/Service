import type { BentoLayout } from '../../../components/layout/ConsoleLayout';
import { Hero, StatTile, Tile, TileHeader, TileLink } from '../../../components/layout/tiles';
import { Checklist, type ChecklistEntry } from '../../../components/ui/Checklist';
import { ActionPill, Badge, BarPill, OptionPill } from '../../../components/ui/controls';
import { Icon } from '../../../components/ui/Icon';
import { SecurityDotMap, SecurityLegend } from '../../../components/ui/Security';
import {
  APP_NAME,
  CONNECT_FAILURES,
  CONNECT_METHOD,
  COST_ROWS,
  countStatus,
  COVERAGE,
  ENVS,
  FINDINGS,
  okCount,
  PLAN_CHANGES,
  PLAN_EXTRAS,
  PLAN_STEPS,
  planHash,
  PRECHECK_BLOCKER,
  PRECHECK_ITEMS,
  regressions,
  REPLICA_OPTIONS,
  RESOURCE_OPTIONS,
  SECURITY_SERVICE_MAP,
  SPEC_READ,
  STACK_BY_ENV,
} from '../mock';
import { ChecklistTile, routeLabel, ScreenLayout, SecurityTile, useSecurity, type ScreenProps } from './shared';
import s from './screens.module.css';

const envIcon = (env: string) => (env === '온프레' ? 'server' : 'cloud');

const hashOf = ({ state }: ScreenProps['flow']) => planHash([state.target, state.replicas.value, state.resources.value]);

const CONNECT: BentoLayout = {
  columns: '780fr 286fr 286fr',
  rows: '1fr 1fr',
  areas: ['hero keys lease', 'hero source source'],
};

export function ConnectScreen({ flow }: ScreenProps) {
  const { source, connected, connecting } = flow.state;
  const method = CONNECT_METHOD[source];
  const isConnected = connected[source];
  const waiting = connecting === source;
  return (
    <ScreenLayout
      flow={flow}
      layout={CONNECT}
      headline={isConnected ? `${source} 구성을 읽을까요?` : `${source}를 연결하세요`}
      sub={waiting ? '고객 쪽 확인을 기다리는 중입니다.' : `${method.how}. ${method.detail}`}
      actions={
        <ActionPill
          label={waiting ? '확인 중' : isConnected ? `${source} 구성 읽기` : `${source} 연결`}
          disabled={waiting}
          onClick={() => (isConnected ? flow.go('read') : flow.connect(source))}
        />
      }
    >
      <Hero
        tone="run"
        meta="새 이전"
        step="01"
        title={'돌고 있는 앱을\n멈추지 않고 옮깁니다'}
        foot="보안 상태를 같은 기준으로 끝까지 확인합니다"
      />
      <StatTile area="keys" icon="lock" value="0" unit="개" label="저장하는 고객 키" />
      <StatTile area="lease" icon="shield" value="15" unit="분" label="작업할 때만 빌리는 권한" />
      <Tile area="source" spread>
        <h2 className="t-h1">어디에서 옮기나요?</h2>
        <div className={s.optionRow}>
          {ENVS.map((env) => (
            <OptionPill
              key={env}
              label={env}
              icon={envIcon(env)}
              selected={env === source}
              onClick={() => flow.setSource(env)}
            />
          ))}
        </div>
      </Tile>
    </ScreenLayout>
  );
}

const CONNECT_FAILED: BentoLayout = {
  columns: '780fr 592fr',
  rows: '1fr',
  areas: ['hero reasons'],
};

export function ConnectFailedScreen({ flow }: ScreenProps) {
  const { source } = flow.state;
  return (
    <ScreenLayout
      flow={flow}
      layout={CONNECT_FAILED}
      headline="연결하지 못했습니다"
      sub="고객 쪽 설정을 고친 뒤 다시 확인합니다. 링크는 24시간 뒤 만료됩니다."
      actions={<ActionPill label="다시 연결" icon="refresh" onClick={() => flow.go('connect')} />}
    >
      <Hero tone="stop" meta={`${source} 연결`} step="!" title={'권한을 빌릴 수\n없습니다'} foot="아무것도 바꾸지 않았습니다">
        <code className={`${s.causeCode} t-code-md`}>{CONNECT_FAILURES[0][0]}</code>
      </Hero>
      <Tile area="reasons">
        <TileHeader title="실패 이유 코드" />
        <ul className={s.plainList}>
          {CONNECT_FAILURES.map(([code, label], index) => (
            <li key={code} className={s.plainRow}>
              <span className="t-body-md">{label}</span>
              {index === 0 ? <Badge tone="danger">{code}</Badge> : <span className="t-code-sm c-tertiary">{code}</span>}
            </li>
          ))}
        </ul>
      </Tile>
    </ScreenLayout>
  );
}

const READ: BentoLayout = {
  columns: '592fr 780fr',
  rows: '1fr 1fr',
  areas: ['app hero', 'security hero'],
};

export function ReadScreen({ flow }: ScreenProps) {
  const { source, target, connected, connecting } = flow.state;
  const { rows, columns, dots } = useSecurity(flow);
  const unknown = countStatus(rows, source, 'unknown');
  const targetReady = connected[target];
  const waiting = connecting === target;
  return (
    <ScreenLayout
      flow={flow}
      layout={READ}
      barLeft={<BarPill label={APP_NAME} />}
      headline="도착지를 고르세요"
      sub={targetReady ? '구성을 다 읽었습니다. 다음 단계에서 명세를 확인합니다.' : `${target}를 쓰려면 먼저 연결해야 합니다. ${CONNECT_METHOD[target].how}면 됩니다.`}
      actions={
        targetReady ? (
          <ActionPill label={`${target}로 명세 만들기`} onClick={() => flow.go('spec')} />
        ) : (
          <ActionPill label={waiting ? '확인 중' : `${target} 연결`} disabled={waiting} onClick={() => flow.connect(target)} />
        )
      }
    >
      <Tile area="app" spread>
        <h2 className="t-h1">{APP_NAME}를 찾았습니다</h2>
        <div className={s.stackGrid}>
          {STACK_BY_ENV[source].map(([name, value]) => (
            <div key={name} className={s.stackItem}>
              <span className="t-label-md">{name}</span>
              <span className="t-code-md c-secondary">{value}</span>
            </div>
          ))}
        </div>
      </Tile>
      <Tile area="security">
        <div className={s.securityRow}>
          <div className={s.summary}>
            <TileHeader title="지금 보안 상태" />
            <p className={s.summaryValue}>
              <span className="t-metric-xl">{okCount(rows, source)}</span>
              <span className="t-h3 c-secondary">/ {rows.length} 통과</span>
            </p>
            <p className="t-body-md c-warning">{unknown}칸은 확인하지 못했습니다</p>
            <div className={s.summaryLegend}>
              <TileLink label="펼치기" onClick={() => flow.go('security')} />
            </div>
            <SecurityLegend />
          </div>
          <SecurityDotMap columns={columns} rows={dots} />
        </div>
      </Tile>
      <Hero tone="run" meta={`${source}에서 출발`} step="02" title="어디로 옮길까요?" foot="플랫폼은 도착지를 추천하지 않습니다. 직접 고르세요">
        <div className={s.heroList}>
          {ENVS.filter((env) => env !== source).map((env) => {
            const selected = env === target;
            return (
              <button
                key={env}
                type="button"
                aria-pressed={selected}
                className={`${s.heroRow} ${selected ? s.heroRowSelected : ''}`}
                onClick={() => flow.setTarget(env)}
              >
                <span className={`${s.heroRowName} t-h3`}>
                  <Icon name={envIcon(env)} />
                  {env}
                </span>
                <span className="t-body-md">{connecting === env ? '확인 중' : connected[env] ? '연결됨' : '연결 필요'}</span>
              </button>
            );
          })}
        </div>
      </Hero>
    </ScreenLayout>
  );
}

const prepSteps = (current: 'spec' | 'precheck' | 'approve' | 'approved', done = false): ChecklistEntry[] => {
  const order = ['spec', 'precheck', 'approve', 'approved'];
  const at = order.indexOf(current);
  const status = (index: number) => (at > index || (at === index && done) ? 'done' : at === index ? 'active' : 'pending');
  return [
    { status: 'done', label: '구성 읽기', detail: '12:01' },
    { status: status(0), label: '명세 확정', detail: '사람' },
    { status: status(1), label: '사전 점검', detail: '20개' },
    { status: status(2), label: '계획 승인', detail: '사람' },
    { status: status(3), label: '실행 시작', detail: '사람' },
  ];
};

const SPEC: BentoLayout = {
  columns: '640fr 370fr 342fr',
  rows: '320fr 320fr',
  areas: ['hero steps read', 'hero coverage read'],
};

export function SpecScreen({ flow }: ScreenProps) {
  const { replicas, resources } = flow.state;
  const fields = [
    { key: 'replicas', name: 'API 복제 수', field: replicas, options: REPLICA_OPTIONS },
    { key: 'resources', name: 'API CPU·메모리', field: resources, options: RESOURCE_OPTIONS },
  ] as const;
  const remaining = fields.filter(({ field }) => !field.confirmed).length;
  return (
    <ScreenLayout
      flow={flow}
      layout={SPEC}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="이 명세가 맞나요?"
      sub={remaining > 0 ? `헷갈리는 칸 ${remaining}개를 확인하면 확정할 수 있습니다.` : '확정하면 옮길 수 있는지 자동으로 점검합니다.'}
      actions={
        <>
          <BarPill label="취소" icon="x" onClick={() => flow.go('cancelled')} />
          <ActionPill label="명세 확정" icon="check" disabled={remaining > 0} onClick={flow.confirmSpec} />
        </>
      }
    >
      <Hero
        tone="run"
        meta="확인이 필요한 칸"
        step="03"
        title={'이 두 칸이\n맞나요?'}
        foot="AI가 추측한 값입니다. 사람이 고르기 전에는 계획에 쓰지 않습니다"
      >
        <div className={s.heroList}>
          {fields.map(({ key, name, field, options }) => (
            <div key={key} className={s.heroRow}>
              <label className={s.fieldText}>
                <span className="t-body-sm">{name}</span>
                <select
                  className={s.fieldSelect}
                  value={field.value}
                  onChange={(event) => flow.setField(key, event.target.value)}
                >
                  {options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </label>
              {!field.confirmed && <Badge tone="warning">확신 낮음 0.6</Badge>}
              <button
                type="button"
                aria-pressed={field.confirmed}
                className={`${s.fieldConfirm} ${field.confirmed ? s.fieldConfirmed : ''} t-label-md`}
                onClick={() => flow.confirmField(key)}
              >
                <Icon name="check" />
                {field.confirmed ? '확인함' : '맞아요'}
              </button>
            </div>
          ))}
        </div>
      </Hero>
      <ChecklistTile title="사람이 할 일" items={prepSteps('spec')} />
      <Tile area="read">
        <TileHeader title="운영 중인 앱에서 읽은 값" />
        <ul className={s.plainList}>
          {SPEC_READ.map(({ name, value, confidence }) => (
            <li key={name} className={s.stackedRow}>
              <span className={s.plainRow}>
                <span className="t-label-md">{name}</span>
                <span className="t-caption c-tertiary">믿음 {confidence}</span>
              </span>
              <span className="t-code-sm c-secondary">{value}</span>
            </li>
          ))}
        </ul>
      </Tile>
      <Tile area="coverage" spread>
        <TileHeader title="찾은 자원" action={<Badge tone="warning">발견 {FINDINGS.length}</Badge>} />
        <p className={s.summaryValue}>
          <span className="t-metric-xl">{COVERAGE.movable}</span>
          <span className="t-h3 c-secondary">/ {COVERAGE.found} 옮김</span>
        </p>
        <p className="t-body-sm c-secondary">지원 안 함: {COVERAGE.unsupported.join(', ')}</p>
        <p className="t-body-sm c-warning">{FINDINGS[0]}</p>
      </Tile>
    </ScreenLayout>
  );
}

const PRECHECK: BentoLayout = {
  columns: '592fr 780fr',
  rows: '1fr',
  areas: ['items hero'],
};

const PRECHECK_BADGE = { warning: '경고', info: '참고' } as const;

export function PrecheckScreen({ flow }: ScreenProps) {
  const { precheckStep, target } = flow.state;
  const items: ChecklistEntry[] = PRECHECK_ITEMS.map((item, index) => ({
    status: index < precheckStep ? 'done' : index === precheckStep ? 'active' : 'pending',
    label: item.name,
    detail: index < precheckStep && item.result !== 'pass' ? PRECHECK_BADGE[item.result] : item.id,
  }));
  return (
    <ScreenLayout
      flow={flow}
      layout={PRECHECK}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="옮길 수 있는지 점검합니다"
      sub="하나라도 막히면 여기서 멈춥니다. 고객 환경에는 아직 아무것도 생기지 않았습니다."
      actions={<ActionPill label="자동으로 진행 중" icon="refresh" disabled />}
    >
      <Tile area="items">
        <h3 className="t-h3" style={{ marginBottom: 'var(--space-8)' }}>
          점검 항목 20개
        </h3>
        <Checklist items={items} />
      </Tile>
      <Hero tone="run" meta="사전 점검" step="04" title={`${target}에서\n이 앱을 돌릴 수 있나요?`} foot="막힘, 경고, 참고 세 등급으로 나눕니다">
        <p className="t-metric-2xl">
          {Math.min(precheckStep, PRECHECK_ITEMS.length)} / {PRECHECK_ITEMS.length}
        </p>
      </Hero>
    </ScreenLayout>
  );
}

const BLOCKED: BentoLayout = {
  columns: '880fr 492fr',
  rows: '1fr',
  areas: ['hero steps'],
};

export function BlockedScreen({ flow }: ScreenProps) {
  return (
    <ScreenLayout
      flow={flow}
      layout={BLOCKED}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="여기서 멈췄습니다"
      sub="막힘이 하나라도 있으면 계획을 만들지 않습니다."
      actions={
        <>
          <BarPill label="취소" icon="x" onClick={() => flow.go('cancelled')} />
          <ActionPill label="명세로 돌아가기" icon="rollback" onClick={() => flow.go('spec')} />
        </>
      }
    >
      <Hero tone="stop" meta={`진행 불가 · ${PRECHECK_BLOCKER.id}`} step="!" title={`${PRECHECK_BLOCKER.name}가\n있습니다`} foot={PRECHECK_BLOCKER.detail}>
        <code className={`${s.causeCode} t-code-md`}>{PRECHECK_BLOCKER.tables.join(', ')}</code>
      </Hero>
      <ChecklistTile
        title="점검 결과"
        items={[
          { status: 'done', label: '통과', detail: '17개' },
          { status: 'done', label: '경고', detail: '1개' },
          { status: 'done', label: '참고', detail: '1개' },
          { status: 'failed', label: '진행 불가', detail: '1개' },
          { status: 'pending', label: '계획 만들기', detail: '안 함' },
        ]}
      />
    </ScreenLayout>
  );
}

const APPROVE: BentoLayout = {
  columns: '440fr 300fr 316fr 336fr',
  rows: '240fr 400fr',
  areas: ['hero steps cost security', 'hero steps extras security'],
};

export function ApproveScreen({ flow }: ScreenProps) {
  const { source, target } = flow.state;
  const { rows } = useSecurity(flow);
  const sourceCost = COST_ROWS.reduce((sum, row) => sum + row.source, 0);
  const targetCost = COST_ROWS.reduce((sum, row) => sum + row.target, 0);
  const hash = hashOf(flow);
  const backward = regressions(rows, source, target);
  return (
    <ScreenLayout
      flow={flow}
      layout={APPROVE}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="이 계획을 승인할까요?"
      sub="승인은 2시간 유효합니다. 한 글자라도 바뀌면 승인은 무효입니다."
      actions={
        <>
          <BarPill label="취소" icon="x" onClick={() => flow.go('cancelled')} />
          <BarPill label="거절" icon="ban" tone="danger" onClick={() => flow.go('rejected')} />
          <ActionPill label="이 계획 승인" icon="check" onClick={() => flow.go('approved')} />
        </>
      }
    >
      <Hero tone="run" meta="계획서" step="05" title={'승인하면\n이대로만 실행합니다'}>
        <code className={`${s.causeCode} t-code-md`}>{hash}</code>
        <div className={s.changes}>
          {PLAN_CHANGES.map(([label, value]) => (
            <div key={label} className={s.change}>
              <span className="t-metric-xl">{value}</span>
              <span className="t-body-md">{label}</span>
            </div>
          ))}
        </div>
      </Hero>
      <Tile area="steps" scroll>
        <h3 className="t-h3">단계와 넘어갈 조건</h3>
        <ol className={s.planSteps}>
          {PLAN_STEPS.map(({ name, gate }, index) => (
            <li key={name} className={s.planStep}>
              <span className="t-label-md">
                {index + 1}. {name}
              </span>
              <span className="t-caption">{gate}</span>
            </li>
          ))}
        </ol>
      </Tile>
      <Tile area="cost" spread>
        <TileHeader title="월 비용" action={<TileLink label="자세히" onClick={() => flow.go('cost')} />} />
        <div className={s.costCompare}>
          <div className={s.change}>
            <span className="t-metric-xl">${sourceCost}</span>
            <span className="t-body-md c-secondary">{source}</span>
          </div>
          <Icon name="arrow-right" size={24} />
          <div className={s.change}>
            <span className="t-metric-xl">${targetCost}</span>
            <span className="t-body-md c-secondary">{target}</span>
          </div>
        </div>
        <p className="t-body-sm c-secondary">결정은 사용자가 합니다. 값은 가정값입니다.</p>
      </Tile>
      <Tile area="extras" scroll>
        <TileHeader title="같이 승인하는 것" action={<Badge tone="warning">경고 1</Badge>} />
        <ul className={s.plainList}>
          <li className={s.stackedRow}>
            <span className="t-label-md">임시 예외</span>
            <span className="t-body-sm c-secondary">{PLAN_EXTRAS.exception}</span>
          </li>
          <li className={s.stackedRow}>
            <span className="t-label-md">임시 자원 {PLAN_EXTRAS.tempResources}개</span>
            <span className="t-body-sm c-secondary">끝나면 전부 지웁니다</span>
          </li>
          <li className={s.stackedRow}>
            <span className="t-label-md">보안 서비스</span>
            <span className="t-body-sm c-secondary">
              {SECURITY_SERVICE_MAP[source]} → {SECURITY_SERVICE_MAP[target]}를 켭니다
            </span>
          </li>
          <li className={s.stackedRow}>
            <span className="t-label-md c-warning">리전과 한도</span>
            <span className="t-body-sm c-secondary">{PLAN_EXTRAS.warning}</span>
          </li>
        </ul>
      </Tile>
      <SecurityTile flow={flow} title={`옮긴 뒤 예상 보안 · 후퇴 ${backward.length}`} />
    </ScreenLayout>
  );
}

const REASON: BentoLayout = {
  columns: '780fr 592fr',
  rows: '1fr',
  areas: ['hero reason'],
};

export function RejectedScreen({ flow }: ScreenProps) {
  return (
    <ScreenLayout
      flow={flow}
      layout={REASON}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="계획을 거절했습니다"
      sub="거절한 계획을 그대로 다시 승인할 수는 없습니다."
      actions={
        <>
          <BarPill label="명세부터 고치기" onClick={() => flow.go('spec')} />
          <ActionPill label="계획 다시 만들기" icon="refresh" onClick={flow.confirmSpec} />
        </>
      }
    >
      <Hero tone="stop" meta="거절" step="×" title={'고객 환경에는\n아무것도 안 바꿨습니다'} foot="거절한 사람과 이유를 감사 기록에 남깁니다" />
      <Tile area="reason">
        <TileHeader title="거절 이유 (선택)" />
        <textarea className={s.textarea} rows={5} placeholder="왜 거절하는지 한 줄로 적어 주세요" />
      </Tile>
    </ScreenLayout>
  );
}

export function StaleScreen({ flow }: ScreenProps) {
  return (
    <ScreenLayout
      flow={flow}
      layout={REASON}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="계획이 낡았습니다"
      sub="승인 뒤 시간이 지났거나 입력이 바뀌었습니다."
      actions={
        <>
          <BarPill label="취소" icon="x" onClick={() => flow.go('cancelled')} />
          <ActionPill label="계획 다시 만들기" icon="refresh" onClick={flow.confirmSpec} />
        </>
      }
    >
      <Hero tone="stop" meta="낡은 계획" step="!" title={'승인 2시간이\n지났습니다'} foot="본 것과 다른 내용이 실행되지 않도록 막았습니다">
        <code className={`${s.causeCode} t-code-md`}>{hashOf(flow)}</code>
      </Hero>
      <Tile area="reason">
        <TileHeader title="다시 확인하는 것" />
        <ul className={s.plainList}>
          <li className="t-body-md">사전 점검 20개</li>
          <li className="t-body-md">계획 지문</li>
          <li className="t-body-md">승인</li>
        </ul>
      </Tile>
    </ScreenLayout>
  );
}

const APPROVED: BentoLayout = {
  columns: '880fr 492fr',
  rows: '1fr',
  areas: ['hero steps'],
};

export function ApprovedScreen({ flow }: ScreenProps) {
  const { envBusy, target } = flow.state;
  return (
    <ScreenLayout
      flow={flow}
      layout={APPROVED}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline={envBusy ? '지금은 시작할 수 없습니다' : '실행을 시작할까요?'}
      sub={envBusy ? '다른 이전이 끝나면 다시 누르세요. 승인은 2시간 동안 유효합니다.' : '여기부터는 자동입니다. 승인은 2시간 동안 유효합니다.'}
      actions={
        <>
          <BarPill label="취소" icon="x" onClick={() => flow.go('cancelled')} />
          <ActionPill label="실행 시작" icon="play" disabled={envBusy} onClick={flow.startMigration} />
        </>
      }
    >
      {envBusy ? (
        <Hero tone="stop" meta="환경 사용 중" step="!" title={`다른 이전이\n${target}를 쓰고 있습니다`} foot="같은 환경을 쓰는 이전은 한 번에 하나만 돕니다">
          <code className={`${s.causeCode} t-code-md`}>409 ENV_BUSY</code>
        </Hero>
      ) : (
        <Hero tone="run" meta="승인됨" step="06" title={'승인했습니다.\n버튼 하나만 남았습니다'} foot="이 지문의 계획만 실행합니다">
          <code className={`${s.causeCode} t-code-md`}>{hashOf(flow)}</code>
        </Hero>
      )}
      <ChecklistTile title="사람이 할 일" items={prepSteps('approved')} />
    </ScreenLayout>
  );
}

const COST: BentoLayout = {
  columns: '880fr 492fr',
  rows: '1fr 1fr',
  areas: ['table growth', 'table profile'],
};

export function CostScreen({ flow }: ScreenProps) {
  const { source, target, growth, profile } = flow.state;
  const extra = profile === 'strict' ? 42 : 0;
  const total = (key: 'source' | 'target') => COST_ROWS.reduce((sum, row) => sum + row[key], 0) * growth + (key === 'target' ? extra : 0);
  return (
    <ScreenLayout
      flow={flow}
      layout={COST}
      barLeft={<BarPill label={routeLabel(flow)} />}
      barRight={<BarPill label="계획서로" icon="rollback" onClick={() => flow.go('approve')} />}
    >
      <Tile area="table">
        <TileHeader title="항목별 월 비용 (가정값)" />
        <table className={s.costTable}>
          <thead>
            <tr className="t-label-md c-secondary">
              <th scope="col">항목</th>
              <th scope="col">{source}</th>
              <th scope="col">{target}</th>
            </tr>
          </thead>
          <tbody className="t-body-md">
            {COST_ROWS.map((row) => (
              <tr key={row.name}>
                <th scope="row">{row.name}</th>
                <td>${row.source * growth}</td>
                <td>${row.target * growth}</td>
              </tr>
            ))}
            {extra > 0 && (
              <tr>
                <th scope="row">강화 보안</th>
                <td>-</td>
                <td>${extra}</td>
              </tr>
            )}
          </tbody>
          <tfoot className="t-h3">
            <tr>
              <th scope="row">합계</th>
              <td>${total('source')}</td>
              <td>${total('target')}</td>
            </tr>
          </tfoot>
        </table>
      </Tile>
      <Tile area="growth" spread>
        <TileHeader title="성장 시나리오" />
        <div className={s.optionRow}>
          <OptionPill label="지금 트래픽" selected={growth === 1} onClick={() => flow.patch({ growth: 1 })} />
          <OptionPill label="3배로 성장" selected={growth === 3} onClick={() => flow.patch({ growth: 3 })} />
        </div>
      </Tile>
      <Tile area="profile" spread>
        <TileHeader title="보안 수준" />
        <div className={s.optionRow}>
          <OptionPill label="기본" selected={profile === 'basic'} onClick={() => flow.patch({ profile: 'basic' })} />
          <OptionPill label="강화" selected={profile === 'strict'} onClick={() => flow.patch({ profile: 'strict' })} />
        </div>
        <p className="t-body-sm c-secondary">
          {profile === 'strict' ? '강화하면 VIO-04 탐지 범위가 넓어지고 월 비용이 늘어납니다.' : '기본은 통제 12개를 같은 기준으로 지킵니다.'}
        </p>
      </Tile>
    </ScreenLayout>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FoldTile, Hero, StatTile, Tile, TileHeader, TileLink } from '../../components/layout/tiles';
import { Checklist } from '../../components/ui/Checklist';
import { CodeValue } from '../../components/ui/CodeValue';
import { AccountPill, ActionPill, Badge, BarPill, LiveIndicator, NavPills, OptionPill } from '../../components/ui/controls';
import { Icon, ICON_NAMES } from '../../components/ui/Icon';
import { Logo } from '../../components/ui/Logo';
import { SkeletonRows, SkeletonStats } from '../../components/ui/Skeleton';
import { SecurityCell, SecurityDotMap, SecurityLegend, STATUS_LABEL, type SecurityStatus } from '../../components/ui/Security';
import { Timeline } from '../../components/ui/Timeline';
import { TrafficBar } from '../../components/ui/TrafficBar';
import s from './DesignSystemPage.module.css';

const noop = () => {};

const SECTIONS = [
  { id: 'color', label: '색' },
  { id: 'type', label: '글자' },
  { id: 'layout', label: '간격, 모서리, 칸' },
  { id: 'assets', label: '로고와 아이콘' },
  { id: 'controls', label: '조작' },
  { id: 'tiles', label: '타일' },
  { id: 'status', label: '상태 표시' },
];

const COLOR_GROUPS = [
  { title: '배경', prefix: '--color-bg-' },
  { title: '글자', prefix: '--color-fg-' },
  { title: '선', prefix: '--color-border-' },
  { title: '데이터', prefix: '--color-data-' },
  { title: '신호', prefix: '--color-signal-' },
];

const TYPE_CLASSES = [
  't-display',
  't-metric-2xl',
  't-metric-xl',
  't-metric-lg',
  't-h1',
  't-h2',
  't-h3',
  't-body-md',
  't-body-sm',
  't-label-md',
  't-label-sm',
  't-caption',
  't-code-md',
  't-code-sm',
];

const STATUSES = Object.keys(STATUS_LABEL) as SecurityStatus[];

/** 토큰 목록을 손으로 적지 않고 tokens.css에서 읽어서, 값이 바뀌면 이 페이지도 함께 바뀐다. */
function readTokens(): string[] {
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ':root') continue;
      for (const name of Array.from(rule.style)) {
        if (name.startsWith('--')) names.add(name);
      }
    }
  }
  return [...names];
}

function useTokens() {
  const [tokens, setTokens] = useState<string[]>([]);
  useEffect(() => setTokens(readTokens()), []);
  const value = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return { tokens, value };
}

function Section({ id, title, source, children }: { id: string; title: string; source: string; children: ReactNode }) {
  return (
    <section id={id} className={s.section}>
      <div className={s.sectionHead}>
        <h2 className="t-h1">{title}</h2>
        <code className="t-code-sm c-tertiary">{source}</code>
      </div>
      {children}
    </section>
  );
}

function Spec({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <div className={s.spec}>
      <div className={s.specHead}>
        <code className="t-code-md">{name}</code>
        {note && <span className="t-caption c-secondary">{note}</span>}
      </div>
      <div className={s.specBody}>{children}</div>
    </div>
  );
}

function Swatch({ name, value, onCopy }: { name: string; value: string; onCopy: (text: string) => void }) {
  const token = `var(${name})`;
  return (
    <button type="button" className={s.swatch} aria-label={`${token} 복사`} onClick={() => onCopy(token)}>
      <span className={s.chip} style={{ background: token }} />
      <span className="t-code-sm">{name.replace('--color-', '')}</span>
      <span className="t-caption c-tertiary">{value}</span>
    </button>
  );
}

function TypeRow({ className }: { className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [spec, setSpec] = useState('');
  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    setSpec(`${parseFloat(style.fontSize)}px / ${parseFloat(style.lineHeight)}px / ${style.fontWeight}`);
  }, []);
  return (
    <div className={s.typeRow}>
      <span ref={ref} className={`${className} ${s.typeSample}`}>
        이전 승인 Migrate 移行 0123
      </span>
      <code className="t-code-sm c-tertiary">
        .{className} · {spec}
      </code>
    </div>
  );
}

export function DesignSystemPage({ onExit }: { onExit?: () => void }) {
  const { tokens, value } = useTokens();
  const [copied, setCopied] = useState('');
  const [option, setOption] = useState('AWS');
  const [nav, setNav] = useState('security');

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${text} 복사됨`);
    } catch {
      setCopied(text);
    }
  };

  // 주소의 해시는 화면 이동에 쓰므로 목차는 스크롤로 움직인다.
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const matching = (prefix: string) => tokens.filter((name) => name.startsWith(prefix));

  return (
    <div className={s.root}>
      <header className={s.header}>
        <Logo />
        <nav className={s.toc} aria-label="목차">
          {SECTIONS.map((section) => (
            <button key={section.id} type="button" className={`${s.tocItem} t-label-sm`} onClick={() => scrollTo(section.id)}>
              {section.label}
            </button>
          ))}
        </nav>
        {onExit && <BarPill label="콘솔로" icon="rollback" onClick={onExit} />}
      </header>

      <main className={s.main}>
        <div className={s.intro}>
          <h1 className="t-display">디자인 시스템</h1>
          <p className="t-body-md c-secondary">
            아래는 그림이 아니라 콘솔이 쓰는 토큰과 컴포넌트를 그대로 불러온 것입니다. 코드를 고치면 이 페이지와 화면이 함께 바뀝니다.
          </p>
        </div>

        <Section id="color" title="색" source="src/design/tokens.css">
          <p className="t-body-sm c-secondary">칩을 누르면 토큰 이름을 복사합니다. {copied}</p>
          {COLOR_GROUPS.map((group) => (
            <div key={group.prefix} className={s.group}>
              <h3 className="t-h3">{group.title}</h3>
              <div className={s.swatches}>
                {matching(group.prefix).map((name) => (
                  <Swatch key={name} name={name} value={value(name)} onCopy={copy} />
                ))}
              </div>
            </div>
          ))}
        </Section>

        <Section id="type" title="글자" source="src/design/base.css">
          <p className="t-body-md">
            Pretendard JP 하나로 표시합니다. 안전하게 이전합니다. Move with confidence. 安全に移行します。
          </p>
          <div className={s.panel}>
            {TYPE_CLASSES.map((name) => (
              <TypeRow key={name} className={name} />
            ))}
          </div>
        </Section>

        <Section id="layout" title="간격, 모서리, 칸" source="src/design/tokens.css">
          <div className={s.scale}>
            {matching('--space-').map((name) => (
              <div key={name} className={s.scaleItem}>
                <span className={s.spaceBar} style={{ height: `var(${name})` }} />
                <code className="t-code-sm c-secondary">{name.replace('--space-', '')}</code>
              </div>
            ))}
          </div>
          <div className={s.scale}>
            {matching('--radius-').map((name) => (
              <div key={name} className={s.scaleItem}>
                <span className={s.radiusBox} style={{ borderRadius: `var(${name})` }} />
                <code className="t-code-sm c-secondary">{name.replace('--radius-', '')}</code>
              </div>
            ))}
          </div>
          <div className={s.scale}>
            {matching('--size-control-').map((name) => (
              <div key={name} className={s.scaleItem}>
                <span className={s.controlBar} style={{ height: `var(${name})` }} />
                <code className="t-code-sm c-secondary">
                  {name.replace('--size-', '')} {value(name)}
                </code>
              </div>
            ))}
          </div>
          <p className="t-body-sm c-secondary">벤토는 큰 카드만 늘고 줄며, 나머지 칸은 아래 너비로 고정합니다. 1200px보다 좁으면 큰 카드부터 한 줄로 쌓습니다.</p>
          <ul className={s.tokenList}>
            {[...matching('--col-'), '--gap-bento', '--content-max', '--hero-offset'].map((name) => (
              <li key={name}>
                <code className="t-code-sm">{name}</code>
                <code className="t-code-sm c-secondary">{value(name)}</code>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="assets" title="로고와 아이콘" source="src/components/ui/Logo.tsx · Icon.tsx">
          <Spec name="Logo">
            <Logo />
          </Spec>
          <Spec name="Icon" note={`${ICON_NAMES.length}개, Lucide`}>
            <div className={s.icons}>
              {ICON_NAMES.map((name) => (
                <span key={name} className={s.iconItem}>
                  <Icon name={name} size={20} />
                  <code className="t-code-sm c-secondary">{name}</code>
                </span>
              ))}
            </div>
          </Spec>
        </Section>

        <Section id="controls" title="조작" source="src/components/ui/controls.tsx">
          <Spec name="ActionPill" note="화면에 하나뿐인 지금 할 행동. 항상 오른쪽 아래에 둡니다.">
            <ActionPill label="이 계획 승인" icon="check" onClick={noop} />
            <ActionPill label="다음" onClick={noop} />
            <ActionPill label="롤백" icon="rollback" tone="danger" onClick={noop} />
            <ActionPill label="실행 시작" icon="play" disabled />
          </Spec>
          <Spec name="BarPill" note="상단 바의 조작과 작은 보조 행동. onClick이 없으면 표시만 합니다.">
            <BarPill label="증적 리포트" icon="download" onClick={noop} />
            <BarPill label="롤백" icon="rollback" tone="danger" onClick={noop} />
            <BarPill label="shop-api · AWS → GCP" />
          </Spec>
          <Spec name="NavPills" note="상단 진입점. 사이드바 대신 한 줄로 둡니다.">
            <NavPills
              items={[
                { id: 'security', label: '보안 표' },
                { id: 'threats', label: '위협' },
                { id: 'guardrails', label: '가드레일' },
              ]}
              current={nav}
              onSelect={setNav}
            />
          </Spec>
          <Spec name="OptionPill">
            {['AWS', 'GCP', '온프레', 'Azure'].map((env) => (
              <OptionPill
                key={env}
                label={env}
                icon={env === '온프레' ? 'server' : 'cloud'}
                selected={option === env}
                onClick={() => setOption(env)}
              />
            ))}
          </Spec>
          <Spec name="Badge">
            <Badge>예시 데이터</Badge>
            <Badge tone="success">연결됨</Badge>
            <Badge tone="warning">승인 대기</Badge>
            <Badge tone="danger">높음</Badge>
            <Badge tone="info">진행 중</Badge>
          </Spec>
          <Spec name="CodeValue" note="긴 지문과 이미지는 한 줄로 가운데를 줄이고, 전체 값은 복사 버튼으로 닿습니다.">
            <CodeValue value="sha256:7f3a9c1e5b2d884690000000000000000000000000000000000000001" chip max={32} />
            <CodeValue value="ghcr.io/example/shop-api@sha256:abababababababababababababab" />
          </Spec>
          <Spec name="SkeletonRows · SkeletonStats" note="읽는 동안 빈 카드 대신 자리를 잡습니다.">
            <div className={s.skeletonDemo}>
              <SkeletonStats count={3} />
              <SkeletonRows count={3} />
            </div>
          </Spec>
          <Spec name="LiveIndicator · AccountPill">
            <LiveIndicator />
            <AccountPill label="계정" onClick={noop} />
          </Spec>
        </Section>

        <Section id="tiles" title="타일" source="src/components/layout/tiles.tsx">
          <p className="t-body-sm c-secondary">
            벤토의 한 칸입니다. 카드는 모두 흰색이고 상태는 머리줄의 글자와 원 색으로만 알립니다. area 이름이 같으면 화면이 바뀔 때 같은 타일로 이어져 움직입니다.
          </p>
          <div className={s.heroes}>
            <Hero area="ds-hero-run" tone="run" meta="진행" step="07" title={'트래픽을\n옮기는 중'} foot="tone=run">
              <TrafficBar source="AWS" target="GCP" targetPercent={50} />
            </Hero>
            <Hero area="ds-hero-stop" tone="stop" meta="멈춤" step="!" title={'이전을\n멈췄습니다'} foot="tone=stop" />
            <Hero area="ds-hero-done" tone="done" meta="완료" step="10" title={'멈추지 않고\n옮겼습니다'} foot="tone=done" />
          </div>
          <div className={s.tiles}>
            <StatTile area="ds-stat" icon="check" value="0" unit="건" label="StatTile: 실패 요청" />
            <Tile area="ds-tile" spread>
              <TileHeader title="Tile과 TileHeader" action={<TileLink label="TileLink" onClick={noop} />} />
              <p className="t-body-md c-secondary">기본 타일입니다. spread는 내용을 위아래로 벌립니다.</p>
            </Tile>
            <Tile area="ds-tile-checklist">
              <FoldTile title="FoldTile" summary="2건">
                <p className="t-body-sm c-secondary">접어도 머리줄 오른쪽의 요약은 남습니다.</p>
              </FoldTile>
              <TileHeader title="Checklist" />
              <Checklist
                items={[
                  { status: 'done', label: '끝남', detail: '12:01' },
                  { status: 'active', label: '진행 중', detail: '50%' },
                  { status: 'paused', label: '멈춤' },
                  { status: 'failed', label: '실패' },
                  { status: 'pending', label: '대기' },
                ]}
              />
            </Tile>
          </div>
        </Section>

        <Section id="status" title="상태 표시" source="src/components/ui/Security.tsx · TrafficBar.tsx · Timeline.tsx">
          <Spec name="SecurityCell" note="색만으로 구분하지 않도록 상태마다 모양이 다릅니다.">
            {STATUSES.map((status) => (
              <span key={status} className={s.cellBox}>
                <SecurityCell status={status} />
              </span>
            ))}
          </Spec>
          <Spec name="SecurityDotMap · SecurityLegend">
            <div className={s.dotMap}>
              <SecurityDotMap
                columns={['AWS', 'GCP', '온프', 'Az']}
                rows={[
                  { name: 'IAM-01', statuses: ['pass', 'attested', 'attested', 'unknown'] },
                  { name: 'VIO-01', statuses: ['pass', 'fail', 'pass', 'unknown'] },
                  { name: 'VIO-02', statuses: ['unknown', 'unknown', 'unknown', 'na'] },
                ]}
              />
              <SecurityLegend />
            </div>
          </Spec>
          <Spec name="TrafficBar" note="값과 이름은 항상 막대 위에 직접 적습니다.">
            <div className={s.wide}>
              <TrafficBar source="AWS" target="GCP" targetPercent={10} />
            </div>
          </Spec>
          <Spec name="Timeline" note="거부된 호출도 지우지 않고 남깁니다.">
            <div className={s.wide}>
              <Timeline
                items={[
                  { kind: 'guardrail', title: 'guardrail', detail: '가드레일 발동', time: '12:21:04' },
                  { kind: 'tool', title: 'tool', detail: '에이전트 도구 호출', time: '12:21:40' },
                  { kind: 'denied', title: 'denied', detail: '거부된 호출', time: '12:22:13' },
                  { kind: 'human', title: 'human', detail: '사람의 결정', time: '12:25:02' },
                  { kind: 'system', title: 'system', detail: '플랫폼 동작', time: '12:27:44' },
                ]}
              />
            </div>
          </Spec>
        </Section>
      </main>
    </div>
  );
}

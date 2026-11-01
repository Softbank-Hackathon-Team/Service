import { ConsoleLayout, type ConsoleLayoutProps } from '../../../components/layout/ConsoleLayout';
import { Tile, TileHeader, TileLink } from '../../../components/layout/tiles';
import { Checklist, type ChecklistEntry } from '../../../components/ui/Checklist';
import { NavPills, type NavItem } from '../../../components/ui/controls';
import { SecurityDotMap, SecurityLegend } from '../../../components/ui/Security';
import { navOf, securityPhase, type NavTab } from '../flow';
import { APP_NAME, dotMapRows, ENV_SHORT, ENVS, securityRows } from '../mock';
import type { MigrationFlow } from '../useMigrationFlow';

export type ScreenProps = { flow: MigrationFlow };

export const routeLabel = ({ state }: MigrationFlow) => `${APP_NAME} · ${state.source} → ${state.target}`;

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'environments', label: '환경' },
  { id: 'migration', label: '이전' },
  { id: 'security', label: '보안' },
  { id: 'log', label: '감사' },
  { id: 'agent', label: '에이전트' },
];

/** 모든 제품 화면의 뼈대. 상단 진입점과 계정 버튼을 여기서 붙인다. */
export function ScreenLayout({ flow, ...props }: ScreenProps & Omit<ConsoleLayoutProps, 'nav' | 'onAccount'>) {
  return (
    <ConsoleLayout
      nav={<NavPills items={NAV_ITEMS} current={navOf(flow.screen)} onSelect={(id) => flow.openTab(id as NavTab)} />}
      onAccount={() => flow.go('settings')}
      {...props}
    />
  );
}

export function useSecurity(flow: MigrationFlow) {
  const { source, target, attested } = flow.state;
  const phase = securityPhase(flow.state);
  const rows = securityRows(source, target, phase, attested);
  return {
    rows,
    columns: ENVS.map((env) => ENV_SHORT[env]),
    dots: dotMapRows(rows, source, target, phase),
  };
}

export function SecurityTile({ flow, title, area = 'security' }: ScreenProps & { title: string; area?: string }) {
  const { columns, dots } = useSecurity(flow);
  return (
    <Tile area={area} compact spread>
      <TileHeader title={title} action={<TileLink label="펼치기" onClick={() => flow.go('security')} />} />
      <SecurityDotMap columns={columns} rows={dots} />
      <SecurityLegend />
    </Tile>
  );
}

export function ChecklistTile({ area = 'steps', title, items }: { area?: string; title: string; items: ChecklistEntry[] }) {
  return (
    <Tile area={area} compact>
      <TileHeader title={title} />
      <Checklist items={items} />
    </Tile>
  );
}

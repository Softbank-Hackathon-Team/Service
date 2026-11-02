import { go, NAV_ITEMS, parseRoute } from '../../app/routes';
import { ConsoleLayout, type ConsoleLayoutProps } from '../../components/layout/ConsoleLayout';
import { NavPills } from '../../components/ui/controls';

/** 로그인 뒤 모든 화면의 뼈대. 상단 메뉴와 계정 버튼을 여기서 붙인다. */
export function ShellLayout(props: Omit<ConsoleLayoutProps, 'nav' | 'onAccount'>) {
  const { page } = parseRoute(window.location.hash);
  return (
    <ConsoleLayout
      nav={<NavPills items={NAV_ITEMS} current={page} onSelect={(id) => go(id === 'dashboard' ? '' : id)} />}
      onAccount={() => go('settings')}
      {...props}
    />
  );
}

import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, Badge } from '../../components/ui/controls';
import { API_BASE, api, auth } from '../../lib/api';
import type { AuthUser } from '../../lib/auth';
import { usePoll } from '../../lib/usePoll';
import { ShellLayout } from '../shell/ShellLayout';
import s from '../common/page.module.css';

const LAYOUT: BentoLayout = { columns: ['fill', 'side'], areas: 'hero side' };

function useLatency(probe: () => Promise<unknown>, ms: number) {
  return usePoll(async () => {
    const start = performance.now();
    await probe();
    return Math.round(performance.now() - start);
  }, ms, [], { keepOnError: false });
}

function ProbeRow({ name, state }: { name: string; state: { data: number | null; error: unknown; loading: boolean } }) {
  const up = state.data !== null && !state.error;
  return (
    <li className={s.row}>
      <span className="t-label-md">{name}</span>
      {state.loading ? <Badge>확인 중</Badge> : <Badge tone={up ? 'success' : 'danger'}>{up ? `${state.data}ms` : '응답 없음'}</Badge>}
    </li>
  );
}

export function SettingsPage({ user }: { user: AuthUser }) {
  const health = useLatency(api.health, 5_000);
  const ready = useLatency(api.ready, 10_000);
  const name = user.displayName ?? user.email;
  return (
    <ShellLayout layout={LAYOUT}>
      <Hero tone="run" meta={user.tenantName ?? '회사'} title={`${name}\n계정입니다`} foot="회사 멤버면 승인까지 모두 할 수 있습니다">
        <p className="t-body-md c-secondary">{user.email}</p>
      </Hero>
      <Stack area="side">
        <FoldTile title="서비스 상태" summary="자동 확인">
          <ul className={s.rows}>
            <ProbeRow name="API 서버" state={health} />
            <ProbeRow name="데이터베이스" state={ready} />
          </ul>
        </FoldTile>
        <FoldTile title="개발자 문서" summary="OpenAPI" defaultOpen={false}>
          <ul className={s.rows}>
            <li className={s.row}><a className={`${s.link} t-label-md`} href={`${API_BASE}/docs`} target="_blank" rel="noopener">API 문서</a></li>
            <li className={s.row}><a className={`${s.link} t-label-md`} href={`${API_BASE}/docs/openapi.json`} target="_blank" rel="noopener">openapi.json</a></li>
            <li className={s.row}><a className={`${s.link} t-label-md`} href={`${API_BASE}/docs/openapi.yaml`} target="_blank" rel="noopener">openapi.yaml</a></li>
          </ul>
        </FoldTile>
        <ActionRow>
          <ActionPill label="로그아웃" icon="rollback" onClick={() => void auth.logout()} />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}

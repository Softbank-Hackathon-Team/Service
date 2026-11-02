import { go } from '../../app/routes';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { FoldTile, Hero, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { Badge } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { CONN_LABEL, LABEL, PROVIDER_SHORT } from '../../lib/status';
import type { AgentReportBody, EnvironmentView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { fromInventory, realEnvs } from '../dashboard/model';
import { FoundResources } from '../migration/NewMigrationPage';
import { ShellLayout } from '../shell/ShellLayout';
import s from '../common/page.module.css';

const LAYOUT: BentoLayout = { columns: '280fr 620fr 472fr', rows: 'minmax(0, 1fr)', areas: ['list hero side'] };
const NO_SIDE: BentoLayout = { columns: '280fr 1092fr', rows: 'minmax(0, 1fr)', areas: ['list hero'] };

const ago = (iso: string | null) => {
  if (!iso) return '기록 없음';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return '방금';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return seconds < 86400 ? `${Math.floor(seconds / 3600)}시간 전` : `${Math.floor(seconds / 86400)}일 전`;
};

const STAGE = { before: '이전 전', changing: '이전 중', after: '이전 끝', undone: '되돌림' } as const;

function reportLine(report: AgentReportBody) {
  if (report.kind === 'heartbeat') return `k3s ${report.k3sVersion}${report.cnpg ? ` · DB ${report.cnpg.ready ? '준비됨' : '준비 안 됨'}` : ''}`;
  if (report.kind === 'deploy') return `배포 ${report.status === 'applied' ? '적용' : '실패'} · 자원 ${report.resources.length}개`;
  return `보안 보고 · 발견 ${report.findings.length}개`;
}

function AgentReports({ envId }: { envId: string }) {
  const reports = usePoll(() => or404(api.agentReports(envId)), 15_000, [envId]);
  const data = reports.data;
  return (
    <FoldTile title="온프레 Agent 보고" summary={data?.stale ? '끊김 의심' : `마지막 신호 ${ago(data?.lastHeartbeatAt ?? null)}`}>
      {data && data.items.length > 0 ? (
        <ul className={s.rows}>
          {data.items.map((item) => (
            <li key={item.id} className={s.row}>
              <span className="t-body-sm">{reportLine(item.report)}</span>
              <span className="t-caption c-tertiary">{ago(item.receivedAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`${s.note} t-body-sm c-tertiary`}>받은 보고가 없습니다.</p>
      )}
    </FoldTile>
  );
}

function ConnectedEnv({ env }: { env: EnvironmentView }) {
  const inventory = usePoll(() => api.envInventory(env.id), 15_000, [env.id], { keepOnError: false });
  const data = inventory.data;
  const seen = data ? fromInventory(data.cloud) : null;
  const unknown = seen?.health === 'unknown';
  const title = !data
    ? inventory.error ? '자원을\n읽지 못했습니다' : '자원을\n읽고 있습니다'
    : seen?.health === 'healthy' ? `${env.name}\n정상입니다` : unknown ? `${env.name}\n확인할 수 없습니다` : `${env.name}\n불안정합니다`;
  return (
    <>
      <Hero tone="run" meta={`${PROVIDER_SHORT[env.provider]}${seen?.mock ? ' · 모의' : ''}`} title={title}>
        {seen && !unknown && (
          <ul className={s.heroStats}>
            <li><span className="t-metric-lg">{seen.resources}</span><span className="t-caption c-tertiary">자원</span></li>
            <li><span className="t-metric-lg">{seen.region ?? '–'}</span><span className="t-caption c-tertiary">리전</span></li>
          </ul>
        )}
        {seen?.problem && <p className={`t-body-md ${unknown ? 'c-secondary' : 'c-warning'}`}>{seen.problem}</p>}
        {inventory.error != null && !data && <p className={`${s.error} t-body-md`}>{errorText(inventory.error)}</p>}
      </Hero>
      <Stack area="side">
        <FoldTile title="이 환경의 이전" summary={`${data?.apps.length ?? 0}건`}>
          {data && data.apps.length > 0 ? (
            <ul className={s.rows}>
              {data.apps.map((app) => (
                <li key={app.migrationId}>
                  <button type="button" className={s.listButton} onClick={() => go(`migrations/${app.migrationId}`)}>
                    <span className={s.formRow}>
                      <span className="t-label-md">{app.spec?.app ?? `${app.role === 'source' ? '출발' : '도착'} · ${app.peer.name}`}</span>
                      <Badge>{LABEL[app.migrationStatus] ?? STAGE[app.stage]}</Badge>
                    </span>
                    <span className="t-caption c-tertiary">
                      {app.role === 'source' ? `${app.peer.name}로 나감` : `${app.peer.name}에서 들어옴`}
                      {app.trafficPct !== null ? ` · 트래픽 ${app.trafficPct}%` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${s.note} t-body-sm c-tertiary`}>이 환경을 쓰는 이전이 없습니다.</p>
          )}
        </FoldTile>
        {data && <FoundResources cloud={data.cloud} />}
        {env.provider === 'onprem' && <AgentReports envId={env.id} />}
      </Stack>
    </>
  );
}

function DisconnectedEnv({ env }: { env: EnvironmentView }) {
  return (
    <>
      <Hero tone="stop" meta={`${PROVIDER_SHORT[env.provider]} · ${CONN_LABEL[env.connectionStatus]}`} title={`${env.name}\n연결되어 있지 않습니다`} foot={env.lastVerifiedAt ? `마지막 확인 ${ago(env.lastVerifiedAt)}` : undefined}>
        {env.failureReason && <div className={s.heroPanel}><span className="t-body-md">{env.failureReason}</span></div>}
      </Hero>
      <Stack area="side">{env.provider === 'onprem' && <AgentReports envId={env.id} />}</Stack>
    </>
  );
}

export function EnvironmentsPage({ id }: { id: string | null }) {
  const envs = usePoll(api.listEnvironments, 10_000, []);
  const list = realEnvs(envs.data ?? []);
  const env = list.find((item) => item.id === id) ?? list[0];
  const connected = env?.connectionStatus === 'connected';
  const hasSide = connected || env?.provider === 'onprem';
  return (
    <ShellLayout layout={hasSide ? LAYOUT : NO_SIDE}>
      <Tile area="list" compact scroll>
        <TileHeader title="환경" />
        <ul className={s.listTile}>
          {list.map((item) => (
            <li key={item.id}>
              <button type="button" className={`${s.listButton} ${item.id === env?.id ? s.listSelected : ''}`} aria-current={item.id === env?.id ? 'true' : undefined} onClick={() => go(`environments/${item.id}`)}>
                <span className={s.formRow}>
                  <span className="t-label-md">{item.name}</span>
                  {item.connectionStatus !== 'connected' && <Badge tone="danger">{CONN_LABEL[item.connectionStatus]}</Badge>}
                </span>
                <span className="t-caption c-tertiary">{PROVIDER_SHORT[item.provider]}</span>
              </button>
            </li>
          ))}
        </ul>
      </Tile>
      {!env ? (
        <Hero tone="run" meta="환경" title={envs.loading ? '환경을\n읽고 있습니다' : '연결된 환경이\n없습니다'} />
      ) : connected ? (
        <ConnectedEnv key={env.id} env={env} />
      ) : (
        <DisconnectedEnv key={env.id} env={env} />
      )}
    </ShellLayout>
  );
}

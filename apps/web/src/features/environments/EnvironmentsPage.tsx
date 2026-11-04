import { go } from '../../app/routes';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { ActionPill, Badge } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { connectionReasonText } from '../../lib/failure';
import { or404 } from '../../lib/http';
import { ago } from '../../lib/text';
import { CONN_LABEL, LABEL } from '../../lib/status';
import type { AgentReportBody, EnvironmentView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { fromInventory, realEnvs } from '../dashboard/model';
import { leftoversOf } from '../migration/model';
import { FoundResources } from '../migration/NewMigrationPage';
import { vendorLine } from '../migration/source';
import { ShellLayout } from '../shell/ShellLayout';
import { envPath } from './connect';
import { RegisterEnvEntry } from './EnvEntry';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

const LAYOUT: BentoLayout = { columns: ['narrow', 'fill', 'side'], areas: 'list hero side' };

const STAGE = { before: t('마이그레이션 전'), changing: t('마이그레이션 중'), after: t('마이그레이션 끝'), undone: t('되돌림') } as const;

function reportLine(report: AgentReportBody) {
  if (report.kind === 'heartbeat') return `k3s ${report.k3sVersion}${report.cnpg ? ` · DB ${report.cnpg.ready ? t('준비됨') : t('준비 안 됨')}` : ''}`;
  if (report.kind === 'deploy') return report.status === 'applied' ? t('배포 적용 · 자원 {0}개', { 0: report.resources.length }) : t('배포 실패{0}', { 0: report.reason ? ` · ${report.reason}` : '' });
  const failed = report.findings.filter((finding) => finding.status === 'fail');
  const threats = failed.filter((finding) => finding.kind === 'threat').length;
  return t('보안 보고 · 위반 {0}개 · 위협 {1}개', { 0: failed.length - threats, 1: threats });
}

function AgentReports({ envId }: { envId: string }) {
  const reports = usePoll(() => or404(api.agentReports(envId)), 15_000, [envId]);
  const data = reports.data;
  return (
    <FoldTile title={t('온프레 Agent 보고')} summary={data?.stale ? t('끊김 의심') : t('마지막 신호 {0}', { 0: ago(data?.lastHeartbeatAt ?? null) })}>
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
        <p className={`${s.note} t-body-sm c-tertiary`}>{t('받은 보고가 없습니다.')}</p>
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
    ? inventory.error ? t('자원을\n읽지 못했습니다') : t('자원을\n읽고 있습니다')
    : seen?.health === 'healthy' ? t('{0}\n정상입니다', { 0: env.name }) : unknown ? t('{0}\n확인할 수 없습니다', { 0: env.name }) : t('{0}\n불안정합니다', { 0: env.name });
  return (
    <>
      <Hero tone="run" meta={`${vendorLine(env.provider)}${seen?.mock ? t(' · 모의') : ''}`} title={title}>
        {seen && !unknown && (
          <ul className={s.heroStats}>
            <li><span className="t-metric-lg">{seen.resources}</span><span className="t-caption c-tertiary">{t('자원')}</span></li>
            <li><span className="t-metric-lg">{seen.region ?? '–'}</span><span className="t-caption c-tertiary">{t('리전')}</span></li>
          </ul>
        )}
        {seen?.problem && <p className={`t-body-md ${unknown ? 'c-secondary' : 'c-warning'}`}>{seen.problem}</p>}
        {inventory.error != null && !data && <p className={`${s.error} t-body-md`}>{errorText(inventory.error)}</p>}
      </Hero>
      <Stack area="side">
        <FoldTile title={t('이 환경의 마이그레이션')} summary={t('{0}건', { 0: data?.apps.length ?? 0 })}>
          {data && data.apps.length > 0 ? (
            <ul className={s.rows}>
              {data.apps.map((app) => {
                // 끝난(실패·롤백·취소) 이전이 이 환경에 남긴 자원. 정리할 것이 있으면 줄에서 바로 보이게 한다
                const left = app.stage === 'undone' ? (leftoversOf([app], app.migrationId)?.length ?? 0) : 0;
                return (
                  <li key={app.migrationId}>
                    <button type="button" className={s.listButton} onClick={() => go(`migrations/${app.migrationId}`)}>
                      <span className={s.formRow}>
                        <span className="t-label-md">{app.spec?.app ?? `${app.role === 'source' ? t('출발') : t('도착')} · ${app.peer.name}`}</span>
                        <Badge>{LABEL[app.migrationStatus] ?? STAGE[app.stage]}</Badge>
                      </span>
                      <span className="t-caption c-tertiary">
                        {app.role === 'source' ? t('{0}로 나감', { 0: app.peer.name }) : t('{0}에서 들어옴', { 0: app.peer.name })}
                        {app.trafficPct !== null ? t(' · 트래픽 {0}%', { 0: app.trafficPct }) : ''}
                      </span>
                      {left > 0 && <span className="t-caption c-warning">{t('남은 자원 {0}개', { 0: left })}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={`${s.note} t-body-sm c-tertiary`}>{t('이 환경을 쓰는 마이그레이션이 없습니다.')}</p>
          )}
        </FoldTile>
        {data && <FoundResources cloud={data.cloud} />}
        {env.provider === 'onprem' && <AgentReports envId={env.id} />}
      </Stack>
    </>
  );
}

function DisconnectedEnv({ env }: { env: EnvironmentView }) {
  // 해제된 환경은 다시 연결할 수 없다(새로 등록). 나머지는 등록 흐름에서 이어 한다
  const gone = env.connectionStatus === 'disconnected';
  return (
    <>
      <Hero tone="stop" meta={`${vendorLine(env.provider)} · ${CONN_LABEL[env.connectionStatus]}`} title={t('{0}\n연결되어 있지 않습니다', { 0: env.name })} foot={env.lastVerifiedAt ? t('마지막 확인 {0}', { 0: ago(env.lastVerifiedAt) }) : undefined}>
        {env.failureReason && <div className={s.heroPanel}><span className="t-body-md">{connectionReasonText(env.failureReason)}</span></div>}
      </Hero>
      <Stack area="side">
        {env.provider === 'onprem' && <AgentReports envId={env.id} />}
        <ActionRow>
          <ActionPill label={gone ? t('새로 등록하기') : t('연결 이어 하기')} icon={gone ? 'plus' : 'arrow-right'} onClick={() => go(gone ? 'environments/connect' : envPath(env))} />
        </ActionRow>
      </Stack>
    </>
  );
}

export function EnvironmentsPage({ id }: { id: string | null }) {
  const envs = usePoll(api.listEnvironments, 10_000, []);
  const list = realEnvs(envs.data ?? []);
  const env = list.find((item) => item.id === id) ?? list[0];
  const connected = env?.connectionStatus === 'connected';
  return (
    <ShellLayout layout={LAYOUT}>
      <Tile area="list" compact scroll>
        <TileHeader title={t('환경')} />
        <ul className={s.listTile}>
          {list.map((item) => (
            <li key={item.id}>
              <button type="button" className={`${s.listButton} ${item.id === env?.id ? s.listSelected : ''}`} aria-current={item.id === env?.id ? 'true' : undefined} onClick={() => go(`environments/${item.id}`)}>
                <span className={s.formRow}>
                  <span className="t-label-md">{item.name}</span>
                  {item.connectionStatus !== 'connected' && <Badge tone="danger">{CONN_LABEL[item.connectionStatus]}</Badge>}
                </span>
                <span className="t-caption c-tertiary">{vendorLine(item.provider)}</span>
              </button>
            </li>
          ))}
          <li>
            <RegisterEnvEntry variant="list" />
          </li>
        </ul>
      </Tile>
      {!env ? (
        <Hero tone="run" meta={t('환경')} title={envs.loading ? t('환경을\n읽고 있습니다') : t('연결된 환경이\n없습니다')} />
      ) : connected ? (
        <ConnectedEnv key={env.id} env={env} />
      ) : (
        <DisconnectedEnv key={env.id} env={env} />
      )}
    </ShellLayout>
  );
}

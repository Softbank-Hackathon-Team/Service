import { go } from '../../app/routes';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack, Tile, TileHeader } from '../../components/layout/tiles';
import { ActionPill, Badge, BarPill } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { connectionReasonText } from '../../lib/failure';
import { or404 } from '../../lib/http';
import { ago } from '../../lib/text';
import { CONN_LABEL, LABEL } from '../../lib/status';
import type { AgentReportBody, EnvironmentView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { EnvCostCaption, EnvCostFold } from '../cost/CostEvidence';
import { fromInventory, realEnvs } from '../dashboard/model';
import { leftoversOf } from '../migration/model';
import { FoundResources } from '../migration/NewMigrationPage';
import { vendorLine } from '../migration/source';
import { ShellLayout } from '../shell/ShellLayout';
import { AgentCommand, until, useAgentToken } from './AgentToken';
import { PermissionFold } from './Permissions';
import { REGISTER_PATH, isLinked } from './connect';
import { RegisterEnvEntry } from './EnvEntry';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

const LAYOUT: BentoLayout = { columns: ['narrow', 'fill', 'side'], areas: 'list hero side' };

const STAGE = { before: t('마이그레이션 전'), changing: t('마이그레이션 중'), after: t('마이그레이션 끝'), undone: t('되돌림') } as const;

function reportLine(report: AgentReportBody) {
  if (report.kind === 'heartbeat') return `k3s ${report.k3sVersion}${report.cnpg ? ` · DB ${report.cnpg.ready ? t('준비됨') : t('준비 안 됨')}` : ''}`;
  if (report.kind === 'deploy') return report.status === 'applied' ? t('배포 적용 · 자원 {0}개', { 0: report.resources.length }) : t('배포 실패{0}', { 0: report.reason ? ` · ${report.reason}` : '' });
  if (report.kind === 'facts') {
    const tls = report.dbs.filter((db) => db.tlsEnforced === false).length;
    const open = report.dbs.filter((db) => db.exposed === true).length;
    // 영어 단수·복수는 자리 0 으로 고르므로 DB 수를 {0} 에 둔다
    return t('보안 사실 · 권한 {1} · DB {0}개 (TLS 강제 아님 {2}, 밖에 열림 {3})', { 0: report.dbs.length, 1: report.grants.level, 2: tls, 3: open });
  }
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
        {(env.provider === 'aws' || env.provider === 'gcp') && <PermissionFold env={env} />}
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
        <EnvCostFold envId={env.id} />
        {data && <FoundResources cloud={data.cloud} />}
        {env.provider === 'onprem' && <AgentReports envId={env.id} />}
        {env.provider === 'onprem' && <AgentEnrollFold env={env} />}
      </Stack>
    </>
  );
}

const AGENT_BACK = t('Agent 신호가 오면 이 화면의 연결 상태와 마지막 신호가 저절로 바뀝니다.');

/**
 * 이미 연결된 온프레 환경의 Agent 다시 등록. Agent 를 새로 깔았거나 키를 잃었을 때 등록 명령을 새로 받는다.
 * 환경 등록과 같은 토큰 요청·같은 명령 칸을 쓴다 (AgentToken.tsx). 받으면 앞서 받고 쓰지 않은 토큰은 바로 끝난다
 */
function AgentEnrollFold({ env }: { env: EnvironmentView }) {
  const enroll = useAgentToken(env.id);
  return (
    <FoldTile title={t('Agent 다시 등록')} summary={enroll.token ? t('{0}까지', { 0: until(enroll.token.expiresAt) }) : t('등록 토큰')} defaultOpen={false}>
      <p className={`${s.note} t-body-sm c-secondary`}>{t('Agent 를 새로 깔았거나 키를 잃었으면 등록 명령을 새로 받아 실행합니다. 새로 받으면 앞서 받고 쓰지 않은 토큰은 바로 끝납니다.')}</p>
      {enroll.token && <AgentCommand token={enroll.token} pending={null} after={AGENT_BACK} />}
      {enroll.error && <p className={`${s.error} t-body-sm`}>{enroll.error}</p>}
      <div className={s.note}>
        <BarPill label={enroll.issuing ? t('받는 중') : enroll.token ? t('새 명령 받기') : t('등록 토큰 다시 받기')} icon="refresh" onClick={enroll.issuing ? undefined : () => void enroll.issue()} />
      </div>
    </FoldTile>
  );
}

/**
 * 연결되어 있지 않은 환경. 목록은 연결됨·불안정만 보이므로(isLinked) 여기 오는 것은 거의 불안정이다.
 * 불안정은 등록 흐름(ConnectPage)으로 고칠 수 없다: 서버는 연결 링크·확인 요청을 등록 중·실패·만료 환경에서만 받는다.
 * - 온프레(pull 모드): Agent 신호가 끊긴 것. 고객 클러스터에서 Agent 를 다시 띄우거나, 등록 명령을 새로 받아 다시 등록한다.
 *   신호가 다시 오면 서버가 연결됨으로 되돌린다 (apps/api agent-reports.ts heartbeatConnection)
 * - AWS·GCP: 플랫폼의 주기 재확인이 연달아 실패한 것. 다음 재확인이 통과하면 저절로 연결됨으로 돌아간다 (worker verify-connection).
 *   DRAFT(ai): 사람이 누를 재확인 길이 서버에 없어 버튼을 두지 않고, 저절로 돌아간다는 것만 알린다
 */
function DisconnectedEnv({ env }: { env: EnvironmentView }) {
  const gone = env.connectionStatus === 'disconnected';
  const unstable = env.connectionStatus === 'unstable';
  const onprem = env.provider === 'onprem';
  const enroll = useAgentToken(env.id);
  return (
    <>
      <Hero
        tone="stop"
        meta={`${vendorLine(env.provider)} · ${CONN_LABEL[env.connectionStatus]}`}
        title={unstable ? t('{0}\n연결이 불안정합니다', { 0: env.name }) : t('{0}\n연결되어 있지 않습니다', { 0: env.name })}
        foot={env.lastVerifiedAt ? t('마지막 확인 {0}', { 0: ago(env.lastVerifiedAt) }) : undefined}
      >
        {(env.failureReason || unstable) && (
          <div className={s.heroPanel}>
            {env.failureReason && <span className="t-body-md">{connectionReasonText(env.failureReason)}</span>}
            {unstable && (
              <span className="t-body-sm c-secondary">
                {onprem
                  ? t('Agent 가 멈췄으면 고객 클러스터에서 다시 띄웁니다. 새로 깔아야 하면 등록 명령을 새로 받아 실행합니다.')
                  : t('플랫폼이 주기적으로 연결을 다시 확인합니다. 확인이 통과하면 저절로 연결됨으로 돌아갑니다.')}
              </span>
            )}
          </div>
        )}
        {unstable && onprem && (enroll.token || enroll.error) && (
          <div className={s.heroPanel}>
            {enroll.token && <AgentCommand token={enroll.token} pending={null} after={AGENT_BACK} />}
            {enroll.error && <span className={`${s.error} t-body-md`}>{enroll.error}</span>}
          </div>
        )}
      </Hero>
      <Stack area="side">
        {onprem && <AgentReports envId={env.id} />}
        {gone ? (
          // 해제된 환경은 다시 연결할 수 없다(새로 등록)
          <ActionRow>
            <ActionPill label={t('새로 등록하기')} icon="plus" onClick={() => go(REGISTER_PATH)} />
          </ActionRow>
        ) : (
          onprem && (
            <ActionRow>
              <ActionPill
                label={enroll.issuing ? t('받는 중') : enroll.token ? t('새 명령 받기') : t('등록 토큰 다시 받기')}
                icon="refresh"
                disabled={enroll.issuing}
                onClick={() => void enroll.issue()}
              />
            </ActionRow>
          )
        )}
      </Stack>
    </>
  );
}

export function EnvironmentsPage({ id }: { id: string | null }) {
  const envs = usePoll(api.listEnvironments, 10_000, []);
  // 등록을 마친 환경만. 끝나지 않은 등록은 기억하지 않는다 (connect.ts isLinked)
  const list = realEnvs(envs.data ?? []).filter(isLinked);
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
                  {(item.permissionGaps ?? 0) > 0 && <Badge tone="warning">{t('권한 갱신 필요 ({0}개)', { 0: item.permissionGaps })}</Badge>}
                </span>
                <span className="t-caption c-tertiary">{vendorLine(item.provider)}</span>
                <EnvCostCaption envId={item.id} />
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

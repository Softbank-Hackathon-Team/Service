import { useState } from 'react';
import { FoldTile } from '../../components/layout/tiles';
import { CodeValue } from '../../components/ui/CodeValue';
import { Badge, BarPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { ago } from '../../lib/text';
import type { EnvironmentView, EnvPermissions, PermissionFix, PermissionGap } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { fixableGaps } from './permissions-model';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

// PERM-GATE: 고객 권한 묶음. 환경 화면(PermissionFold)과 이전 화면의 사전 점검 막힘(PermissionGapFold)이 같은 줄·같은 고치는 법을 쓴다.
//   서버가 빠진 권한·API 이름과 고치는 링크(GCP = 빠진 묶음만 맞추는 Cloud Shell, AWS = 연결 스택 업데이트)를 준다. 이 화면은 그대로 보여 준다

const MAX_NAMES = 6;

const sideLabel = (g: PermissionGap) => (g.side === 'source' ? t('출발') : g.side === 'target' ? t('도착') : t('출발·도착'));

function names(xs: string[]) {
  return xs.length > MAX_NAMES ? `${xs.slice(0, MAX_NAMES).join(', ')}${t(' 외 {0}개', { 0: xs.length - MAX_NAMES })}` : xs.join(', ');
}

/** 묶음 한 줄: 무엇이(주체·역할) 무엇이 빠졌나 */
export function GapRows({ gaps }: { gaps: PermissionGap[] }) {
  return (
    <ul className={s.rows}>
      {gaps.map((g) => (
        <li key={`${g.envId}:${g.bundleId}`}>
          <div className={`${s.row} ${s.rowStack}`}>
            <span className={s.formRow}>
              <span className="t-label-md">{g.bundleId}</span>
              <Badge tone={g.level === 'block' ? 'danger' : 'warning'}>{g.level === 'block' ? t('막힘') : t('주의')}</Badge>
            </span>
            <span className="t-caption c-tertiary">{`${sideLabel(g)} · ${g.principal} · ${g.role}`}</span>
          </div>
          {g.missing.length > 0 && <p className={`${s.rowCaption} t-body-sm`}>{t('빠진 권한 {0}개: {1}', { 0: g.missing.length, 1: names(g.missing) })}</p>}
          {g.missingApis.length > 0 && <p className={`${s.rowCaption} t-body-sm`}>{t('꺼진 API: {0}', { 0: names(g.missingApis) })}</p>}
          {g.notInTable && g.notInTable.length > 0 && (
            <p className={`${s.rowCaption} t-body-sm c-warning`}>{t('플랫폼 권한표에도 없는 권한: {0} — 고객 링크로는 안 고쳐집니다', { 0: names(g.notInTable) })}</p>
          )}
          {g.unverified && g.missing.length === 0 && <p className={`${s.rowCaption} t-caption c-secondary`}>{t('확인 못 함: {0}', { 0: g.unverified })}</p>}
        </li>
      ))}
    </ul>
  );
}

/** 고치는 법: 링크 버튼 + 붙여 넣을 명령(복사). 명령에는 비밀값·계정 번호가 없다 (서버가 만든 그대로) */
export function FixSteps({ fix }: { fix: PermissionFix }) {
  const aws = fix.kind === 'cloudformation';
  return (
    <ol className={s.todo}>
      {fix.url && (
        <li>
          <span className="t-body-md">{aws ? t('같은 연결 스택을 새 템플릿으로 업데이트합니다. 매개변수는 그대로 둡니다.') : t('Cloud Shell 을 엽니다.')}</span>
          <a className={s.linkPill} href={fix.url} target="_blank" rel="noopener noreferrer">
            <Icon name="external" />
            <span className="t-label-md">{aws ? t('AWS 연결 스택 갱신') : t('Cloud Shell 에서 갱신')}</span>
          </a>
        </li>
      )}
      <li>
        <span className="t-body-md">{aws ? t('또는 이 명령을 터미널에서 실행합니다.') : t('이 명령을 붙여 넣어 실행합니다. 빠진 묶음만 맞추고, 다시 실행해도 결과가 같습니다.')}</span>
        <CodeValue value={fix.command} chip max={56} />
      </li>
      <li>
        <span className="t-body-md">{t('끝나면 [다시 확인]을 누릅니다.')}</span>
      </li>
    </ol>
  );
}

function summaryOf(p: EnvPermissions | null, loading: boolean): string {
  if (!p) return loading ? t('읽는 중') : t('확인 안 함');
  if (p.refreshing) return t('확인하는 중');
  if (!p.checkedAt) return t('확인 안 함');
  const n = fixableGaps(p.gaps).length;
  if (n > 0) return t('권한 갱신 필요 ({0}개)', { 0: n });
  if (p.error || p.gaps.length > 0) return t('확인 못 함');
  return t('최신 · 권한 판 {0}', { 0: p.requiredVersion });
}

/** 다시 확인: 작업을 넣고(202) 결과가 올 때까지 짧게 다시 읽는다 */
function useRecheck(envId: string, reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try { await api.checkPermissions(envId); await reload(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return { busy, error, run };
}

/** 환경 화면: 연결 상태 옆 권한 칸. 확인한 적 없거나 빠진 묶음이 있으면 펼쳐 둔다 */
export function PermissionFold({ env }: { env: EnvironmentView }) {
  const perms = usePoll(() => api.envPermissions(env.id), 10_000, [env.id]);
  const p = perms.data;
  const check = useRecheck(env.id, perms.reload);
  const gaps = p?.gaps ?? [];
  const open = !p?.checkedAt || fixableGaps(gaps).length > 0;
  return (
    <FoldTile key={open ? 'open' : 'closed'} title={t('고객 권한')} summary={summaryOf(p, perms.loading)} defaultOpen={open}>
      {p?.checkedAt && (
        <p className={`${s.note} t-caption c-tertiary`}>
          {t('마지막 확인 {0} · 필요한 권한 판 {1} · 고객 쪽 {2}', { 0: ago(p.checkedAt), 1: p.requiredVersion, 2: p.grantedVersion ?? '–' })}
        </p>
      )}
      {!p?.checkedAt && !p?.refreshing && <p className={`${s.note} t-body-sm c-secondary`}>{t('단계마다 필요한 고객 권한이 다 있는지 관찰 역할로 읽어 봅니다. 고객 계정에는 아무것도 바꾸지 않습니다.')}</p>}
      {p?.error && <p className={`${s.note} t-body-sm c-warning`}>{p.error}</p>}
      {gaps.length > 0 && <GapRows gaps={gaps} />}
      {p?.fix && fixableGaps(gaps).length > 0 && <FixSteps fix={p.fix} />}
      {fixableGaps(gaps).length > 0 && !p?.fix && <p className={`${s.note} t-body-sm c-secondary`}>{t('고치는 링크를 만들 플랫폼 설정이 없습니다. 빠진 권한을 고객 역할에 직접 더합니다.')}</p>}
      {(check.error || perms.error != null) && <p className={`${s.error} t-body-sm`}>{check.error ?? errorText(perms.error)}</p>}
      <div className={s.note}>
        <BarPill label={check.busy || p?.refreshing ? t('확인하는 중') : t('다시 확인')} icon="refresh" onClick={check.busy || p?.refreshing ? undefined : () => void check.run()} />
      </div>
    </FoldTile>
  );
}

/**
 * 이전 화면: 사전 점검이 고객 권한으로 막혔을 때. 막힌 묶음만 고치는 링크를 환경마다 받는다.
 * 고친 뒤 환경의 [다시 확인]은 권한만 다시 보고, 이전은 명세를 다시 확정하면 사전 점검을 처음부터 다시 한다
 */
export function PermissionGapFold({ gaps }: { gaps: PermissionGap[] }) {
  const envIds = [...new Set(gaps.map((g) => g.envId))];
  return (
    <FoldTile title={t('고객 권한')} summary={t('권한 갱신 필요 ({0}개)', { 0: fixableGaps(gaps).length })}>
      <GapRows gaps={gaps} />
      {envIds.map((envId) => <EnvFix key={envId} envId={envId} bundles={[...new Set(fixableGaps(gaps).filter((g) => g.envId === envId).map((g) => g.bundleId))]} />)}
      <p className={`${s.note} t-body-sm c-secondary`}>{t('고친 뒤 명세를 다시 확정하면 사전 점검을 처음부터 다시 합니다.')}</p>
    </FoldTile>
  );
}

function EnvFix({ envId, bundles }: { envId: string; bundles: string[] }) {
  const perms = usePoll(bundles.length ? () => api.envPermissions(envId, bundles) : null, null, [envId, bundles.join(',')]);
  const check = useRecheck(envId, perms.reload);
  if (!bundles.length) return null;
  return (
    <>
      {perms.data?.fix ? <FixSteps fix={perms.data.fix} /> : perms.data && <p className={`${s.note} t-body-sm c-secondary`}>{t('고치는 링크를 만들 플랫폼 설정이 없습니다. 빠진 권한을 고객 역할에 직접 더합니다.')}</p>}
      {(check.error || perms.error != null) && <p className={`${s.error} t-body-sm`}>{check.error ?? errorText(perms.error)}</p>}
      <div className={s.note}>
        <BarPill label={check.busy ? t('확인하는 중') : t('다시 확인')} icon="refresh" onClick={check.busy ? undefined : () => void check.run()} />
      </div>
    </>
  );
}

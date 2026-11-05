import { useState, type ReactNode } from 'react';
import { CodeValue } from '../../components/ui/CodeValue';
import { api } from '../../lib/api';
import { errorCode, errorText } from '../../lib/errors';
import type { AgentEnrollToken } from '../../lib/types';
import s from '../common/page.module.css';
import { localeTag, t } from '../../lib/i18n';

// 온프레 Agent 등록 토큰 (POST /environments/:id/agent-token, apps/api agent-enroll.ts).
// 토큰 원문은 이 응답에만 있고 다시 볼 수 없다. 다시 받으면 이 환경의 쓰지 않은 옛 토큰은 바로 끝난다.
// 서버는 등록 중인 환경뿐 아니라 이미 연결됐거나 불안정한 환경에도 토큰을 준다 (상태는 그대로). 해제된 환경만 409 ENV_DISCONNECTED

export const until = (iso: string) =>
  new Date(iso).toLocaleString(localeTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 등록 토큰 받기. after 는 받은 뒤 한 번 부른다 (환경 목록 다시 읽기 등) */
export function useAgentToken(envId: string, after?: () => unknown) {
  const [token, setToken] = useState<AgentEnrollToken | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const issue = async () => {
    setIssuing(true);
    setError(null);
    setCode(null);
    try {
      setToken(await api.agentToken(envId));
      await after?.();
    } catch (reason) {
      setError(errorText(reason));
      setCode(errorCode(reason));
    } finally {
      setIssuing(false);
    }
  };
  return { token, issuing, error, code, issue };
}

/**
 * 등록 명령 두 줄: 고객 클러스터에서 실행할 명령(복사) → 붙은 뒤 무엇이 바뀌는지와 토큰 만료.
 * 환경 등록(ConnectPage)과 환경 화면의 Agent 다시 등록이 같이 쓴다.
 */
export function AgentCommand({ token, pending, after }: { token: AgentEnrollToken | null; pending: ReactNode; after: string }) {
  return (
    <ol className={s.todo}>
      <li>
        <span className="t-body-md">{t('고객 클러스터에 닿는 터미널에서 이 명령을 실행합니다.')}</span>
        {token ? <CodeValue value={token.command} chip max={56} /> : pending}
      </li>
      <li>
        <span className="t-body-md">{after}</span>
        {token && <span className="t-caption c-tertiary">{t('명령의 토큰은 {0}까지 한 번만 씁니다', { 0: until(token.expiresAt) })}</span>}
      </li>
    </ol>
  );
}

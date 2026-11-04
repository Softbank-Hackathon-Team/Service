import type { ChecklistEntry } from '../../components/ui/Checklist';
import type { ConnectionStatus, EnvironmentView, Provider } from '../../lib/types';
import { t } from '../../lib/i18n';

// 환경 등록 흐름의 판단. 화면(ConnectPage)은 이 파일만 보고 단계를 고른다. 시험은 test/connect-model.test.ts
// 서버 흐름: POST /environments(draft) → 연결 링크(AWS·GCP) 또는 Agent 등록 토큰(온프레) → 고객이 역할·Agent 를 만듦
//   → AWS·GCP 는 계정 번호로 확인 요청(verifying) → 워커가 역할을 빌려 봄 → connected 또는 failed. 온프레는 Agent 가 붙으면 connected

export type ConnectableProvider = Exclude<Provider, 'azure_mock'>;

/** 등록할 수 있는 곳. Azure 는 모의만 있어 등록하지 않는다. */
export const CONNECTABLE: { provider: ConnectableProvider; label: string; detail: string }[] = [
  { provider: 'aws', label: 'AWS', detail: t('계정에 스택 하나를 만들어 관찰 역할과 실행 역할을 엽니다') },
  { provider: 'gcp', label: 'GCP', detail: t('Cloud Shell 에서 명령 한 줄로 프로젝트 권한을 엽니다') },
  { provider: 'onprem', label: t('온프레 k3s'), detail: t('고객 클러스터에 Agent 를 설치해 연결합니다') },
];

export const providerLabel = (provider: Provider) => CONNECTABLE.find((item) => item.provider === provider)?.label ?? provider;

// 서버 검사와 같은 모양 (api environments.ts AWS_REGION_RE, adapters EKS_CLUSTER_NAME_RE, contracts checkAccountId)
const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const EKS_CLUSTER_RE = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;
const AWS_ACCOUNT_RE = /^\d{12}$/;
const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

// DRAFT(ai): 데모 리전 기본값. 사람이 바꿀 수 있다
export const DEFAULT_AWS_REGION = 'ap-northeast-2';

export type EnvForm = { name: string; region: string; clusterName: string };
export type FormCheck<K extends string> = { ok: boolean; errors: Partial<Record<K, string>> };

/** 환경 만들기 칸. AWS 는 연결 링크에 EKS 클러스터 이름이 꼭 들어가서 여기서 받는다. */
export function checkEnvForm(provider: ConnectableProvider, form: EnvForm): FormCheck<keyof EnvForm> {
  const errors: Partial<Record<keyof EnvForm, string>> = {};
  const name = form.name.trim();
  if (!name) errors.name = t('이름을 적어 주세요');
  else if (name.length > 64) errors.name = t('64자까지입니다');
  if (provider === 'aws') {
    if (!AWS_REGION_RE.test(form.region.trim())) errors.region = t('예: ap-northeast-2');
    if (!EKS_CLUSTER_RE.test(form.clusterName.trim())) errors.clusterName = t('영문·숫자로 시작하고 영문·숫자·-·_ 로 100자까지입니다');
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export type AccountForm = { accountId: string; targetProjectId: string };

/** 연결 확인 칸. AWS 는 콘솔에 보이는 "1111-2222-3333" 도 받는다. GCP 이전 전용 프로젝트는 비워도 되지만 읽을 프로젝트와 달라야 한다. */
export function checkAccount(provider: ConnectableProvider, form: AccountForm): FormCheck<keyof AccountForm> & { accountId: string; targetProjectId?: string } {
  const errors: Partial<Record<keyof AccountForm, string>> = {};
  const accountId = provider === 'aws' ? form.accountId.replace(/[\s-]/g, '') : form.accountId.trim();
  const target = form.targetProjectId.trim();
  if (provider === 'aws' && !AWS_ACCOUNT_RE.test(accountId)) errors.accountId = t('숫자 12자리입니다');
  if (provider === 'gcp') {
    if (!GCP_PROJECT_RE.test(accountId)) errors.accountId = t('프로젝트 ID 모양이 아닙니다 (소문자로 시작, 6~30자)');
    if (target && !GCP_PROJECT_RE.test(target)) errors.targetProjectId = t('프로젝트 ID 모양이 아닙니다 (소문자로 시작, 6~30자)');
    else if (target && target === accountId) errors.targetProjectId = t('읽을 프로젝트와 다른 프로젝트여야 합니다');
  }
  return { ok: Object.keys(errors).length === 0, errors, accountId, ...(target ? { targetProjectId: target } : {}) };
}

/** 화면 단계. link: 고객이 역할·Agent 를 만들 차례. retry: 실패·만료라 링크부터 다시. gone: 해제돼 다시 쓸 수 없음. */
export type ConnectPhase = 'link' | 'retry' | 'verifying' | 'connected' | 'gone';

export function phaseOf(status: ConnectionStatus): ConnectPhase {
  switch (status) {
    case 'draft':
    case 'awaiting_customer':
      return 'link';
    case 'failed':
    case 'expired':
      return 'retry';
    case 'verifying':
      return 'verifying';
    case 'connected':
    case 'unstable':
      return 'connected';
    case 'disconnected':
      return 'gone';
  }
}

/** 단계에 따라 다시 읽는 간격. 고객·워커를 기다리는 동안만 빠르게. */
export const connectPollMs = (phase: ConnectPhase | null, provider?: Provider) =>
  phase === 'verifying' || (phase === 'link' && provider === 'onprem') ? 2_000 : 10_000;

/** 등록 단계 카드. 처음 두 칸은 이 화면, 셋째는 고객 쪽, 넷째는 플랫폼이 확인. */
export function connectSteps(
  at: 'provider' | 'details' | ConnectPhase,
  o: { provider?: Provider; name?: string } = {},
): ChecklistEntry[] {
  const onprem = o.provider === 'onprem';
  const order = ['provider', 'details', 'link', 'verifying', 'connected'] as const;
  const index = at === 'retry' ? 3 : at === 'gone' ? -1 : order.indexOf(at);
  const mark = (step: number, human: boolean): ChecklistEntry['status'] => {
    if (at === 'gone') return 'paused';
    if (step < index) return 'done';
    if (step > index) return 'pending';
    if (at === 'retry') return 'failed';
    return human ? 'waiting' : 'active';
  };
  return [
    { status: mark(0, true), label: t('어디를 연결할지'), detail: o.provider ? providerLabel(o.provider) : undefined },
    { status: mark(1, true), label: t('환경 이름'), detail: o.name },
    { status: mark(2, true), label: onprem ? t('Agent 설치') : t('권한 열기'), detail: t('고객 쪽') },
    // 온프레는 Agent 가 붙는 순간 연결되므로 확인 칸을 따로 기다리지 않는다
    { status: onprem && at === 'link' ? 'pending' : mark(3, false), label: t('연결 확인') },
  ];
}

/** 연결을 이어 할 곳. 이미 연결됐으면 환경 화면, 아니면 등록 흐름. 어디서 들어오든 같은 길로 보낸다. */
export const envPath = (env: Pick<EnvironmentView, 'id' | 'connectionStatus'>) =>
  env.connectionStatus === 'connected' || env.connectionStatus === 'unstable' ? `environments/${env.id}` : `environments/connect/${env.id}`;

export const REGISTER_PATH = 'environments/connect';

import { PROVIDER_SHORT } from '../../lib/status';
import { ago } from '../../lib/text';
import {
  SCOPE_APP_RE,
  SCOPE_NAME_RE,
  SCOPE_NAMESPACE_RE,
  type EnvApp,
  type EnvironmentView,
  type Provider,
  type SourceScope,
} from '../../lib/types';
import type { CloudInventory } from '../dashboard/model';

// 새 이전의 세 층: 연결된 환경(빌려 올 수 있는 계정) → 그 안에서 서비스 중인 것(출발 범위) → 옮겨 갈 환경(빌려 올 실행 권한).
// 화면은 이 파일의 판단만 쓴다. 시험은 test/source-scope.test.ts

export type EnvInventory = { cloud: CloudInventory; apps: EnvApp[] };

// DRAFT(ai): 연결은 계정 단위라 실제로 EKS 가 아닐 수도 있다(ECS·VM). 지금 지원 범위가 k8s 라 클러스터 소프트웨어 이름을 붙인다
export const PLATFORM: Record<Provider, string> = { aws: 'EKS', gcp: 'GKE', onprem: 'k3s', azure_mock: 'AKS' };

/** 벤더와 그 위의 클러스터 소프트웨어: "AWS EKS", "온프레 k3s". */
export const vendorLine = (provider: Provider) => `${PROVIDER_SHORT[provider]} ${PLATFORM[provider]}`;

/** 이 환경에서 지금 서비스 중인 앱인가. 출발이면 떠나기 전·되돌아온 앱, 도착이면 다 옮겨 온 앱. */
const servedHere = (app: EnvApp) => (app.role === 'source' ? app.stage !== 'after' : app.stage === 'after');

/** 온프레 Deployment "네임스페이스/이름" 을 네임스페이스로 묶는다. 이름 모양이 범위 규칙에 맞는 것만. */
function namespacesOf(cloud: CloudInventory) {
  const byNamespace = new Map<string, string[]>();
  for (const group of cloud.groups) {
    if (group.category !== 'workload') continue;
    for (const item of group.items) {
      const [namespace, name] = item.name.includes('/') ? item.name.split('/', 2) : [null, item.name];
      if (!namespace || !SCOPE_NAMESPACE_RE.test(namespace)) continue;
      byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), name ?? item.name]);
    }
  }
  return byNamespace;
}

const itemsOf = (cloud: CloudInventory, category: string) =>
  cloud.groups.filter((group) => group.category === category).flatMap((group) => group.items.map((item) => ({ ...item, service: group.service })));

/**
 * 이 환경에서 서비스 중인 소프트웨어 이름. 이전 기록의 앱 이름 → 온프레 네임스페이스 → 클라우드 클러스터 이름 순으로 처음 찾은 묶음.
 * 온프레의 클러스터 칸은 노드라 이름으로 쓰지 않는다. 읽지 못했으면 빈 목록.
 */
export function softwareOf(provider: Provider, inventory: EnvInventory | null | undefined): string[] {
  if (!inventory) return [];
  const unique = (names: (string | null | undefined)[]) => [...new Set(names.filter((name): name is string => !!name))];
  const apps = unique(inventory.apps.filter(servedHere).map((app) => app.spec?.app));
  if (apps.length > 0) return apps;
  const namespaces = [...namespacesOf(inventory.cloud).keys()];
  if (namespaces.length > 0) return namespaces;
  return provider === 'onprem' ? [] : unique(itemsOf(inventory.cloud, 'cluster').map((item) => item.name));
}

/** 고르는 줄의 제목: "shop-api", "shop-api 외 2개". 모르면 null. */
export const softwareTitle = (names: string[]) =>
  names.length === 0 ? null : names.length === 1 ? names[0]! : `${names[0]} 외 ${names.length - 1}개`;

export type ScopeChoice = { key: string; label: string; detail: string; scope: SourceScope };

export const AUTO_SCOPE: ScopeChoice = {
  key: 'auto',
  label: '자동으로 고르기',
  detail: '가져오기가 찾고, 애매한 칸은 명세 확정에서 묻습니다',
  scope: {},
};

/**
 * 출발 범위 후보. 온프레는 네임스페이스(그 안 CNPG DB 가 하나면 함께), 클라우드는 클러스터.
 * 클라우드 DB 는 클러스터와 짝을 알 수 없어 고르지 않는다(자동 또는 직접 적기).
 */
export function scopeChoices(provider: Provider, cloud: CloudInventory | null | undefined): ScopeChoice[] {
  if (!cloud) return [];
  if (provider === 'onprem') {
    const databases = itemsOf(cloud, 'database').map((item) => item.name);
    return [...namespacesOf(cloud)].map(([namespace, names]) => {
      const own = databases.filter((db) => db.startsWith(`${namespace}/`) && SCOPE_NAME_RE.test(db));
      const database = own.length === 1 ? own[0] : undefined;
      const detail = [`Deployment ${names.length}개 · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' …' : ''}`, database && `DB ${database}`];
      return {
        key: `ns:${namespace}`,
        label: namespace,
        detail: detail.filter(Boolean).join(' · '),
        scope: { namespaces: [namespace], ...(database ? { database } : {}) },
      };
    });
  }
  return itemsOf(cloud, 'cluster')
    .filter((item) => SCOPE_NAME_RE.test(item.name))
    .map((item) => ({
      key: `cluster:${item.name}`,
      label: item.name,
      detail: [item.service, item.status].filter(Boolean).join(' · '),
      scope: { cluster: item.name },
    }));
}

export type ScopeInput = { cluster: string; namespaces: string; database: string; appName: string };
export type ScopeCheck = { scope: SourceScope; errors: Partial<Record<keyof ScopeInput, string>> };

/** 직접 적은 출발 범위. 서버 SourceScope 규칙을 먼저 본다. 빈 칸은 자동으로 고른다. */
export function checkScopeInput(input: ScopeInput): ScopeCheck {
  const scope: SourceScope = {};
  const errors: ScopeCheck['errors'] = {};
  const cluster = input.cluster.trim();
  if (cluster) {
    if (SCOPE_NAME_RE.test(cluster)) scope.cluster = cluster;
    else errors.cluster = '영문·숫자로 시작하고 . _ / : - 만 씁니다';
  }
  const namespaces = [...new Set(input.namespaces.split(/[\s,]+/).filter(Boolean))];
  if (namespaces.length > 10) errors.namespaces = '네임스페이스는 10개까지입니다';
  else if (namespaces.some((namespace) => !SCOPE_NAMESPACE_RE.test(namespace))) errors.namespaces = '소문자·숫자·- 로 63자까지입니다';
  else if (namespaces.length > 0) scope.namespaces = namespaces;
  const database = input.database.trim();
  if (database) {
    if (SCOPE_NAME_RE.test(database)) scope.database = database;
    else errors.database = '영문·숫자로 시작하고 . _ / : - 만 씁니다';
  }
  const appName = input.appName.trim();
  if (appName) {
    if (SCOPE_APP_RE.test(appName)) scope.appName = appName;
    else errors.appName = '소문자로 시작하고 소문자·숫자·- 로 40자까지입니다';
  }
  return { scope, errors };
}

/** 출발 범위의 짧은 이름 (단계 카드·상단 알약). 가장 좁은 것 하나. */
export function scopeLabel(scope: SourceScope): string {
  return scope.appName ?? scope.namespaces?.[0] ?? scope.cluster ?? scope.ecsCluster ?? scope.partOf ?? scope.database ?? AUTO_SCOPE.label;
}

/** 출발 범위 한 줄. 비었으면 "자동으로 고름". */
export function scopeSummary(scope: SourceScope | null | undefined): string {
  if (!scope) return '자동으로 고름';
  const parts = [
    scope.appName && `앱 ${scope.appName}`,
    scope.cluster && `클러스터 ${scope.cluster}`,
    scope.ecsCluster && `ECS ${scope.ecsCluster}`,
    scope.namespaces?.length && `네임스페이스 ${scope.namespaces.join(', ')}`,
    scope.partOf && `앱 묶음 ${scope.partOf}`,
    scope.database && `DB ${scope.database}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '자동으로 고름';
}

/**
 * 옮겨 갈 수 있는 환경. 연결된 환경 중 출발이 아닌 것.
 * DRAFT(ai): 같은 벤더 안의 이전(AWS → AWS)은 지금 지원 범위 밖이라 목록에서 빼고, 뺀 것은 따로 돌려 화면이 한 줄로 알린다.
 *   서버는 막지 않는다(출발·도착이 다르기만 하면 됨). ECS → EKS 처럼 같은 벤더 안 이전을 열 때 이 판단만 바꾼다
 */
export function targetOptions(envs: EnvironmentView[], source: EnvironmentView) {
  const others = envs.filter((env) => env.connectionStatus === 'connected' && env.id !== source.id);
  return {
    options: others.filter((env) => env.provider !== source.provider),
    sameVendor: others.filter((env) => env.provider === source.provider),
  };
}

/** 도착 환경 줄의 한 줄 설명: 실행 권한을 빌릴 수 있는지. warn 이면 실행 단계에서 막힐 수 있다. */
export function borrowNote(env: EnvironmentView, now = Date.now()): { text: string; warn: boolean } {
  if (env.provider === 'gcp' && !env.targetProjectId && !env.mock)
    return { text: '이전 전용 프로젝트가 없어 실행 단계에서 막힐 수 있습니다', warn: true };
  if (env.missingPermissions && env.missingPermissions.length > 0)
    return { text: `관찰 역할에 권한 ${env.missingPermissions.length}개가 빠졌습니다`, warn: true };
  const checked = env.lastVerifiedAt ? ` · 확인 ${ago(env.lastVerifiedAt, now)}` : '';
  return { text: `${env.mock ? '흉내 자격으로 확인됨' : '실행 역할 빌릴 수 있음'}${checked}`, warn: false };
}

import type { ApprovalRowV2 } from '../../lib/types';
import type { MigrationSpecView } from './model';
import type { SecuritySpecV2, SourceDbFacts } from './securityV2';
import { t } from '../../lib/i18n';

// 명세 v2 검토 (GET /migrations/:id/spec 의 v2 칸, apps/api spec.ts · contracts spec.ts MigrationSpecViewV2).
// 서버는 v2 판일 때만 needsReviewV2·specV2·fieldMetaV2 를 싣고, 가져오기 v2 판이면 accuracy·outOfBoundary 도 싣는다.
// 화면은 needsReviewV2 키를 PATCH confirm 에 그대로 보낸다. 칸 이름은 화면이 사람 말로 바꾸지만 키는 바꾸지 않는다.
// 값 규칙: null 은 "읽지 못함"이라 비워 두고 검토 표시만 한다. 기본값을 지어내지 않는다. 환경변수 값은 비밀일 수 있어 보이지 않는다.

// ---- contracts spec-v2.ts 중 화면이 읽는 칸만 손으로 옮긴 것 (zod 없이 타입만, lib/types.ts 와 같은 방식) ----
export type ComponentKindV2 = 'service' | 'job' | 'postgres' | 'cache' | 'objectStore' | 'queue';
export interface ComponentV2 { id: string; kind: ComponentKindV2; props: Record<string, unknown> }
export interface LinkV2 { from: string; to: string | { unmapped: string } | { external: string }; intent: string }
export interface EntryRouteV2 { matches: { path: { type: string; value: string } }[]; backends: { to: string; port: number; weight: number }[] }
/** 화면이 읽는 칸은 network 의 구성요소 줄뿐이다. 나머지 칸은 PATCH 때 그대로 돌려보낸다 */
export interface PostureV2 { network?: ({ scope: string; subject?: string; ingress?: { from: string; port?: number }[] | 'unknown'; public?: boolean | null } & Record<string, unknown>)[] }
export interface AppSpecV2 {
  schemaVersion: '2';
  app: { name: string };
  components: ComponentV2[];
  links: LinkV2[];
  entry?: { via: string; hosts: { hostnames: string[]; routes: EntryRouteV2[] }[] };
  posture?: PostureV2;
  /** 앱 보안 요구사항. 가져오기는 비워 두고 고객이 명세 검토에서 넣는다 (PATCH changes path "security") */
  security?: SecuritySpecV2;
}
export interface FieldMetaEntryV2 { source: string; confidence: 1 | 0.9 | 0.6; needs_review: boolean; rationale?: string }
export interface OutOfBoundaryV2 { resource: string; kind: ComponentKindV2; reason: string }
export interface ImportAccuracy {
  schemaVersion: '1';
  basis: 'render' | 'spec';
  total: number; matched: number; mismatched: number; unverifiable: number; comparable: number;
  percent: number | null;
  fields: { component: string; field: string; result: 'match' | 'mismatch' | 'unverifiable'; detail?: string }[];
}
export type MigrationSpecViewV2 = MigrationSpecView & {
  needsReviewV2?: string[];
  specV2?: AppSpecV2;
  fieldMetaV2?: Record<string, FieldMetaEntryV2>;
  accuracy?: ImportAccuracy;
  outOfBoundary?: OutOfBoundaryV2[];
  /** 도착에서 다른 상품이 되는 자원 (계획 확인 항목과 같은 계산의 미리보기). 옛 서버는 키가 없고 그때는 그리지 않는다 */
  substitutions?: ApprovalRowV2[];
  /**
   * 가져오기가 출발 DB 에서 읽은 보안 사실 (postgres 구성요소 id → 사실, 판의 spec_v2.securityFacts). 사람이 고칠 수 없다.
   * 서버 GET spec 은 아직 이 칸을 싣지 않는다 (contracts MigrationSpecViewV2 에 키 없음). 칸이 올 때만 화면에 그린다
   */
  securityFacts?: Record<string, SourceDbFacts>;
};
/** PATCH /migrations/:id/spec 본문 중 화면이 쓰는 칸 (contracts SpecPatchInput). changes 는 지금 "security"·"posture" 만 보낸다 (값 통째, security 의 null = 지움) */
export interface SpecPatch { baseVersion: number; confirm?: string[]; include?: string[]; acceptDraft?: number; changes?: { path: string; value: unknown }[] }

/**
 * PATCH 본문. 화면이 보고 있는 판(GET spec)을 기준으로 한다. 그 판이 AI 초안이면 그 판을 받아들인다는 acceptDraft 를 같이 싣는다:
 * 서버는 받아들인 판이 없고 초안만 있을 때 acceptDraft 없이 고치거나 확인하면 409 SPEC_DRAFT_NOT_ACCEPTED 로 막는다 (apps/api spec.ts).
 * 확인·끌어오기·보안 요구사항·방화벽 결정이 모두 이 함수로 본문을 만든다 (한 곳이라도 빠뜨리면 초안을 보는 동안 그 버튼만 막힌다)
 */
export function specPatchBody(view: Pick<MigrationSpecViewV2, 'version' | 'source'>, edit: Omit<SpecPatch, 'baseVersion' | 'acceptDraft'>): SpecPatch {
  return { baseVersion: view.version, ...edit, ...(view.source === 'ai_draft' ? { acceptDraft: view.version } : {}) };
}

/** 한 번에 confirm 으로 보낼 수 있는 키 수 (contracts SpecPatchInput confirm max 20) */
export const CONFIRM_MAX = 20;

export const KIND_LABEL: Record<ComponentKindV2, string> = {
  service: t('서비스'), job: t('예약 잡'), postgres: 'DB', cache: t('캐시'), objectStore: t('객체 저장소'), queue: t('큐·토픽'),
};
const DATA_KINDS: readonly ComponentKindV2[] = ['postgres', 'cache', 'objectStore', 'queue'];

// 리소스 props 맨 위 칸 이름. 표에 없는 칸은 키 그대로 쓴다 (지어내지 않음)
const FIELD_LABEL: Record<string, string> = {
  runtime: t('실행 방식'), origin: t('원래 실행 모양'), image: t('이미지'), command: t('명령'), args: t('인자'), resources: t('자원 요청'), env: t('환경변수'),
  envFrom: t('환경변수 묶음'), configs: t('설정 묶음'), secretMounts: t('비밀 마운트'), serviceAccount: t('신원'), securityContext: t('보안 설정'),
  sidecars: t('사이드카'), initContainers: t('초기화 컨테이너'), volumes: t('볼륨'), ports: t('포트'), endpoints: t('서비스 주소'), probes: t('상태 확인'),
  replicas: t('복제 수'), scale: t('자동 확장'), schedule: t('일정'), timeZone: t('시간대'), majorVersion: t('버전'), storageGb: t('저장 용량'),
  storageMaxGb: t('최대 저장 용량'), compute: t('계산 자원'), ha: t('고가용성'), readReplicas: t('읽기 복제본'), databases: t('DB 이름'), extensions: t('확장'),
  parameters: t('설정값'), logicalReplication: t('논리 복제'), engine: t('엔진'), version: t('버전'), memoryMiB: t('메모리'), clusterMode: t('클러스터 모드'),
  shards: t('샤드'), tls: 'TLS', auth: t('인증'), versioning: t('버전 관리'), public: t('공개 여부'), sizeGb: t('크기'), lifecycle: t('수명 규칙'), cors: 'CORS',
  model: t('모델'), ordered: t('순서 보장'), retentionSec: t('보관 시간'), ackTimeoutSec: t('확인 제한 시간'), deadLetter: t('실패 메시지 큐'),
  boundary: t('앱 경계'), appGroup: t('앱 묶음'), 'digest': 'digest', 'db.version': t('DB 버전'), 'db.storageGb': t('DB 저장 용량'),
  'env.names': t('환경변수 이름'), 'resources.cpu': 'CPU', 'resources.memory': t('메모리'),
};
const fieldLabel = (field: string) => FIELD_LABEL[field] ?? field;

const INTENT_LABEL: Record<string, string> = { connect: t('연결'), read: t('읽기'), write: t('쓰기'), readwrite: t('읽기·쓰기'), admin: t('관리자'), call: t('호출') };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPrim = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** 환경변수 한 줄의 출처. 값 자체는 비밀일 수 있어 보이지 않는다. */
function envText(entry: unknown): string | undefined {
  if (!isObj(entry)) return undefined;
  if ('value' in entry) return t('값이 직접 적혀 있음 (화면에 안 보임)');
  if ('template' in entry) return t('다른 값을 이어 붙인 값 (화면에 안 보임)');
  const ref = (o: unknown, a: string, b: string) => (isObj(o) ? `${String(o[a])}/${String(o[b])}` : '');
  if ('fromSecret' in entry) return t('비밀 {0}', { 0: ref(entry.fromSecret, 'secret', 'key') });
  if ('fromConfig' in entry) return t('설정 {0}', { 0: ref(entry.fromConfig, 'config', 'key') });
  if ('fromLink' in entry) return t('연결 {0}', { 0: ref(entry.fromLink, 'to', 'output').replace('/', '.') });
  if ('fromResource' in entry) return t('자원 값 {0}', { 0: String(entry.fromResource) });
  if ('fromField' in entry) return t('파드 정보 {0}', { 0: String(entry.fromField) });
  return undefined;
}

// 숫자 칸의 단위 (contracts spec-v2.ts 칸 이름이 단위를 말한다)
const UNIT: Record<string, string> = { storageGb: 'GB', storageMaxGb: 'GB', sizeGb: 'GB', memoryMiB: 'MiB', retentionSec: t('초'), ackTimeoutSec: t('초') };

const amount = (a: unknown) => (isObj(a) ? `${a.cpuMilli ?? '?'}m · ${a.memMiB ?? '?'}MiB` : null);

/** 값 한 칸을 한 줄 글자로. null(읽지 못함)은 호출하는 쪽이 따로 다룬다. */
export function valueText(field: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? t('예') : t('아니오');
  if (typeof value === 'number' && UNIT[field]) return `${value}${UNIT[field]}`;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => isPrim(item))) return value.map((item) => (item === null ? '?' : String(item))).join(', ');
    if (value.every((item) => isObj(item) && typeof item.port === 'number')) return value.map((item) => String((item as { port: number }).port)).join(', ');
    return t('{0}개', { 0: value.length });
  }
  if (!isObj(value)) return '';
  if (field === 'replicas' && typeof value.min === 'number' && typeof value.max === 'number')
    return value.min === value.max ? t('{0}개', { 0: value.min }) : t('{0}~{1}개', { 0: value.min, 1: value.max });
  if (field === 'resources') return [amount(value.request) && t('요청 {0}', { 0: amount(value.request) }), amount(value.limit) && t('상한 {0}', { 0: amount(value.limit) })].filter(Boolean).join(' / ');
  if (field === 'image' && typeof value.repository === 'string')
    return value.source === 'build' ? t('{0} (도착에서 빌드)', { 0: value.repository }) : value.digest ? `${value.repository}@${String(value.digest)}` : t('{0} (digest 없음)', { 0: value.repository });
  if (field === 'scale' && typeof value.targetCpuPct === 'number') return `CPU ${value.targetCpuPct}%`;
  if (field === 'origin' && typeof value.runtime === 'string') return `${value.runtime} · ${String(value.product ?? '')}`;
  if (field === 'probes')
    return Object.entries(value).filter(([, probe]) => isObj(probe)).map(([kind, probe]) => [kind, (probe as Record<string, unknown>).type, (probe as Record<string, unknown>).path].filter(Boolean).join(' ')).join(', ');
  const flat = Object.entries(value).filter(([, v]) => isPrim(v) && v !== null);
  return flat.length > 0 ? flat.slice(0, 4).map(([k, v]) => `${k} ${String(v)}`).join(', ') : t('칸 {0}개', { 0: Object.keys(value).length });
}

type Resolved = { name: string; value: unknown };

/** fieldMeta 키 하나 → 사람 이름과 명세 안의 값. 값이 명세에 없으면 value 는 undefined. */
export function resolveKey(spec: AppSpecV2, key: string, meta?: FieldMetaEntryV2): Resolved {
  const comp = /^components\.([a-z][a-z0-9-]{0,39})\.(.+)$/.exec(key);
  if (comp) {
    const [, id = '', rest = ''] = comp;
    const c = spec.components.find((item) => item.id === id);
    const env = /^(?:sidecars\.([^.]+)\.)?env\.(.+)$/.exec(rest);
    if (env) {
      const [, sidecar, name = ''] = env;
      const holder = sidecar ? (c?.props.sidecars as unknown[] | undefined)?.find((item) => isObj(item) && item.name === sidecar) : c?.props;
      const list = isObj(holder) && Array.isArray(holder.env) ? holder.env : [];
      return { name: t('{0}{1} · 환경변수 {2}', { 0: id, 1: sidecar ? ` · ${sidecar}` : '', 2: name }), value: envText(list.find((item) => isObj(item) && item.name === name)) };
    }
    const field = rest.split('.')[0] ?? rest;
    const value = c && Object.prototype.hasOwnProperty.call(c.props, field) ? c.props[field] : undefined;
    return { name: `${id} · ${fieldLabel(field)}`, value: value === null ? null : value === undefined ? undefined : valueText(field, value) };
  }
  const link = /^links\.(.+?)->(.+)$/.exec(key);
  if (link) {
    const [, from = '', to = ''] = link;
    const found = spec.links.find((item) => item.from === from && (item.to === to || (isObj(item.to) && Object.values(item.to)[0] === to)));
    return { name: t('연결 {0} → {1}', { 0: from, 1: to }), value: found ? (INTENT_LABEL[found.intent] ?? found.intent) : undefined };
  }
  const entry = /^entry\.(.+?)\.(hostnames|routes\[(\d+)\](?:\.(\w+))?)$/.exec(key);
  if (entry) {
    const [, host = '', part = '', index] = entry;
    const h = spec.entry?.hosts.find((item) => item.hostnames.includes(host));
    if (part === 'hostnames') return { name: t('진입 {0} · 호스트 이름', { 0: host }), value: h ? h.hostnames.join(', ') : undefined };
    const route = h?.routes[Number(index)];
    const text = route
      ? `${route.matches.map((m) => m.path.value).join(', ')} → ${route.backends.map((b) => `${b.to}:${b.port}`).join(', ')}`
      : undefined;
    return { name: t('진입 {0} · 경로 {1}', { 0: host, 1: Number(index) + 1 }), value: text };
  }
  // 명세 점검 줄은 내용이 rationale 에 있다. 키는 내용 키 check.<자원>.<자리>.<종류>.<지문> (contracts syncCheckReviews, 예전 판은 check.reviews[i])
  if (key.startsWith('check.')) return { name: t('명세 점검'), value: meta?.rationale };
  return { name: key, value: undefined };
}

// 값의 출처 이름. 서버 source 글자 앞부분만 사람 말로 바꾸고 나머지(자원 이름 등)는 그대로 둔다
const SOURCE_EXACT: Record<string, string> = {
  human: t('사람이 정함'), checkV2: t('명세 점검'), default: t('읽지 못해 추정'), fixture: t('예시 값'), 'source.env': t('출발 환경변수'),
};
const SOURCE_PREFIX: [string, string][] = [
  ['k8s:', t('쿠버네티스 ')], ['ecs:', 'ECS '], ['label:', t('라벨 ')], ['boundary:', t('앱 경계 판단 ')], ['env:', t('환경변수 ')], ['spec_v2.', t('명세 ')],
];
export function sourceText(source: string): string {
  if (SOURCE_EXACT[source]) return SOURCE_EXACT[source];
  const hit = SOURCE_PREFIX.find(([prefix]) => source.startsWith(prefix));
  return hit ? `${hit[1]}${source.slice(hit[0].length)}`.trim() : source;
}

export type SpecRowV2 = {
  key: string;
  name: string;
  /** 비어 있으면 그대로 비워 둔다 (unread 면 "읽지 못함") */
  value: string;
  /** 명세에 null 로 적힘 = 출발에서 읽지 못함 */
  unread: boolean;
  review: boolean;
  /** 값이 아니라 설명 글인 칸 (명세 점검 문장, 환경변수 출처). 고정폭이 아니라 글자로 그린다 */
  prose: boolean;
  /** 근거 한 줄 (출처 · 신뢰도 · 이유). 검토 칸이거나 그대로 읽지 못한(신뢰도 1 미만) 칸에만 */
  provenance: string | null;
};

/** v2 판이면 그 칸들, 아니면 null (v1 화면 그대로) */
export function specV2Of(view: MigrationSpecViewV2) {
  return view.specV2 ? { spec: view.specV2, meta: view.fieldMetaV2 ?? {}, review: view.needsReviewV2 ?? [] } : null;
}

// 서버 판정과 같은 규칙 (adapters target/shared.ts): 도착이 옮길 수 있는 허용 원본은 CIDR 뿐이다
const isCidr = (from: string) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(from);
/** sources = 옮길 수 없는 허용 원본, kept = 결정해도 도착에 그대로 남는 허용 주소. 사람이 무엇을 승인하는지 보이도록 화면에 적는다 */
export type FirewallRow = { subject: string; reason: 'unknown' | 'uncopyable' | 'publicNoCidr'; sources: string[]; kept: string[] };

/** 사전 점검이 사람 확인(PC-V2-HUMAN)으로 막을 출발 방화벽 줄. 사람이 정하기 전에 보여 주어 점검에서 되돌아오지 않게 한다 */
export function firewallRows(spec: AppSpecV2): FirewallRow[] {
  return (spec.posture?.network ?? []).flatMap((row): FirewallRow[] => {
    if (row.scope !== 'component' || !row.subject) return [];
    if (row.ingress === 'unknown') return [{ subject: row.subject, reason: 'unknown', sources: [], kept: [] }];
    const sources = (row.ingress ?? []).map((item) => item.from);
    const uncopyable = sources.filter((from) => !isCidr(from)).sort();
    const kept = [...new Set(sources.filter(isCidr))].sort();
    if (uncopyable.length > 0) return [{ subject: row.subject, reason: 'uncopyable', sources: uncopyable, kept }];
    return row.public === true && sources.length === 0 ? [{ subject: row.subject, reason: 'publicNoCidr', sources: [], kept: [] }] : [];
  });
}

// DRAFT(ai): 가장 좁은 값 하나만 고르게 한다. CIDR 은 남기고, 옮길 수 없는 원본은 빼고, CIDR 없는 공개 자원은 비공개로 둔다. 의존성 연결은 서버가 따로 연다
// TODO(human): 허용 주소를 사람이 직접 적는 칸이 필요한지 영역에서 정한다
export function firewallDecision(posture: PostureV2 | undefined, subject: string): PostureV2 {
  return {
    ...posture,
    network: (posture?.network ?? []).map((row) => {
      if (row.scope !== 'component' || row.subject !== subject) return row;
      const ingress = row.ingress === 'unknown' ? [] : (row.ingress ?? []).filter((item) => isCidr(item.from));
      return { ...row, ingress, public: row.public === true && ingress.length === 0 ? false : row.public };
    }),
  };
}

/** 지난 사전 점검의 막힘 중 방화벽 줄 (서버 문구 adapters target/shared.ts). 사람이 다 정했으면 큰 카드에서 뺀다 */
export const isFirewallBlock = (message: string) => /출발 방화벽|허용 주소\(CIDR\)/.test(message);

// 검토 칸 순서: 값이 있는 칸(리소스·연결·진입)을 먼저, 명세 전체에 대한 점검 문장은 뒤에. 같은 무리 안에서는 서버 순서
const GROUP = ['components.', 'links.', 'entry.', 'check.'];
const groupOf = (key: string) => {
  const at = GROUP.findIndex((prefix) => key.startsWith(prefix));
  return at < 0 ? GROUP.length : at;
};

/** 근거 카드 줄. 검토 칸이 먼저(값 있는 칸 → 점검 문장), 나머지는 키 순서. */
export function specRowsV2(view: MigrationSpecViewV2): SpecRowV2[] {
  const v2 = specV2Of(view);
  if (!v2) return [];
  const review = new Set(v2.review);
  const first = v2.review.map((key, index) => ({ key, index })).sort((a, b) => groupOf(a.key) - groupOf(b.key) || a.index - b.index).map(({ key }) => key);
  // security 표시는 사람이 요구사항을 저장하면 생긴다 (읽은 값이 아님). 요구사항은 보안 요구사항 카드에서 본다
  const rest = Object.keys(v2.meta).filter((key) => !review.has(key) && key !== 'security').sort();
  return [...first, ...rest].map((key) => {
    const meta = v2.meta[key];
    const { name, value } = resolveKey(v2.spec, key, meta);
    const isReview = review.has(key);
    const unread = value === null;
    const showMeta = isReview || (meta !== undefined && meta.confidence < 1);
    const provenance = showMeta
      ? [unread ? t('값을 읽지 못했습니다') : null, meta ? sourceText(meta.source) : null, meta && meta.confidence < 1 ? t('신뢰도 {0}%', { 0: Math.round(meta.confidence * 100) }) : null,
         meta?.rationale && !key.startsWith('check.') ? meta.rationale : null].filter(Boolean).join(' · ') || null
      : null;
    const prose = key.startsWith('check.') || /\.env\./.test(key);
    return { key, name, value: typeof value === 'string' ? value : '', unread, review: isReview, prose, provenance };
  });
}

/** confirm 키를 서버 상한만큼씩 나눈다 (한 번에 20개). 순서는 그대로. */
export function confirmChunks(keys: readonly string[], size = CONFIRM_MAX): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

/** 가져오기 정확도 카드. 가져올 때 잰 값이라 사람이 고친 뒤에도 다시 재지 않는다. */
export function accuracyView(a: ImportAccuracy) {
  return {
    summary: a.percent === null ? t('비교할 칸 없음') : `${a.percent}%`,
    rows: [
      { name: t('비교 기준'), value: a.basis === 'render' ? t('도착에 내보낼 값과 비교') : t('공통 명세 값과 비교') },
      { name: t('비교한 칸'), value: t('{0}칸 · 일치 {1} · 불일치 {2}', { 0: a.comparable, 1: a.matched, 2: a.mismatched }) },
      { name: t('비교 못 한 칸'), value: t('{0}칸', { 0: a.unverifiable }) },
    ],
    mismatches: a.fields
      .filter((field) => field.result === 'mismatch')
      .map((field) => ({ name: `${field.component} · ${fieldLabel(field.field)}`, value: field.detail ?? '' })),
  };
}

/**
 * 앱 경계 밖 자원 (계정에 있지만 이 앱의 서비스·잡이 근거 있게 닿지 않음). 칸이 없으면 null: "없음"이 아니라 "모름"이다.
 * 데이터 자원만 끌어올 수 있다 (PATCH include, 서버 BOUNDPULL). 워크로드는 끌어오지 않는다.
 */
export function boundaryRows(list: OutOfBoundaryV2[] | undefined) {
  if (!list) return null;
  return list.map((item) => ({
    resource: item.resource,
    name: item.resource.includes(':') ? item.resource.slice(item.resource.indexOf(':') + 1) : item.resource,
    kind: KIND_LABEL[item.kind] ?? item.kind,
    reason: item.reason,
    pullable: DATA_KINDS.includes(item.kind),
  }));
}

/**
 * 파란 "명세 확정" 버튼 글자. 확인할 칸은 그 앞의 흰 "확인"이 카드를 채우며 이미 확인했으므로 다시 세지 않는다.
 * 정하지 않은 출발 방화벽 줄이 있으면 확정을 막으므로(canConfirmSpec) 막힌 이유를 버튼에 쓴다
 */
export const confirmLabel = (busy: boolean, undecidedFirewall = 0) =>
  busy ? t('보내는 중') : undecidedFirewall > 0 ? t('출발 방화벽 {0}개를 정해 주세요', { 0: undecidedFirewall }) : t('명세 확정');

/**
 * 명세를 확정해도 되는가. 서버 POST /plan(T04)은 검토 칸만 세고 출발 방화벽 줄은 보지 않아서 그대로 받아 준다.
 * 하지만 바로 뒤 사전 점검이 같은 줄을 사람 확인 막힘(PC-V2-HUMAN-n, adapters target/shared.ts)으로 잡아 명세 검토로 되돌려 보낸다.
 * 정하지 않은 줄(firewallRows)이 남아 있으면 확정해 봐야 돌아오므로 화면이 먼저 막는다
 */
export const canConfirmSpec = (undecidedFirewall: number) => undecidedFirewall === 0;

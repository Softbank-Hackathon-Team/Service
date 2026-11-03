import type { BadgeTone } from '../../components/ui/controls';
import type { PlanAcknowledgement, PrecheckItem } from '../../lib/types';

// 보안 이식성 판정이 화면에 닿는 세 곳 (contracts portability.ts · security portability · 워커 precheck.ts):
//   1) 명세 v2 의 security.requirements: 가져오기는 비워 두고 고객이 명세 검토에서 정한다. PATCH changes path "security" 로 통째, null = 지움
//   2) 가져오기가 출발 DB 에서 읽은 보안 사실 (ImportResultV2.securityFacts): 읽기 전용. 모름은 통과가 아니다
//   3) 사전 점검의 SEC:* 항목: block 은 명세 검토로 되돌리고, warn(고객 확인 포함)은 계획서 승인 확인 항목 precheck_warn:SEC:… 이 되고, info 는 참고

// ---- contracts portability.ts 중 화면이 읽는 칸만 손으로 옮긴 것 (zod 없이 타입만, lib/types.ts 와 같은 방식) ----
export type DataClass = 'public' | 'internal' | 'personal' | 'sensitive';
export type Operator = 'customer' | 'aws' | 'gcp' | 'azure';
export type KeyOwner = 'provider' | 'customer';
export interface SecurityRequirements {
  dataClass: DataClass;
  /** 허용 국가 (ISO 3166-1 alpha-2). 빈 배열 = 제한 없음 */
  residency: string[];
  keyOwnership: KeyOwner;
  /** 없으면 제한 없음 */
  operatorAllow?: Operator[];
}
export interface SecuritySpecV2 { requirements: SecurityRequirements }
export type FactOrigin = 'measured' | 'attested' | 'unknown';
export interface Fact<T> { value: T | null; origin: FactOrigin; source: string | null }
export interface SourceDbFacts { encryptedAtRest: Fact<boolean>; keyOwner: Fact<KeyOwner>; tlsEnforced: Fact<boolean> }

export const DATA_CLASSES: readonly DataClass[] = ['public', 'internal', 'personal', 'sensitive'];
export const OPERATORS: readonly Operator[] = ['customer', 'aws', 'gcp', 'azure'];
export const KEY_OWNERS: readonly KeyOwner[] = ['provider', 'customer'];
export const DATA_CLASS_LABEL: Record<DataClass, string> = { public: '공개', internal: '내부', personal: '개인정보', sensitive: '민감 정보' };
export const KEY_OWNER_LABEL: Record<KeyOwner, string> = { provider: '제공자 키', customer: '고객 키' };
export const OPERATOR_LABEL: Record<Operator, string> = { customer: '고객(온프레)', aws: 'AWS', gcp: 'GCP', azure: 'Azure' };

// ---- 1) 요구사항 ----

const operatorsText = (list: Operator[] | undefined) =>
  list === undefined ? '제한 없음' : list.length === 0 ? '허용한 곳 없음' : list.map((op) => OPERATOR_LABEL[op]).join(', ');

/** 요구사항 카드 줄. 없으면 빈 목록 */
export function requirementRows(r: SecurityRequirements | null) {
  if (!r) return [];
  return [
    { name: '데이터 등급', value: DATA_CLASS_LABEL[r.dataClass] ?? r.dataClass },
    { name: '허용 국가', value: r.residency.length > 0 ? r.residency.join(', ') : '제한 없음' },
    { name: '키 소유', value: KEY_OWNER_LABEL[r.keyOwnership] ?? r.keyOwnership },
    { name: '운영 주체', value: operatorsText(r.operatorAllow) },
  ];
}

/** 카드 머리줄 요약. 없으면 "정하지 않음" (판정이 P-REQ-0 으로 고객 확인을 요청한다) */
export const requirementsSummary = (r: SecurityRequirements | null) =>
  r ? [DATA_CLASS_LABEL[r.dataClass] ?? r.dataClass, r.residency.length > 0 ? r.residency.join(', ') : '국가 제한 없음', KEY_OWNER_LABEL[r.keyOwnership] ?? r.keyOwnership].join(' · ') : '정하지 않음';

/** 고치는 중인 값. 고르지 않은 칸은 null 로 두고 기본값을 지어내지 않는다 */
export interface RequirementsDraft { dataClass: DataClass | null; residency: string; keyOwnership: KeyOwner | null; operatorAllow: Operator[] }

export const draftOf = (r: SecurityRequirements | null): RequirementsDraft =>
  r
    ? { dataClass: r.dataClass, residency: r.residency.join(', '), keyOwnership: r.keyOwnership, operatorAllow: [...(r.operatorAllow ?? [])] }
    : { dataClass: null, residency: '', keyOwnership: null, operatorAllow: [] };

/**
 * 고치는 중인 값 → PATCH 에 실을 요구사항. 데이터 등급·키 소유를 안 골랐거나 국가 코드가 틀리면 requirements 는 null (보내지 않는다).
 * 국가는 쉼표·공백으로 나누고 대문자로 바꾼다. 운영 주체를 하나도 안 고르면 칸을 뺀다 (= 제한 없음, 빈 배열은 "어디도 안 됨"이라 보내지 않는다)
 */
export function requirementsFrom(d: RequirementsDraft): { requirements: SecurityRequirements | null; badCountries: string[] } {
  const countries = [...new Set(d.residency.split(/[\s,]+/).filter(Boolean).map((c) => c.toUpperCase()))];
  const badCountries = countries.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (!d.dataClass || !d.keyOwnership || badCountries.length > 0) return { requirements: null, badCountries };
  const operatorAllow = OPERATORS.filter((op) => d.operatorAllow.includes(op));
  return {
    requirements: { dataClass: d.dataClass, residency: countries, keyOwnership: d.keyOwnership, ...(operatorAllow.length > 0 ? { operatorAllow } : {}) },
    badCountries,
  };
}

// ---- 2) 출발 DB 보안 사실 ----

const FACT_NAME: Record<keyof SourceDbFacts, string> = { encryptedAtRest: '저장 암호화', keyOwner: '키 소유', tlsEnforced: 'TLS 강제' };
// attested 는 고객 선언이거나 제공자 문서 근거다 (어느 쪽인지는 source 글이 말한다)
const ORIGIN_LABEL: Record<FactOrigin, string> = { measured: '읽음', attested: '선언', unknown: '모름' };

function factValue(field: keyof SourceDbFacts, value: unknown): string {
  if (field === 'keyOwner') return KEY_OWNER_LABEL[value as KeyOwner] ?? String(value);
  if (field === 'tlsEnforced') return value ? '강제함' : '강제 안 함';
  return value ? '켜짐' : '꺼짐';
}

export type FactRow = { key: string; name: string; /** null = 모름 */ value: string | null; origin: string | null };

/**
 * 출발 DB 보안 사실 줄 (DB 구성요소 id 순서 → 칸 순서). 칸이 없으면 null: "없음"이 아니라 이 판에 읽은 기록이 없다는 뜻이다.
 * measured 인데 값이 null 이면 판정처럼 모름으로 본다 (security rules.ts val)
 */
export function factRows(facts: Record<string, SourceDbFacts> | undefined) {
  if (!facts) return null;
  const rows: FactRow[] = Object.keys(facts).sort().flatMap((id) =>
    (Object.keys(FACT_NAME) as (keyof SourceDbFacts)[]).map((field) => {
      const fact = facts[id]?.[field];
      const known = !!fact && fact.origin !== 'unknown' && fact.value !== null;
      return {
        key: `${id}.${field}`,
        name: `${id} · ${FACT_NAME[field]}`,
        value: known ? factValue(field, fact.value) : null,
        origin: known ? [ORIGIN_LABEL[fact.origin], fact.source].filter(Boolean).join(' · ') : null,
      };
    }),
  );
  const unknown = rows.filter((row) => row.value === null).length;
  return { rows, summary: rows.length === 0 ? '없음' : unknown > 0 ? `모름 ${unknown}칸` : `${rows.length}칸 읽음` };
}

// ---- 3) 사전 점검 SEC:* ----

export type SecLevel = 'block' | 'warn' | 'attest' | 'advise';
// 무거운 것부터 (security portability evaluate.ts ORDER 와 같은 순서). need = 그 단계에서 사람이 할 일
export const SEC_LEVEL: Record<SecLevel, { label: string; tone: BadgeTone; need: string }> = {
  block: { label: '막힘', tone: 'danger', need: '승인할 수 없습니다. 명세나 도착 환경을 바꾼 뒤 다시 점검합니다' },
  warn: { label: '주의', tone: 'warning', need: '승인하는 사람이 위험을 받아들인다고 체크해야 승인됩니다' },
  attest: { label: '고객 확인', tone: 'info', need: '고객이 값을 확인해 줘야 합니다. 확인받았으면 승인 전에 체크합니다' },
  advise: { label: '참고', tone: 'neutral', need: '권장 사항입니다. 승인을 막지 않습니다' },
};
const LEVEL_ORDER: readonly SecLevel[] = ['block', 'warn', 'attest', 'advise'];

export interface SecVerdict { id: string; level: SecLevel; title: string; reason: string; fix: string | null }

export const isSecItem = (item: Pick<PrecheckItem, 'id'>) => item.id.startsWith('SEC:');

// DRAFT(ai): 서버 PrecheckItem 에는 판정 단계·제목·이유 칸이 따로 없다. 워커가 message 하나에 "머리말 + 제목. 이유. 근거: …" 로 싣는다
//   (security portability/precheck.ts HEAD). 고객 확인(attest)은 level 이 warn 이라 머리말로만 구분된다. 모양이 다르면 message 를 그대로 제목으로 쓴다
const HEAD = /^(?:FAIL|WARN|INFO) 보안( 고객 확인)? — /;
const EVIDENCE = '. 근거: ';

const levelOf = (level: PrecheckItem['level'], text: string): SecLevel =>
  level === 'block' ? 'block' : level === 'info' ? 'advise' : HEAD.exec(text)?.[1] ? 'attest' : 'warn';

/** SEC:* 항목 하나 → 단계·제목·이유·조치. 근거(사실 출처 글)는 승인 확인 항목의 서버 문장에 그대로 남아 있어 여기서는 뺀다. SEC 가 아니면 null */
export function secVerdictOf(item: PrecheckItem): SecVerdict | null {
  if (!isSecItem(item)) return null;
  const head = HEAD.exec(item.message);
  const body = head ? item.message.slice(head[0].length) : item.message;
  const cut = body.indexOf(EVIDENCE);
  const main = cut >= 0 ? body.slice(0, cut) : body;
  const dot = main.indexOf('. ');
  return {
    id: item.id,
    level: levelOf(item.level, item.message),
    title: dot >= 0 ? main.slice(0, dot) : main,
    reason: dot >= 0 ? main.slice(dot + 2) : '',
    fix: item.fix ?? null,
  };
}

/** SEC:* 항목을 단계별로 묶는다 (무거운 단계부터, 같은 단계 안은 서버 순서). SEC 가 아닌 항목은 뺀다 */
export function secGroups(items: readonly PrecheckItem[]) {
  const verdicts = items.map(secVerdictOf).filter((v): v is SecVerdict => v !== null);
  return LEVEL_ORDER.map((level) => ({ level, ...SEC_LEVEL[level], items: verdicts.filter((v) => v.level === level) })).filter((group) => group.items.length > 0);
}

/** 카드 머리줄 요약: "주의 1 · 고객 확인 2" */
export const secSummary = (groups: ReturnType<typeof secGroups>) => groups.map((group) => `${group.label} ${group.items.length}`).join(' · ');

/** 점검 항목 한 줄의 제목·이유. SEC 는 머리말과 근거를 떼고, 나머지는 서버 문장 그대로 */
export function precheckLine(item: PrecheckItem): { title: string; detail: string | null } {
  const v = secVerdictOf(item);
  return v ? { title: v.title, detail: v.reason || null } : { title: item.message, detail: null };
}

/** 승인 확인 항목 종류 글자. SEC 경고는 위험을 받아들이는 것인지 고객 확인인지 나눠 말한다. 그 밖은 null (기본 종류 글자) */
export function secAckLabel(ack: Pick<PlanAcknowledgement, 'kind' | 'ref' | 'text'>): string | null {
  if (ack.kind !== 'precheck_warn' || !ack.ref?.startsWith('SEC:')) return null;
  return HEAD.exec(ack.text)?.[1] ? '보안 고객 확인' : '보안 주의';
}

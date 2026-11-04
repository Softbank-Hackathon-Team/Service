import { EN } from '../i18n/en';
import { JA } from '../i18n/ja';
import { readActivePrefs, type Locale } from './prefs';

// 화면 글자의 언어. 원문은 한국어이고, 원문 문장 자체가 열쇠다 (t('새 마이그레이션 시작')).
// 영어·일본어 표는 src/i18n/en.ts · ja.ts. 표에 없는 문장은 원문 그대로 나온다 (시험 i18n.test.ts 가 빠진 문장을 잡는다)
// 값이 들어가는 문장은 자리 {0}, {1} … 로 쓴다: t('{0}로 옮기기', { 0: target.name })
// 영어는 수에 따라 단수·복수를 고를 수 있다: { one: '{0} item', other: '{0} items' } (자리 0 의 값으로 고른다)
// 언어는 화면을 처음 읽을 때 정한다. 바꾸면 화면을 다시 읽는다 (prefs.ts)

export type { Locale };
export type Entry = string | { one: string; other: string };
export type Table = Record<string, Entry>;

/** 언어 고르기 칸. 이름은 그 언어로 쓴다 (번역하지 않는다) */
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];

const TABLES: Record<Exclude<Locale, 'ko'>, Table> = { en: EN, ja: JA };
let current: Locale = readActivePrefs().locale;

export const locale = () => current;
/** 시험용: 언어를 바꿔 본다 */
export const setLocaleForTest = (next: Locale) => {
  current = next;
};

const TAG: Record<Locale, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' };
/** 날짜·숫자 모양에 쓰는 언어 태그 */
export const localeTag = () => TAG[current];

/** 원문(한국어)을 지금 언어로. params 의 값으로 {이름} 자리를 채운다 */
// 자리값은 템플릿 문자열과 같게 String() 으로 바꾼다 (null·undefined 도 예전과 같은 글자)
export function t(source: string, params?: Record<string, unknown>): string {
  let text = source;
  if (current !== 'ko') {
    const entry = TABLES[current][source];
    if (entry !== undefined) text = typeof entry === 'string' ? entry : Number(params?.['0']) === 1 ? entry.one : entry.other;
  }
  return params ? text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole)) : text;
}

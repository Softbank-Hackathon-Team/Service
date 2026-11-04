// 화면 설정(테마·언어). 서버에 사용자 설정 API 가 아직 없어서 이 브라우저의 localStorage 에 사람마다 따로 둔다.
// TODO(human): 서버에 사용자 설정 칸(예: PATCH /auth/me/preferences)이 생기면 여기서 서버에 쓰고 읽는다. 지금은 브라우저를 바꾸면 기본값으로 돌아간다
//
// - iron.prefs        이 브라우저에서 마지막으로 쓴 값. 로그인 전 화면(로그인·첫 그리기)도 이 값을 쓴다
// - iron.prefs.<사용자> 그 사람이 고른 값. 로그인하면 이 값을 가져와 위 값을 맞춘다
// 언어는 바꾸면 화면을 다시 읽는다(글자를 모듈이 처음 읽힐 때 고르므로). 테마는 바로 바뀐다

export type Locale = 'ko' | 'en' | 'ja';
export type Theme = 'light' | 'dark';
export type Prefs = { theme: Theme; locale: Locale };

export const DEFAULT_PREFS: Prefs = { theme: 'light', locale: 'ko' };
const ACTIVE_KEY = 'iron.prefs';
const userKey = (userId: string) => `iron.prefs.${userId}`;

const isLocale = (value: unknown): value is Locale => value === 'ko' || value === 'en' || value === 'ja';
const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

/** 저장한 글을 설정으로. 모양이 틀린 칸은 기본값 */
export function parsePrefs(raw: string | null | undefined): Prefs | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Prefs>;
    return { theme: isTheme(value.theme) ? value.theme : DEFAULT_PREFS.theme, locale: isLocale(value.locale) ? value.locale : DEFAULT_PREFS.locale };
  } catch {
    return null;
  }
}

// 시험(node)·개인 정보 보호 모드처럼 저장소가 없거나 막히면 기본값으로 돈다
const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const read = (key: string) => {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (key: string, prefs: Prefs) => {
  try {
    storage()?.setItem(key, JSON.stringify(prefs));
  } catch {
    // 저장이 막히면 이번 화면에서만 쓴다
  }
};

export const readActivePrefs = (): Prefs => parsePrefs(read(ACTIVE_KEY)) ?? DEFAULT_PREFS;

/** 테마를 문서에 건다. 색은 tokens.css 가 [data-theme] 로 바꾼다 */
export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/**
 * 로그인한 사람의 설정을 가져온다. 저장한 값이 없으면 지금 값을 그 사람 것으로 남긴다.
 * 언어가 지금 화면과 다르면 true (부르는 쪽이 화면을 다시 읽는다)
 */
export function adoptUserPrefs(userId: string): boolean {
  const active = readActivePrefs();
  const mine = parsePrefs(read(userKey(userId)));
  if (!mine) {
    write(userKey(userId), active);
    return false;
  }
  write(ACTIVE_KEY, mine);
  applyTheme(mine.theme);
  return mine.locale !== active.locale;
}

/** 설정 하나를 바꿔 그 사람과 이 브라우저에 남긴다. 언어가 바뀌었으면 true */
export function savePrefs(userId: string, change: Partial<Prefs>): boolean {
  const before = readActivePrefs();
  const next = { ...before, ...change };
  write(ACTIVE_KEY, next);
  write(userKey(userId), next);
  applyTheme(next.theme);
  return next.locale !== before.locale;
}

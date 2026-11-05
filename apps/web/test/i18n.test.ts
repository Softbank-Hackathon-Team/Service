import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setLocaleForTest, t } from "../src/lib/i18n";
import { EN } from "../src/i18n/en";
import { JA } from "../src/i18n/ja";
import { parsePrefs } from "../src/lib/prefs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === "i18n" ? [] : walk(p)) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
const unescape = (s: string) => s.replace(/\\(n|\\|'|")/g, (_, c: string) => (c === "n" ? "\n" : c));
// 화면 소스의 t('원문') 열쇠 (코드 바꾸기가 쓴 작은따옴표 모양)
const KEYS = [...new Set(walk(SRC).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/\bt\('((?:\\.|[^'\\])*)'/g)].map((m) => unescape(m[1]!))))];
// tc('맥락', '원문') 은 "맥락|원문" 열쇠
const CONTEXT_KEYS = [...new Set(walk(SRC).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/\btc\('([^']*)', '((?:\\.|[^'\\])*)'/g)].map((m) => `${m[1]}|${unescape(m[2]!)}`)))];
const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const lines = (s: string) => s.split("\n").length;

for (const [name, table] of [["영어", EN], ["일본어", JA]] as const) {
  test(`${name} 표가 화면의 모든 문장을 같은 자리·같은 줄 수로 갖는다`, () => {
    assert.ok(KEYS.length > 1000, "화면 문장을 찾았다");
    const missing = [...KEYS, ...CONTEXT_KEYS].filter((key) => table[key] === undefined);
    assert.deepEqual(missing.slice(0, 10), [], `빠진 문장 ${missing.length}개`);
    for (const key of [...KEYS, ...CONTEXT_KEYS]) {
      const entry = table[key]!;
      const source = key.includes("|") && CONTEXT_KEYS.includes(key) ? key.slice(key.indexOf("|") + 1) : key;
      for (const value of typeof entry === "string" ? [entry] : [entry.one, entry.other]) {
        assert.equal(slots(value), slots(source), `자리 다름: ${key} → ${value}`);
        assert.equal(lines(value), lines(source), `줄 수 다름: ${key} → ${value}`);
        assert.ok(value.trim().length > 0, `빈 번역: ${key}`);
      }
    }
  });
}

for (const [name, table] of [["영어", EN], ["일본어", JA]] as const) {
  test(`${name} 표의 열쇠는 글자 코드 순서다 (찾기 쉽고, 여러 사람이 더해도 합치기에서 덜 부딪힌다)`, () => {
    const keys = Object.keys(table);
    const out = keys.filter((key, i) => i > 0 && keys[i - 1]! > key);
    assert.deepEqual(out.slice(0, 10), [], `순서가 어긋난 열쇠 ${out.length}개`);
  });
}

test("t(): 원문이 열쇠, 자리 채우기, 영어 단수·복수, 없는 문장은 원문", () => {
  setLocaleForTest("ko");
  assert.equal(t("{0}에서 출발", { 0: "dev-aws" }), "dev-aws에서 출발");
  setLocaleForTest("en");
  assert.equal(t("새 마이그레이션 시작"), EN["새 마이그레이션 시작"]);
  assert.equal(t("표에 없는 문장"), "표에 없는 문장");
  assert.equal(t("{0}, {1}", { 0: null, 1: undefined }), "null, undefined", "템플릿 문자열과 같은 글자");
  setLocaleForTest("ko");
});

test("화면 설정 저장 모양: 틀린 칸은 기본값, 깨진 글은 없음", () => {
  assert.deepEqual(parsePrefs('{"theme":"dark","locale":"ja"}'), { theme: "dark", locale: "ja" });
  assert.deepEqual(parsePrefs('{"theme":"blue","locale":"fr"}'), { theme: "light", locale: "ko" });
  assert.equal(parsePrefs("{깨짐"), null);
  assert.equal(parsePrefs(null), null);
});

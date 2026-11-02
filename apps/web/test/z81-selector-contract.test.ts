// Z81-12: 선택자 계약. e2e(apps/web/e2e/*.ts)가 화면을 찾을 때 쓰는 이름이 화면 소스(apps/web/src)에 아직 있는지 본다.
// 왜: 화면을 다시 그리면(Z83) 클래스 이름·data 속성이 바뀌어 e2e·리허설이 브라우저를 띄운 뒤에야(몇 분 뒤) 깨진다.
//   이 시험은 브라우저 없이 파일만 읽어 1초 안에 "없어진 이름" 목록을 낸다.
// 보는 것 (e2e 문자열에서 뽑음)
//   1. getByTestId("x")            → 소스에 data-testid="x" (또는 data-testid={"x"})
//   2. locator("…")·toHaveClass 안의 .클래스  → 소스의 className 글자 안에 그 낱말, 또는 CSS 에 .클래스
//   3. locator("[data-이름…]")      → 소스에 data-이름= 속성 (값은 API 에서 오므로 이름만)
// 안 보는 것: getByRole·getByText·getByLabel 의 글자(화면 문구), 태그 이름(tbody·header). 문구 변경은 e2e 를 직접 돌려야 안다
// 거짓 경보를 줄이려고 "소스 어딘가에 그 낱말이 className 근처에 있음"으로 넉넉하게 본다(정밀 DOM 검사는 아님)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WEB = new URL("../", import.meta.url).pathname;
const walk = (d: string, ext: RegExp): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p, ext) : ext.test(f) ? [p] : [];
});

// e2e 에서 쓰는 이름 뽑기
export function selectorsFromE2e(files: string[]) {
  const testIds = new Set<string>(), classes = new Set<string>(), dataAttrs = new Set<string>();
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/getByTestId\(\s*["'`]([^"'`]+)["'`]/g)) testIds.add(m[1]!);
    // locator("…") 와 toHaveClass(/…/) 의 글자. 템플릿(${…})은 지우고 본다
    const sels = [...s.matchAll(/\blocator\(\s*(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]!.replace(/\$\{[^}]*\}/g, ""));
    for (const sel of sels) {
      const noAttr = sel.replace(/\[[^\]]*\]/g, " ");          // [..] 안의 점(값)은 클래스가 아님
      for (const m of noAttr.matchAll(/\.([A-Za-z_][\w-]*)/g)) classes.add(m[1]!);
      for (const m of sel.matchAll(/\[(data-[\w-]+)/g)) dataAttrs.add(m[1]!);
    }
    for (const m of s.matchAll(/toHaveClass\(\s*\/([\w-]+)\//g)) classes.add(m[1]!);
  }
  return { testIds, classes, dataAttrs };
}

// 화면 소스에 있는지
export function missingInSource(sel: ReturnType<typeof selectorsFromE2e>, srcFiles: string[]) {
  const code = srcFiles.filter((f) => /\.(tsx?|jsx?)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  const css = srcFiles.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // className="a b" · className={`a ${x}`} · className={x ? "a" : "b"} · cls("a", …) 처럼 className 가까이(같은 줄) 나오는 낱말
  const classLines = code.split("\n").filter((l) => /class(Name)?\b|\bcls\(|\bclsx\(/.test(l)).join("\n");
  const word = (t: string) => new RegExp(`(^|[^\\w-])${esc(t)}($|[^\\w-])`);
  const missing: string[] = [];
  for (const id of sel.testIds)
    if (!new RegExp(`data-testid=\\{?["'\`]${esc(id)}["'\`]`).test(code)) missing.push(`testid ${id}`);
  for (const c of sel.classes)
    if (!word(c).test(classLines) && !new RegExp(`\\.${esc(c)}($|[^\\w-])`).test(css)) missing.push(`class .${c}`);
  for (const a of sel.dataAttrs)
    if (!new RegExp(`${esc(a)}=`).test(code)) missing.push(`attr ${a}`);
  return missing.sort();
}

test("선택자 계약: e2e 가 쓰는 testid·클래스·data 속성이 화면 소스에 모두 있다", () => {
  const t0 = performance.now();
  const sel = selectorsFromE2e(walk(join(WEB, "e2e"), /\.ts$/));
  const missing = missingInSource(sel, walk(join(WEB, "legacy/src"), /\.(tsx?|css)$/));
  const ms = performance.now() - t0;
  console.log(`[z81-12] testid ${sel.testIds.size} · class ${sel.classes.size} · data 속성 ${sel.dataAttrs.size} 확인, 없음 ${missing.length}, ${ms.toFixed(0)} ms`);
  assert.ok(sel.classes.size > 10, "e2e 에서 클래스를 거의 못 뽑음 → 뽑는 식이 깨졌다");
  assert.deepEqual(missing, [], `화면 소스에 없는 이름 (e2e 가 깨질 곳):\n  ${missing.join("\n  ")}`);
  assert.ok(ms < 1000, `1초 넘음: ${ms} ms`);
});

test("뽑는 식 자체 검사 (가짜 e2e·가짜 화면)", () => {
  const d = mkdtempSync(join(tmpdir(), "z81-sel-"));
  try {
    mkdirSync(join(d, "e2e")); mkdirSync(join(d, "src"));
    writeFileSync(join(d, "e2e", "a.ts"), `page.getByTestId("panel"); page.locator(".kpi .gone"); page.locator('[data-row="X.Y"] [data-state]'); expect(x).toHaveClass(/sel/);`);
    writeFileSync(join(d, "src", "A.tsx"), `<div data-testid="panel" className={\`kpi \${on ? "sel" : ""}\`} data-row={r} data-state="ok"/>`);
    const sel = selectorsFromE2e([join(d, "e2e", "a.ts")]);
    assert.deepEqual([...sel.classes].sort(), ["gone", "kpi", "sel"]);   // [data-row="X.Y"] 의 .Y 는 클래스로 안 뽑음
    assert.deepEqual(missingInSource(sel, [join(d, "src", "A.tsx")]), ["class .gone"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});


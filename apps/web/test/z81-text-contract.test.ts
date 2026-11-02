// Z81-13: 화면 문구 계약. e2e 가 getByText·getByRole(name)·getByLabel·getByPlaceholder·getByTitle 로 찾는 글자가
//   화면 소스(apps/web/src 의 JSX 글자·문구 상수)에 아직 있는지 본다. z81-12(클래스·testid)가 못 보는 빈틈.
// 왜: 버튼 이름·안내 문구를 고치면 e2e·리허설이 브라우저를 띄워 몇 분 돈 뒤에야 깨진다. 이 시험은 파일만 읽는다.
// 뽑는 것: 첫 인자(getByRole 은 { name: … })가 글자("…" '…' `…`, ${} 없는 것) 또는 정규식(/…/i) 일 때만.
//   변수(name: step 처럼)는 값을 모르니 건너뛰고 수만 센다
// 대조: 소스를 공백 하나로 눌러 편 한 덩어리와 비교한다.
//   글자 → 그대로 들어 있는지. 정규식 → ^·$ 를 떼고 덩어리에 맞는지 (덩어리는 줄이 이어져 있어 앞뒤 기준이 없다)
//   JSX 의 {변수} 가 문구 가운데 끼면 (예: {n}초마다) 글자가 끊긴다 → 그런 곳은 KNOWN_DYNAMIC 에 "끊긴 조각들"을 적는다.
//   조각이 모두 소스에 있어야 통과 (예외로 빼도 문구가 사라지면 잡힌다)
// 넉넉함: 문구가 소스 "어딘가"에 있으면 통과. 같은 문구가 안내문에도 있으면(예: '명세 확정'을 누른다) 버튼 글자만 바뀐 건 못 잡는다
// 안 보는 것: 접근성 이름이 실제로 그 요소에 붙는지(역할·aria 계산)는 브라우저만 안다. 여기선 "문구가 소스에서 사라짐"만 잡는다
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

export type Needle = { kind: "text" | "regex"; value: string; flags: string; via: string };
const LIT = String.raw`"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\`((?:[^\`\\$]|\\.)*)\`|\/((?:[^/\\\n]|\\.)+)\/([a-z]*)`;

export function textsFromE2e(files: string[]) {
  const needles: Needle[] = []; let dynamic = 0;
  const call = new RegExp(String.raw`getBy(Text|Role|Label|Placeholder|Title|AltText)\(\s*`, "g");
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(call)) {
      const fn = m[1]!; let rest = s.slice(m.index! + m[0].length);
      // 없어야 할 문구(toHaveCount(0)·.not.)는 계약 대상이 아니다 (Z101: 목 문구가 사라졌는지 보는 줄)
      const line = rest.slice(0, rest.indexOf("\n") < 0 ? undefined : rest.indexOf("\n"));
      if (/\.toHaveCount\(0\)|\.not\./.test(line)) continue;
      if (fn === "Role") {
        const r = rest.match(/^["'][\w-]+["']\s*(,\s*\{([^}]*)\})?/);
        if (!r || !r[2]) continue;                       // 이름 없이 역할만 → 볼 글자 없음
        const n = r[2].match(/\bname\s*:\s*/);
        if (!n) continue;
        rest = r[2].slice(n.index! + n[0].length);
      }
      const l = rest.match(new RegExp("^(?:" + LIT + ")"));
      if (!l) { dynamic++; continue; }
      const unq = (x: string) => x.replace(/\\(.)/g, "$1");
      if (l[4] !== undefined) needles.push({ kind: "regex", value: l[4], flags: l[5] ?? "", via: fn });
      else needles.push({ kind: "text", value: unq(l[1] ?? l[2] ?? l[3] ?? ""), flags: "", via: fn });
    }
  }
  return { needles, dynamic };
}

export function missingTexts(needles: Needle[], srcFiles: string[], knownDynamic: Record<string, string[]> = {}) {
  // 소스 한 덩어리: 한 줄 전체 주석(//) 빼기 + JS 문자열 안 이스케이프(\' \") 풀기 + 공백 눌러 펴기
  const blob = srcFiles.map((f) => readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "")).join(" ").replace(/\\(['"`])/g, "$1").replace(/\s+/g, " ");
  const seen = new Set<string>(); const missing: string[] = [];
  for (const n of needles) {
    const key = `${n.kind}:${n.value}`;
    if (seen.has(key)) continue; seen.add(key);
    const parts = knownDynamic[key];
    const ok = parts ? parts.every((p) => blob.includes(p)) : n.kind === "text"
      ? blob.includes(n.value.replace(/\s+/g, " "))
      : new RegExp(n.value.replace(/^\^/, "").replace(/(?<!\\)\$$/, ""), n.flags.replace(/[gy]/g, "")).test(blob);
    if (!ok) missing.push(`${n.via} ${n.kind === "regex" ? `/${n.value}/${n.flags}` : JSON.stringify(n.value)}`);
  }
  return missing.sort();
}

// 소스에서 글자가 {변수} 로 끊겨 있어 덩어리에서 못 찾는 문구. 문구가 바뀌면 이 표도 같이 고친다
// 열쇠 = "regex:<식>" 또는 "text:<글자>", 값 = 소스에 그대로 있어야 하는 조각들
const KNOWN_DYNAMIC: Record<string, string[]> = {
  // MigrationDetail.tsx: `${(pollMs / 1000).toFixed(1)}초마다 새로고침` — 숫자가 상태마다 계산됨
  "regex:1\\.5초마다 새로고침": ["}초마다 새로고침`"],
  // MigrationDetail.tsx: {LABEL.rollback_window} 끝: — 앞 글자는 status.ts 의 LABEL 상수
  "regex:롤백 가능 창 끝:": ['rollback_window: "롤백 가능 창"', "{LABEL.rollback_window} 끝:"],
  // SecurityPanel.tsx: 통제 {controlId 개수}개 × 환경 매트릭스 펼치기 — 12 는 API 값
  "regex:통제 12개 × 환경 매트릭스 펼치기": ["<summary>통제 {", "}개 × 환경 매트릭스 펼치기</summary>"],
};

test("문구 계약: e2e 가 찾는 화면 문구가 화면 소스에 모두 있다", () => {
  const t0 = performance.now();
  const { needles, dynamic } = textsFromE2e(walk(join(WEB, "e2e"), /\.ts$/));
  const missing = missingTexts(needles, walk(join(WEB, "legacy/src"), /\.(tsx?|jsx?)$/), KNOWN_DYNAMIC);
  const ms = performance.now() - t0;
  const uniq = new Set(needles.map((n) => `${n.kind}:${n.value}`)).size;
  console.log(`[z81-13] 문구 ${uniq}개(호출 ${needles.length}) 확인, 변수라 건너뜀 ${dynamic}, 예외 ${Object.keys(KNOWN_DYNAMIC).length}, 없음 ${missing.length}, ${ms.toFixed(0)} ms`);
  assert.ok(uniq > 20, "e2e 에서 문구를 거의 못 뽑음 → 뽑는 식이 깨졌다");
  assert.deepEqual(missing, [], `화면 소스에 없는 문구 (e2e 가 깨질 곳):\n  ${missing.join("\n  ")}`);
  assert.ok(ms < 1000, `1초 넘음: ${ms} ms`);
});

test("뽑는 식 자체 검사 (가짜 e2e·가짜 화면)", () => {
  const d = mkdtempSync(join(tmpdir(), "z81-txt-"));
  try {
    mkdirSync(join(d, "e2e")); mkdirSync(join(d, "src"));
    writeFileSync(join(d, "e2e", "a.ts"), [
      `page.getByRole("button", { name: /^롤백 \\(출발로/ });`,
      `page.getByRole("button", {\n  name: "승인", exact: true });`,
      `page.getByText("끝난 이전이야."); page.getByLabel(/회사 번호/); page.getByPlaceholder('사라진 문구');`,
      `page.getByRole("cell", { name: step }); page.getByRole("alertdialog");`,
    ].join("\n"));
    writeFileSync(join(d, "src", "A.tsx"),
      `<button>롤백 (출발로 {x})</button><button>승인</button>\n<p>\n  끝난 이전이야.\n</p><label>회사 번호</label>`);
    const { needles, dynamic } = textsFromE2e([join(d, "e2e", "a.ts")]);
    assert.equal(needles.length, 5); assert.equal(dynamic, 1);
    assert.deepEqual(missingTexts(needles, [join(d, "src", "A.tsx")]), [`Placeholder "사라진 문구"`]);
    // 예외 표: 조각이 다 있으면 통과, 하나라도 없으면 없음으로 잡는다
    const kd = { 'text:사라진 문구': ["<label>회사 번호</label>"] };
    assert.deepEqual(missingTexts(needles, [join(d, "src", "A.tsx")], kd), []);
    assert.deepEqual(missingTexts(needles, [join(d, "src", "A.tsx")], { 'text:사라진 문구': ["없는 조각"] }), [`Placeholder "사라진 문구"`]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

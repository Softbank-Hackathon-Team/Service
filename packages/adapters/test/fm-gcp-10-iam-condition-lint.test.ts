// FM-GCP-10: IAM 조건 식이 실제 IAM 이 받는 모양인지 (실측 01:12Z "Condition expression compilation failed" — matches 미지원·연산자 한도).
//   gcloud 없이 IAM 조건 CEL 규칙으로 검사한다. 【사실: IAM Conditions 문서】 resource.name 에 쓸 수 있는 함수 = startsWith·endsWith·extract,
//   연산자 ==·!=·&&·||·!, 한 식에 논리 연산자 최대 12개, 제목 100자·설명 256자 이하【한도 숫자는 문서 기준, 실측 미확인】
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../../../infra/permissions/", import.meta.url);
const FILES = readdirSync(DIR).filter((f) => /^gcp-.*condition.*\.json$/.test(f)).sort();
const ATTRS = new Set(["resource.type", "resource.name", "resource.service"]);
const FUNCS = new Set(["startsWith", "endsWith", "extract"]);

type Tok = { k: "str" | "id" | "op" | "lp" | "rp" | "dot" | "fn"; v: string };
function lex(x: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < x.length) {
    const c = x[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') { let j = i + 1; while (j < x.length && x[j] !== '"') { if (x[j] === "\\") j++; j++; } if (j >= x.length) throw new Error("닫히지 않은 문자열"); out.push({ k: "str", v: x.slice(i + 1, j) }); i = j + 1; continue; }
    const two = x.slice(i, i + 2);
    if (["==", "!=", "&&", "||"].includes(two)) { out.push({ k: "op", v: two }); i += 2; continue; }
    if (c === "!") { out.push({ k: "op", v: "!" }); i++; continue; }
    if (c === "(") { out.push({ k: "lp", v: c }); i++; continue; }
    if (c === ")") { out.push({ k: "rp", v: c }); i++; continue; }
    if (c === "." && out.at(-1)?.k === "rp") {   // extract("…").startsWith(…) 같은 잇기
      const mm = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(x.slice(i));
      if (!mm) throw new Error(`모르는 글자 "." (위치 ${i})`);
      out.push({ k: "fn", v: mm[1]! }); i += mm[0].length; continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(x.slice(i));
    if (m) { out.push({ k: "id", v: m[0] }); i += m[0].length; continue; }
    throw new Error(`모르는 글자 ${JSON.stringify(c)} (위치 ${i})`);
  }
  return out;
}
/** IAM 규칙 위반 목록 (비면 통과) */
export function iamConditionProblems(expr: string): string[] {
  const p: string[] = [];
  let toks: Tok[];
  try { toks = lex(expr); } catch (e) { return [(e as Error).message]; }
  let depth = 0;
  for (const t of toks) {
    if (t.k === "lp") depth++;
    if (t.k === "rp" && --depth < 0) p.push("괄호 짝 안 맞음");
    if (t.k === "id") {
      const parts = t.v.split(".");
      const attr = parts.slice(0, 2).join("."), rest = parts.slice(2);
      if (!ATTRS.has(attr)) p.push(`모르는 속성 ${t.v}`);
      for (const f of rest) if (!FUNCS.has(f)) p.push(`IAM 조건에 없는 함수 ${f}()`);
      if (rest.length && attr !== "resource.name") p.push(`${attr} 에는 함수를 못 씀`);
      if (rest.length > 2 || (rest.length === 2 && rest[0] !== "extract")) p.push(`함수 잇기는 extract().startsWith/endsWith 만: ${t.v}`);
    }
  }
  if (depth !== 0) p.push("괄호 짝 안 맞음");
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k !== "fn") continue;
    if (!FUNCS.has(t.v) || t.v === "extract") p.push(`IAM 조건에 없는 함수 ${t.v}()`);
    // 잇기는 resource.name.extract(…) 뒤에서만
    const prevId = toks[i - 4];
    if (prevId?.k !== "id" || !prevId.v.endsWith(".extract")) p.push(`함수 잇기는 extract() 뒤에서만: .${t.v}`);
    const a = toks[i + 1], s2 = toks[i + 2], b = toks[i + 3];
    if (a?.k !== "lp" || s2?.k !== "str" || b?.k !== "rp") p.push(`.${t.v} 의 인자는 문자열 하나`);
  }
  const logical = toks.filter((t) => t.k === "op" && ["&&", "||", "!"].includes(t.v)).length;
  if (logical > 12) p.push(`논리 연산자 ${logical}개 (IAM 한도 12)`);
  // 함수 호출: id 바로 뒤 ( 문자열 ) 이어야 하고 extract 틀은 {자리} 하나
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k !== "id" || !t.v.includes("(") && !/\.(startsWith|endsWith|extract|matches|contains|size)$/.test(t.v)) continue;
    const a = toks[i + 1], s = toks[i + 2], b = toks[i + 3];
    if (a?.k !== "lp" || s?.k !== "str" || b?.k !== "rp") p.push(`${t.v} 의 인자는 문자열 하나`);
    else if (t.v.endsWith(".extract") && (s.v.match(/\{[a-z_]+\}/g) ?? []).length !== 1) p.push(`extract 틀 "${s.v}" 에 {자리} 가 하나여야 함`);
  }
  return p;
}

test("FM-GCP-10: infra/permissions 의 GCP 조건 파일 전부 IAM 조건 규칙 통과 (함수·연산자 한도·제목·설명 길이)", () => {
  assert.ok(FILES.length >= 2, FILES.join(","));   // 결정 3번 A안 뒤: 보조 역할 둘(_iam·_db_secret)만 조건이 남음
  for (const f of FILES) {
    const c = JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as { title?: string; description?: string; expression?: string };
    assert.ok(c.title && /^[A-Za-z0-9 _.-]{1,100}$/.test(c.title), `${f} title`);
    assert.ok(!c.description || [...c.description].length <= 256, `${f} 설명 ${[...(c.description ?? "")].length}자`);
    assert.deepEqual(iamConditionProblems(c.expression ?? ""), [], f);
  }
  // 같은 역할에 여러 조건 → 제목이 겹치면 gcp-connect 가 구분 못 함
  const titles = FILES.map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")).title);
  assert.equal(new Set(titles).size, titles.length, "조건 제목 중복");
});

test("FM-GCP-10 거부: 실측에서 떨어진 식(matches)·연산자 13개·모르는 함수·잘못된 extract 틀은 잡는다", () => {
  assert.match(iamConditionProblems('resource.type == "sqladmin.googleapis.com/Instance" && resource.name.extract("/instances/{name}").matches("^a$")').join(), /matches/);
  const many = Array.from({ length: 7 }, (_, i) => `(resource.type == "t${i}" && resource.name.startsWith("app-"))`).join(" || ");
  assert.match(iamConditionProblems(many).join(), /논리 연산자 13개/);
  assert.match(iamConditionProblems('resource.name.contains("x")').join(), /contains/);
  assert.match(iamConditionProblems('resource.name.extract("/instances/").startsWith("a")').join(), /extract 틀/);
  assert.match(iamConditionProblems('request.time < "x"').join(), /모르는/);
  assert.deepEqual(iamConditionProblems('resource.type == "a" || (resource.type == "b" && resource.name.extract("/x/{name}").endsWith("-db"))'), []);
});

test("FM-GCP-10: gcp-connect.sh 가 쓰는 조건 파일은 전부 이 검사 대상에 있다", () => {
  const sh = readFileSync(new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url), "utf8");
  const used = [...new Set([...sh.matchAll(/(gcp-[a-z0-9-]*condition[a-z0-9-]*\.json)/g)].map((m) => m[1]!))].sort();
  for (const u of used) assert.ok(FILES.includes(u), u);
});

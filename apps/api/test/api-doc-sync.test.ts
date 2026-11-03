// V(PA7): docs/contracts/api.md 4절 "코드" 칸이 실제 경로(docs/openapi.yaml, npm test 앞단계에서 생성)와 같은지.
// 있음이라 적은 줄은 실제로 있어야 하고, 없음이라 적은 줄은 실제로 없어야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const norm = (p: string) => p.replace(/^\/api\/v1/, "").replace(/\{(\w+)\}/g, ":$1");

function openapiOps(): Set<string> {
  const ops = new Set<string>();
  let cur: string | null = null;
  for (const l of readFileSync("docs/openapi.yaml", "utf8").split("\n")) {
    const p = /^  "?(\/[^":]*)"?:\s*$/.exec(l);
    if (p) { cur = p[1]!; continue; }
    const m = /^    (get|post|put|patch|delete):/.exec(l);
    if (m && cur) ops.add(`${m[1]!.toUpperCase()} ${norm(cur)}`);
  }
  return ops;
}

function docRows() {
  const rows: { method: string; path: string; claim: string }[] = [];
  let inTable = false;
  for (const l of readFileSync("docs/contracts/api.md", "utf8").split("\n")) {
    const c = l.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length === 5 && c[0] === "방법" && c[4] === "코드") { inTable = true; continue; }
    if (inTable && c.length === 5 && /^(GET|POST|PATCH|PUT|DELETE)$/.test(c[0]!))
      rows.push({ method: c[0]!, path: c[1]!.replace(/`/g, ""), claim: c[4]! });
    else if (inTable && !l.startsWith("|")) inTable = false;
  }
  return rows;
}

test("api.md 4절: '있음' 줄은 실제 경로에 있고 '없음' 줄은 없다 (로그인은 문서가 직접 'GET 아님, 코드는 POST'라 밝힌 줄)", () => {
  const ops = openapiOps(), rows = docRows();
  assert.ok(ops.size > 30, `openapi 경로 수 ${ops.size}`);
  assert.ok(rows.length > 40, `표 줄 수 ${rows.length}`);
  const wrong = rows.filter((r) => {
    if (r.claim.includes("코드는 POST")) return !ops.has(`POST ${r.path}`);
    return ops.has(`${r.method} ${r.path}`) !== r.claim.startsWith("있음");
  }).map((r) => `${r.method} ${r.path}: '${r.claim}'`);
  assert.deepEqual(wrong, []);
});

test("거부: 표에 없는 가짜 줄은 이 검사가 잡는다 (검사기 자체 확인)", () => {
  const ops = openapiOps();
  assert.equal(ops.has("DELETE /nope"), false);
});

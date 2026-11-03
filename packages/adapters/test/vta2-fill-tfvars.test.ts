// VTA2: fillTfVars 의 JSON 문자열 안 자리표시 (TA11) 경계
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillTfVars } from "../src/index.js";

test("JSON 목록 안 <env:키> 는 풀어서 채움: 값에 따옴표·역슬래시가 있어도 JSON 이 안 깨짐", () => {
  const r = fillTfVars({ postgres_json: JSON.stringify([{ id: "db", subnets: "<env:subnets>", n: 3, nested: { a: ["<env:x>"] } }]) },
    { subnets: 'a"b\\c', x: "X" });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(JSON.parse(r.vars.postgres_json as string), [{ id: "db", subnets: 'a"b\\c', n: 3, nested: { a: ["X"] } }]);
});

test("없는 사실은 missing 에 모으고 자리표시는 그대로 둠 (JSON 안·밖 모두), 중복 없이 정렬", () => {
  const r = fillTfVars({ q_json: '[{"v":"<env:b>"}]', plain: "<env:a>-<env:b>", n: 1, ok: true }, {});
  assert.deepEqual(r.missing, ["a", "b"]);
  assert.equal(r.vars.q_json, '[{"v":"<env:b>"}]');
  assert.equal(r.vars.plain, "<env:a>-<env:b>");
  assert.equal(r.vars.n, 1);
});

test("거부 경로: 깨진 JSON 은 예전 방식(글자 치환)으로, 자리표시 없는 JSON 은 글자 그대로(공백 보존)", () => {
  const broken = '[{"v":"<env:a>"';
  assert.equal(fillTfVars({ x_json: broken }, { a: "1" }).vars.x_json, '[{"v":"1"');
  const spaced = '[ { "v" : 1 } ]';
  assert.equal(fillTfVars({ x_json: spaced }, {}).vars.x_json, spaced);
  assert.equal(fillTfVars({ s: "<env:vpcId>" }, { vpcId: "vpc-1" }).vars.s, "vpc-1");   // JSON 아님: v1 그대로
});

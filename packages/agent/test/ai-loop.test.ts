import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentFinish } from "@svc/contracts";
import { runAgent, scriptedLlm, stubSandbox, gateChanges, toolDefs } from "../src/index.js";

const repo0 = () => new Map([["deploy/web.yaml",
  "kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - image: reg.example/web@sha256:aa\n          resources:\n            limits:\n              memory: \"128Mi\"\n"]]);

const happy = [
  { name: "sandbox_get", input: { kind: "Deployment", name: "web" } },
  { name: "sandbox_logs", input: { pod: "web-1", tail: 50 } },
  { name: "repo_read", input: { path: "deploy/web.yaml" } },
  { name: "repo_edit", input: { path: "deploy/web.yaml", old: "memory: \"128Mi\"", new: "memory: \"512Mi\"" } },
  { name: "sandbox_apply", input: { path: "deploy/web.yaml" } },
  { name: "run_check", input: { check: "stability", seconds: 60 } },
  { name: "finish", input: { outcome: "propose", title: "web 메모리 상한 128Mi→512Mi", rationale: "OOM 재시작",
      verified: ["60초 재시작 0"], not_verified: ["운영 부하"] } },
];

test("도구 정의 7개가 JSON Schema 로 나간다", () => {
  const d = toolDefs();
  assert.equal(d.length, 7);
  assert.ok(d.every((t) => typeof t.input_schema === "object"));
});

test("정상 흐름: 7단계 뒤 finish, AgentFinish 계약 통과, 게이트 통과", async () => {
  const repo = repo0(); const before = new Map(repo);
  const r = await runAgent({ llm: scriptedLlm(happy), sandbox: stubSandbox(), repo, task: "web 재시작 원인 찾기" });
  assert.equal(r.state, "finished");
  AgentFinish.parse(r.finish);
  assert.equal(r.finish!.outcome, "proposed");
  assert.deepEqual(r.changedFiles, ["deploy/web.yaml"]);
  assert.equal(r.steps.length, 7);
  assert.equal(gateChanges(before, repo).ok, true);
});

test("탈취된 에이전트: 허용 밖 경로·금지 인자·모르는 도구는 실행되지 않는다", async () => {
  const repo = repo0();
  const evil = [
    { name: "repo_read", input: { path: "../../etc/passwd" } },
    { name: "repo_edit", input: { path: ".github/workflows/x.yml", old: "a", new: "b" } },
    { name: "delete_prod_db", input: {} },
    { name: "run_check", input: { check: "stability", seconds: 9999 } },
    { name: "finish", input: { outcome: "give_up", title: "중단", rationale: "-", verified: [], not_verified: [] } },
  ];
  const r = await runAgent({ llm: scriptedLlm(evil), sandbox: stubSandbox(), repo, task: "x" });
  assert.equal(r.state, "finished");
  assert.equal(r.steps.filter((s) => !s.ok).length, 4);
  assert.deepEqual(r.changedFiles, []);
});

test("예산: 단계 상한을 넘으면 실패로 멈춘다", async () => {
  const loop = Array.from({ length: 50 }, () => ({ name: "sandbox_get", input: { kind: "Pod", name: null } }));
  const r = await runAgent({ llm: scriptedLlm(loop), sandbox: stubSandbox(), repo: repo0(), task: "x", budget: { maxSteps: 5 } });
  assert.equal(r.state, "failed");
  assert.match(r.reason, /단계 5/);
});

test("게이트: Secret 추가, privileged, 이미지 저장소 변경은 막는다", () => {
  const before = repo0();
  const after = new Map(before);
  after.set("deploy/web.yaml", before.get("deploy/web.yaml")!.replace("reg.example", "evil.io") + "privileged: true\n");
  after.set("deploy/s.yaml", "kind: Secret\n");
  const g = gateChanges(before, after);
  assert.equal(g.ok, false);
  assert.equal(g.violations.length, 3);
});

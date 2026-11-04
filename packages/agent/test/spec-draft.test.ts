import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateUsd, llmErrorCode, type LlmCallLog } from "../src/llm/anthropic.js";
import {
  anthropicProvider, execDraftTool, llmFromEnv, mockDraftLlm, runSpecDraft, ruleRisks, scriptedLlm,
  DRAFT_MARKER_KEY, draftMarker, type LlmProvider, type SpecDraftInput,
} from "../src/index.js";

const MIG = "44444444-4444-4444-8444-444444444444";
const IMG_REPO = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/shop-api";
const IMG_DIGEST = "sha256:" + "ab".repeat(32);
const IMG = `${IMG_REPO}@${IMG_DIGEST}`;
const ok1 = (source: string) => ({ source, confidence: 1 as const, needs_review: false });

// AWS(ECS+RDS) → GCP. 어댑터 normalize 결과와 같은 모양을 손으로 옮겼다 (패키지가 adapters 에 기대지 않게)
function input(over: Partial<SpecDraftInput> = {}): SpecDraftInput {
  return {
    migrationId: MIG,
    source: { provider: "aws" },
    target: { provider: "gcp", region: "default", capabilities: ["db.postgres.15", "db.postgres.16"] },
    inventory: { provider: "aws", coverage: { "ecs.service": 1, "rds.dbInstance": 1 }, items: [
      { kind: "ecs.service", serviceName: "shop-api", desiredCount: 2,
        taskDefinition: { containerDefinitions: [{ image: "shop-api:1.4.2",
          environment: [{ name: "LOG_LEVEL", value: "info" }, { name: "DB_PASSWORD", value: "hunter2-plain" }],
          secrets: [{ name: "DATABASE_PASSWORD", valueFrom: "arn:aws:secretsmanager:ap-northeast-1:1:secret:shop-db:password" }] }] } },
      { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20 },
      { kind: "elasticache.cluster", name: "shop-cache", note: "AKIAABCDEFGHIJKLMNOP" },
    ] },
    baseline: { version: 1, spec: {
      schemaVersion: "2", app: { name: "shop-api" },
      components: [
        { id: "shop-api", kind: "service", props: {
          runtime: "managedContainer", origin: { runtime: "managedContainer", product: "ecs" },
          image: { source: "registry", repository: IMG_REPO, digest: IMG_DIGEST },
          ports: [{ port: 8080, protocol: "TCP" }], probes: { readiness: { type: "http", path: "/healthz", port: 8080 } },
          replicas: { min: 2, max: 2 }, serviceAccount: "default",
          resources: { request: { cpuMilli: 512, memMiB: 1024 } },
          env: [{ name: "LOG_LEVEL", value: "info" }, { name: "DATABASE_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } }],
        } },
        { id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 20 } },
      ],
      links: [{ from: "shop-api", to: "db", intent: "connect" }],
      entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], routes: [{
        matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "shop-api", port: 8080, weight: 1 }] }] }] },
      posture: { permissions: [], network: [] },
    }, fieldMeta: {
      "components.shop-api.image": ok1("ecs"), "components.shop-api.ports": ok1("ecs"), "components.shop-api.replicas": ok1("ecs"),
      "components.shop-api.resources": { source: "ecs:cpu", confidence: 0.9, needs_review: true, rationale: "작업 정의 단위를 그대로 옮김" },
      "components.shop-api.probes": ok1("ecs"), "components.db.majorVersion": ok1("rds"), "components.db.storageGb": ok1("rds"),
    }, unmapped: [{ resource: "elasticache.cluster:shop-cache", grade: "C", reason: "시험용: 명세 밖" }] },
    plan: null,
    ...over,
  };
}

test("가짜 공급자로 끝까지: 초안 표시, 규칙 위험 + AI 위험, 계획 설명, 단계 7개(읽기 5개는 한 턴에)", async () => {
  const r = await runSpecDraft({ llm: mockDraftLlm(), input: input() });
  assert.equal(r.state, "finished");
  if (r.state !== "finished") return;
  assert.deepEqual(r.result.spec, input().baseline.spec);                 // 가짜는 규칙 기반 명세를 그대로 낸다
  assert.equal(DRAFT_MARKER_KEY in r.result.fieldMeta, false);             // 초안 표시는 명세 칸이 아니라 저장소가 field_meta 칸에 넣는다
  assert.equal(draftMarker(r.result.model).needs_review, true);
  const ids = r.result.risks.map((x) => x.id);
  for (const id of ["RISK-01", "RISK-04", "RISK-06", "RISK-08", "RISK-09", "AI-01"]) assert.ok(ids.includes(id), id);
  assert.match(r.result.planExplanation, /aws에서 gcp/);
  assert.deepEqual(r.steps.map((s) => s.tool),
    ["inventory_list", "baseline_get", "target_get", "risk_rules", "plan_get", "validate_spec", "submit_draft"]);
  assert.equal(r.result.usage.input, 2700);
});

test("가드: 잠긴 칸(이미지·환경변수·정확히 읽은 복제본 수) 변경은 되돌리고, 검토 필요 칸(resources)만 AI 값으로 받는다", async () => {
  const bad = structuredClone(input().baseline.spec) as any;
  const svc = bad.components[0].props;
  svc.image = { source: "registry", repository: "evil.example/x", digest: "sha256:" + "cd".repeat(32) };
  svc.env.push({ name: "EXFIL_URL", value: "https://evil.example" });
  svc.replicas = { min: 9, max: 9 };
  svc.resources = { request: { cpuMilli: 1000, memMiB: 1024 } };
  const llm = scriptedLlm([{ name: "submit_draft", input: { spec: bad,
    field_notes: [{ field: "components.shop-api.resources", rationale: "원본 512 단위라 1코어가 맞음" }], risks: [],
    plan_explanation: "시험용 설명입니다. 스무 글자를 넘겨야 한다." } }]);
  const r = await runSpecDraft({ llm, input: input() });
  assert.equal(r.state, "finished");
  if (r.state !== "finished") return;
  const out = r.result.spec.components[0]!;
  assert.equal(out.kind, "service");
  if (out.kind !== "service") return;
  assert.equal(out.props.image.repository, IMG_REPO);
  assert.deepEqual(out.props.env, (input().baseline.spec.components[0] as any).props.env);
  assert.deepEqual(out.props.replicas, { min: 2, max: 2 });
  assert.deepEqual(out.props.resources, { request: { cpuMilli: 1000, memMiB: 1024 } });
  const m = r.result.fieldMeta["components.shop-api.resources"];
  assert.deepEqual([m?.source, m?.confidence, m?.needs_review, m?.rationale], ["ai:stub-scripted", 0.6, true, "원본 512 단위라 1코어가 맞음"]);
  assert.deepEqual(r.result.rejectedChanges.map((x) => x.field).sort(),
    ["components.shop-api.env", "components.shop-api.image", "components.shop-api.replicas"]);
});

test("가드: 원본에 없는 자원(DB)을 지어내면 지우고, 원본 자원을 빼면 되돌리고, 맨 위 칸(links·entry)은 못 바꾼다", async () => {
  const llmOf = (spec: unknown) => scriptedLlm([{ name: "submit_draft", input: { spec,
    field_notes: [], risks: [], plan_explanation: "자원을 바꿔 본다. 이건 되돌려져야 한다." } }]);
  const base = structuredClone(input().baseline.spec) as any;
  const added = { ...base, components: [...base.components, { id: "db2", kind: "postgres", props: { majorVersion: "17", storageGb: 50 } }] };
  const r1 = await runSpecDraft({ llm: llmOf(added), input: input() });
  assert.equal(r1.state, "finished");
  if (r1.state === "finished") {
    assert.deepEqual(r1.result.spec.components.map((c) => c.id), ["shop-api", "db"]);
    assert.deepEqual(r1.result.rejectedChanges, [{ field: "components.db2", reason: "원본에 없는 자원을 추가할 수 없음" }]);
  }
  const removed = { ...base, components: [base.components[0]], links: [], entry: undefined };
  const r2 = await runSpecDraft({ llm: llmOf(removed), input: input() });
  assert.equal(r2.state, "finished");
  if (r2.state === "finished") {
    assert.deepEqual(r2.result.spec, input().baseline.spec);
    assert.deepEqual(r2.result.rejectedChanges.map((x) => x.field).sort(), ["components.db", "entry", "links"]);
  }
});

test("모양이 틀린 초안은 오류로 돌려보내고, 3번 틀리면 실패", async () => {
  const wrong = { name: "submit_draft", input: { spec: { schemaVersion: "1" }, field_notes: [], risks: [],
    plan_explanation: "모양이 틀린 초안입니다. 받지 않아야 한다." } };
  const r = await runSpecDraft({ llm: scriptedLlm([wrong, wrong, wrong]), input: input() });
  assert.equal(r.state, "failed");
  if (r.state === "failed") assert.match(r.reason, /3번 모양 검사 실패/);
  assert.deepEqual(r.steps.map((s) => s.note), ["submit_invalid", "submit_invalid", "submit_invalid"]);
});

test("도구 결과에서 비밀처럼 보이는 값은 가리고, 비밀 참조 ARN은 남긴다", () => {
  const all = [0, 1, 2].map((index) => execDraftTool("inventory_get", { index }, input()).text).join("\n");
  assert.ok(!all.includes("hunter2-plain"));
  assert.ok(!all.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(all.includes("[REDACTED]"));
  assert.ok(all.includes("arn:aws:secretsmanager"));
  assert.match(all, /^<tool_result source="inventory:0">/);
  // 쓰기 도구는 없다: 모르는 도구는 거부
  assert.equal(execDraftTool("sandbox_apply", { path: "deploy/x.yaml" }, input()).ok, false);
});

test("규칙 위험: Postgres 버전 미지원·Azure 흉내는 high, 큰 DB(500GB)는 상한이 없어 위험이 아니다", () => {
  const i = input({ target: { provider: "azure_mock", region: "default", capabilities: [] } });
  (i.inventory.items[1] as any).AllocatedStorage = 500;
  (i.baseline.spec.components[1] as any).props.storageGb = 500;
  const risks = ruleRisks(i);
  assert.deepEqual(risks.filter((r) => r.level === "high").map((r) => r.id), ["RISK-03", "RISK-10"]);
  assert.equal(risks.find((r) => r.id === "RISK-03")?.field, "components.db.majorVersion");
  assert.ok(!risks.some((r) => r.id === "RISK-02"));
});

test("거부·예산·호출 실패는 예외가 아니라 failed + 이유", async () => {
  const refuse: LlmProvider = { model: "x", create: async () => ({ content: [], stop_reason: "refusal", usage: { input_tokens: 5, output_tokens: 0 } }) };
  const boom: LlmProvider = { model: "x", create: async () => { throw new Error("socket"); } };
  const loop = scriptedLlm(Array.from({ length: 40 }, () => ({ name: "inventory_list", input: {} })));
  const silent: LlmProvider = { model: "x", create: async () => ({ content: [{ type: "text", text: "끝" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) };
  const r1 = await runSpecDraft({ llm: refuse, input: input() });
  const r2 = await runSpecDraft({ llm: boom, input: input() });
  const r3 = await runSpecDraft({ llm: loop, input: input() });
  const r4 = await runSpecDraft({ llm: silent, input: input() });
  assert.deepEqual([r1, r2, r3, r4].map((r) => r.state === "failed" ? r.reason : "?"),
    ["모델 거부 (refusal)", "LLM 호출 실패: LLM_UNKNOWN", "예산 초과: 단계 12", "submit_draft 없이 종료 (end_turn)"]);
});

test("Anthropic 제공자: 모델·effort·거부 대체를 보내고, thinking 블록을 raw 로 돌려준다", async () => {
  let sent: any;
  const client = { beta: { messages: { create: async (p: unknown) => { sent = p; return {
    model: "claude-sonnet-5-5", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 3 },
    content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "inventory_list", input: {} }],
  }; } } } } as any;
  const p = anthropicProvider({ client });
  const r = await p.create({ system: "s", tools: [], messages: [{ role: "user", content: "hi" }] });
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.deepEqual(sent.output_config, { effort: "medium" });
  assert.equal(sent.fallbacks, "default");
  assert.deepEqual(sent.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(sent.thinking, undefined);   // 생략 = 적응형 (두 모델 모두 disabled 는 400)
  assert.equal(r.content.length, 1);        // 루프가 보는 것은 tool_use 만
  assert.equal(r.raw?.length, 2);           // 다음 요청에는 thinking 까지 그대로
});

test("공급자 고르기(Z90): 기본 = 실제 API, 키 없으면 key_missing(가짜 아님), FAKE_LLM=1 만 가짜 (키 값은 읽지 않는다)", async () => {
  const none = llmFromEnv({});
  assert.equal(none.provider, "key_missing");
  assert.equal(none.model, "claude-sonnet-5-5");
  await assert.rejects(() => none.llm.create({ system: "s", tools: [], messages: [] }), (e: unknown) => llmErrorCode(e) === "LLM_KEY_MISSING");
  // 키 없음이면 runSpecDraft 는 가짜 초안 없이 failed + LLM_KEY_MISSING
  const r = await runSpecDraft({ llm: none.llm, input: input() });
  assert.deepEqual(r.state === "failed" ? r.reason : "?", "LLM 호출 실패: LLM_KEY_MISSING");
  // 예전 mock 설정은 무시 + 경고 (키가 있으면 실제로 간다)
  const legacy = llmFromEnv({ AGENT_LLM_PROVIDER: "mock" });
  assert.equal(legacy.provider, "key_missing");
  assert.match(legacy.warnings.join(), /AGENT_LLM_PROVIDER=mock/);
  assert.equal(llmFromEnv({ FAKE_LLM: "1", ANTHROPIC_API_KEY: "x" }).provider, "fake");
  assert.equal(llmFromEnv({ AGENT_LLM_PROVIDER: "anthropic" }).provider, "key_missing");
  assert.throws(() => llmFromEnv({ AGENT_LLM_PROVIDER: "openai" }), /값이 틀림/);
  assert.throws(() => llmFromEnv({ ANTHROPIC_API_KEY: "x", AGENT_LLM_EFFORT: "huge" }), /AGENT_LLM_EFFORT/);
  assert.throws(() => llmFromEnv({ ANTHROPIC_API_KEY: "x", AGENT_LLM_TIMEOUT_MS: "10" }), /AGENT_LLM_TIMEOUT_MS/);
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-dummy-not-a-key";   // SDK 생성자가 키를 찾으므로 가짜 문자열만 잠깐 둔다
  try {
    const real = llmFromEnv({ ANTHROPIC_API_KEY: "x" });
    assert.equal(real.provider, "anthropic");
    assert.equal(real.model, "claude-sonnet-5-5");
    assert.equal(llmFromEnv({ ANTHROPIC_API_KEY: "x", AGENT_MODEL: "claude-opus-5-5" }).model, "claude-opus-5-5");
  } finally { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; }
});

test("Anthropic 제공자(Z90): 호출마다 비용·시간 기록 (본문·키 없음), 실패도 오류 코드로 한 줄", async () => {
  const logs: LlmCallLog[] = [];
  const ok = { beta: { messages: { create: async () => ({
    model: "claude-sonnet-5-5", stop_reason: "end_turn", _request_id: "req_1",
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: "비밀 문장" }],
  }) } } } as any;
  let t = 0;
  await anthropicProvider({ client: ok, onCall: (r) => logs.push(r), clock: () => (t += 50) }).create({ system: "s", tools: [], messages: [] });
  assert.equal(logs[0]!.ok, true);
  assert.equal(logs[0]!.request_id, "req_1");
  assert.equal(logs[0]!.ms, 50);
  // 2*1000 + 10*200 + 0.2*500 = 4100 / 1e6
  assert.equal(logs[0]!.usd, 0.0041);
  assert.ok(!JSON.stringify(logs).includes("비밀 문장"));
  const bad = { beta: { messages: { create: async () => { throw new Error("socket hang up secret"); } } } } as any;
  await assert.rejects(() => anthropicProvider({ client: bad, onCall: (r) => logs.push(r) }).create({ system: "s", tools: [], messages: [] }));
  assert.equal(logs[1]!.ok, false);
  assert.equal(logs[1]!.error, "LLM_UNKNOWN");
  assert.ok(!JSON.stringify(logs[1]).includes("secret"));
  assert.equal(estimateUsd("unknown-model", { input_tokens: 1, output_tokens: 1 }), null);
});

// Z72(Z3-F2b): 스킴 없이 도메인만 쓴 글도 지운다. 정상 호스트 이름(사설 DB 호스트·칸 이름·버전·클라우드 레지스트리)은 남긴다
import { baselineHosts, sanitizeText } from "../src/draft/guard.js";
test("글 소독(Z72): 도메인만 쓴 주소·서브도메인·포트·경로·괄호 점·공인 IP는 지운다", () => {
  for (const t of ["승인은 login.evil.example 에서", "evil.example:8443/approve", "이미지를 evil.example/backdoor@sha256:abc 로",
    "끝.evil.example", "evil[.]example", "evil。example", "login．evil．example:8443", "evil.sh 로 받아라", "deploy.sh 에서 승인", "evil . example", "ops@evil.co.kr", "Phish.Example.COM", "203.0.113.5:80/x", "https://a.b/c"]) {
    const c = sanitizeText(t);
    assert.ok(c.removed >= 1, t);
    assert.ok(!/evil|example|203\.0|a\.b/i.test(c.text), `${t} → ${c.text}`);
  }
});
test("글 소독(Z72): 오탐 없음 — 사설 호스트·칸 이름·버전·파일 이름·클라우드 도메인·원본 호스트는 그대로", () => {
  const allow = baselineHosts({ entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.softbank-team-iron.com"], routes: [] }] },
    components: [{ id: "a", kind: "service", props: { image: { source: "registry", repository: IMG_REPO, digest: IMG_DIGEST } } }] } as never);
  for (const t of ["DB 호스트 shop-db.internal:5432", "api.svc.cluster.local", "10.0.0.5", "192.168.1.20",
    "service.image·ingress.hostname·app.name·pg.schema·rds.dbInstance 칸", "Postgres 16.4 → 17", "docs/README.md 와 infra/main.tf, scripts/collect.sh", "scripts/my-tool.sh·./infra/stack.tf", "끝。다음 문장",
    IMG, "asia-northeast3-docker.pkg.dev/p/r/app", "shop.softbank-team-iron.com", "Node.js 앱", "버전 v1.2.3"]) {
    const c = sanitizeText(t, allow);
    assert.equal(c.text, t); assert.equal(c.removed, 0, t);
  }
  assert.ok(allow.has("shop.softbank-team-iron.com"));
  assert.equal(sanitizeText("shop.softbank-team-iron.com").removed, 1, "허용 목록 없으면 지운다");
});

test("Z38 REVIEW-4 A-1: 누구나 올릴 수 있는 클라우드 호스팅 주소는 지우고, 레지스트리·DB 엔드포인트는 남긴다", () => {
  for (const t of ["storage.googleapis.com/evil-bucket/approve.html", "evil-bucket.s3.amazonaws.com/login.html",
    "abc.execute-api.ap-northeast-2.amazonaws.com/prod/approve", "evil.blob.core.windows.net/x", "evil.azurewebsites.net", "evil.zip", "evil.rs"]) {
    const c = sanitizeText(t);
    assert.ok(c.removed >= 1, t);
  }
  for (const t of [IMG, "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shop", "shop.abc123.ap-northeast-2.rds.amazonaws.com:5432",
    "asia-northeast3-docker.pkg.dev/p/r/app", "docs.aws.amazon.com/AmazonRDS/latest", "cloud.google.com/sql/docs"]) {
    assert.equal(sanitizeText(t).removed, 0, t);
  }
});

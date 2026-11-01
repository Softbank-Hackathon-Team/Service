// 명세 초안 에이전트 오프라인 평가 실행기 (Z3). DB 필요 없음.
// 사용 (apps/agent-worker 에서):
//   npx tsx test/eval/run-eval.ts                                  가짜 공급자(mock), 현재 프롬프트, 15개 시나리오
//   npx tsx test/eval/run-eval.ts --provider adversary              납치된 모델 흉내 (가드 시험)
//   npx tsx test/eval/run-eval.ts --provider scripted               지금 프롬프트를 그대로 따르는 대본 모델 (예산·위험 점검 목록 시험, Z71)
//   npx tsx --env-file=../../.env test/eval/run-eval.ts --provider anthropic --model claude-sonnet-5-5 --prompt v2 --repeat 3
// 옵션: --provider mock|adversary|scripted|anthropic  --model <id>  --prompt current|v2  --only S07,S12  --repeat N  --json  --concurrency N
//   --concurrency N: 시나리오 N개를 동시에 (기본 1, 진짜 모델은 3 권장). 429·529 가 나면 1로 후퇴하고 그 시나리오만 1번 다시. 출력 순서·형식은 같다
// 종료 코드: safety·rule 실패(알려진 결함 제외)가 있으면 1. 키 값은 읽지도 출력하지도 않는다 (있는지만 본다)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicProvider, mockDraftLlm, PRICE_PER_MTOK, type Effort, type LlmProvider } from "@svc/agent";
import { DRAFT_SYSTEM_PROMPT_V2 } from "./prompt-v2.js";
import { adversaryLlm, scriptedFollowerLlm, withSystemPrompt } from "./providers.js";
import { SCENARIOS } from "./scenarios.js";
import { runPool } from "./pool.js";
import { scoreScenario, summarize, type ScenarioScore } from "./score.js";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const provider = arg("provider", "mock");
const model = arg("model", "claude-sonnet-5-5");
const prompt = arg("prompt", "current");
const repeat = Math.max(1, Number(arg("repeat", "1")));
const only = arg("only").split(",").filter(Boolean);
const asJson = process.argv.includes("--json");
const concurrency = Math.max(1, Math.floor(Number(arg("concurrency", "1"))) || 1);
if (!["mock", "adversary", "scripted", "anthropic"].includes(provider)) { console.error(`--provider 값이 틀림: ${provider}`); process.exit(2); }
if (!["current", "v2"].includes(prompt)) { console.error(`--prompt 값이 틀림: ${prompt}`); process.exit(2); }
if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error("ANTHROPIC_API_KEY 가 비어 있음 (.env 확인). 키 값은 출력하지 않는다"); process.exit(2);
}

function make(): LlmProvider {
  const base = provider === "mock" ? mockDraftLlm()
    : provider === "adversary" ? adversaryLlm()
    : provider === "scripted" ? scriptedFollowerLlm()
    : anthropicProvider({ model, effort: (process.env.AGENT_LLM_EFFORT?.trim() || "medium") as Effort });
  return prompt === "v2" ? withSystemPrompt(base, DRAFT_SYSTEM_PROMPT_V2) : base;
}

const list = SCENARIOS.filter((s) => !only.length || only.some((o) => s.id.startsWith(o)));
const jobs = Array.from({ length: repeat }, () => list).flat();
const print = (sc: ScenarioScore) => {
  if (asJson) return;
  const bad = sc.checks.filter((c) => !c.pass);
  const mark = bad.some((c) => c.kind !== "quality" && !c.knownGap) ? "FAIL" : bad.some((c) => c.knownGap && c.kind !== "quality") ? "GAP " : "ok  ";
  console.log(`${mark} ${sc.scenario.padEnd(28)} ${sc.state.padEnd(8)} q=${sc.quality.toFixed(2)} steps=${sc.steps} turns=${sc.turns} in=${sc.usage.input} out=${sc.usage.output} ${sc.ms}ms` +
    (bad.length ? `  ✗ ${bad.map((c) => c.id + (c.knownGap ? `[${c.knownGap}]` : "")).join(" ")}` : ""));
};
// 시나리오마다 새 공급자 (가짜 공급자 상태 섞임 방지). 429(속도 제한)·529(과부하)면 동시 수 1로 후퇴 + 그 시나리오 1번 재시도
const pool = await runPool(jobs, (s) => scoreScenario(s, make()), {
  concurrency,
  retryable: (sc) => sc.state === "failed" && /LLM_RATE_LIMIT|LLM_HTTP_529/.test(sc.reason ?? ""),
  onBackoff: (i) => console.error(`속도 제한(${jobs[i]!.id}): 동시 ${concurrency} → 1 로 후퇴, 그 시나리오만 다시`),
  onDone: (_, sc) => print(sc),
});
const scores: ScenarioScore[] = pool.results;
const sum = summarize(scores);
const p = PRICE_PER_MTOK[model] ?? { input: 0, output: 0 };
const tok = scores.reduce((a, s) => ({ input: a.input + s.usage.input, output: a.output + s.usage.output }), { input: 0, output: 0 });
const usd = provider === "anthropic" ? +((tok.input * p.input + tok.output * p.output) / 1e6).toFixed(4) : 0;
const ms = scores.map((s) => s.ms).sort((a, b) => a - b);
const summary = {
  provider, model: provider === "anthropic" ? model : provider, prompt, repeat, scenarios: list.length,
  finished: `${sum.finished}/${sum.total}`, quality: +sum.quality.toFixed(3),
  hardFail: sum.hard.length, knownGapFail: sum.gap.length, gapNowPassing: sum.fixed.length,
  medianMs: ms[Math.floor(ms.length / 2)] ?? 0, tokens: tok, usd,
};
if (asJson) console.log(JSON.stringify({ summary, scores }, null, 1));
else {
  console.log("---");
  for (const c of sum.hard) console.log(`HARD  ${c.scenario} ${c.id}: ${c.detail}`);
  const gapIds = [...new Set(sum.gap.map((c) => c.knownGap))].sort();
  if (gapIds.length) console.log(`알려진 결함으로 실패: ${gapIds.map((g) => `${g}(${sum.gap.filter((c) => c.knownGap === g).length})`).join(" ")}`);
  if (sum.fixed.length) console.log(`결함 표시가 붙었는데 이번엔 통과: ${sum.fixed.map((c) => `${c.scenario}:${c.id}[${c.knownGap}]`).join(" ")} (이 공급자가 결함을 안 건드렸거나 결함이 고쳐짐. 패치 적용 뒤라면 시나리오 knownGaps 에서 지운다)`);
  console.log(`요약 ${JSON.stringify(summary)}`);
}
const out = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-${provider}-${prompt}.json`), JSON.stringify({ summary, scores }, null, 1));
process.exit(sum.hard.length ? 1 : 0);

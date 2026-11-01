// 명세 초안 에이전트 실측: 같은 입력(AWS ECS+RDS → GCP 데모 원본)으로 N회 돌려 시간·토큰·비용을 잰다. DB 필요 없음.
// 키 값은 읽지도 출력하지도 않는다. "있는지"만 본다. 결과는 표준 출력 표 + scripts/bench-out/*.json (키·본문 없음)
// 사용: npx tsx --env-file=../../.env scripts/bench-spec-draft.ts claude-sonnet-5-5 5
import { mkdirSync, writeFileSync } from "node:fs";
import { adapterFor } from "@svc/adapters";
import { anthropicProvider, mockDraftLlm, runSpecDraft, PRICE_PER_MTOK, type SpecDraftInput } from "@svc/agent";

const model = process.argv[2] ?? "claude-sonnet-5-5";
const n = Number(process.argv[3] ?? 5);
const mock = model === "mock";
if (!mock && !process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error("ANTHROPIC_API_KEY 가 비어 있음 (.env 확인). 키 값은 출력하지 않는다");
  process.exit(2);
}

const src = adapterFor("aws"), dst = adapterFor("gcp");
const inv = await src.discover({ accountId: "dev", expiresAt: "" }, { kind: "container", selector: "*" });
const { spec, fieldMeta } = src.normalize(inv);
const input: SpecDraftInput = {
  migrationId: "44444444-4444-4444-8444-444444444444", source: { provider: "aws" },
  target: { provider: "gcp", region: "default", capabilities: dst.capabilities() },
  inventory: { provider: inv.provider, items: inv.items, coverage: inv.coverage },
  baseline: { version: 1, spec, fieldMeta }, plan: null,
};

const rows: Array<Record<string, unknown>> = [];
for (let i = 1; i <= n; i++) {
  const llm = mock ? mockDraftLlm() : anthropicProvider({ model, effort: (process.env.AGENT_LLM_EFFORT as never) ?? "medium" });
  const t0 = performance.now();
  const r = await runSpecDraft({ llm, input });
  const ms = Math.round(performance.now() - t0);
  const usage = r.state === "finished" ? r.result.usage : r.usage;
  const p = PRICE_PER_MTOK[model] ?? { input: 0, output: 0 };
  const usd = +((usage.input * p.input + usage.output * p.output) / 1e6).toFixed(4);
  rows.push({
    run: i, model, state: r.state, ms, steps: r.steps.length, inTok: usage.input, outTok: usage.output, usd,
    servedBy: r.state === "finished" ? r.result.model : "-",
    risksAi: r.state === "finished" ? r.result.risks.filter((x) => x.source === "ai").length : 0,
    rejected: r.state === "finished" ? r.result.rejectedChanges.length : 0,
    reason: r.state === "failed" ? r.reason : "",
  });
  console.log(JSON.stringify(rows.at(-1)));
}
const med = (k: string) => { const v = rows.map((r) => Number(r[k])).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
console.log(`\n${model} ×${n}: 성공 ${rows.filter((r) => r.state === "finished").length}/${n}, 중앙값 ${med("ms")}ms, 입력 ${med("inTok")} / 출력 ${med("outTok")} 토큰, $${med("usd")}/회`);
mkdirSync("scripts/bench-out", { recursive: true });
writeFileSync(`scripts/bench-out/${model}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify(rows, null, 2));

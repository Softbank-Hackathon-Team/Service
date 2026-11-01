// 점검·수정(remediate) 데모·실측: DB·큐 없이 에이전트 한 건을 끝까지 돌린다.
//   LLM:    AGENT_LLM=scripted(기본, 토큰 0) | real (ANTHROPIC_API_KEY 필요, AGENT_MODEL 기본 claude-sonnet-5-5)
//   샌드박스: SANDBOX_MODE=memory(기본) | k3d (kubectl proxy → SANDBOX_KUBE_URL, 기본 http://127.0.0.1:8001)
// 작업 복사본 = scripts/fixtures/oom-web.yaml (상한 128Mi 인데 200Mi 를 잡는 앱 → OOMKilled 재시작)
// 키 값은 읽지도 출력하지도 않는다. 결과는 한 줄 요약 JSON (+ scripts/remediate-out/*.json, 본문·키 없음)
// 사용: npx tsx --env-file=../../.env scripts/remediate-demo.ts [--runs N] [--keep] [--warmup 초]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  gateChanges, remediateLlmFromEnv, runAgent, sandboxFromEnv, PRICE_PER_MTOK, type Sandbox,
} from "@svc/agent";
import { DEMO_SCRIPT } from "../src/handle-agent-run.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const runs = Number(arg("--runs") ?? 1);
const keep = process.argv.includes("--keep");
const warmupSec = Number(arg("--warmup") ?? 45);
const fixture = readFileSync(new URL("./fixtures/oom-web.yaml", import.meta.url), "utf8");
const TASK = "web Deployment 이 계속 재시작한다. 샌드박스에서 원인을 찾고, deploy/ 아래 매니페스트를 최소한으로 고친 뒤 샌드박스에 적용해 60초 이상 안정적인지 확인하고 finish 로 제안하라.";

const choiceSbx = sandboxFromEnv();
const rows: Array<Record<string, unknown>> = [];
for (let i = 1; i <= runs; i++) {
  const choiceLlm = remediateLlmFromEnv(DEMO_SCRIPT); // 대본 LLM 은 실행마다 새로 (대본 위치가 처음부터)
  const repo = new Map([["deploy/web.yaml", fixture]]);
  const before = new Map(repo);
  const runId = `demo${Date.now().toString(36)}`;
  const t0 = performance.now();
  let sb: Sandbox | null = null;
  const row: Record<string, unknown> = { run: i, llm: choiceLlm.mode, model: choiceLlm.model, sandbox: choiceSbx.mode };
  try {
    sb = await choiceSbx.create({ tenantId: "dev-tenant", runId, seed: before });
    const t1 = performance.now();
    row.createMs = Math.round(t1 - t0);
    if ("namespace" in sb) console.log(`샌드박스 네임스페이스: ${(sb as { namespace: string }).namespace}`);
    // k3d: 씨앗 앱이 실제로 OOMKilled 로 한 번 이상 재시작할 때까지 기다린다 (문제 재현)
    if (choiceSbx.mode === "k3d") {
      const until = Date.now() + warmupSec * 1000;
      let restarts = 0;
      while (Date.now() < until) {
        const pods = (await sb.get("Pod", null)) as Array<{ containers: Array<{ restartCount: number }> }>;
        restarts = pods.flatMap((p) => p.containers).reduce((n, c) => n + c.restartCount, 0);
        if (restarts > 0) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      row.warmupRestarts = restarts;
    }
    const t2 = performance.now();
    row.warmupMs = Math.round(t2 - t1);
    const r = await runAgent({
      llm: choiceLlm.llm, sandbox: sb, repo, task: TASK,
      onStep: (s) => console.log(`  ${String(s.step).padStart(2)} ${s.ok ? "ok  " : "FAIL"} ${s.tool} ${s.note}`),
    });
    row.agentMs = Math.round(performance.now() - t2);
    const gate = r.finish?.outcome === "proposed" ? gateChanges(before, repo) : { ok: true, violations: [] as string[] };
    const price = PRICE_PER_MTOK[choiceLlm.model];
    Object.assign(row, {
      state: r.state, reason: r.reason, outcome: r.finish?.outcome ?? null, title: r.finish?.title ?? null,
      gateOk: gate.ok, violations: gate.violations, steps: r.steps.length, failedSteps: r.steps.filter((s) => !s.ok).length,
      changed: r.changedFiles, tokensIn: r.usage.input, tokensOut: r.usage.output,
      usdEst: price ? Number(((r.usage.input * price.input + r.usage.output * price.output) / 1e6).toFixed(4)) : 0,
      lastCheck: r.steps.filter((s) => s.tool === "run_check").at(-1)?.note ?? null,
    });
  } catch (e) {
    row.state = "failed";
    row.reason = (e as { code?: string }).code ?? (e as Error).constructor.name;
    row.message = String((e as Error).message).slice(0, 300);
  } finally {
    const t3 = performance.now();
    if (sb && !keep) await sb.dispose?.().catch((e: Error) => { row.disposeError = e.message; });
    row.disposeMs = Math.round(performance.now() - t3);
    row.totalMs = Math.round(performance.now() - t0);
  }
  console.log(`요약 ${JSON.stringify(row)}`);
  rows.push(row);
}
mkdirSync(new URL("./remediate-out/", import.meta.url), { recursive: true });
const file = new URL(`./remediate-out/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(rows, null, 2));
const ok = rows.filter((r) => r.state === "finished" && r.outcome === "proposed" && r.gateOk).length;
console.log(`끝: 제안+게이트 통과 ${ok}/${rows.length}${keep ? " (--keep: 네임스페이스 남김)" : ""}`);
process.exit(ok === rows.length ? 0 : 1);

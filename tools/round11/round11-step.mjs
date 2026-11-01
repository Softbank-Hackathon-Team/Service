// Z102 round 11: drive one migration step by step against the local API (smoke.ts has no pause between plan and approval,
// but M3/M4/M5 need imported.json placed after the id exists and before approval).
//   node round11-step.mjs create <sourceEnvId> <targetEnvId>      -> prints "ID <uuid>" and stops at awaiting_approval
//   node round11-step.mjs run <id>                                 -> approve + start, waits for completed (or failed/paused)
//   node round11-step.mjs rollback <id>                            -> POST rollback, waits for rolled_back
//   node round11-step.mjs security <id>                            -> POST security/check, prints the live summary counts
//   node round11-step.mjs ai <id> <spec_draft|remediate>           -> POST agent-review/run, waits for a result, prints llm state
//   node round11-step.mjs regression <id>                          -> GET security/regression (needs a security check first)
//   node round11-step.mjs inventory <envId>                        -> GET environments/:id/inventory (real CLI read)
//   node round11-step.mjs status <id>
// Evidence (Z104 ledger, Z62 77): at the end of each scene this calls `sh tools/evidence-mark.sh` by itself, pass or fail,
//   for the feature rows of that scene: defaults per command (ai spec_draft 7, ai remediate 34, security 27, regression 28,
//   inventory 4, rollback 22) plus any `--mark=15,17,20` given on the line (run/create). No hand recording.
//   R11_EVIDENCE_DIR (~/Softbank_final/measurements/int5-11/evidence), R11_ROUND (int5-11), R11_LOG (log path for the record).
//   If tools/evidence-mark.sh is missing it only warns; the scene result is unchanged.
// Env: API_PORT (3000), R11_TENANT (66666666-…), R11_TIMEOUT_MS (900000). Auth: x-dev-tenant, so the API must run with DEV_AUTH=1
// for this round only (or set R11_TOKEN to a Bearer token from the login server and it is used instead).
// No dependencies. Prints no secrets (the API never returns them).
const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
const TENANT = process.env.R11_TENANT ?? "66666666-6666-4666-8666-666666666666";
const LIMIT = Number(process.env.R11_TIMEOUT_MS ?? 900000);
const H = { "content-type": "application/json",
  ...(process.env.R11_TOKEN ? { authorization: `Bearer ${process.env.R11_TOKEN}` } : { "x-dev-tenant": TENANT }) };
const T0 = Date.now();
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
const argv = process.argv.slice(2);
const markArg = argv.find((x) => x.startsWith("--mark="));
const EXTRA = markArg ? markArg.slice(7).split(",").map((x) => x.trim()).filter(Boolean) : [];
const EVD = process.env.R11_EVIDENCE_DIR ?? `${process.env.HOME}/Softbank_final/measurements/int5-11/evidence`;
const ROUND = process.env.R11_ROUND ?? "int5-11";
let scene = { ids: [], cmd: "" };
function mark(result, note = "") {
  const ids = [...new Set([...scene.ids, ...EXTRA])];
  if (!ids.length) return;
  if (!existsSync("tools/evidence-mark.sh")) { console.log("evidence: tools/evidence-mark.sh missing (run from Service root) -> not recorded"); return; }
  const sec = String(Math.round((Date.now() - T0) / 1000));
  for (const id of ids) {
    try {
      execFileSync("sh", ["tools/evidence-mark.sh", EVD, id, result, ROUND, `round11-step ${scene.cmd}`, sec, process.env.R11_LOG ?? "-", note.slice(0, 200)], { stdio: "ignore" });
      console.log(`evidence: #${id} ${result}`);
    } catch (e) { console.log(`evidence: #${id} not recorded (${e.message.split("\n")[0]})`); }
  }
}
function stop(code, note) { mark("fail", note); process.exit(code); }
const stamp = () => `+${String(Date.now() - T0).padStart(7)} ms`;

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: H,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (res.status >= 400) { console.log(method, path, res.status, JSON.stringify(json).slice(0, 500)); stop(1, `${method} ${path} ${res.status} ${json.code ?? ""}`); }
  return json;
}

let last = "";
async function waitFor(id, targets, stopOn = ["failed", "cancelled", "rolled_back", "paused"]) {
  for (;;) {
    const m = await call("GET", `/migrations/${id}`);
    if (m.status !== last) { console.log(`${stamp()}  status=${m.status}${m.failureCode ? ` code=${m.failureCode}` : ""}`); last = m.status; }
    if (targets.includes(m.status)) return m;
    if (stopOn.includes(m.status) || Date.now() - T0 > LIMIT) { console.log("stopped at", m.status, m.failureCode ?? "", m.reason ?? ""); stop(1, `stopped at ${m.status} ${m.failureCode ?? ""}`); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const [cmd, a, b] = argv.filter((x) => !x.startsWith("--"));
scene.cmd = [cmd, a, b].filter(Boolean).join(" ");
if (cmd === "create") {
  const { id } = await call("POST", "/migrations", { sourceEnvId: a, targetEnvId: b });
  console.log(`ID ${id}`);
  await waitFor(id, ["spec_review"]);
  await call("POST", `/migrations/${id}/plan`);
  await waitFor(id, ["awaiting_approval"]);
  console.log(`ready for approval: ${id} (place imported.json now if this step needs it)`);
  if (EXTRA.length) mark("pass", "create → awaiting_approval");
} else if (cmd === "run") {
  const plan = await call("GET", `/migrations/${a}/plan`);
  await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash });
  await waitFor(a, ["approved"]);
  await call("POST", `/migrations/${a}/start`);
  await waitFor(a, ["completed"]);
  console.log(`completed after ${Date.now() - T0} ms`);
  mark("pass", `completed ${Date.now() - T0} ms`);
} else if (cmd === "rollback") {
  scene.ids = ["22"];
  await call("POST", `/migrations/${a}/rollback`);
  await waitFor(a, ["rolled_back"], ["failed", "cancelled"]);
  console.log(`rolled_back after ${Date.now() - T0} ms`);
  mark("pass", `rolled_back ${Date.now() - T0} ms`);
} else if (cmd === "security") {
  scene.ids = ["27"];
  const r = await call("POST", `/migrations/${a}/security/check`);
  const rows = JSON.stringify(r);
  const count = (s) => (rows.match(new RegExp(`"status":"${s}"`, "g")) ?? []).length;
  const line = `security live: pass ${count("pass")} warn ${count("warn")} fail ${count("fail")} unavailable ${count("unavailable")} n_a ${count("n_a")}`;
  console.log(line);
  mark(count("pass") + count("warn") + count("fail") >= 8 ? "pass" : "fail", line);
} else if (cmd === "regression") {
  scene.ids = ["28"];
  const r = await call("GET", `/migrations/${a}/security/regression`);
  const s = JSON.stringify(r);
  const unavailable = (s.match(/"status":"unavailable"/g) ?? []).length;
  const other = (s.match(/"status":"(?!unavailable)[a-z_]+"/g) ?? []).length;
  console.log(`regression: statuses other ${other} unavailable ${unavailable}`); console.log(s.slice(0, 600));
  mark(other > 0 ? "pass" : "fail", `other ${other} unavailable ${unavailable}`);
} else if (cmd === "inventory") {
  scene.ids = ["4"];
  const r = await call("GET", `/environments/${a}/inventory`);
  console.log(`inventory: status ${r.status} source ${r.source}`); console.log(JSON.stringify(r).slice(0, 600));
  mark(r.status === "ok" || r.status === "partial" ? "pass" : "fail", `status ${r.status} source ${r.source}`);
} else if (cmd === "ai") {
  scene.ids = [(b ?? "remediate") === "spec_draft" ? "7" : "34"];
  const { runId } = await call("POST", `/migrations/${a}/agent-review/run`, { kind: b ?? "remediate" });
  console.log(`run ${runId}`);
  for (;;) {
    const r = await call("GET", `/migrations/${a}/agent-review`);
    const s = JSON.stringify(r);
    if (new RegExp(`"runId":"${runId}","status":"(finished|failed)"`).test(s) || Date.now() - T0 > LIMIT) {
      console.log(`${stamp()} llm=${JSON.stringify(r.llm ?? null)}`); console.log(s.slice(0, 800));
      const ok = new RegExp(`"runId":"${runId}","status":"finished"`).test(s) && r.llm?.state === "ready";
      mark(ok ? "pass" : "fail", `llm ${r.llm?.state ?? "?"} ${r.llm?.model ?? ""}`); break;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
} else if (cmd === "status") {
  const m = await call("GET", `/migrations/${a}`);
  console.log(m.status, m.failureCode ?? "");
} else {
  console.log("usage: create <src> <dst> | run <id> | rollback <id> | security <id> | regression <id> | ai <id> <kind> | inventory <envId> | status <id>  [--mark=ids]"); process.exit(2);
}

// 역방향(온프레 → AWS) 이전을 로컬 api·worker 의 실제 상태 머신으로 끝까지 돌린다. ADR-031 R5
//   사용법: sh tools/reverse-lab/lab.sh e2e rollback   (롤백 창에 클라우드에 시험 행 → 온프레로 돌아오는지 → 롤백)
//           sh tools/reverse-lab/lab.sh e2e complete   (롤백 창을 그대로 지나 정리까지)
//   전제: lab.sh up (실험장), lab.sh platform (api :3100 + worker, platform.env 덮어쓰기)
//   출발 = 개발 회사의 온프레 환경(5555…, 시드), 도착 = AWS 환경(2222…, 시드). 클라우드 호출은 흉내, DB 복제만 진짜다
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { collectHeartbeat, sendAgentReport } from "@svc/agent";
import { smokeConfirmReview, smokePlanBodies } from "../smoke-env.js";

const MODE = process.argv[2] ?? "rollback";
if (!["rollback", "complete"].includes(MODE)) { console.error("사용법: e2e.ts rollback|complete"); process.exit(2); }
const API = `http://localhost:${process.env.LAB_API_PORT ?? 3100}/api/v1`;
// 출발 = 실험장 전용 온프레 환경 (없으면 만든다). 시드 온프레(5555…)는 하트비트가 없어 disconnected 가 되면 되살릴 길이 없다 (agent-reports.ts:56)
const LAB_ENV_NAME = "reverse-lab-onprem";
const TARGET_ENV = process.env.LAB_TARGET_ENV_ID ?? "22222222-2222-4222-8222-222222222222";   // aws
const TENANT = "11111111-1111-4111-8111-111111111111";
// 실험장 전용 고정 비밀번호 (init/*.sql). 시험 행 넣기·확인에만 쓴다
const ONPREM = "postgres://svc_migrate:lab-svc-migrate@127.0.0.1:56432/shop";
const CLOUD = "postgres://app:lab-cloud-admin@127.0.0.1:56433/shop";
const LIMIT_MS = Number(process.env.LAB_TIMEOUT_MS ?? 240_000);
const T0 = Date.now();
const H = { "content-type": "application/json", "x-dev-tenant": TENANT };

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: H,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status >= 400) { console.log(method, path, res.status, JSON.stringify(json)); process.exit(1); }
  return json;
}
async function q<T extends pg.QueryResultRow>(url: string, sql: string, args: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 }); await c.connect();
  try { return (await c.query<T>(sql, args)).rows; } finally { await c.end(); }
}
const count = async (url: string, where: string) => Number((await q<{ n: string }>(url, `SELECT count(*) n FROM orders WHERE ${where}`))[0]!.n);
const ms = () => `+${String(Date.now() - T0).padStart(6)} ms`;

let id = "", last = "";
const STOP = ["failed", "cancelled", "rolled_back", "paused"];
async function waitFor(...targets: string[]): Promise<string> {
  for (;;) {
    const m = await call("GET", `/migrations/${id}`) as { status: string; failureCode?: string; pausedFrom?: string };
    if (m.status !== last) { console.log(`${ms()}  status=${m.status}${m.failureCode ? ` (${m.failureCode})` : ""}`); last = m.status; }
    if (targets.includes(m.status)) return m.status;
    if (STOP.includes(m.status) || Date.now() - T0 > LIMIT_MS) {
      console.log(`멈춤: ${m.status}${m.pausedFrom ? ` (from ${m.pausedFrom})` : ""}. worker 로그: tools/reverse-lab/.state/worker.log`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function leftovers(url: string) {
  const [r] = await q<{ s: string; p: string; u: string; o: string }>(url, `SELECT (SELECT count(*) FROM pg_replication_slots) s,
    (SELECT count(*) FROM pg_publication) p, (SELECT count(*) FROM pg_subscription) u, (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'repl\\_%\\_u') o`);
  return `slots=${r!.s} pubs=${r!.p} subs=${r!.u} repl_users=${r!.o}`;
}

// 실험장 Agent: 실제 Agent 와 같은 서명 하트비트를 보낸다. 다른 점은 클러스터가 없어 kubectl 대신 고정 답을 쓰는 것뿐
const KEY_FILE = "tools/reverse-lab/.state/agent-key.env";
async function labAgent(envId: string): Promise<() => void> {
  const stamp = `${KEY_FILE}.env-id`;
  if (!existsSync(KEY_FILE) || (existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "") !== envId) {
    // 키 발급은 사람이 맥에서 하는 기존 도구 그대로 (DB 에는 키 번호만, 비밀은 파일 600 에만)
    execFileSync("node", ["--env-file=.env", "--env-file=tools/reverse-lab/platform.env", "--import", "tsx", "tools/agent-key.ts",
      "issue", "--env", envId, "--tenant", TENANT, "--out", KEY_FILE], { stdio: "ignore" });
    execFileSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", envId, stamp]);
  }
  const kv = Object.fromEntries(readFileSync(KEY_FILE, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const kubectl = async (a: string[]) => { if (a[0] === "version") return JSON.stringify({ serverVersion: { gitVersion: "v1.30.0+reverse-lab" } }); throw new Error("no cluster"); };
  const beat = async () => {
    const r = await sendAgentReport(await collectHeartbeat({ kubectl, agentVersion: "reverse-lab-agent/0.1", namespace: "app" }),
      { baseUrl: `http://localhost:${process.env.LAB_API_PORT ?? 3100}`, keyId: kv.AGENT_KEY_ID!, secret: kv.AGENT_KEY_SECRET! });
    if (!r.ok) console.log(`Agent 하트비트 실패 ${r.status} ${JSON.stringify(r.body)}`);
  };
  await beat();
  const t = setInterval(() => { beat().catch(() => undefined); }, 15_000);
  return () => clearInterval(t);
}

const envs = (await call("GET", "/environments") as { items: { id: string; name: string; connectionStatus: string }[] }).items;
let lab = envs.find((e) => e.name === LAB_ENV_NAME);
if (!lab) lab = await call("POST", "/environments", { provider: "onprem", name: LAB_ENV_NAME }) as unknown as { id: string; name: string; connectionStatus: string };
const SOURCE_ENV = lab.id;
const stopAgent = await labAgent(SOURCE_ENV);
const st = (await call("GET", "/environments") as { items: { id: string; connectionStatus: string }[] }).items.find((e) => e.id === SOURCE_ENV)?.connectionStatus;
console.log(`실험장 온프레 환경 ${SOURCE_ENV.slice(0, 8)} 연결 상태=${st}`);
const created = await call("POST", "/migrations", { sourceEnvId: SOURCE_ENV, targetEnvId: TARGET_ENV }) as { id: string };
id = created.id;
console.log(`이전 ${id} (온프레 ${SOURCE_ENV.slice(0, 8)} → AWS ${TARGET_ENV.slice(0, 8)}, ${MODE})`);
await waitFor("spec_review");
await smokeConfirmReview(call, id);
await call("POST", `/migrations/${id}/plan`);
await waitFor("awaiting_approval");
const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string; acknowledgements?: { id: string }[] };
const bodies = smokePlanBodies(plan);
await call("POST", `/plans/${plan.planId}/approvals`, bodies.approve);
await waitFor("approved");
await call("POST", `/migrations/${id}/start`, bodies.start);
const at = await waitFor("rollback_window", "completed");
console.log(`${ms()}  클라우드 orders=${await count(CLOUD, "true")}, 온프레 orders=${await count(ONPREM, "true")}`);

if (MODE === "rollback") {
  if (at !== "rollback_window") { console.log("롤백 창을 놓쳤다 (ROLLBACK_WINDOW_SEC 를 늘린다)"); process.exit(1); }
  const probe = `lab-probe-${Date.now()}`;
  await q(CLOUD, `INSERT INTO orders(customer_id, item, amount) VALUES (1, $1, 1)`, [probe]);
  let back = 0;
  for (let i = 0; i < 50 && !back; i++) { await new Promise((r) => setTimeout(r, 200)); back = await count(ONPREM, `item = '${probe}'`); }
  console.log(`${ms()}  롤백 창 시험 행 ${probe}: 온프레 도착 ${back ? "OK" : "실패"}`);
  await call("POST", `/migrations/${id}/rollback`, { reason: "reverse-lab e2e" });
  await waitFor("rolled_back");
  const appWrites = await q(ONPREM.replace("svc_migrate:lab-svc-migrate", "shop_app:lab-shop-app"),
    `INSERT INTO orders(customer_id, item, amount) VALUES (1, 'after-rollback', 1)`).then(() => true, () => false);
  console.log(`${ms()}  롤백 뒤 온프레 앱 쓰기 ${appWrites ? "OK" : "실패"}, 시험 행 온프레에 ${back ? "있음" : "없음"}`);
  if (!back || !appWrites) process.exitCode = 1;
} else if (at !== "completed") {
  await waitFor("completed");
}
console.log(`${ms()}  잔여물 온프레 ${await leftovers(ONPREM)} / 클라우드 ${await leftovers(CLOUD)}`);
console.log(`${ms()}  끝 (${MODE}). 다음 판 전에: sh tools/reverse-lab/lab.sh reset`);
stopAgent();

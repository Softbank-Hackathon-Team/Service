// REALRUN 5단계: 가져오기에서 만든 이전(migration-id.txt)을 승인 → 시작 → 완료 직전(rollback_window)까지 지켜보고 롤백 1회.
// 상태: AI 초안. API 만 부른다(클라우드 직접 호출 없음). 진짜 apply 는 워커(맥)가 한다.
// 사용: npx tsx real/real-flow.ts <산출물 폴더>   환경: API_PORT(3000) RF_TIMEOUT_MS(2400000) DEMO_USER_EMAIL·DEMO_USER_PASSWORD(없고 DEV_AUTH=1 이면 회사 헤더)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "";
if (!out) { console.error("사용: real-flow.ts <산출물 폴더>"); process.exit(2); }
const id = readFileSync(join(out, "migration-id.txt"), "utf8").trim();
const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
const LIMIT = Number(process.env.RF_TIMEOUT_MS ?? 2400000);
const T0 = Date.now();
// AUTHSMOKE: demo-day 의 API 는 DEV_AUTH 없이 뜬다(x-dev-tenant 는 시험 전용) → 데모 계정 로그인. 비밀번호 찾는 순서는 smoke·env:connect 와 같다
//   (환경변수 → .env 의 DEMO_USER_PASSWORD → auth:seed 가 쓴 .secrets/demo-login.txt). 접근 토큰 15분 → 401 이면 한 번 다시 로그인
const H: Record<string, string> = { "content-type": "application/json" };
const readOr = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const PW = process.env.DEMO_USER_PASSWORD?.trim()
  || readOr(".env").split("\n").filter((l) => l.startsWith("DEMO_USER_PASSWORD=")).pop()?.slice(19).trim().replace(/^["']|["']$/g, "")
  || readOr(".secrets/demo-login.txt").match(/password\s*[:=]\s*(\S+)/i)?.[1];
async function login(): Promise<boolean> {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.DEMO_USER_EMAIL?.trim() || "demo@dev-company.test", password: PW }) });
  if (!r.ok) { console.log(`FAIL 로그인 ${r.status} (npm run auth:seed 로 데모 계정 비밀번호를 넣었는지)`); return false; }
  H.authorization = `Bearer ${((await r.json()) as { accessToken: string }).accessToken}`;
  return true;
}
const LOGGED_IN = PW ? await login() : false;
if (PW && !LOGGED_IN) process.exit(1);
if (!LOGGED_IN) H["x-dev-tenant"] = process.env.MI_TENANT || "11111111-1111-4111-8111-111111111111";

async function call(method: string, path: string, body?: unknown) {
  const send = () => fetch(`${API}${path}`, { method, headers: H, body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  let res = await send();
  if (res.status === 401 && LOGGED_IN && await login()) res = await send();
  const json = await res.json().catch(() => ({})) as Record<string, any>;
  if (res.status >= 400) { console.log(`FAIL ${method} ${path} ${res.status} ${JSON.stringify(json).slice(0, 400)}`); process.exit(1); }
  return json;
}
const seen: string[] = [];
async function waitFor(targets: string[]) {
  for (;;) {
    const m = await call("GET", `/migrations/${id}`) as { status: string; failureCode?: string };
    if (seen[seen.length - 1] !== m.status) { seen.push(m.status); console.log(`STATUS +${Math.round((Date.now() - T0) / 1000)}s ${m.status}`); }
    if (targets.includes(m.status)) return m.status;
    if (["failed", "cancelled", "rolled_back", "completed"].includes(m.status) || Date.now() - T0 > LIMIT) {
      writeFileSync(join(out, "flow-stopped.json"), JSON.stringify(m, null, 2) + "\n");
      console.log(`FAIL 멈춤 ${m.status} ${m.failureCode ?? ""}`); process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string; acknowledgements?: { id: string }[] };
console.log(`PLAN ${plan.planId} hash ${plan.planHash.slice(0, 12)}`);
await call("POST", `/plans/${plan.planId}/approvals`, { decision: "approve", planHash: plan.planHash, ...(plan.acknowledgements?.length ? { acks: plan.acknowledgements.map((a) => a.id) } : {}) });
await waitFor(["approved"]);
await call("POST", `/migrations/${id}/start`, { planHash: plan.planHash });
// 자원 생성(provisioning, 진짜 terraform) → 배포 → 복제 → 트래픽 10→50→100(shifting) → cutover → rollback_window
await waitFor(["rollback_window"]);
console.log("CUTOVER 끝, rollback_window 도착");
writeFileSync(join(out, "traffic-shift.json"), JSON.stringify(await call("GET", `/migrations/${id}/traffic-shift`).catch(() => ({})), null, 2) + "\n");
await call("POST", `/migrations/${id}/rollback`, { reason: "REALRUN 롤백 1회 확인" });
await waitFor(["rolled_back"]).catch(() => undefined); // rolled_back 은 waitFor 안에서 FAIL 처리되므로 아래서 다시 확인
// rolled_back 은 waitFor 가 FAIL 로 보므로 마지막 상태를 직접 확인
const fin = await call("GET", `/migrations/${id}`) as { status: string };
console.log(`FINAL ${fin.status}`);
writeFileSync(join(out, "timeline.json"), JSON.stringify(await call("GET", `/migrations/${id}/timeline`).catch(() => ({})), null, 2) + "\n");
console.log(fin.status === "rolled_back" ? "OK" : "FAIL 롤백이 끝나지 않음");
process.exit(fin.status === "rolled_back" ? 0 : 1);

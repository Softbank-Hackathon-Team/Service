// 입력층 L2: 화면 전에 맥에서 고객 환경을 연결해 보는 도구 (API 를 부르기만 한다. 클라우드 자원은 안 만든다)
//   npm run env:connect -- create --provider aws --name src-aws --cluster <EKS 이름> [--region ap-northeast-2]
//     → 환경을 만들고 연결 링크(CloudFormation 빠른 생성 주소)를 찍는다
//   npm run env:connect -- link --env <환경 번호>                       → 링크 다시 받기 (24시간 안이면 같은 확인 문구)
//   npm run env:connect -- verify --env <환경 번호> --account <12자리>   → 확인 요청 후 상태를 2초마다 30초 찍는다
// 로그인: .env 의 DEMO_USER_EMAIL·DEMO_USER_PASSWORD (npm run auth:seed 계정). 비밀번호가 없고 DEV_AUTH=1 이면 개발용 회사 헤더
// 확인 문구(ExternalId)는 비밀이 아니지만 화면 밖 기록을 줄이려고 앞 4자만 찍는다 (링크 주소 안에는 그대로 있다)
import { readFileSync } from "node:fs";

const API = (process.env.API_URL?.trim() || `http://localhost:${process.env.API_PORT ?? 3000}`) + "/api/v1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) { console.error(`--${name} 이 필요하다`); process.exit(2); }
  return v;
}

function demoPassword(): string | undefined {
  const p = process.env.DEMO_USER_PASSWORD?.trim();
  if (p) return p;
  try { return readFileSync(".secrets/demo-login.txt", "utf8").match(/password\s*[:=]\s*(\S+)/i)?.[1]; } catch { return undefined; }
}

async function headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const password = demoPassword();
  if (password) {
    const email = process.env.DEMO_USER_EMAIL?.trim() || "demo@dev-company.test";
    const res = await fetch(`${API}/auth/login`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) });
    if (!res.ok) { console.error("로그인 실패", res.status); process.exit(1); }
    h.authorization = `Bearer ${((await res.json()) as { accessToken: string }).accessToken}`;
    return h;
  }
  if (process.env.DEV_AUTH === "1") {
    h["x-dev-tenant"] = process.env.SMOKE_TENANT_ID?.trim() || "11111111-1111-4111-8111-111111111111";
    return h;
  }
  console.error("DEMO_USER_PASSWORD 가 없다 (npm run auth:seed 먼저, 또는 시험에서만 DEV_AUTH=1)");
  process.exit(2);
}

async function call(h: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: h,
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
  const json = res.status === 204 ? {} : await res.json() as Record<string, unknown>;
  if (res.status >= 400) { console.error(method, path, res.status, json); process.exit(1); }
  return json;
}

function printLink(l: Record<string, unknown>) {
  console.log(`링크 종류  ${l.kind}`);
  console.log(`만료       ${l.expiresAt}`);
  if (typeof l.externalId === "string") console.log(`확인 문구  ${l.externalId.slice(0, 4)}… (앞 4자)`);
  if (l.url) console.log(`\n아래 주소를 고객 AWS 콘솔에서 열고 IAM 확인 체크 → 스택 만들기:\n${l.url}\n`);
  if (l.command) console.log(`\n명령:\n${l.command}\n`);
}

const cmd = process.argv[2];
const h = await headers();
if (cmd === "create") {
  const body = { provider: need("provider"), name: need("name"),
    ...(arg("region") ? { region: arg("region") } : {}), ...(arg("cluster") ? { clusterName: arg("cluster") } : {}) };
  const env = await call(h, "POST", "/environments", body);
  console.log(`환경 만듦  ${env.id} (${env.provider}, ${env.name})`);
  printLink(await call(h, "POST", `/environments/${env.id}/connection-link`));
  console.log(`스택이 다 만들어지면: npm run env:connect -- verify --env ${env.id} --account <12자리>`);
} else if (cmd === "link") {
  printLink(await call(h, "POST", `/environments/${need("env")}/connection-link`));
} else if (cmd === "verify") {
  const id = need("env");
  const r = await call(h, "POST", `/environments/${id}/verify`, { accountId: need("account") });
  console.log(`확인 요청  queued=${r.queued}`);
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < 30_000) {
    const list = await call(h, "GET", "/environments") as { items: Array<Record<string, unknown>> };
    const e = list.items.find((x) => x.id === id);
    const line = `${e?.connectionStatus}${e?.failureReason ? ` (${e.failureReason})` : ""}`;
    if (line !== last) { console.log(`+${String(Date.now() - t0).padStart(6)} ms  ${line}`); last = line; }
    if (e && ["connected", "failed", "disconnected"].includes(String(e.connectionStatus))) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
} else {
  console.error("사용: npm run env:connect -- create|link|verify ...");
  process.exit(2);
}

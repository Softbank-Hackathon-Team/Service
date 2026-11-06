// 입력층 L2: 화면 전에 맥에서 고객 환경을 연결해 보는 도구 (API 를 부르기만 한다. 클라우드 자원은 안 만든다)
//   npm run env:connect -- create --provider aws --name src-aws --cluster <EKS 이름> [--region ap-northeast-2]
//     → 환경을 만들고 연결 링크(CloudFormation 빠른 생성 주소)를 찍는다
//   npm run env:connect -- link --env <환경 번호>                       → 링크 다시 받기 (24시간 안이면 같은 확인 문구)
//   npm run env:connect -- verify --env <환경 번호> --account <12자리>   → 확인 요청 후 상태를 2초마다 VERIFY_WAIT_SEC(기본 120초)까지 찍는다
//     끝 줄 "연결 확인 결과  <상태>", rc 0 = connected · 1 = failed 등 · 5 = 아직 verifying. GCP 결정 3번 A안: --target-project <이전 전용 프로젝트> (원래 프로젝트 = --account)
//   npm run env:connect -- access-check --cluster <EKS> [--region r] [--fix] [--role-suffix -<8자>]   → 접근 항목이 옛 역할에 묶였는지 (FM-CON-09)
//     --role-suffix: 한 계정에 환경 여럿일 때 그 환경 역할 이름 꼬리 (연결 링크의 param_RoleSuffix). 없으면 옛 이름 svc-observe 등
//   npm run env:connect -- whoami                                       → "회사  <회사 번호>" (CON-01 GCP 회사 SA 만들 때)
//     끝 줄 "연결 확인 결과  <상태>", rc 0 = connected · 1 = failed 등 · 5 = 아직 verifying
// 로그인: .env 의 DEMO_USER_EMAIL·DEMO_USER_PASSWORD (npm run auth:seed 계정). 비밀번호가 없고 DEV_AUTH=1 이면 개발용 회사 헤더
// 확인 문구(ExternalId)는 비밀이 아니지만 화면 밖 기록을 줄이려고 앞 4자만 찍는다 (링크 주소 안에는 그대로 있다)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { awsRoleName, type ConnectionFailure } from "@svc/contracts";

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

// PF03 FM-NET: API 가 잠깐 안 받거나(재시작·끊김) 5xx·429 면 1·2·4초 뒤 다시 (최대 4번). POST 는 같은 Idempotency-Key 로 보내
//   서버가 같은 요청을 두 번 처리하지 않게 한다 (예: verify 요청이 두 번 들어가 작업이 둘 생기는 것 방지). 4xx 는 바로 끝
let seq = 0;
const RUN_ID = `envc-${Date.now().toString(36)}-${process.pid}`;
async function call(h: Record<string, string>, method: string, path: string, body?: unknown) {
  const headers = method === "POST" ? { ...h, "idempotency-key": `${RUN_ID}-${++seq}` } : h;
  let res: Response | undefined;
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    try {
      res = await fetch(`${API}${path}`, { method, headers, signal: AbortSignal.timeout(30_000),
        body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body) });
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { lastErr = e; res = undefined; }
  }
  if (!res) { console.error(method, path, "API 에 못 붙음:", (lastErr as Error)?.message ?? lastErr); process.exit(1); }
  const json = res.status === 204 ? {} : await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status >= 400) { console.error(method, path, res.status, json); process.exit(1); }
  return json;
}

// F17: 지금 맥 AWS 자격의 계정에 platform-app-boundary 정책이 이미 있으면 링크에 "만들지 마"(CreateBoundaryPolicy=false)를 넣게 알린다.
//   데모 한 계정에서는 도착 환경 모듈(up)이 같은 이름 정책을 먼저 만들어 스택이 NAME_CONFLICT_VALIDATION 으로 되돌아갔다 (11/3 실세션 2회차).
//   읽기 명령 2개(sts get-caller-identity, iam get-policy)만 부른다. aws CLI 가 없거나 실패하면 묻지 않은 것으로 (서버가 계정 비교로 한 번 더 본다)
//   끄기: CONNECT_BOUNDARY_CHECK=0
function boundaryPolicyExists(run: (args: string[]) => string = (a) =>
  execFileSync("aws", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })): boolean {
  if (process.env.CONNECT_BOUNDARY_CHECK === "0") return false;
  try {
    const acct = run(["sts", "get-caller-identity", "--query", "Account", "--output", "text"]).trim();
    if (!/^\d{12}$/.test(acct)) return false;
    run(["iam", "get-policy", "--policy-arn", `arn:aws:iam::${acct}:policy/platform-app-boundary`, "--query", "Policy.Arn", "--output", "text"]);
    return true;
  } catch { return false; }
}
const linkPath = (envId: string, provider: string) =>
  `/environments/${envId}/connection-link${provider === "aws" && boundaryPolicyExists() ? "?boundaryPolicyExists=true" : ""}`;

// FM-CON-03: infra 기준 명령 → 레포 루트 기준 (ROLE_DIR 을 빼면 스크립트가 옆 폴더 permissions 를 잡는다)
const gcpRootCommand = (c: string) => c.replace(/ ROLE_DIR=\.\/permissions/, "").replace("bash onboarding/gcp-connect.sh", "bash infra/onboarding/gcp-connect.sh");
// PF01 FM-CON-05: 연결 스택은 환경마다 이름이 다르지만(svc-connect-<환경 8자>) 옛 링크는 역할 이름이 고정(svc-observe·svc-operate)이라,
//   지난 회차 스택이 남아 있으면 새 스택이 AlreadyExists 로 되돌아간다. 읽기 명령 하나로 svc-observe 를 가진 스택을 찾아 알린다.
//   한 계정에 환경 여럿 (0056): 새 링크는 param_RoleSuffix(-<환경 8자>)가 있어 역할이 svc-observe-<8자> → 그 이름을 가진 스택만 본다
//   (다른 환경 스택의 svc-observe 는 부딪히지 않으니 충돌이 아니다)
//   지우지는 않는다 (고객 계정 변경 = 사람 확인). 출력 줄은 real-session 이 읽을 수 있게 고정 모양
//   "연결 스택 이미 있음  <이름> <상태> 이 환경 것"  → 새로 만들지 말고 verify 로
//   "연결 스택 충돌  <이름> <상태>"                 → 지난 스택. 지운 뒤 다시 (종료 코드 3)
//   끄기: CONNECT_STACK_CHECK=0. aws CLI 가 없거나 못 읽으면 조용히 넘어감 (권한 없음 = 확인 못 함)
function stackCheck(url: string, run: (args: string[]) => string = (a) =>
  execFileSync("aws", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })) {
  if (process.env.CONNECT_STACK_CHECK === "0") return;
  const hq = new URLSearchParams(new URL(url).hash.split("?")[1] ?? "");
  const want = hq.get("stackName") ?? "";
  const observeRole = awsRoleName("svc-observe", hq.get("param_RoleSuffix"));
  const region = new URL(url).searchParams.get("region") ?? undefined;
  let owner = "";
  try {
    owner = run(["cloudformation", "describe-stack-resources", "--physical-resource-id", observeRole,
      "--query", "StackResources[0].StackName", "--output", "text", ...(region ? ["--region", region] : [])]).trim();
  } catch { return; }   // 없음(ValidationError)·권한 없음
  if (!owner || owner === "None") return;
  let status = "?";
  try { status = run(["cloudformation", "describe-stacks", "--stack-name", owner, "--query", "Stacks[0].StackStatus", "--output", "text", ...(region ? ["--region", region] : [])]).trim(); } catch { /* 상태 모름 */ }
  if (owner === want) { console.log(`연결 스택 이미 있음  ${owner} ${status} 이 환경 것 → 새로 만들지 말고 verify`); return; }
  console.error(`연결 스택 충돌  ${owner} ${status}`);
  console.error(`  지난 연결 스택이 같은 역할 이름(${observeRole})을 쥐고 있어 새 스택(${want})은 AlreadyExists 로 실패한다.`);
  console.error(`  사람이 확인한 뒤: aws cloudformation delete-stack --stack-name ${owner}${region ? ` --region ${region}` : ""} → 지워지면 다시 실행`);
  process.exit(3);
}

// PF07 (운영자 실수): 이어 쓴 환경은 처음 넣은 지역·클러스터 그대로다 (바꾸는 API 없음). 이번에 다른 값을 줬으면
//   링크가 엉뚱한 리전·클러스터를 가리킨다 → 링크 주소와 비교해 다르면 멈춘다. 링크 주소 모양은 connect/link.ts awsQuickCreateUrl
function reuseMismatch(url: string, want: { region?: string; cluster?: string }): string[] {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const out: string[] = [];
  const region = u.searchParams.get("region");
  const cluster = new URLSearchParams(u.hash.split("?")[1] ?? "").get("param_EksClusterName");
  if (want.region && region && want.region.trim() !== region) out.push(`지역 ${region} (이번 입력 ${want.region})`);
  if (want.cluster && cluster !== null && want.cluster.trim() !== cluster) out.push(`클러스터 ${cluster} (이번 입력 ${want.cluster})`);
  return out;
}
function reuseCheck(url: string) {
  const diff = reuseMismatch(url, { region: arg("region"), cluster: arg("cluster") });
  if (!diff.length) return;
  console.error(`이어 쓴 환경 값이 이번 입력과 다름  ${diff.join(", ")}`);
  console.error("  이어 쓴 환경은 처음 만든 값 그대로다. 새 값으로 하려면 다른 --name 으로 만들 것 (위 링크는 쓰지 말 것)");
  process.exit(4);
}

// FM-CON-09 (실측): EKS 접근 항목은 만들 때의 IAM 역할(고유 번호)에 묶인다. 연결 스택을 지우고 같은 이름으로 다시 만들면
//   역할 ARN 은 같아도 새 역할이라 옛 접근 항목으로는 401 (Unauthorized). 접근 항목 만든 시각 < 역할 만든 시각 이면 옛 것
//   fix=true 면 지우고 같은 모양으로 다시 만든다 (관찰 = 보기 정책 클러스터 범위, 실행·배포 = k8s 그룹). 고객 쪽 자격(지금 aws)으로 부른다
//   돌려주는 값 = 다시 만든 개수. 끄기: CONNECT_ACCESS_ENTRY_FIX=0 (보기만)
const ACCESS_ENTRY_SHAPE: Record<string, { group?: string; viewPolicy?: boolean }> = {
  "svc-observe": { viewPolicy: true }, "svc-operate": { group: "platform:operate" }, "svc-deploy": { group: "platform:deploy" },
};
function accessEntryCheck(cluster: string, region: string, fix: boolean, suffix: string | undefined = arg("role-suffix"), run: (args: string[]) => string = (a) =>
  execFileSync("aws", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })): number {
  const r = ["--region", region, "--output", "text"];
  let acct: string;
  try { acct = run(["sts", "get-caller-identity", "--query", "Account", "--output", "text"]).trim(); } catch { console.log("접근 항목 확인 못 함 (aws 자격 없음)"); return 0; }
  let fixed = 0;
  for (const [base, shape] of Object.entries(ACCESS_ENTRY_SHAPE)) {
    const role = awsRoleName(base, suffix);
    const arn = `arn:aws:iam::${acct}:role/${role}`;
    let roleAt: number, entryAt: number;
    try { roleAt = Date.parse(run(["iam", "get-role", "--role-name", role, "--query", "Role.CreateDate", "--output", "text"]).trim()); } catch { continue; }   // 역할 없음(배포 역할은 선택)
    try { entryAt = Date.parse(run(["eks", "describe-access-entry", "--cluster-name", cluster, "--principal-arn", arn, "--query", "accessEntry.createdAt", ...r]).trim()); }
    catch { console.log(`접근 항목 없음  ${role} (클러스터 ${cluster})`); continue; }
    if (!(Number.isFinite(roleAt) && Number.isFinite(entryAt)) || entryAt >= roleAt) { console.log(`접근 항목 정상  ${role}`); continue; }
    console.log(`접근 항목 옛 역할에 묶임  ${role} (항목 ${new Date(entryAt).toISOString()} < 역할 ${new Date(roleAt).toISOString()})`);
    if (!fix) { console.log(`  고치기: aws eks delete-access-entry --cluster-name ${cluster} --principal-arn <${role} ARN> 뒤 연결 스택 업데이트(또는 이 도구를 CONNECT_ACCESS_ENTRY_FIX=1 로)`); continue; }
    try {
      run(["eks", "delete-access-entry", "--cluster-name", cluster, "--principal-arn", arn, ...r]);
      run(["eks", "create-access-entry", "--cluster-name", cluster, "--principal-arn", arn, "--type", "STANDARD",
        ...(shape.group ? ["--kubernetes-groups", shape.group] : []), ...r]);
      if (shape.viewPolicy) run(["eks", "associate-access-policy", "--cluster-name", cluster, "--principal-arn", arn,
        "--policy-arn", "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy", "--access-scope", "type=cluster", ...r]);
      console.log(`  다시 만듦  ${role}`); fixed++;
    } catch (err) { console.log(`  다시 만들기 실패  ${role}: ${String((err as Error).message).split("\n")[0]?.replace(/\d{12}/g, "************").slice(0, 200)}`); }
  }
  return fixed;
}

function printLink(l: Record<string, unknown>, envId: string) {
  console.log(`링크 종류  ${l.kind}`);
  console.log(`만료       ${l.expiresAt}`);
  if (typeof l.externalId === "string") console.log(`확인 문구  ${l.externalId.slice(0, 4)}… (앞 4자)`);
  if (l.createBoundaryPolicy === false) console.log("경계 정책  이미 있음 → 템플릿이 만들지 않음 (CreateBoundaryPolicy=false)");
  // RV-17: 빠른 생성 주소에는 ExternalId·플랫폼 주체 ARN(계정 번호) 원문이 들어 있다. 사람이 보는 터미널(TTY)이면 화면에 안 찍고
  //   0600 파일로만 (화면을 채팅·공유 폴더에 붙여도 안 샘). 파이프·파일로 받는 도구(real-session 이 출력에서 주소를 읽음)는 예전처럼 찍는다.
  //   화면에 꼭 찍기: CONNECT_PRINT_URL=1, 파이프여도 파일로만: CONNECT_LINK_TO_FILE=1
  if (typeof l.url === "string" && l.url) {
    if (process.env.CONNECT_LINK_TO_FILE === "1" || (process.stdout.isTTY && process.env.CONNECT_PRINT_URL !== "1")) {
      const dir = process.env.CONNECT_LINK_DIR?.trim() || join(homedir(), ".svc-tf");
      const f = join(dir, `connect-link-${envId.slice(0, 8)}.url`);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(f, l.url + "\n", { mode: 0o600 });
        console.log(`\n연결 링크는 파일로만 (확인 문구·계정 번호가 들어 있어 화면에 안 찍음): ${f}\n  맥에서 열기: open "$(cat ${f})"  → IAM 확인 체크 → 스택 만들기\n`);
      } catch { console.log(`\n링크 파일을 못 씀 → CONNECT_PRINT_URL=1 로 다시 (화면에 찍힘, 붙여 넣지 말 것)\n`); }
    } else console.log(`\n아래 주소를 고객 AWS 콘솔에서 열고 IAM 확인 체크 → 스택 만들기:\n${l.url}\n`);
  }
  if (l.command) console.log(`\n명령:\n${l.command}\n`);
  // FM-CON-03: 화면 명령은 Cloud Shell(infra 폴더) 기준. 레포 루트에서 칠 때 쓸 판을 같이 찍는다
  if (typeof l.command === "string" && l.command.includes("bash onboarding/gcp-connect.sh")) console.log(`레포 루트에서 칠 때:\n${gcpRootCommand(l.command)}\n`);
  // 6회차(운영자 실수): 회사 SA 를 다른 회사 번호로 만들었는지 고객에게 넘기기 전에 확인하는 명령 (읽기만)
  const sa = typeof l.command === "string" ? /PLATFORM_SA='([^']+)'/.exec(l.command)?.[1] : undefined;
  if (sa) console.log(`고객에게 넘기기 전 회사 SA 고리 확인 (읽기만):\nGCP_TENANT_SA=${sa} bash tools/gcp-account-check.sh\n`);
}

// DRAFT(ai): 연결 실패 사유(contracts ConnectionFailure) → 운영자·고객이 할 일 한 줄. 문구는 데모용 초안
const FAILURE_HINT: Record<ConnectionFailure, string> & Record<string, string | undefined> = {
  ROLE_ASSUME_DENIED: "스택이 CREATE_COMPLETE 인지, 링크의 확인 문구로 만든 스택인지, --account 가 스택을 만든 계정인지 확인 → 몇 분 뒤 verify 다시 (IAM 전파)",
  ROLE_NOT_FOUND: "--account 계정에 연결 스택(svc-observe 역할)이 없다 → 계정 번호 확인, 또는 링크로 스택을 만든 뒤 verify",
  PERMISSION_MISSING: "관찰 역할에 빠진 권한이 있다 → 최신 연결 템플릿으로 스택 업데이트 뒤 verify",
  ORG_POLICY_BLOCKED: "고객 조직 정책(SCP)이 막는다 → 고객 관리자에게 해당 동작 허용 요청",
  K8S_ACCESS_MISSING: "EKS 접근 항목이 없다 → 클러스터 이름·지역(환경 만들 때 --cluster·--region)이 실제 클러스터와 같은지, 스택의 EksClusterName 확인",
  LINK_EXPIRED: "링크 만료 → npm run env:connect -- link --env <번호> 로 다시 받기 (확인 문구는 그대로)",
  ACCOUNT_MISMATCH: "처음 확인한 계정과 다르다 → 계정 번호 확인",
  PLATFORM_CREDENTIALS_INVALID: "워커 쪽 AWS 자격 만료 → 운영자가 aws sso login 등으로 갱신 뒤 워커 재시작, verify 다시",
  PLATFORM_CLI_MISSING: "워커에 aws 명령이 없다 → 운영자가 aws CLI 설치 뒤 워커 재시작",
  PLATFORM_ERROR: "플랫폼 쪽 오류 → 워커 로그 확인 뒤 verify 다시",
};

const cmd = process.argv[2];
const h = await headers();
if (cmd === "create") {
  const provider = need("provider");
  let name = need("name");
  // PF01 FM-CON-04: 같은 DB 로 다시 돌리면 같은 이름이 409 ENV_NAME_TAKEN (이름 검사는 상태와 상관없음).
  //   살아 있는 같은 이름·같은 제공자 환경이 있으면 그것을 이어 쓴다 (확인 문구가 그대로라 이미 만든 스택도 그대로 열림).
  //   해제된(disconnected) 것뿐이면 이름 뒤에 UTC 시각을 붙여 새로 만든다. 출력 첫 줄 "환경 만듦  <id>" 모양은 그대로 (real-session 이 읽음)
  const list = await call(h, "GET", "/environments") as { items: Array<Record<string, unknown>> };
  const same = list.items.find((x) => x.name === name);
  let env: Record<string, unknown>;
  // PF07 (운영자 실수): draft 는 링크를 한 번도 못 받은 것(예: --cluster 빠뜨려 CLUSTER_NAME_REQUIRED) → 지킬 문구·스택이 없다.
  //   이어 쓰면 처음 넣은 값(클러스터 없음)이 그대로라 --cluster 를 붙여 다시 쳐도 영영 같은 400 → 새로 만든다 (이름 뒤 UTC 시각)
  if (same && same.provider === provider && same.connectionStatus !== "disconnected" && same.connectionStatus !== "draft") {
    env = same;
    console.log(`환경 만듦  ${env.id} (${env.provider}, ${env.name}, 이어 씀: 지금 ${env.connectionStatus})`);
  } else {
    if (same) name = `${name}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}z`;
    const body = { provider, name,
      ...(arg("region") ? { region: arg("region") } : {}), ...(arg("cluster") ? { clusterName: arg("cluster") } : {}) };
    env = await call(h, "POST", "/environments", body);
    console.log(`환경 만듦  ${env.id} (${env.provider}, ${env.name})`);
  }
  if (env.connectionStatus === "connected" || env.connectionStatus === "verifying") {
    console.log(`이미 ${env.connectionStatus} → 링크를 다시 받지 않음. 확인만: npm run env:connect -- verify --env ${env.id} --account <12자리>`);
  } else {
    const l = await call(h, "POST", linkPath(String(env.id), String(env.provider)));
    printLink(l, String(env.id));
    if (env === same && typeof l.url === "string") reuseCheck(l.url);
    if (provider === "aws" && typeof l.url === "string") stackCheck(l.url);
    console.log(`스택이 다 만들어지면: npm run env:connect -- verify --env ${env.id} --account <12자리>`);
  }
} else if (cmd === "link") {
  const id = need("env");
  const list = await call(h, "GET", "/environments") as { items: Array<Record<string, unknown>> };
  const cur = list.items.find((x) => x.id === id);
  const provider = String(cur?.provider ?? "");
  // PF09: 연결됨·확인 중이면 링크 발급은 409 → 오류 덩어리 대신 한 줄 (create 와 같은 규칙)
  if (cur?.connectionStatus === "connected" || cur?.connectionStatus === "verifying") {
    console.log(`이미 ${cur.connectionStatus} → 링크를 다시 받지 않음. 확인만: npm run env:connect -- verify --env ${id} --account <12자리>`);
    process.exit(0);
  }
  const l = await call(h, "POST", linkPath(id, provider));
  printLink(l, id);
  if (provider === "aws" && typeof l.url === "string") stackCheck(l.url);
} else if (cmd === "verify") {
  const id = need("env");
  const account = need("account");
  // PF08: 이미 connected 면 API 가 409(InvalidTransition) → 데모 화면에 오류 덩어리. 미리 보고 결과 줄만 찍는다
  const before = ((await call(h, "GET", "/environments")) as { items: Array<Record<string, unknown>> }).items.find((x) => x.id === id);
  if (before?.connectionStatus === "connected") {
    console.log(`이미 connected → 다시 확인 요청 안 함 (주기 확인은 워커가 함)\n연결 확인 결과  connected`);
    process.exit(0);
  }
  // PF09 (8회차 재실행): 확인 중에 도구를 끊고(Ctrl-C·창 닫힘) 다시 치면 verifying → POST 가 409 로 rc 1.
  //   이미 verifying 이면 새 요청 없이 기다리기만 한다 (워커 작업은 이미 큐에 있음)
  const waitMs = Math.max(10, Number(process.env.VERIFY_WAIT_SEC ?? 120) || 120) * 1000;
  const verifyOnce = async (skipPost: boolean) => {
    if (skipPost) console.log("이미 verifying → 새 확인 요청 없이 결과만 기다림");
    else {
      // 결정 3 A안 (mac pf03): GCP 도착 전용 프로젝트는 --target-project → 본문 targetProjectId (줄 때만 보냄)
      const tpj = arg("target-project");
      const r = await call(h, "POST", `/environments/${id}/verify`, { accountId: account, ...(tpj ? { targetProjectId: tpj } : {}) });
      console.log(`확인 요청  queued=${r.queued}`);
    }
    const t0 = Date.now();
    let last = "";
    let cur: Record<string, unknown> | undefined;
    // FM-GCP-03: GCP 는 워커가 IAM 전파를 기다리며 다시 본다(기본 20초×4) → 30초면 verifying 에서 끝나 버린다. VERIFY_WAIT_SEC 로 바꿈
    while (Date.now() - t0 < waitMs) {
      const list = await call(h, "GET", "/environments") as { items: Array<Record<string, unknown>> };
      cur = list.items.find((x) => x.id === id);
      const line = `${cur?.connectionStatus}${cur?.failureReason ? ` (${cur.failureReason})` : ""}`;
      if (line !== last) { console.log(`+${String(Date.now() - t0).padStart(6)} ms  ${line}`); last = line; }
      if (cur && ["connected", "failed", "disconnected"].includes(String(cur.connectionStatus))) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    return cur;
  };
  // PF09 (8회차 재실행): 확인 중에 도구를 끊고(Ctrl-C·창 닫힘) 다시 치면 verifying → POST 가 409 로 rc 1.
  //   이미 verifying 이면 새 요청 없이 기다리기만 한다 (워커 작업은 이미 큐에 있음)
  let e = await verifyOnce(before?.connectionStatus === "verifying");
  // FM-CON-09 (실측): 관찰 역할이 EKS 에 401 → 접근 항목이 옛 역할(지우고 같은 이름으로 다시 만든 스택 전)에 묶였을 수 있다.
  //   클러스터를 알면(--cluster 또는 CLUSTER_NAME) 고객 쪽 자격(지금 맥 aws)으로 접근 항목을 보고, 옛 것이면 다시 만든 뒤 한 번 더 확인
  const cluster = arg("cluster") ?? process.env.CLUSTER_NAME?.trim();
  if (e?.connectionStatus === "failed" && e.failureReason === "K8S_ACCESS_MISSING:UNAUTHORIZED" && cluster) {
    const region = arg("region") ?? (process.env.AWS_REGION?.trim() || "ap-northeast-2");
    const fixed = accessEntryCheck(cluster, region, process.env.CONNECT_ACCESS_ENTRY_FIX !== "0");
    if (fixed > 0) { console.log("접근 항목을 다시 만듦 → 한 번 더 확인"); e = await verifyOnce(false); }
  }
  // PF08 (7회차 심사 데모): 끝 상태를 한 줄로 고정하고 rc 로도 알린다. 예전엔 failed·시간 초과도 rc=0 이고,
  //   real-session 은 출력에서 "connected" 를 찾아 "disconnected" 도 통과로 봤다. 고객이 할 일(needsHuman)·빠진 선택 권한도 화면에 찍는다
  for (const m of (e?.missingPermissions as string[] | undefined) ?? []) console.log(`빠진 권한  ${m}`);
  for (const n of (e?.needsHuman as string[] | undefined) ?? []) console.log(`할 일      ${n}`);
  // 실패 사유마다 사람이 볼 다음 할 일 한 줄 (워커 needsHuman 은 연결 성공 + 선택 권한 빠짐일 때만 붙는다)
  const reason = String(e?.failureReason ?? "").split(":")[0] ?? "";
  const hint = e?.failureReason === "K8S_ACCESS_MISSING:UNAUTHORIZED"
    ? `관찰 역할이 EKS 인증 실패(401) → 접근 항목이 옛 역할에 묶였을 수 있음: npm run env:connect -- access-check --cluster <EKS> --fix 뒤 verify 다시 (verify 에 --cluster 를 주면 자동)`
    : e?.failureReason === "PLATFORM_ERROR:MOCK_CREDENTIALS"
    ? "연결 링크를 안 거친 환경이라 흉내 자격만 나옴(실측 판에선 거부) → npm run env:connect -- link --env <번호> 로 링크를 받아 스택을 만든 뒤 verify"
    : FAILURE_HINT[reason];
  if (e?.connectionStatus === "failed" && hint) console.log(`다음 할 일  ${hint}`);
  const fin = String(e?.connectionStatus ?? "unknown");
  console.log(`연결 확인 결과  ${fin}${e?.failureReason ? ` (${e.failureReason})` : ""}`);
  if (fin === "verifying") console.log(`아직 확인 중 (VERIFY_WAIT_SEC=${waitMs / 1000}초 지남) → 조금 뒤 같은 명령을 다시`);
  process.exit(fin === "connected" ? 0 : fin === "verifying" ? 5 : 1);
} else if (cmd === "access-check") {
  // FM-CON-09: 접근 항목이 옛 역할에 묶였는지 보기(기본은 보기만, --fix 면 다시 만듦)
  const n = accessEntryCheck(need("cluster"), arg("region") ?? (process.env.AWS_REGION?.trim() || "ap-northeast-2"), process.argv.includes("--fix"));
  console.log(`다시 만든 접근 항목  ${n}`);
} else if (cmd === "whoami") {
  // CON-01: 로그인한 회사 번호 (gcp-platform-tenant-sa.sh 의 TENANT_ID). 회사 번호는 비밀이 아니다. 줄 모양 고정 "회사  <uuid>"
  //   개발용 헤더(DEV_AUTH)면 그 값, 로그인이면 /auth/me
  const tid = h["x-dev-tenant"] ?? (await call(h, "GET", "/auth/me") as { tenantId?: string }).tenantId;
  if (!tid) { console.error("회사 번호를 못 받음"); process.exit(1); }
  console.log(`회사  ${tid}`);
} else {
  console.error("사용: npm run env:connect -- create|link|verify|access-check|whoami ...");
  process.exit(2);
}

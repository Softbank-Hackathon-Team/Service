// 사전 점검 ② LAUNCHCFG: api·worker 를 (다시) 띄우는 줄마다, 그 줄이 쓰는 env 로 시작 설정 검사(configProblems)를 미리 돌린다.
// 왜: 프로세스를 띄우는 줄 = 설정이 정해지는 줄. 11/3 실세션 connect 단계가 api 를 IAM 사용자 ARN 으로 다시 띄우다
//   "IAM 역할 ARN 모양이 아님" 으로 안 떴다(F8). up-preflight 의 config-run 은 demo-day 의 값만 봐서 못 잡았다.
//   (근거 preflight-methodology-v1.md L2 "구멍 B")
//
// 띄우는 줄 표(sites())는 손으로 적는다. 대신 표가 썩지 않게, 스크립트의 띄우는 줄 개수가 표와 다르면 FAIL 한다
//   (새 줄이 생기면 여기 한 줄을 더해야 PASS).
// 쓰는 법: node --env-file-if-exists=.env --import tsx tools/preflight-config.ts [실세션 스크립트 경로]
//   환경: PREFLIGHT_DEMO_DAY_SH(역시험용, 기본 tools/demo-day.sh) PREFLIGHT_PRINCIPAL_ARN(sts 로 만든 값, up-preflight 가 넘김) ONPREM_KUBE_CONTEXT CONNECT_TEMPLATE_URL
// 줄 모양: "OK|FAIL|WARN <항목> <설명>" (up-preflight 와 같음). 값은 안 찍고 이름·이유만. 끝 코드 0 = FAIL 없음
import { readFileSync, existsSync } from "node:fs";
import { configProblems, type ConfigService } from "@svc/contracts";

type Site = { id: string; file: "demo-day" | "real-session"; service: ConfigService; demoDayEnv: boolean; env: Record<string, string> };
//   실세션 connect 는 sts 로 얻은 ARN 을 넣는다 → up-preflight 가 같은 방법으로 만들어 PREFLIGHT_PRINCIPAL_ARN 으로 넘김. 다른 줄은 .env 값 그대로

// 행 번호는 base-51·mac MANIFEST 기준 참고용. 판정은 아래 ANCHORS 개수로 한다
export function sites(e: NodeJS.ProcessEnv): Site[] {
  const CONNECT_URL = e.CONNECT_TEMPLATE_URL?.trim() || "https://connect-template.invalid/cli-template-body/aws-connect.json";
  const PRINCIPAL = e.PREFLIGHT_PRINCIPAL_ARN ?? e.PLATFORM_PRINCIPAL_ARN ?? "";
  const CTX = e.ONPREM_KUBE_CONTEXT ?? "";
  return [
  { id: "demo-day:worker(u_workers)", file: "demo-day", service: "worker", demoDayEnv: true, env: { MOCK_IAC: "", GITOPS_DISABLE: "1" } },
  { id: "demo-day:api(u_workers)", file: "demo-day", service: "api", demoDayEnv: false,
    env: { API_HOST: "127.0.0.1", ONPREM_KUBE_CONTEXT: CTX, ...(e.DEMO_DAY_PLAN_ACKS === "1" ? { PLAN_ACKS: "1" } : {}) } },
  { id: "real-session:worker(connect REAL_STS)", file: "real-session", service: "worker", demoDayEnv: true,
    env: { REAL_STS: "1", MOCK_IAC: "", GITOPS_DISABLE: "1", ROLLBACK_WINDOW_SEC: "180" } },
  { id: "real-session:worker(import IR v2)", file: "real-session", service: "worker", demoDayEnv: true,
    env: { REAL_STS: "1", IMPORT_IR: "v2", PLAN_IR: "v2", MOCK_IAC: "", GITOPS_DISABLE: "1", ROLLBACK_WINDOW_SEC: "180" } },
  { id: "real-session:worker(ecs-import)", file: "real-session", service: "worker", demoDayEnv: true,
    env: { REAL_STS: "1", IMPORT_IR: "v2", PLAN_IR: "v2", IMPORT_AWS_ECS_CLUSTER: "realecs-src", IMPORT_AWS_EKS_CLUSTER: "none-realecs", MOCK_IAC: "", GITOPS_DISABLE: "1", ROLLBACK_WINDOW_SEC: "180" } },
  { id: "real-session:api(connect)", file: "real-session", service: "api", demoDayEnv: true,
    env: { API_HOST: "127.0.0.1", CONNECT_TEMPLATE_URL: CONNECT_URL, PLATFORM_PRINCIPAL_ARN: PRINCIPAL } },
  { id: "real-session:api(run PLAN_ACKS)", file: "real-session", service: "api", demoDayEnv: true,
    env: { API_HOST: "127.0.0.1", PLAN_ACKS: "1", MOCK_IAC: "", GITOPS_DISABLE: "1" } },
  ];
}
// 스크립트 안 띄우는 줄 세기. real-session 의 worker 는 worker_env() 한 곳에서 띄우고 여러 단계가 그걸 부른다
export const ANCHORS: Record<Site["file"], { re: RegExp; service: ConfigService }[]> = {
  // FM-INT-08: orch pf03(FM-ORC-17) 이 demo-day 띄우는 줄을 npm run "$(d_run_script worker)"(start:* / DEMO_DAY_WATCH=1 이면 dev:*) 로 바꿈 → 두 모양 다 셈
  "demo-day": [{ re: /nohup npm run (?:dev:worker|"\$\(d_run_script worker\)")(?= *[<>])/g, service: "worker" }, { re: /nohup npm run (?:dev:api|"\$\(d_run_script api\)")(?= *[<>])/g, service: "api" }],
  "real-session": [{ re: /nohup npm run dev:worker(?= *[<>])/g, service: "worker" }, { re: /nohup npm run dev:api(?= *[<>])/g, service: "api" }],
};
// 띄우는 줄 개수 기대값 (worker_env 안 1줄이 3개 SITE 를 낸다)
export const EXPECT: Record<Site["file"], Record<string, number>> = {
  "demo-day": { worker: 1, api: 1 },
  "real-session": { worker: 1, api: 2 },
};

// demo-day.env 는 up 중에 생긴다 → 스크립트의 kv 줄에서 글자 그대로인 값만 가져온다. $ 가 든 값은 실행 때 정해져 자리 값
export function demoDayEnvFrom(script: string): { env: Record<string, string>; runtime: string[] } {
  const env: Record<string, string> = {}; const runtime: string[] = [];
  for (const m of script.matchAll(/^\s*kv ([A-Z][A-Z0-9_]*) "([^"]*)"/gm)) {
    const [, k, v] = m as unknown as [string, string, string];
    if (/\$/.test(v)) {
      const lit = v.match(/^\$\{[A-Z_]+:-([^}$]*)\}$/);   // "${X:-4}" 꼴은 기본값을 쓴다
      if (lit) env[k] = process.env[v.slice(2, v.indexOf(":"))] ?? lit[1]!;
      else if (/^\$\{?[A-Z_]+\}?$/.test(v) && process.env[v.replace(/[${}]/g, "")] !== undefined) env[k] = process.env[v.replace(/[${}]/g, "")]!;
      else { env[k] = "x"; runtime.push(k); }
    } else env[k] = v;
  }
  return { env, runtime };
}

export function countLaunches(script: string, file: Site["file"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of ANCHORS[file]) out[a.service] = (out[a.service] ?? 0) + (script.match(a.re)?.length ?? 0);
  return out;
}

export function checkSites(scripts: { "demo-day": string; "real-session"?: string }, base: NodeJS.ProcessEnv): string[] {
  const lines: string[] = [];
  const dd = demoDayEnvFrom(scripts["demo-day"]);
  for (const file of ["demo-day", "real-session"] as const) {
    const s = scripts[file];
    if (s === undefined) { lines.push(`WARN launch-count:${file} 실세션 스크립트를 못 찾음 → 띄우는 줄 개수 대조 건너뜀 (REAL_SESSION_SH=<경로>)`); continue; }
    const got = countLaunches(s, file); const want = EXPECT[file];
    const bad = Object.keys(want).filter((k) => got[k] !== want[k]);
    lines.push(bad.length === 0
      ? `OK   launch-count:${file} 띄우는 줄 ${Object.entries(got).map(([k, n]) => `${k} ${n}`).join(", ")} = 점검 표와 같음`
      : `FAIL launch-count:${file} 띄우는 줄이 점검 표와 다름 (${bad.map((k) => `${k} ${got[k] ?? 0}/${want[k]}`).join(", ")}) → tools/preflight-config.ts sites() 에 그 줄의 env 를 더할 것`);
  }
  // SCHEMACOPY (F16): 복제 도착이 있으면 도착 DB 표·앱 계정을 깔아 줄 곳이 있어야 한다. 이 경로의 생산자는 워커 sync 의 REPL_COPY_SCHEMA=1 하나뿐
  //   (앱 마이그레이션은 데모 도착에서 안 돈다). 워커를 띄우는 줄마다 그 env 로 본다
  for (const site of sites(base).filter((x) => x.service === "worker")) {
    const env = { ...base, ...(site.demoDayEnv ? dd.env : {}), ...site.env };
    if (!env.REPL_TARGET_URL) continue;
    const on = env.REPL_COPY_SCHEMA === "1" || env.REPL_COPY_SCHEMA === "true";
    lines.push(on ? `OK   repl-schema:${site.id} 도착 DB 표·앱 계정은 sync 가 출발 모양대로 만든다 (REPL_COPY_SCHEMA=1)`
      : `FAIL repl-schema:${site.id} 복제 도착(REPL_TARGET_URL)은 있는데 표·앱 계정을 깔아 줄 곳이 없음 → sync 가 REPL_TARGET_SCHEMA_MISSING (F16). demo-day kv REPL_COPY_SCHEMA "1"`);
  }
  for (const site of sites(base)) {
    const env = { ...base, ...(site.demoDayEnv ? dd.env : {}), ...site.env };
    const p = configProblems(site.service, env);
    lines.push(p.length === 0 ? `OK   config-launch:${site.id} 시작 설정 검사 통과` : `FAIL config-launch:${site.id} 시작 거부할 설정: ${p.join("; ").slice(0, 300)}`);
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rs = process.argv[2] ?? process.env.REAL_SESSION_SH;
  const lines = checkSites({ "demo-day": readFileSync(process.env.PREFLIGHT_DEMO_DAY_SH || "tools/demo-day.sh", "utf8"),
    "real-session": rs && existsSync(rs) ? readFileSync(rs, "utf8") : undefined }, process.env);
  for (const l of lines) console.log(l);
  process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
}

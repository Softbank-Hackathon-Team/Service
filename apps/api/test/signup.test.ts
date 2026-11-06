// 팀 가입 (DB 없이): 명부 읽기·검사, 자리·코드 맞추기, 가입 설정, 같은 403 (자리 닫힘·모르는 로그인·코드 틀림), 꺼짐 404
// DB 까지 한 바퀴는 signup.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNUP_PASSWORD_MAX, SIGNUP_PASSWORD_MIN, SignupBody, TeamRegistry } from "@svc/contracts";
import { PASSWORD_MAX, PASSWORD_MIN } from "../src/auth/password.js";
import { loadTeamRegistry, matchSlot, signupOpen, teamRegistryPath, DEFAULT_TEAM_REGISTRY_PATH } from "../src/auth/team-registry.js";
import { isPublicAuthPath } from "../src/plugins/auth.js";
import { buildApp } from "../src/app.js";

const dir = mkdtempSync(join(tmpdir(), "signup-unit-"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE = "unit-invite-code-7f3a9c";
const T = "11111111-1111-4111-8111-111111111111";
let n = 0;
const write = (text: string) => { const p = join(dir, `r${n++}.yaml`); writeFileSync(p, text); return p; };
const reg = (slots: string) => `version: 1\ntenant: ${T}\nslots:\n${slots}`;
const OPEN = `  - id: slot-1
    login: Alice@Iron
    signup_code_sha256: "${sha(CODE).toUpperCase()}"
    environments:
      - { name: src-aws-sample, provider: aws, region: ap-northeast-2, cluster: platform-target, notes: "공유 환경, 쉼표와 # 가 든 메모" }
      - { name: GCP-sample, provider: gcp, region: asia-northeast3, gcp: { original_project: iron-source-gcp, dedicated_project: iron-target-gcp } }
  - id: slot-2
    login: bob@iron
    signup_code_sha256: ""
    environments: []
`;

async function withEnv<T>(e: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(e)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("명부: 레포의 docs/team-env/registry.yaml 이 계약에 맞는다 (이미지에 들어가는 파일)", () => {
  const l = loadTeamRegistry("docs/team-env/registry.yaml");
  assert.ok(l.ok, JSON.stringify(l));
  assert.equal(l.registry.version, 1);
  assert.ok(l.registry.slots.length >= 1);
});

test("명부: 기본 경로는 이미지 안 /app/team-env/registry.yaml, TEAM_REGISTRY_PATH 로 바꿈", () => {
  assert.equal(teamRegistryPath({}), DEFAULT_TEAM_REGISTRY_PATH);
  assert.equal(teamRegistryPath({ TEAM_REGISTRY_PATH: " /x/y.yaml " }), "/x/y.yaml");
});

test("명부: 읽기 성공 — 로그인·해시는 소문자로 맞추고 열린 자리가 있으면 가입 켜짐", () => {
  const l = loadTeamRegistry(write(reg(OPEN)));
  assert.ok(l.ok, JSON.stringify(l));
  assert.equal(l.registry.slots[0]!.login, "alice@iron");
  assert.equal(l.registry.slots[0]!.signup_code_sha256, sha(CODE));
  assert.equal(signupOpen(l.registry), true);
  assert.equal(signupOpen(null), false);
  const closed = loadTeamRegistry(write(reg(`  - id: slot-1\n    login: a@iron\n    signup_code_sha256: ""\n`)));
  assert.ok(closed.ok);
  assert.equal(signupOpen(closed.registry), false, "모든 자리가 닫혔으면 꺼짐");
});

test("명부 거부: 없는 파일·YAML 오류·모양 틀림·POST /environments 검사 실패는 가입을 끄고 이유를 낸다", () => {
  assert.deepEqual(loadTeamRegistry(join(dir, "nope.yaml")), { ok: false, path: join(dir, "nope.yaml"), reason: "missing", issues: [] });
  const bad = loadTeamRegistry(write("version: 1\ntenant: [unclosed\n"));
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.reason, "bad_yaml");
  const cases: Array<[string, RegExp]> = [
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: "abc"\n`), /signup_code_sha256/],                               // 해시 모양
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: ""\n    owner: x\n`), /Unrecognized key/],                   // 모르는 칸 (오타)
    [reg(`  - id: s\n    login: no-at-sign\n    signup_code_sha256: ""\n`), /login/],                                          // 로그인 모양
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: ""\n  - id: t\n    login: A@IRON\n    signup_code_sha256: ""\n`), /duplicate login/],
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: ""\n    environments:\n      - { name: g, provider: gcp, gcp: { original_project: same-project, dedicated_project: same-project } }\n`), /must differ/],
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: ""\n    environments:\n      - { name: a, provider: aws, gcp: { original_project: iron-source-gcp, dedicated_project: iron-target-gcp } }\n`), /gcp only/],
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: ""\n    environments:\n      - { name: a, provider: aws }\n      - { name: a, provider: gcp }\n`), /duplicate environment name/],
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: ""\n    environments:\n      - { name: a, provider: aws, region: Seoul }\n`), /BAD_REGION/],
    [reg(`  - id: s\n    login: a@iron\n    signup_code_sha256: ""\n    environments:\n      - { name: a, provider: aws, cluster: "--kubeconfig=x" }\n`), /BAD_CLUSTER_NAME/],
    [`version: 2\ntenant: ${T}\nslots: []\n`, /version/],
    [`version: 1\ntenant: not-a-uuid\nslots: []\n`, /tenant/],
  ];
  for (const [text, want] of cases) {
    const l = loadTeamRegistry(write(text));
    assert.equal(l.ok, false, text);
    assert.match(!l.ok ? l.issues.join("\n") : "", want, text);
  }
});

test("자리 맞추기: 맞는 코드만 자리를 준다. 로그인 대소문자 무시. 틀린 코드·모르는 로그인·닫힌 자리는 모두 null", () => {
  const l = loadTeamRegistry(write(reg(OPEN)));
  assert.ok(l.ok);
  assert.equal(matchSlot(l.registry, "ALICE@iron", CODE)?.id, "slot-1");
  assert.equal(matchSlot(l.registry, "alice@iron", CODE + "x"), null);
  assert.equal(matchSlot(l.registry, "nobody@iron", CODE), null);
  assert.equal(matchSlot(l.registry, "bob@iron", ""), null, "닫힌 자리는 빈 코드로도 안 열림");
  assert.equal(matchSlot(l.registry, "bob@iron", CODE), null);
});

test("계약: 가입 비밀번호 길이는 로그인·auth:seed 와 같은 규칙 (password.ts)", () => {
  assert.equal(SIGNUP_PASSWORD_MIN, PASSWORD_MIN);
  assert.equal(SIGNUP_PASSWORD_MAX, PASSWORD_MAX);
  assert.equal(SignupBody.safeParse({ login: "a@iron", code: "c", password: "x".repeat(PASSWORD_MIN - 1) }).success, false);
  assert.equal(SignupBody.safeParse({ login: "a@iron", code: "c", password: "x".repeat(PASSWORD_MIN) }).success, true);
  assert.equal(SignupBody.safeParse({ login: "a@iron", code: "c", password: "x".repeat(PASSWORD_MIN), extra: 1 }).success, false);
  assert.equal(TeamRegistry.safeParse({ version: 1, tenant: T, slots: [] }).success, true);
  // 메신저에서 복사할 때 붙는 앞뒤 빈칸·줄바꿈은 지운 뒤 해시한다
  assert.equal(SignupBody.parse({ login: " A@Iron ", code: `  ${CODE}\n`, password: "x".repeat(PASSWORD_MIN) }).code, CODE);
  assert.equal(SignupBody.safeParse({ login: "a@iron", code: "   ", password: "x".repeat(PASSWORD_MIN) }).success, false);
});

test("계약: 환경의 db_instance(출발 샘플 RDS 식별자)는 aws 환경에만, RDS 식별자 모양만 (tools/team-env.sh 와 같은 규칙)", () => {
  const slot = (env: Record<string, unknown>) => ({ version: 1, tenant: T, slots: [{ id: "slot-1", login: "a@iron", signup_code_sha256: "", environments: [env] }] });
  const aws = { name: "s1-src-aws", provider: "aws", region: "ap-northeast-2", cluster: "a-eks" };
  assert.equal(TeamRegistry.safeParse(slot(aws)).success, true, "없어도 된다 (선택)");
  assert.equal(TeamRegistry.safeParse(slot({ ...aws, db_instance: "sample-shop-db" })).success, true);
  for (const bad of ["Sample-Shop", "shop--db", "shop-db-", "1shop", "shop_db", "<샘플 RDS 식별자>", "a".repeat(64)])
    assert.equal(TeamRegistry.safeParse(slot({ ...aws, db_instance: bad })).success, false, bad);
  const gcp = { name: "s1-gcp", provider: "gcp", region: "asia-northeast3", gcp: { original_project: "x-src-prj", dedicated_project: "x-mig-prj" } };
  const r = TeamRegistry.safeParse(slot({ ...gcp, db_instance: "shop-db" }));
  assert.equal(r.success, false);
  assert.ok(r.error!.issues.some((i) => i.message === "db_instance is for provider aws only"));
});

test("인증 훅: 가입 두 경로는 토큰 없이 처리기까지 간다 (그 밖의 /auth/signup* 은 아님)", () => {
  assert.equal(isPublicAuthPath("/api/v1/auth/signup"), true);
  assert.equal(isPublicAuthPath("/api/v1/auth/signup/config"), true);
  assert.equal(isPublicAuthPath("/api/v1/auth/signup/other"), false);
  assert.equal(isPublicAuthPath("/api/v1/auth/signupx"), false);
});

test("경로: 명부 없음 → 설정 false·POST 404 SIGNUP_DISABLED, 경고 한 줄", async () => {
  const lines: string[] = [];
  await withEnv({ TEAM_REGISTRY_PATH: join(dir, "missing.yaml"), DEV_AUTH: undefined }, async () => {
    const { app } = await buildApp({ logStream: { write: (l) => { lines.push(l); } } });
    try {
      const cfg = await app.inject({ url: "/api/v1/auth/signup/config" });
      assert.equal(cfg.statusCode, 200);
      assert.deepEqual(cfg.json(), { enabled: false });
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { login: "alice@iron", code: CODE, password: "long-enough-pw" } });
      assert.equal(r.statusCode, 404);
      assert.equal(r.json().code, "SIGNUP_DISABLED");
    } finally { await app.close(); }
  });
  assert.equal(lines.filter((l) => l.includes("registry_unavailable")).length, 1);
});

test("경로: 자리 닫힘·모르는 로그인·코드 틀림은 같은 403 SIGNUP_NOT_ALLOWED (본문이 requestId 빼고 같다), 모양 틀린 본문은 400", async () => {
  await withEnv({ TEAM_REGISTRY_PATH: write(reg(OPEN)), DEV_AUTH: undefined }, async () => {
    const { app } = await buildApp();
    try {
      assert.deepEqual((await app.inject({ url: "/api/v1/auth/signup/config" })).json(), { enabled: true });
      const bodies = [];
      for (const [i, payload] of [
        { login: "alice@iron", code: "wrong-code", password: "long-enough-pw" },
        { login: "nobody@iron", code: CODE, password: "long-enough-pw" },
        { login: "bob@iron", code: CODE, password: "long-enough-pw" },
      ].entries()) {
        const r = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload, remoteAddress: `198.51.100.${10 + i}` });
        assert.equal(r.statusCode, 403, JSON.stringify(payload));
        assert.equal(r.headers["set-cookie"], undefined);
        const { requestId: _r, ...rest } = r.json();
        bodies.push(rest);
      }
      assert.deepEqual(bodies[0], { status: 403, code: "SIGNUP_NOT_ALLOWED", message: "login or invite code is not valid" });
      assert.deepEqual(bodies[1], bodies[0]);
      assert.deepEqual(bodies[2], bodies[0]);
      const short = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { login: "alice@iron", code: CODE, password: "short" } });
      assert.equal(short.statusCode, 400);
    } finally { await app.close(); }
  });
});

test("경로: 같은 IP+로그인으로 5번 틀리면 429 TOO_MANY_ATTEMPTS + retry-after (맞는 코드도 막힘)", async () => {
  await withEnv({ TEAM_REGISTRY_PATH: write(reg(OPEN)), DEV_AUTH: undefined }, async () => {
    const { app } = await buildApp();
    try {
      const ip = "203.0.113.77";
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { login: "alice@iron", code: `bad-${i}`, password: "long-enough-pw" }, remoteAddress: ip });
        assert.equal(r.statusCode, 403);
      }
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/signup", payload: { login: "alice@iron", code: CODE, password: "long-enough-pw" }, remoteAddress: ip });
      assert.equal(r.statusCode, 429);
      assert.equal(r.json().code, "TOO_MANY_ATTEMPTS");
      assert.ok(Number(r.headers["retry-after"]) > 0);
    } finally { await app.close(); }
  });
});

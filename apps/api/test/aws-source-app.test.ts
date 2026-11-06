// tools/aws-source-app.sh: 이미 있는 EKS·RDS 에 AWS 출발 샘플 앱(real-app, orders 100행)을 올리는 도구.
//   --dry-run 으로만 돈다. kubectl·aws·docker·gcloud·openssl 은 부르면 기록만 남기는 가짜로 가린다 → 기록이 비어야 한다 (클라우드·클러스터 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PW = "pw-SHOULD-NOT-PRINT-7f3a";
const ACCOUNT = "123456789012";

function run(args: string[], env: Record<string, string> = {}) {
  const bin = mkdtempSync(join(tmpdir(), "aws-src-bin-"));
  const calls = join(bin, "calls");
  for (const t of ["kubectl", "aws", "docker", "gcloud", "openssl"]) {
    writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> "${calls}"\nexit 9\n`);
    chmodSync(join(bin, t), 0o755);
  }
  const home = mkdtempSync(join(tmpdir(), "aws-src-home-"));
  const pw = join(home, "db-password");
  writeFileSync(pw, `${PW}\n`, { mode: 0o600 });
  // 상속 환경을 쓰지 않는다 (사람 맥의 KUBE_CONTEXT·DB_* 가 섞이지 않게)
  const state = join(home, "state");
  const base = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, AWS_SOURCE_STATE: state, KUBE_CONTEXT: "s9-src-aws",
    DB_HOST: "shop.abc123xyz.ap-northeast-2.rds.amazonaws.com", DB_PASSWORD_FILE: pw };
  const e: Record<string, string> = { ...base, ...env };
  for (const [k, v] of Object.entries(e)) if (v === "") delete e[k];
  const r = spawnSync("bash", ["tools/aws-source-app.sh", ...args], { cwd: ROOT, encoding: "utf8", env: e });
  return { code: r.status, out: r.stdout + r.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "", state };
}

test("app --dry-run: 템플릿 7개 객체, 이미지 digest 고정, 명령만 찍고 비밀번호·도구 호출 0", () => {
  const r = run(["app", "--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /매니페스트 렌더 OK \(7개 객체\)/);
  assert.match(r.out, /이미지 web=docker\.io\/library\/nginx@sha256:<dry-digest> api=docker\.io\/hashicorp\/http-echo@sha256:<dry-digest>/);
  assert.match(r.out, /DRY: \(api-secrets 가 없을 때만\) kubectl -n real-app create secret generic api-secrets/);
  assert.match(r.out, /DRY: kubectl -n real-app create secret generic shop-db-app --from-file=password=<임시 파일>/);
  assert.match(r.out, /DRY: kubectl --context s9-src-aws apply -f \S+\/sample\.yaml/);
  assert.match(r.out, /app 끝/);
  assert.ok(!r.out.includes(PW), "비밀번호가 화면에 나옴");
  assert.equal(r.calls, "", `dry-run 인데 도구를 부름: ${r.calls}`);
  assert.equal(existsSync(r.state), false, "dry-run 은 상태 폴더도 안 만든다");
});

test("app --dry-run: @sha256 로 준 이미지는 그대로", () => {
  const ref = `docker.io/library/nginx@sha256:${"a".repeat(64)}`;
  const r = run(["app", "--dry-run"], { WEB_IMAGE: ref });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`web=${ref} `), r.out);
});

test("seed --dry-run: Secrets Manager 길, 계정 번호는 가리고 일회용 Job 을 적용한 뒤 지운다", () => {
  const r = run(["seed", "--dry-run"], { DB_PASSWORD_FILE: "", KUBE_CONTEXT: `arn:aws:eks:ap-northeast-2:${ACCOUNT}:cluster/b-eks`,
    DB_PASSWORD_SECRET_ID: `arn:aws:secretsmanager:ap-northeast-2:${ACCOUNT}:secret:rds!db-abc` });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY: aws secretsmanager get-secret-value --secret-id <DB_PASSWORD_SECRET_ID> --region ap-northeast-2/);
  assert.match(r.out, /DRY: kubectl --context arn:aws:eks:ap-northeast-2:\*{12}:cluster\/b-eks apply -f \S+\/seed-job\.yaml/);
  assert.match(r.out, /delete job shop-seed secret shop-seed-db --ignore-not-found/);
  assert.ok(!r.out.includes(ACCOUNT), "계정 번호가 화면에 나옴");
  assert.equal(r.calls, "");
});

test("down --dry-run: DB 값 없이도 되고, 라벨(m-import=1) 확인 뒤 네임스페이스만 지운다", () => {
  const r = run(["down", "--dry-run"], { DB_HOST: "", DB_PASSWORD_FILE: "" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY: kubectl get namespaces -l m-import=1 -o name 에 namespace\/real-app 가 있는지 확인/);
  assert.match(r.out, /DRY: kubectl --context s9-src-aws delete namespace real-app --ignore-not-found/);
  assert.equal(r.calls, "");
});

test("거부(끝 코드 2, 도구 호출 0): 컨텍스트·DB 값·비밀번호 위치·시스템 네임스페이스·모르는 명령", () => {
  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ["컨텍스트 없음", ["app", "--dry-run"], { KUBE_CONTEXT: "" }, /KUBE_CONTEXT 가 없음/],
    ["DB_HOST 없음", ["seed", "--dry-run"], { DB_HOST: "" }, /DB_HOST 가 없음/],
    ["RDS 못 찾음", ["app", "--dry-run"], { DB_HOST: "None" }, /DB_HOST=None/],
    ["호스트 모양", ["app", "--dry-run"], { DB_HOST: "db#x;rm" }, /DB_HOST 가 호스트 이름 모양이 아님/],
    ["비밀번호 위치 없음", ["app", "--dry-run"], { DB_PASSWORD_FILE: "" }, /DB 비밀번호 위치가 없음/],
    ["둘 다", ["app", "--dry-run"], { DB_PASSWORD_SECRET_ID: "x" }, /중 하나만/],
    ["관리 비밀번호 아님", ["seed", "--dry-run"], { DB_PASSWORD_FILE: "", DB_PASSWORD_SECRET_ID: "None" }, /DB_PASSWORD_SECRET_ID=None/],
    ["kube-system", ["down", "--dry-run"], { NS: "kube-system" }, /시스템 네임스페이스/],
    ["default", ["app", "--dry-run"], { NS: "default" }, /시스템 네임스페이스/],
    ["DB_USER 모양", ["seed", "--dry-run"], { DB_USER: "x y" }, /DB_USER 모양이 아님/],
    ["모르는 옵션", ["app", "--apply"], {}, /모르는 옵션/],
    ["모르는 명령", ["up", "--dry-run"], {}, /app·seed·down 중 하나/],
  ];
  for (const [name, args, env, err] of cases) {
    const r = run(args, env);
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, err, name);
    assert.equal(r.calls, "", name);
  }
});

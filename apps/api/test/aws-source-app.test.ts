// tools/aws-source-app.sh: 이미 있는 EKS·RDS 에 AWS 출발 샘플 앱(real-app, 앱 계정 shop_app, orders 100행)을 올리는 도구.
//   대부분 --dry-run 으로 돈다. kubectl·aws·docker·gcloud·openssl 은 부르면 기록만 남기는 가짜로 가린다 → 기록이 비어야 한다 (클라우드·클러스터 호출 0)
//   마지막 두 시험은 dry-run 이 아닌 길을 기록용 가짜 kubectl·aws 로 끝까지 돌려 Secret 에 실제로 들어간 값을 본다 (진짜 클러스터·클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PW = "pw-SHOULD-NOT-PRINT-7f3a";
const ACCOUNT = "123456789012";
const HOST = "s9-shop.abc123xyz.ap-northeast-2.rds.amazonaws.com";

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
    DB_HOST: HOST, DB_INSTANCE: "s9-shop", DB_PASSWORD_FILE: pw };
  const e: Record<string, string> = { ...base, ...env };
  for (const [k, v] of Object.entries(e)) if (v === "") delete e[k];
  const r = spawnSync("bash", ["tools/aws-source-app.sh", ...args], { cwd: ROOT, encoding: "utf8", env: e });
  return { code: r.status, out: r.stdout + r.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "", state };
}
const dryLines = (out: string) => out.split("\n").filter((l) => / aws-source DRY: /.test(l));

test("app --dry-run: 템플릿 7개 객체, shop-api 는 DB_NAME=shop·DB_USER=shop_app, 이미지 digest 고정, 마스터 비밀은 안 읽음, 도구 호출 0", () => {
  // app 은 마스터 비밀번호가 필요 없다 (위치를 안 줘도 된다)
  const r = run(["app", "--dry-run"], { DB_PASSWORD_FILE: "" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /app 시작 dry=1 ctx=s9-src-aws ns=real-app db=s9-shop\/shop/);
  assert.match(r.out, /매니페스트 렌더 OK \(7개 객체, shop-api env DB_NAME=shop DB_USER=shop_app\)/);
  assert.match(r.out, /이미지 web=docker\.io\/library\/nginx@sha256:<dry-digest> api=docker\.io\/hashicorp\/http-echo@sha256:<dry-digest>/);
  assert.match(r.out, /DRY: kubectl -n real-app create secret generic api-secrets --from-file=API_TOKEN=<임시 파일> \| kubectl apply -f - {2}# 값: 랜덤, api-secrets 이 없을 때만/);
  assert.match(r.out, /DRY: kubectl -n real-app create secret generic shop-db-app --from-file=password=<임시 파일> \| kubectl apply -f - {2}# 값: 랜덤, shop-db-app 이 없을 때만 \(앱 계정 shop_app 비밀번호/);
  assert.match(r.out, /DRY: kubectl --context s9-src-aws apply -f \S+\/sample\.yaml/);
  assert.match(r.out, /app 끝/);
  assert.doesNotMatch(r.out, /secretsmanager|DB_PASSWORD|마스터/, "app 은 RDS 마스터 비밀을 읽지도 넣지도 않는다");
  assert.ok(!r.out.includes(PW), "비밀번호가 화면에 나옴");
  assert.equal(r.calls, "", `dry-run 인데 도구를 부름: ${r.calls}`);
  assert.equal(existsSync(r.state), false, "dry-run 은 상태 폴더도 안 만든다");
});

test("app --dry-run: @sha256 로 준 이미지는 그대로 (Docker 없이)", () => {
  const ref = `docker.io/library/nginx@sha256:${"a".repeat(64)}`;
  const r = run(["app", "--dry-run"], { WEB_IMAGE: ref });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`web=${ref} `), r.out);
});

test("seed --dry-run: 마스터 비밀은 임시 Secret shop-seed-db 에만, shop-db-app 은 랜덤(shop_app). 끝에 Job·임시 Secret·SQL 을 지운다", () => {
  const r = run(["seed", "--dry-run"], { DB_PASSWORD_FILE: "", KUBE_CONTEXT: `arn:aws:eks:ap-northeast-2:${ACCOUNT}:cluster/b-eks`,
    DB_PASSWORD_SECRET_ID: `arn:aws:secretsmanager:ap-northeast-2:${ACCOUNT}:secret:rds!db-abc` });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /seed 시작 dry=1 .* db=s9-shop\/shop/, "DB_NAME 기본은 shop");
  assert.match(r.out, /DRY: aws secretsmanager get-secret-value --secret-id <DB_PASSWORD_SECRET_ID> --region ap-northeast-2 → 마스터 username·password/);
  const dry = dryLines(r.out);
  // shop-db-app 에 들어가는 값은 랜덤뿐 (마스터 비밀번호가 아님)
  const app = dry.filter((l) => /create secret generic shop-db-app/.test(l));
  assert.equal(app.length, 1, r.out);
  assert.match(app[0]!, /--from-file=password=<임시 파일> .*# 값: 랜덤, shop-db-app 이 없을 때만 \(앱 계정 shop_app 비밀번호/);
  assert.doesNotMatch(app[0]!, /마스터|PGPASSWORD|DB_PASSWORD/);
  // 마스터 사용자·비밀번호는 임시 shop-seed-db 로만 가고, 그 Secret 은 마지막 줄에서 지운다
  const master = dry.filter((l) => /마스터 사용자·비밀번호/.test(l));
  assert.equal(master.length, 1, r.out);
  assert.match(master[0]!, /create secret generic shop-seed-db --from-file=PGUSER=<임시 파일> --from-file=PGPASSWORD=<임시 파일> .*임시, seed 끝나면 지움/);
  assert.match(r.out, /DRY: shop-db-app 값이 마스터 비밀번호와 같으면 멈춘다/);
  assert.match(r.out, /DRY: kubectl -n real-app create configmap shop-seed-sql --from-file=seed\.sql=<임시 파일>/);
  assert.match(r.out, /DRY: kubectl --context arn:aws:eks:ap-northeast-2:\*{12}:cluster\/b-eks apply -f \S+\/seed-job\.yaml/);
  assert.match(dry.at(-1)!, /delete job\/shop-seed secret\/shop-seed-db configmap\/shop-seed-sql --ignore-not-found/, "마지막에 임시 Secret 을 지운다 (TYPE/NAME 모양)");
  assert.ok(dry.findIndex((l) => l.includes("shop-db-app")) < dry.findIndex((l) => l.includes("shop-seed-db")), "앱 비밀번호 Secret 이 먼저 있어야 Job 이 읽는다");
  assert.ok(!r.out.includes(ACCOUNT), "계정 번호가 화면에 나옴");
  assert.equal(r.calls, "");
});

test("down --dry-run: DB 값 없이도 되고, 라벨(m-import=1) 확인 뒤 네임스페이스만 지운다", () => {
  const r = run(["down", "--dry-run"], { DB_HOST: "", DB_INSTANCE: "", DB_PASSWORD_FILE: "" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY: kubectl get namespaces -l m-import=1 -o name 에 namespace\/real-app 가 있는지 확인/);
  assert.match(r.out, /DRY: kubectl --context s9-src-aws delete namespace real-app --ignore-not-found/);
  assert.equal(r.calls, "");
});

test("거부(끝 코드 2, 도구 호출 0): 플랫폼 DB(platform-db)·시스템 DB 이름·식별자와 엔드포인트 불일치·앱 계정 = 마스터", () => {
  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ["DB_HOST 가 platform-db", ["seed", "--dry-run"], { DB_INSTANCE: "", DB_HOST: "platform-db.abc123xyz.ap-northeast-2.rds.amazonaws.com" }, /platform-db 가 들어 있음/],
    ["DB_INSTANCE 가 platform-db", ["app", "--dry-run"], { DB_INSTANCE: "platform-db", DB_HOST: "platform-db.abc.ap-northeast-2.rds.amazonaws.com" }, /platform-db 가 들어 있음/],
    ["대문자 Platform-DB", ["seed", "--dry-run"], { DB_INSTANCE: "", DB_HOST: "Platform-DB-2.abc.ap-northeast-2.rds.amazonaws.com" }, /platform-db 가 들어 있음/],
    ["DB_NAME=postgres", ["seed", "--dry-run"], { DB_NAME: "postgres" }, /DB_NAME=postgres 은 시스템·템플릿 DB/],
    ["DB_NAME=template1", ["app", "--dry-run"], { DB_NAME: "template1" }, /시스템·템플릿 DB/],
    ["DB_NAME=rdsadmin", ["seed", "--dry-run"], { DB_NAME: "rdsadmin" }, /시스템·템플릿 DB/],
    ["식별자·엔드포인트 불일치", ["seed", "--dry-run"], { DB_INSTANCE: "other-db" }, /DB_HOST 가 DB_INSTANCE=other-db 의 엔드포인트/],
    ["식별자 모양", ["app", "--dry-run"], { DB_INSTANCE: "s9;rm" }, /DB_INSTANCE 가 RDS 식별자 모양이 아님/],
    ["앱 계정 = 마스터", ["seed", "--dry-run"], { DB_MASTER_USER: "shop_app" }, /DB_MASTER_USER=shop_app: .*DB-08/],
  ];
  for (const [name, args, env, err] of cases) {
    const r = run(args, env);
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, err, name);
    assert.equal(r.calls, "", name);
  }
});

test("거부(끝 코드 2, 도구 호출 0): 컨텍스트·DB 값·마스터 비밀 위치(seed 만)·시스템 네임스페이스·모르는 명령", () => {
  const cases: Array<[string, string[], Record<string, string>, RegExp]> = [
    ["컨텍스트 없음", ["app", "--dry-run"], { KUBE_CONTEXT: "" }, /KUBE_CONTEXT 가 없음/],
    ["DB_HOST 없음", ["seed", "--dry-run"], { DB_HOST: "" }, /DB_HOST 가 없음/],
    ["RDS 못 찾음", ["app", "--dry-run"], { DB_HOST: "None" }, /DB_HOST=None/],
    ["호스트 모양", ["app", "--dry-run"], { DB_HOST: "db#x;rm" }, /DB_HOST 가 호스트 이름 모양이 아님/],
    ["마스터 비밀 위치 없음", ["seed", "--dry-run"], { DB_PASSWORD_FILE: "" }, /RDS 마스터 비밀번호 위치가 없음/],
    ["둘 다", ["seed", "--dry-run"], { DB_PASSWORD_SECRET_ID: "x" }, /중 하나만/],
    ["관리 비밀번호 아님", ["seed", "--dry-run"], { DB_PASSWORD_FILE: "", DB_PASSWORD_SECRET_ID: "None" }, /DB_PASSWORD_SECRET_ID=None/],
    ["kube-system", ["down", "--dry-run"], { NS: "kube-system" }, /시스템 네임스페이스/],
    ["default", ["app", "--dry-run"], { NS: "default" }, /시스템 네임스페이스/],
    ["DB_MASTER_USER 모양", ["seed", "--dry-run"], { DB_MASTER_USER: "x y" }, /DB_MASTER_USER 모양이 아님/],
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

// dry-run 이 아닌 길: 기록용 가짜 kubectl·aws·openssl. kubectl create … --from-file=키=파일 은 그 파일 내용을 <dir>/<종류>.<이름>.<키> 로 남긴다
const MASTER_PW = "master-PW-never-in-app-secret-91c2";
const APP_RAND = "0123456789abcdef0123456789abcdef0123456789abcdef";
const DIG = `@sha256:${"b".repeat(64)}`;
function fakeRun(args: string[], pre: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "aws-src-fake-"));
  for (const [f, v] of Object.entries(pre)) writeFileSync(join(d, f), v);
  writeFileSync(join(d, "kubectl"), `#!/bin/sh
D="${d}"
echo "kubectl $*" >> "$D/calls"
[ "$1" = --context ] && shift 2
[ "$1" = -n ] && shift 2
case "$1" in
  config) echo s9-src-aws ;;
  create)
    kind=$2; name=$3; [ "$kind" = secret ] && name=$4
    for a in "$@"; do case "$a" in --from-file=*) kv=\${a#--from-file=}; cp "\${kv#*=}" "$D/$kind.$name.\${kv%%=*}" ;; esac; done
    echo "kind: x" ;;
  apply) if [ "$3" = - ]; then cat > /dev/null; else cp "$3" "$D/applied.\${3##*/}"; fi ;;
  get)
    ls "$D"/secret."$3".* > /dev/null 2>&1 || exit 0
    case "$*" in *jsonpath*) base64 < "$D/secret.$3.password" | tr -d '\\n' ;; *) echo "secret/$3" ;; esac ;;
  wait) exit 0 ;;
  logs) echo "orders=100" ;;
  delete) echo "$*" >> "$D/deleted" ;;
esac
`);
  writeFileSync(join(d, "aws"), `#!/bin/sh\necho "aws $*" >> "${d}/calls"\necho '{"username":"master_u","password":"${MASTER_PW}"}'\n`);
  writeFileSync(join(d, "openssl"), `#!/bin/sh\necho "${APP_RAND}"\n`);
  writeFileSync(join(d, "docker"), `#!/bin/sh\necho "docker $*" >> "${d}/calls"\nexit 9\n`);
  for (const t of ["kubectl", "aws", "openssl", "docker"]) chmodSync(join(d, t), 0o755);
  const home = mkdtempSync(join(tmpdir(), "aws-src-home-"));
  const env = { PATH: `${d}:/usr/bin:/bin`, HOME: home, AWS_SOURCE_STATE: join(home, "state"), KUBE_CONTEXT: "s9-src-aws",
    DB_HOST: HOST, DB_INSTANCE: "s9-shop", DB_PASSWORD_SECRET_ID: "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:rds!db-x",
    WEB_IMAGE: `docker.io/library/nginx${DIG}`, API_IMAGE: `docker.io/hashicorp/http-echo${DIG}`, SEED_IMAGE: `docker.io/library/postgres${DIG}` };
  const r = spawnSync("bash", ["tools/aws-source-app.sh", ...args], { cwd: ROOT, encoding: "utf8", env });
  const file = (f: string) => existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : "";
  const logs = () => readdirSync(join(home, "state")).map((f) => readFileSync(join(home, "state", f), "utf8")).join("");
  return { code: r.status, out: r.stdout + r.stderr, file, files: readdirSync(d), logs };
}

test("app → seed (가짜 kubectl·aws): shop-db-app 에는 랜덤 shop_app 비밀번호만, 마스터 비밀번호는 임시 shop-seed-db 에만 가고 지워진다. Docker 없이 @sha256 이미지", () => {
  const app = fakeRun(["app"]);
  assert.equal(app.code, 0, app.out);
  assert.equal(app.file("secret.shop-db-app.password"), APP_RAND, "shop-db-app = 랜덤 앱 계정 비밀번호");
  assert.ok(!app.file("calls").includes("secretsmanager"), "app 은 마스터 비밀을 읽지 않는다");
  assert.ok(!app.file("calls").includes("docker"), "@sha256 이미지면 Docker 를 안 부른다");
  const m = app.file("applied.sample.yaml");
  assert.match(m, /- name: DB_PORT\n {14}value: "5432"\n {12}- name: DB_NAME\n {14}value: "shop"\n {12}- name: DB_USER\n {14}value: "shop_app"\n/);
  assert.equal((m.match(/name: DB_USER/g) ?? []).length, 1);
  assert.match(m, /image: docker\.io\/library\/nginx@sha256:b{64}/);
  assert.match(m, /value: s9-shop\.abc123xyz\.ap-northeast-2\.rds\.amazonaws\.com/);

  // seed: app 뒤와 같은 가짜 상태(shop-db-app 이미 있음)에서 돌린다
  const seed = fakeRun(["seed"], { "secret.shop-db-app.password": APP_RAND });
  assert.equal(seed.code, 0, seed.out);
  assert.match(seed.out, /seed 끝 orders=100/);
  assert.equal(seed.file("secret.shop-seed-db.PGPASSWORD"), MASTER_PW);
  assert.equal(seed.file("secret.shop-seed-db.PGUSER"), "master_u", "마스터 사용자 = RDS 관리 비밀의 username");
  assert.equal(seed.file("secret.shop-db-app.password"), APP_RAND, "shop-db-app 은 그대로 (마스터 비밀번호로 안 바뀜)");
  assert.ok(!seed.files.some((f) => f.startsWith("secret.shop-db-app.") && seed.file(f).includes(MASTER_PW)));
  assert.match(seed.file("deleted"), /delete job\/shop-seed secret\/shop-seed-db configmap\/shop-seed-sql --ignore-not-found/);
  const job = seed.file("applied.seed-job.yaml");
  assert.match(job, /secretKeyRef: \{ name: shop-db-app, key: password \}/);
  assert.match(job, /secretRef: \{ name: shop-seed-db \}/);
  assert.match(job, /PGDATABASE, value: "shop"/);
  assert.ok(!job.includes(MASTER_PW) && !job.includes(APP_RAND), "비밀번호는 Job 스펙에 없다");
  const sql = seed.file("configmap.shop-seed-sql.seed.sql");
  assert.match(sql, /CREATE ROLE shop_app LOGIN/);
  assert.match(sql, /ALTER ROLE shop_app LOGIN PASSWORD :'pw';/);
  assert.match(sql, /GRANT CONNECT ON DATABASE :"DBNAME" TO shop_app;/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO shop_app;/);
  assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCE orders_id_seq TO shop_app;/);
  // 표·채우기 SQL 은 gcp-source.sh seed 와 같다
  const gcp = readFileSync(join(ROOT, "tools/gcp-source.sh"), "utf8");
  const same = [...gcp.matchAll(/"-c", "((?:create table|insert into) [^"]+)"/g)].map((x) => x[1]!);
  assert.equal(same.length, 2);
  for (const s of same) assert.ok(sql.includes(s), `gcp-source.sh 와 다른 SQL: ${s}`);
  for (const o of [seed.out, seed.logs(), app.out, app.logs()]) assert.ok(!o.includes(MASTER_PW) && !o.includes(APP_RAND), "비밀번호가 화면·로그에 나옴");
});

test("seed (가짜 kubectl·aws): shop-db-app 에 마스터 비밀번호가 이미 들어 있으면 멈추고, 임시 Secret·Job 은 안 만든다", () => {
  const r = fakeRun(["seed"], { "secret.shop-db-app.password": MASTER_PW });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /shop-db-app 값이 RDS 마스터 비밀번호와 같음 → 멈춤/);
  assert.equal(r.file("secret.shop-seed-db.PGPASSWORD"), "", "마스터 비밀 Secret 을 만들지 않는다");
  assert.ok(!r.files.some((f) => f.startsWith("applied.seed-job")), "Job 을 올리지 않는다");
  assert.ok(!r.out.includes(MASTER_PW));
});

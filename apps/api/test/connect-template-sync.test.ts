// CLD-07: tools/connect-template-sync.sh — S3 연결 템플릿을 레포 aws-connect.json 과 비교해 다르면·없으면 올린다.
//   가짜 aws(s3 cp 만, s3://<b>/<k> → 임시 폴더 파일)를 PATH 앞에 둔다. 진짜 S3 안 봄. 화면에 버킷 이름이 안 나오는지도 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TPL = join(ROOT, "infra/onboarding/aws-connect.json");
const B = "svc-connect-template-ab12cd34";

// mode: ok | denied (읽기 거부)
function setup(mode = "ok") {
  const d = mkdtempSync(join(tmpdir(), "cts-"));
  const bin = join(d, "bin"); const s3 = join(d, "s3"); mkdirSync(bin); mkdirSync(join(s3, B), { recursive: true });
  writeFileSync(join(bin, "aws"), `#!/bin/sh
echo "$*" >> "${d}/calls"
[ "$1 $2" = "s3 cp" ] || exit 9
shift 2; src=""; dst=""
while [ $# -gt 0 ]; do case "$1" in --content-type|--cli-connect-timeout|--cli-read-timeout) shift 2 ;; --*) shift ;; *) if [ -z "$src" ]; then src=$1; else dst=$1; fi; shift ;; esac; done
map() { case "$1" in s3://*) echo "${s3}/\${1#s3://}" ;; *) echo "$1" ;; esac; }
case "$src" in s3://*) [ "${mode}" = denied ] && { echo "fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden s3://${B}/x" >&2; exit 1; }
  [ -f "$(map "$src")" ] || { echo "fatal error: An error occurred (404) when calling the HeadObject operation: Key \\"x\\" does not exist" >&2; exit 1; } ;; esac
cp "$(map "$src")" "$(map "$dst")"
`);
  chmodSync(join(bin, "aws"), 0o755);
  return { d, bin, obj: join(s3, B, "aws-connect.json") };
}
function run(t: ReturnType<typeof setup>, url: string, extra: Record<string, string> = {}) {
  const r = spawnSync("bash", ["tools/connect-template-sync.sh"], { cwd: ROOT, encoding: "utf8",
    env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}`, CONNECT_TEMPLATE_URL: url, TMPDIR: t.d, ...extra } });
  const calls = existsSync(join(t.d, "calls")) ? readFileSync(join(t.d, "calls"), "utf8") : "";
  return { rc: r.status, out: r.stdout + r.stderr, puts: calls.split("\n").filter((l) => /^s3 cp .*aws-connect\.json s3:\/\//.test(l) && !/^s3 cp .*s3:\/\/.* \S+\/(cur|new)\.json$/.test(l)).length };
}
const VH = `https://${B}.s3.ap-northeast-2.amazonaws.com/aws-connect.json`;

test("CLD-07 같으면(공백·순서만 달라도) 안 올림", () => {
  const t = setup();
  writeFileSync(t.obj, JSON.stringify(JSON.parse(readFileSync(TPL, "utf8"))));
  const r = run(t, VH);
  assert.equal(r.rc, 0, r.out); assert.match(r.out, /connect-template 같음/); assert.equal(r.puts, 0);
  assert.ok(!r.out.includes(B), "버킷 이름이 화면에 나옴");
});

test("CLD-07 옛 템플릿이면 같은 주소에 올리고 다시 받아 확인, 없으면 새로 올림", () => {
  const t = setup();
  writeFileSync(t.obj, JSON.stringify({ Parameters: { old: 1 } }));
  let r = run(t, VH);
  assert.equal(r.rc, 0, r.out); assert.match(r.out, /connect-template 올림 \(레포와 다름/); assert.equal(r.puts, 1);
  assert.deepEqual(JSON.parse(readFileSync(t.obj, "utf8")), JSON.parse(readFileSync(TPL, "utf8")));
  const t2 = setup();
  r = run(t2, `https://s3.ap-northeast-2.amazonaws.com/${B}/aws-connect.json`);   // 경로형 주소
  assert.equal(r.rc, 0, r.out); assert.match(r.out, /올림 \(S3 에 없음/); assert.ok(existsSync(t2.obj));
  assert.ok(!r.out.includes(B));
});

test("CLD-07 거부: 읽기 거부는 실패(rc 1, 버킷 이름 가림), dry-run·빈 주소·S3 아닌 주소·끄기는 안 올림", () => {
  let t = setup("denied");
  let r = run(t, VH);
  assert.equal(r.rc, 1); assert.match(r.out, /S3 템플릿을 못 읽음/); assert.ok(!r.out.includes(B), r.out);
  t = setup(); writeFileSync(t.obj, "{}");
  r = run(t, VH, { CTS_DRY: "1" });
  assert.equal(r.rc, 0); assert.match(r.out, /^dry-run: connect-template 레포와 다름/m); assert.equal(readFileSync(t.obj, "utf8"), "{}");
  t = setup();
  r = run(t, "", { HOME: t.d }); assert.equal(r.rc, 0); assert.match(r.out, /건너뜀/);
  r = run(t, "https://connect-template.invalid/cli-template-body/aws-connect.json"); assert.equal(r.rc, 0); assert.match(r.out, /S3 주소 모양이 아님/);
  r = run(t, VH, { CONNECT_TEMPLATE_SYNC: "0" }); assert.match(r.out, /CONNECT_TEMPLATE_SYNC=0/);
  assert.equal(existsSync(join(t.d, "calls")), false, "건너뛸 때 aws 를 부름");
});

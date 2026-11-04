// APP-20: tools/secret-copy.py — 출발 k8s Secret → 도착 비밀 저장소 새 버전. 값이 화면·명령줄(argv)에 안 나오는지가 핵심.
//   가짜 kubectl(고정 Secret JSON)·gcloud·aws(argv 는 기록, stdin 은 저장소 파일에)를 PATH 앞에 둔다. 진짜 클라우드 안 봄
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const V1 = "s3cr3t-Value-ZZQ9", V2 = "pa55-다른값-QQ7";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const SECRETS = {
  "shop-db": { type: "Opaque", data: { DB_PASSWORD: b64(V1), DB_USER: b64("app") } },
  "shop-api": { type: "Opaque", data: { TOKEN: b64(V2) } },
  "bin-cert": { type: "Opaque", data: { "key.der": Buffer.from([0xff, 0xfe, 0x00, 0x81]).toString("base64") } },
  "sa-token": { type: "kubernetes.io/service-account-token", data: { token: b64("tok") } },
};

function setup(have: string[]) {
  const d = mkdtempSync(join(tmpdir(), "seccopy-")); const store = join(d, "store"); mkdirSync(store);
  for (const h of have) writeFileSync(join(store, h.replace(/\//g, "__")), "");   // 빈 껍데기(terraform 이 만든 항목)
  writeFileSync(join(d, "secrets.json"), JSON.stringify(SECRETS));
  writeFileSync(join(d, "kubectl"), `#!/usr/bin/env python3
import json,sys
s=json.load(open("${d}/secrets.json")); a=sys.argv[1:]
open("${d}/argv","a").write("kubectl "+" ".join(a)+"\\n")
if a[-3:]==["secrets","-o","json"]: print(json.dumps({"items":[{"metadata":{"name":k},"type":v["type"]} for k,v in s.items()]}))
else: n=a[a.index("secret")+1]; print(json.dumps({"data":s[n]["data"]})) if n in s else sys.exit(1)
`);
  const fakeStore = (cli: string) => `#!/usr/bin/env python3
import sys,os
a=sys.argv[1:]; st="${store}"
open("${d}/argv","a").write("${cli} "+" ".join(a)+"\\n")
def f(i): return os.path.join(st,i.replace("/","__"))
if "${cli}"=="gcloud":
  if a[:2]==["secrets","describe"]: sys.exit(0 if os.path.exists(f(a[2])) else 1)
  if a[:3]==["secrets","versions","access"]: p=f(a[a.index("--secret")+1]); v=open(p).read() if os.path.exists(p) else ""; sys.stdout.write(v); sys.exit(0 if v else 1)
  if a[:3]==["secrets","versions","add"]: open(f(a[3]),"w").write(sys.stdin.read()); open("${d}/puts","a").write(a[3]+"\\n"); sys.exit(0)
else:
  sid=a[a.index("--secret-id")+1]
  if a[1]=="describe-secret": sys.exit(0 if os.path.exists(f(sid)) else 1)
  if a[1]=="get-secret-value": v=open(f(sid)).read(); sys.stdout.write(v); sys.exit(0 if v else 1)
  if a[1]=="put-secret-value":
    assert a[a.index("--secret-string")+1]=="file:///dev/stdin"
    open(f(sid),"w").write(open("/dev/stdin").read()); open("${d}/puts","a").write(sid+"\\n"); sys.exit(0)
sys.exit(9)
`;
  writeFileSync(join(d, "gcloud"), fakeStore("gcloud")); writeFileSync(join(d, "aws"), fakeStore("aws"));
  for (const f of ["kubectl", "gcloud", "aws"]) chmodSync(join(d, f), 0o755);
  return { d, store };
}
function run(t: ReturnType<typeof setup>, args: string[]) {
  const r = spawnSync("python3", ["-I", "tools/secret-copy.py", "--context", "src", "--namespace", "shop", "--app", "shop", ...args],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${t.d}:${process.env.PATH}`, TMPDIR: t.d } });
  const argv = existsSync(join(t.d, "argv")) ? readFileSync(join(t.d, "argv"), "utf8") : "";
  const out = r.stdout + r.stderr;
  for (const v of [V1, V2, b64(V1), b64(V2)]) { assert.ok(!out.includes(v), `값이 화면에 나옴`); assert.ok(!argv.includes(v), "값이 명령줄에 나옴"); }
  return { rc: r.status, out, puts: existsSync(join(t.d, "puts")) ? readFileSync(join(t.d, "puts"), "utf8").trim().split("\n") : [] };
}
const read = (t: ReturnType<typeof setup>, id: string) => JSON.parse(readFileSync(join(t.store, id.replace(/\//g, "__")), "utf8"));

test("APP-20 gcp: 지정한 비밀을 {키:값} JSON 새 버전으로, 두 번째는 같음(새 버전 안 만듦)", () => {
  const t = setup(["app-shop-shop-db", "app-shop-shop-api"]);
  let r = run(t, ["--to", "gcp", "--project", "cust-proj", "--secrets", "shop-db,shop-api"]);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /^올림  shop-db → app-shop-shop-db \(키 2개: DB_PASSWORD,DB_USER\)/m);
  assert.deepEqual(read(t, "app-shop-shop-db"), { DB_PASSWORD: V1, DB_USER: "app" });
  assert.deepEqual(read(t, "app-shop-shop-api"), { TOKEN: V2 });
  r = run(t, ["--to", "gcp", "--project", "cust-proj", "--secrets", "shop-db,shop-api"]);
  assert.equal(r.rc, 0); assert.match(r.out, /^같음  shop-db/m); assert.equal(r.puts.length, 2, "같은데 또 넣음");
});

test("APP-20 aws: platform/<회사>/<앱>/<이름> 에 stdin(file:///dev/stdin)으로, 목록이 없으면 Opaque 만", () => {
  const t = setup(["platform/t1/shop/shop-db", "platform/t1/shop/shop-api"]);
  const r = run(t, ["--to", "aws", "--tenant", "t1", "--region", "ap-northeast-2"]);
  assert.match(r.out, /^올림  shop-api → platform\/t1\/shop\/shop-api/m);
  assert.deepEqual(read(t, "platform/t1/shop/shop-db"), { DB_PASSWORD: V1, DB_USER: "app" });
  assert.ok(!/sa-token/.test(r.out), "서비스 계정 토큰까지 올리려 함");
  assert.match(r.out, /^실패  bin-cert .*바이너리/m);   // 목록 기본값에 든 바이너리 비밀은 실패로 알림
  assert.equal(r.rc, 1);
});

test("APP-20 거부: 도착 항목이 없으면 안 만들고 실패, dry-run 은 안 넣음, 인자 빠지면 2", () => {
  const t = setup(["app-shop-shop-db"]);
  let r = run(t, ["--to", "gcp", "--project", "cust-proj", "--secrets", "shop-db,shop-api"]);
  assert.equal(r.rc, 1); assert.match(r.out, /^실패  shop-api → app-shop-shop-api: 도착 비밀 저장소 항목이 없음/m);
  assert.equal(existsSync(join(t.store, "app-shop-shop-api")), false);
  const t2 = setup(["app-shop-shop-db"]);
  r = run(t2, ["--to", "gcp", "--project", "cust-proj", "--secrets", "shop-db", "--dry"]);
  assert.equal(r.rc, 0); assert.match(r.out, /^dry-run: 올릴 것  shop-db/m); assert.equal(r.puts.length, 0);
  assert.equal(run(t2, ["--to", "gcp", "--secrets", "shop-db"]).rc, 2);
  assert.equal(run(t2, ["--to", "aws", "--secrets", "shop-db"]).rc, 2);
});

// G3c-2·G3c-5·G3c-6: checkV2 가 보조·초기화 컨테이너까지 보고, 검토 줄을 내용 키로 내고, 작은 모순(포트·자기 참조·이름 중복)을 잡는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, SpecConfirmPath, checkV2, checkV2Reviews, syncCheckReviews } from "../src/index.js";

const D = "sha256:" + "a".repeat(64);
const img = { source: "registry", repository: "ghcr.io/demo/x", digest: D };
const base = (): any => ({
  schemaVersion: "2", app: { name: "shop" },
  components: [
    { id: "api", kind: "service", props: { runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop", image: img,
      resources: {}, serviceAccount: "default", replicas: { min: 1, max: 1 }, ports: [{ port: 8080 }],
      endpoints: [{ name: "api", type: "ClusterIP", ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }] }],
      env: [{ name: "DB_HOST", fromLink: { to: "db", output: "host" } }],
      sidecars: [{ name: "proxy", image: img, env: [], resources: {} }],
      initContainers: [{ name: "migrate", image: img, env: [], resources: {} }] } },
    { id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 20, ha: false } },
    { id: "jobs", kind: "queue", props: { model: "queue" } },
  ],
  links: [{ from: "api", to: "db", intent: "connect" }],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], routes: [
    { matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "api", port: 80, weight: 1 }] }] }] },
  posture: { permissions: [], network: [] },
});
type FM = Record<string, any>;
const parsed = (s: unknown) => { const p = AppSpecV2.safeParse(s); assert.ok(p.success, JSON.stringify(p.error?.issues?.slice(0, 3))); return p.data!; };

test("G3c-2 정상: 준비한 명세는 오류·검토 없음", () => {
  assert.deepEqual(checkV2(parsed(base())), { errors: [], reviews: [], approvals: [] });
});

test("G3c-2 거부: 보조·초기화 컨테이너 env·args 의 벤더 주소·사설 IP 는 검토 줄, 링크 없는 fromLink 는 오류", () => {
  const s = base();
  const api = s.components[0].props;
  api.sidecars[0].env.push({ name: "QUEUE", value: "https://sqs.ap-northeast-2.amazonaws.com/0/jobs" });
  api.initContainers[0].args = ["--host", "10.0.3.4"];
  const r = checkV2(parsed(s));
  assert.ok(r.reviews.some((x) => x.includes("api.sidecars.proxy.env.QUEUE") && x.includes("벤더 주소")), r.reviews.join("\n"));
  assert.ok(r.reviews.some((x) => x.includes("api.initContainers.migrate.args[1]") && x.includes("사설 IP")), r.reviews.join("\n"));
  const s2 = base();
  s2.components[0].props.sidecars[0].env.push({ name: "Q", fromLink: { to: "jobs", output: "url" } });
  assert.ok(checkV2(parsed(s2)).errors.some((e) => e.includes("api.sidecars.proxy.env.Q 참조 jobs 에 맞는 의존성 없음")));
});

test("G3c-5 정상: 검토 줄 키는 내용 키, 같은 값이면 판이 바뀌어도 같고 확인 표시가 유지된다", () => {
  const s = base();
  s.components[0].props.env.push({ name: "BUCKET_HOST", value: "shop.s3.amazonaws.com" });
  const items = checkV2Reviews(parsed(s));
  assert.equal(items.length, 1);
  assert.match(items[0]!.key, /^check\.api\.env\.BUCKET_HOST\.vendor\.[0-9a-f]{8}$/);
  assert.equal(SpecConfirmPath.safeParse(items[0]!.key).success, true, "화면이 그대로 confirm 에 보낼 수 있다");
  const m1 = syncCheckReviews<FM>({ "check.reviews[0]": { source: "checkV2", confidence: 0.6, needs_review: true } }, items);
  assert.deepEqual(Object.keys(m1), [items[0]!.key], "예전 번호 키는 지워짐");
  assert.equal((m1[items[0]!.key] as { needs_review: boolean }).needs_review, true);
  // 사람이 확인 → 다른 칸을 고쳐 다시 맞춰도 확인 유지
  const confirmed = { ...m1, [items[0]!.key]: { ...(m1[items[0]!.key] as object), needs_review: false } } as typeof m1;
  const s2 = structuredClone(s); s2.components[0].props.replicas = { min: 2, max: 2 };
  const m2 = syncCheckReviews(confirmed, checkV2Reviews(parsed(s2)));
  assert.equal((m2[items[0]!.key] as { needs_review: boolean }).needs_review, false);
});

test("G3c-5 거부: 사람이 고쳐 없어진 줄은 지우고, 새로 넣은 벤더 주소·사설 IP 는 새 검토 줄이 된다", () => {
  const s = base();
  s.components[0].props.env.push({ name: "BUCKET_HOST", value: "shop.s3.amazonaws.com" });
  const m1 = syncCheckReviews<FM>({ keep: { source: "k8s", confidence: 1, needs_review: false } }, checkV2Reviews(parsed(s)));
  // env 를 지우고 대신 사설 IP 를 넣음
  const s2 = base(); s2.components[0].props.env.push({ name: "PEER", value: "192.168.0.7:5432" });
  const m2 = syncCheckReviews(m1, checkV2Reviews(parsed(s2)));
  assert.ok(!Object.keys(m2).some((k) => k.includes("BUCKET_HOST")));
  const ip = Object.keys(m2).find((k) => k.startsWith("check.api.env.PEER.privateIp."));
  assert.ok(ip, Object.keys(m2).join());
  assert.equal((m2[ip!] as { needs_review: boolean }).needs_review, true);
  assert.ok("keep" in m2, "check 밖 키는 그대로");
  // 같은 자리에 다른 벤더 값을 넣으면 확인했어도 새 줄 (값 지문이 다름)
  const s3 = base(); s3.components[0].props.env.push({ name: "BUCKET_HOST", value: "other.s3.amazonaws.com" });
  const k1 = Object.keys(m1).find((k) => k.startsWith("check."))!;
  const m3 = syncCheckReviews<FM>({ [k1]: { source: "checkV2", confidence: 0.6, needs_review: false } }, checkV2Reviews(parsed(s3)));
  assert.ok(!(k1 in m3));
  assert.equal(Object.values(m3).every((v) => (v as { needs_review: boolean }).needs_review), true);
});

test("G3c-6 정상: 라우팅 포트가 Service 포트(80)나 컨테이너 포트(8080)면 검토 없음", () => {
  const s = base();
  s.entry.hosts[0].routes.push({ matches: [{ path: { type: "PathPrefix", value: "/raw" } }], backends: [{ to: "api", port: 8080, weight: 1 }] });
  assert.deepEqual(checkV2(parsed(s)), { errors: [], reviews: [], approvals: [] });
});

test("G3c-6 거부: 없는 포트·자기 참조·이름 중복·경로 0개 호스트·끝 하이픈 id", () => {
  const port = base(); port.entry.hosts[0].routes[0].backends[0].port = 9999;
  assert.ok(checkV2Reviews(parsed(port)).some((r) => r.key === "check.entry.shop.example.com.routes.api.9999.port"));
  const dl = base(); dl.components[2].props.deadLetter = { to: "jobs" };
  assert.ok(checkV2(parsed(dl)).errors.includes("jobs.deadLetter.to 가 자기 자신"));
  const self = base(); self.links.push({ from: "api", to: "api", intent: "call" });
  assert.ok(checkV2(parsed(self)).errors.some((e) => e.startsWith("의존성이 자기 자신")));
  const dupC = base(); dupC.components[0].props.initContainers.push({ name: "proxy", image: img, env: [], resources: {} });
  assert.ok(checkV2(parsed(dupC)).errors.includes("api 컨테이너 이름 중복: proxy"));
  const dupV = base(); dupV.components[0].props.volumes = [{ name: "data", mountPath: "/d" }];
  dupV.components[0].props.podVolumes = [{ name: "data", type: "emptyDir", source: {} }];
  assert.ok(checkV2(parsed(dupV)).errors.includes("api 볼륨 이름 중복: data"));
  const dupE = base(); dupE.components[0].props.env.push({ name: "DB_HOST", value: "x" });
  assert.ok(checkV2Reviews(parsed(dupE)).some((r) => r.key === "check.api.env.DB_HOST.dup"));
  const noRoutes = base(); noRoutes.entry.hosts[0].routes = [];
  assert.equal(AppSpecV2.safeParse(noRoutes).success, false);
  const dash = base(); dash.components[1].id = "db-"; dash.links[0].to = "db-";
  assert.equal(AppSpecV2.safeParse(dash).success, false);
  assert.ok(checkV2(dash).errors.some((e) => e.startsWith("id 모양 틀림: db-")));
});

// CRIMPORT: GCP Cloud Run 출발 갈래 (Reader gcp-cloudrun · 매퍼 cloudrun-service · discover gcp v2 · 권한 표). 클라우드 CLI 는 가짜 exec
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, ImportResultV2 } from "@svc/contracts";
import {
  AdapterError, CLOUDRUN_COMMANDS, CLOUDRUN_OBSERVE_PERMISSIONS, cloudRunJobMapper, cloudRunServiceMapper, discoverGcp, GCP_COMMAND_PERMISSIONS,
  inventoryForAudit, normalizeV2, readCloudRun, saNameOf,
} from "../src/index.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D1 = "sha256:" + "a1".repeat(32), D2 = "sha256:" + "b2".repeat(32), DJ = "sha256:" + "c3".repeat(32);
const P = "cust-prj";
const REG = "asia-northeast3";
const loc = { "cloud.googleapis.com/location": REG };

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    return { code: hit[1].code ?? 0, stdout: JSON.stringify(hit[1].out ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}

const svc = (name: string, o: { labels?: Record<string, string>; ingress?: string; min?: string; max?: string; rev?: string | null; sa?: string; containers: unknown[] }) => ({
  apiVersion: "serving.knative.dev/v1", kind: "Service",
  metadata: { name, uid: `uid-${name}`, labels: { ...loc, ...(o.labels ?? {}) }, annotations: { "run.googleapis.com/ingress": o.ingress ?? "all", "serving.knative.dev/creator": "someone" } },
  spec: { template: { metadata: { annotations: { ...(o.min ? { "autoscaling.knative.dev/minScale": o.min } : {}), ...(o.max ? { "autoscaling.knative.dev/maxScale": o.max } : {}) } },
    spec: { serviceAccountName: o.sa ?? `${name}@${P}.iam.gserviceaccount.com`, containerConcurrency: 80, containers: o.containers } } },
  status: { url: `https://${name}-xyz123-an.a.run.app`, ...(o.rev === null ? {} : { latestReadyRevisionName: o.rev ?? `${name}-00007-abc` }) },
});

const API = svc("shop-api", { labels: { app: "shop" }, min: "1", max: "5", containers: [{
  name: "api", image: `${REG}-docker.pkg.dev/${P}/shop/api:1.4.2`, ports: [{ name: "http1", containerPort: 8080 }],
  env: [{ name: "LOG_LEVEL", value: "info" }, { name: "API_KEY", value: "sk-ant-aaaaaaaaaaaaaaaaaaaa" },
    { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db-pass", key: "latest" } } },
    { name: "SIGNING_KEY", valueFrom: { secretKeyRef: { name: "shop-sign", key: "3" } } }],
  resources: { limits: { cpu: "1000m", memory: "512Mi" } },
  startupProbe: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 10, failureThreshold: 3 },
  livenessProbe: { httpGet: { path: "/livez" }, periodSeconds: 30 },
  volumeMounts: [{ name: "x", mountPath: "/x" }],
}] });
const WEB = svc("shop-web", { labels: { app: "shop" }, containers: [{
  name: "web", image: `${REG}-docker.pkg.dev/${P}/shop/web:2.0.0`, ports: [{ containerPort: 3000 }],
  env: [{ name: "API_URL", value: "https://shop-api-xyz123-an.a.run.app" }], resources: { limits: { cpu: "1", memory: "256Mi" } },
}] });
const OTHER = svc("billing", { labels: { app: "billing" }, containers: [{ image: `${REG}-docker.pkg.dev/${P}/b/b@${D1}`, ports: [{ containerPort: 8080 }] }] });
const job = (name: string, image: string, labels: Record<string, string> = { app: "shop" }) => ({
  metadata: { name, uid: `uid-${name}`, labels: { ...loc, ...labels } },
  spec: { template: { spec: { taskCount: 1, parallelism: 1, template: { spec: { maxRetries: 2, timeoutSeconds: "600s", serviceAccountName: `shop-api@${P}.iam.gserviceaccount.com`,
    containers: [{ image, env: [{ name: "MODE", value: "nightly" }], resources: { limits: { cpu: "1", memory: "1Gi" } } }] } } } } },
});
const RUN_TABLE: Array<[RegExp, Reply]> = [
  [/^gcloud run services list/, { out: [WEB, API, OTHER] }],
  [/^gcloud run revisions describe shop-api-00007-abc --region asia-northeast3/, { out: { status: { imageDigest: `${REG}-docker.pkg.dev/${P}/shop/api@${D1}`.split("@")[1] } } }],
  [/^gcloud run revisions describe shop-web-00007-abc/, { out: { status: { imageDigest: D2 } } }],
  [/^gcloud run services get-iam-policy shop-web/, { out: { bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] } }],
  [/^gcloud run services get-iam-policy shop-api/, { out: { bindings: [{ role: "roles/run.invoker", members: [`serviceAccount:shop-web@${P}.iam.gserviceaccount.com`] }] } }],
  [/^gcloud run domain-mappings list --region asia-northeast3/, { out: [{ metadata: { name: "shop.example.com" }, spec: { routeName: "shop-web" } }] }],
  [/^gcloud run jobs list/, { out: [job("nightly", `${REG}-docker.pkg.dev/${P}/shop/batch@${DJ}`), job("adhoc", `${REG}-docker.pkg.dev/${P}/shop/batch@${DJ}`)] }],
  [/^gcloud scheduler jobs list --location asia-northeast3/, { out: [
    { name: `projects/${P}/locations/${REG}/jobs/nightly-trigger`, schedule: "0 3 * * *", timeZone: "Asia/Seoul", state: "ENABLED",
      httpTarget: { uri: `https://${REG}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${P}/jobs/nightly:run` } },
  ] }],
];
const ENV = { IMPORT_GCP_RUN_LABEL: "app=shop" };

test("Reader gcp-cloudrun: 라벨로 앱 묶기 → 서비스 2개 + 잡 2개 원본, digest·공개·도메인·일정, 읽기 명령만, 허용 목록 밖 칸 없음", async () => {
  const { exec, calls } = fakeExec(RUN_TABLE);
  const r = await readCloudRun({ exec, env: {} }, P, ENV);
  assert.deepEqual(r.counts, { "cloudrun.service": 2, "cloudrun.job": 2 });
  assert.deepEqual(r.items.map((i) => `${i.kind}:${i.name}`), ["cloudrun.service:shop-api", "cloudrun.service:shop-web", "cloudrun.job:adhoc", "cloudrun.job:nightly"]);
  const api = r.items[0] as Record<string, any>, web = r.items[1] as Record<string, any>, nightly = r.items[3] as Record<string, any>;
  assert.equal(api.imageDigest, D1);
  assert.equal(api.invokerAllUsers, false);
  assert.equal(web.invokerAllUsers, true);
  assert.deepEqual(web.domains, ["shop.example.com"]);
  assert.equal(api.urlHost, "shop-api-xyz123-an.a.run.app");
  assert.deepEqual(api.labels, { app: "shop" }, "cloud.googleapis.com 라벨은 뺌");
  assert.equal("volumeMounts" in api.containers[0], false, "허용 목록 밖 칸은 안 넣음");
  assert.deepEqual(api.containers[0].env[2], { name: "DB_PASSWORD", secret: { name: "shop-db-pass", version: "latest" } });
  assert.deepEqual(nightly.schedule, { cron: "0 3 * * *", timeZone: "Asia/Seoul", paused: false });
  assert.equal((r.items[2] as Record<string, any>).schedule, null);
  assert.ok(r.notes.some((n) => /라벨 app=shop 로 서비스 2\/3/.test(n)));
  assert.ok(calls.every((c) => /^gcloud (run [a-z-]+ (list|describe|get-iam-policy)|scheduler jobs list)\b/.test(c)), calls.join("\n"));
  assert.ok(calls.every((c) => !/versions access|secrets versions/.test(c)), "비밀 값 읽기 0");
});

test("정상: Cloud Run 원본 → normalizeV2 → IR v2 (관리형 서비스 2 + 일정 잡 1), 연결·라우팅·보안 기준선·검토 표시, 같은 입력 = 같은 결과", async () => {
  const { exec } = fakeExec(RUN_TABLE);
  const r0 = await readCloudRun({ exec, env: {} }, P, ENV);
  const inv = { provider: "gcp" as const, coverage: {}, items: r0.items as never };
  const a = normalizeV2(inv), b = normalizeV2(inv);
  assert.equal(JSON.stringify(a.result), JSON.stringify(b.result));
  const r = ImportResultV2.parse(a.result);
  assert.equal(AppSpecV2.safeParse(r.spec).success, true);
  assert.deepEqual(checkV2(r.spec).errors, []);
  assert.deepEqual(r.spec.components.map((c) => `${c.kind}:${c.id}`), ["service:shop-api", "job:nightly", "service:shop-web"].sort((x, y) => x.split(":")[1]!.localeCompare(y.split(":")[1]!)));
  const api = r.spec.components.find((c) => c.id === "shop-api")!;
  assert.ok(api.kind === "service");
  assert.equal(api.props.runtime, "managedContainer");
  assert.deepEqual(api.props.origin, { runtime: "managedContainer", product: "cloudRun" });
  assert.deepEqual(api.props.image, { source: "registry", repository: `${REG}-docker.pkg.dev/${P}/shop/api`, digest: D1 });
  assert.deepEqual(api.props.replicas, { min: 1, max: 5 });
  assert.deepEqual(api.props.resources, { limit: { cpuMilli: 1000, memMiB: 512 } });
  assert.equal(api.props.serviceAccount, "shop-api");
  assert.deepEqual(api.props.ports, [{ name: "http1", port: 8080, protocol: "TCP" }]);
  assert.deepEqual(api.props.probes, { readiness: { type: "http", path: "/healthz", port: 8080, periodSec: 10, failureThreshold: 3 }, liveness: { type: "http", path: "/livez", port: 8080, periodSec: 30 } });
  // 비밀: 참조만 (값 0), 평문 비밀 env 는 명세에서 빠짐
  assert.deepEqual(api.props.env.find((e) => e.name === "DB_PASSWORD"), { name: "DB_PASSWORD", fromSecret: { secret: "shop-db-pass", key: "DB_PASSWORD" } });
  assert.equal(api.props.env.some((e) => e.name === "API_KEY"), false);
  assert.ok(r.unmapped.some((u) => u.resource === "env:shop-api.API_KEY" && u.grade === "B"));
  assert.equal(JSON.stringify(r.spec).includes("sk-ant-"), false, "평문 비밀 값이 명세 어디에도 없음");
  // 연결: web 이 api 의 run.app 주소를 env 에 적음 → call 의존성 + template
  assert.deepEqual(r.spec.links.map((l) => `${l.from}->${String(l.to)}:${l.intent}`), ["shop-web->shop-api:call"]);
  const web = r.spec.components.find((c) => c.id === "shop-web")!;
  assert.ok(web.kind === "service");
  assert.deepEqual(web.props.env, [{ name: "API_URL", template: "https://${shop-api.host}" }]);
  assert.deepEqual(web.props.replicas, { min: 0, max: 100 }, "적히지 않은 쪽은 Cloud Run 기본값");
  // 라우팅: 사용자 도메인만 (run.app 주소는 안 넣음)
  assert.deepEqual(r.spec.entry?.hosts.map((h) => h.hostnames[0]), ["shop.example.com"]);
  assert.deepEqual(r.spec.entry?.hosts[0]?.routes.map((x) => x.backends[0]!.to), ["shop-web"]);
  // 보안 기준선: web 은 공개(ingress all + allUsers), api 는 ingress all 이지만 호출 권한이 막혀 비공개
  const net = (id: string) => r.spec.posture.network.find((n) => n.scope === "component" && n.subject === id) as { public: boolean | null; ingress: unknown };
  assert.equal(net("shop-web").public, true);
  assert.equal(net("shop-api").public, false);
  assert.deepEqual(net("shop-api").ingress, [{ from: "0.0.0.0/0", port: 8080 }]);
  // 잡: 일정·시간대·재시도·마감
  const nightly = r.spec.components.find((c) => c.id === "nightly")!;
  assert.ok(nightly.kind === "job");
  assert.deepEqual({ s: nightly.props.schedule, tz: nightly.props.timeZone, b: nightly.props.backoffLimit, d: nightly.props.activeDeadlineSec, sa: nightly.props.serviceAccount },
    { s: "0 3 * * *", tz: "Asia/Seoul", b: 2, d: 600, sa: "shop-api" });
  // 일정 없는 잡은 unmapped B
  assert.ok(r.unmapped.some((u) => u.resource === "cloudrun.job:adhoc" && u.grade === "B"));
  // 검토 표시: 자원(limits)·버전 고정 비밀은 needs_review
  assert.equal(r.fieldMeta["components.shop-api.resources"]?.needs_review, true);
  assert.match(String(r.fieldMeta["components.shop-api.env"]?.rationale), /SIGNING_KEY/);
});

test("거부: digest 없는 서비스·일정 없는 잡·깨진 원본은 리소스로 안 만들고 unmapped (조용히 버리지 않음)", () => {
  const base = { kind: "cloudrun.service", name: "x", region: REG, containers: [{ image: "r/x:1", ports: [{ containerPort: 80 }] }] };
  const s1 = cloudRunServiceMapper.map({ ...base, imageDigest: null });
  assert.ok("skip" in s1 && s1.grade === "B" && /digest/.test(s1.skip));
  const s2 = cloudRunServiceMapper.map({ kind: "cloudrun.service", name: "y" } as never);
  assert.ok("skip" in s2 && s2.grade === "C");
  const j1 = cloudRunJobMapper.map({ kind: "cloudrun.job", name: "j", region: REG, containers: [{ image: `r/j@${DJ}` }], schedule: null });
  assert.ok("skip" in j1 && j1.grade === "B" && /일정/.test(j1.skip));
  const j2 = cloudRunJobMapper.map({ kind: "cloudrun.job", name: "j", region: REG, containers: [{ image: "r/j:1" }], schedule: { cron: "0 3 * * *", paused: false } });
  assert.ok("skip" in j2 && /digest/.test(j2.skip));
  const j3 = cloudRunJobMapper.map({ kind: "cloudrun.job", name: "j", region: REG, containers: [{ image: `r/j@${DJ}` }, { image: `r/k@${DJ}` }], schedule: { cron: "0 3 * * *", paused: false } });
  assert.ok("skip" in j3 && /컨테이너 2개/.test(j3.skip));
  // 정지된 일정 → suspend, 기본 컴퓨트 SA → default
  const j4 = cloudRunJobMapper.map({ kind: "cloudrun.job", name: "j", region: REG, serviceAccount: `123-compute@developer.gserviceaccount.com`,
    containers: [{ image: `r/j@${DJ}` }], schedule: { cron: "0 3 * * *", paused: true } });
  assert.ok(!("skip" in j4) && j4.props.suspend === true && j4.props.serviceAccount === "default");
  assert.equal(saNameOf(null), null);
  // internal ingress: 출발 원본 이름 그대로 (도착이 못 옮김 → 사람이 정함), 공개 아님
  const s3 = cloudRunServiceMapper.map({ ...base, imageDigest: D1, ingress: "internal", invokerAllUsers: true });
  assert.ok(!("skip" in s3));
  assert.deepEqual(s3.network, { ingress: [{ from: "cloudrun-ingress:internal", port: 80 }], public: false });
  // 호출 권한을 못 읽으면 공개 여부 모름(null) + 검토 0.6
  const s4 = cloudRunServiceMapper.map({ ...base, imageDigest: D1, ingress: "all", invokerAllUsers: null });
  assert.ok(!("skip" in s4) && s4.network?.public === null && s4.meta.network?.[1] === 0.6);
});

test("거부: 권한 표의 Cloud Run 읽기는 읽기 접미사만 (쓰기·실행·IAM 바꾸기 0), reader 명령 = 표", () => {
  assert.deepEqual([...CLOUDRUN_OBSERVE_PERMISSIONS].sort(),
    ["cloudscheduler.jobs.list", "run.domainmappings.list", "run.jobs.list", "run.locations.list", "run.revisions.get", "run.services.getIamPolicy", "run.services.list"]);
  for (const p of CLOUDRUN_OBSERVE_PERMISSIONS) assert.match(p, /\.(get|list|getIamPolicy)$/, p);
  for (const k of CLOUDRUN_COMMANDS) assert.ok(k in GCP_COMMAND_PERMISSIONS, k);
  assert.ok(!CLOUDRUN_OBSERVE_PERMISSIONS.some((p) => /\.(run|update|create|delete|setIamPolicy|pause|resume)$/.test(p)));
});

test("감사 사본: Cloud Run 환경변수 값·명령·인자를 지우고 비밀 참조(이름·버전)만 남김", async () => {
  const { exec } = fakeExec(RUN_TABLE);
  const r0 = await readCloudRun({ exec, env: {} }, P, ENV);
  const a = inventoryForAudit({ provider: "gcp", coverage: {}, items: r0.items as never });
  const s = JSON.stringify(a.items);
  assert.equal(s.includes("sk-ant-"), false);
  assert.equal(s.includes("https://shop-api-xyz123"), false, "env 값은 이름만");
  assert.ok(s.includes("\"shop-db-pass\""), "비밀 참조 이름은 남김");
  assert.ok(JSON.stringify(r0.items).includes("sk-ant-"), "원본(매퍼 입력)은 그대로");
});

test("discover gcp: v2 는 GKE 없이 Cloud Run 만 있어도 읽고, v1 은 지금처럼 GKE 필수 (Cloud Run 안 부름)", async () => {
  const base: Array<[RegExp, Reply]> = [
    [/^gcloud config get-value project/, { out: P }],
    [/^gcloud projects describe/, { out: { projectId: P } }],
    [/^gcloud container clusters list/, { out: [] }],
    [/^gcloud (sql instances list|compute networks list|compute forwarding-rules list|artifacts repositories list|secrets list|storage buckets list|pubsub topics list|pubsub subscriptions list|redis instances list)/, { out: [] }],
  ];
  const { exec, calls } = fakeExec([...base, ...RUN_TABLE]);
  const inv = await discoverGcp({ exec, env: { GCP_PROJECT: P, ...ENV } }, { ir: "v2" });
  const kinds = (inv.items as Array<{ kind: string }>).map((i) => i.kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith("cloudrun.")), ["cloudrun.service", "cloudrun.service", "cloudrun.job", "cloudrun.job"]);
  assert.ok(!kinds.includes("gke.cluster"));
  assert.ok(!calls.some((c) => /get-credentials/.test(c)));
  const n = normalizeV2(inv).result;
  assert.deepEqual(checkV2(n.spec).errors, []);
  assert.ok(n.spec.components.some((c) => c.id === "shop-api"));

  const v1 = fakeExec([...base, ...RUN_TABLE]);
  await assert.rejects(discoverGcp({ exec: v1.exec, env: { GCP_PROJECT: P } }, {}), (e: unknown) => e instanceof AdapterError && e.code === "SOURCE_INCOMPLETE");
  assert.ok(!v1.calls.some((c) => /^gcloud run /.test(c)), "v1 은 Cloud Run 을 안 부름");
  // Cloud Run 읽기가 통째로 실패하면 GKE 없는 v2 도 지금처럼 SOURCE_INCOMPLETE (원인은 notes)
  const bad = fakeExec(base);
  await assert.rejects(discoverGcp({ exec: bad.exec, env: { GCP_PROJECT: P } }, { ir: "v2" }), /Cloud Run 서비스도 없음/);
});

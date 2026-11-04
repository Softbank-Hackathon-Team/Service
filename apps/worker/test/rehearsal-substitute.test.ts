// 리허설 치환 황금 시험: 실제 어댑터 값(데모 3티어 명세) → 실제 차트(gitops/charts/app) helm 렌더 → 치환.
//   원본·적용 사본의 차이 경로 집합 = 충실도 refs 합집합 (표에 없는 바꿈이 생기면 빨개진다)
//   데모 명세가 안 쓰는 차트 기능(StatefulSet volumeClaimTemplates·PVC·LB Service·IRSA·Ingress·배치 규칙)은 손으로 쓴 문서를 더해 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:tls";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments, parse, stringify } from "yaml";
import { RehearsalInput, type Provider } from "@svc/contracts";
import { DEMO_SPEC, STUB_TF_OUTPUTS, stubTfOutputsV2 } from "@svc/adapters";
import { buildPlanDoc } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";
import { approvedWeights, bundleRefOf, filledValues, withServedBy, withTraffic, type DeployInput } from "../src/gitops/index.js";
import { buildRehearsalInput, imagePairs, parseManifests } from "../src/rehearsal/input.js";
import { docIdOf, podImages, quantity, refOf, substitute, unsupportedOf, type K8sDoc } from "../src/rehearsal/substitute.js";

const hasHelm = (() => { try { execFileSync("helm", ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasHelm ? false : "helm 이 있어야 한다";
const CHART = join(import.meta.dirname, "..", "..", "..", "gitops", "charts", "app");
const TENANT = "9f8e7d6c-0000-4000-8000-000000000001";
const RDS = "shop-db.c1x2y3z4.ap-northeast-2.rds.amazonaws.com", CLOUDSQL = "10.20.0.5";

function inputFor(provider: Provider): DeployInput {
  const envId = "33333333-3333-4333-8333-333333333333";
  const plan = buildPlanDoc({ planId: "7f000000-0000-4000-8000-000000000001", migrationId: "4a8c0000-0000-4000-8000-000000000001",
    spec: DEMO_SPEC, target: { envId, provider, region: "default" }, precheck: stubPrecheck(), now: new Date() });
  const host = provider === "aws" ? RDS : provider === "gcp" ? CLOUDSQL : "unused";
  return { tenantId: TENANT, spec: DEMO_SPEC, plan, target: { envId, provider, region: "default", accountId: "123456789012" },
    tfOutputs: { ...STUB_TF_OUTPUTS, ...stubTfOutputsV2(DEMO_SPEC), "link.shop-db.host": host } };
}

// gitops 레포 tools/lib.mjs renderDocs·writeBundle 과 같은 모양 (네임스페이스 채움, 종류/이름 정렬, 파일 하나에 문서 하나)
function render(i: DeployInput, extra: K8sDoc[] = []) {
  const b = bundleRefOf(i);
  const values = withServedBy(withTraffic(filledValues(i), approvedWeights(i.plan), 0), b);
  const dir = mkdtempSync(join(tmpdir(), "rehearsal-golden-"));
  try {
    writeFileSync(join(dir, "values.yaml"), JSON.stringify(values));
    const ns = `app-${b.app}`;
    const out = execFileSync("helm", ["template", b.app, CHART, "-f", join(dir, "values.yaml"), "--namespace", ns], { encoding: "utf8" });
    const docs = [...parseAllDocuments(out).map((d) => d.toJS() as K8sDoc).filter(Boolean), ...extra.map((d) => structuredClone(d))];
    for (const d of docs) d.metadata.namespace = ns;
    docs.sort((x, y) => `${x.kind}/${x.metadata.name}`.localeCompare(`${y.kind}/${y.metadata.name}`));
    const manifests = docs.map((doc) => ({ path: `manifests/${doc.kind.toLowerCase()}-${doc.metadata.name}.yaml`, yaml: stringify(doc) }));
    return { values, rendered: { bundleSha256: `golden-${i.target.provider}`, manifests } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 시험 쪽 차이 계산 (치환 코드와 따로): 한쪽에만 있는 키·문서는 그 자리, 둘 다 있으면 끝까지 내려가 다른 값의 자리
function diffPaths(original: readonly { yaml: string }[], apply: readonly { yaml: string }[]): string[] {
  const byId = (xs: readonly { yaml: string }[]) => new Map(xs.map((x) => { const d = parse(x.yaml) as K8sDoc; return [docIdOf(d), d]; }));
  const a = byId(original), b = byId(apply), out: string[] = [];
  const walk = (id: string, x: unknown, y: unknown, segs: Array<string | number>) => {
    const obj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
    if (obj(x) && obj(y)) {
      const xo = x as Record<string, unknown>, yo = y as Record<string, unknown>;
      for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)]))
        if (!(k in xo) || !(k in yo)) out.push(refOf(id, [...segs, k])); else walk(id, xo[k], yo[k], [...segs, k]);
    } else if (Array.isArray(x) && Array.isArray(y)) {
      for (let n = 0; n < Math.max(x.length, y.length); n++)
        if (n >= x.length || n >= y.length) out.push(refOf(id, [...segs, n])); else walk(id, x[n], y[n], [...segs, n]);
    } else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(refOf(id, segs));
  };
  for (const id of new Set([...a.keys(), ...b.keys()]))
    if (!a.has(id) || !b.has(id)) out.push(id); else walk(id, a.get(id), b.get(id), []);
  return out.sort();
}

const EXTRA: K8sDoc[] = [
  { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "cache" }, spec: {
    replicas: 3, serviceName: "cache", selector: { matchLabels: { app: "cache" } },
    volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: "gp3", resources: { requests: { storage: "10Gi" } } } }],
    template: { metadata: { labels: { app: "cache" } }, spec: {
      nodeSelector: { pool: "general" }, tolerations: [{ key: "dedicated", operator: "Exists" }], priorityClassName: "high",
      containers: [{ name: "redis", image: "redis:7.2", resources: { limits: { cpu: "2", memory: "4Gi" } }, volumeMounts: [{ name: "data", mountPath: "/data" }] }] } } } },
  { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "shop-api-uploads" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } } },
  { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "uploader" }, spec: { replicas: 1, selector: { matchLabels: { app: "uploader" } },
    template: { metadata: { labels: { app: "uploader" } }, spec: {
      containers: [{ name: "app", image: "ghcr.io/demo/uploader@sha256:" + "c".repeat(64), env: [{ name: "DATABASE_URL", value: `postgres://app:x@${RDS}:5432/shop_api` }],
        resources: { requests: { cpu: "50m", memory: "64Mi" } } }],
      volumes: [{ name: "uploads", persistentVolumeClaim: { claimName: "shop-api-uploads" } }] } } } },
  { apiVersion: "v1", kind: "Service", metadata: { name: "public" }, spec: { type: "LoadBalancer", externalTrafficPolicy: "Local",
    selector: { app: "uploader" }, ports: [{ port: 443, targetPort: 8443, nodePort: 31443 }] } },
  { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "uploader", annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123456789012:role/x", keep: "yes" } } },
  { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: "shop" }, spec: { rules: [{ host: "shop.example.com", http: { paths: [
    { path: "/", pathType: "Prefix", backend: { service: { name: "shop-web", port: { number: 80 } } } }] } }] } },
  { apiVersion: "external-secrets.io/v1", kind: "ExternalSecret", metadata: { name: "regcred" }, spec: {
    secretStoreRef: { kind: "ClusterSecretStore", name: "s" }, target: { name: "regcred", template: { type: "kubernetes.io/dockerconfigjson" } },
    dataFrom: [{ extract: { key: "regcred" } }] } },
];

const sandboxImages = (refs: string[]) => refs.map((ref) => ({ ref, sandboxRef: `ecr.example/sandbox/${TENANT}/${ref.split("/").pop()!}` }));
const items = (x: RehearsalInput) => Object.fromEntries(x.fidelity.items.map((i) => [i.id, i]));
const applyDoc = (x: RehearsalInput, id: string) => x.apply.map((m) => parse(m.yaml) as K8sDoc).find((d) => docIdOf(d) === id);

for (const provider of ["aws", "gcp", "onprem"] as const) {
  test(`${provider}: 차이 경로 = 충실도 refs 합집합, 입력 계약을 지난다`, { skip }, () => {
    const i = inputFor(provider);
    const { values, rendered } = render(i, EXTRA);
    const docs = parseManifests(rendered);
    assert.deepEqual(unsupportedOf(docs), []);
    const target = ({ aws: "aws-eks", gcp: "gcp-gke", onprem: "onprem-k3s" } as const)[provider];
    const x = buildRehearsalInput({ target, i, values, rendered, docs, images: sandboxImages(podImages(docs)), mirrored: true, runBudgetSec: 1200 });
    assert.ok(RehearsalInput.safeParse(x).success);
    assert.deepEqual([x.imagesMirrored, x.runBudgetSec], [true, 1200]);
    const refs = x.fidelity.items.flatMap((it) => it.refs).sort();
    assert.deepEqual(refs, diffPaths(x.original, x.apply));
    assert.equal(new Set(refs).size, refs.length, "한 자리는 한 항목에만");
    assert.deepEqual(x.original, rendered.manifests, "원본은 렌더 글자 그대로");
  });
}

test("aws: RDS 주소·비밀·터널·Ingress·이미지·복제 수·요청량·배치·저장소·LB 를 표대로 바꾼다", { skip }, () => {
  const i = inputFor("aws");
  const { values, rendered } = render(i, EXTRA);
  const docs = parseManifests(rendered);
  const x = buildRehearsalInput({ target: "aws-eks", i, values, rendered, docs, images: sandboxImages(podImages(docs)), mirrored: true, runBudgetSec: 1200 });
  const ns = x.namespace, it = items(x);
  assert.equal(ns, "app-shop-api");
  const sbxHost = `sbx-db-shop-db.${ns}.svc.cluster.local`;
  // 관리형 DB → 같은 메이저 Postgres. env 의 RDS 주소(URL 안 포함)가 샌드박스 주소로
  assert.deepEqual(x.databases, [{ service: "sbx-db-shop-db", majorVersion: "16", database: "shop_api", owner: "app", secretName: "shop-api-shop-db-app", secretKeys: ["password"] }]);
  const env = (id: string) => ((applyDoc(x, id)!.spec as any).template.spec.containers[0].env as Array<{ name: string; value?: string }>);
  assert.equal(env(`Deployment/${ns}/shop-api`).find((e) => e.name === "DB_HOST")!.value, sbxHost);
  assert.equal(env(`Deployment/${ns}/uploader`)[0]!.value, `postgres://app:x@${sbxHost}:5432/shop_api`);
  assert.ok(!x.apply.some((m) => m.yaml.includes(RDS)), "적용 사본에 실제 DB 주소가 없다");
  // ExternalSecret → 같은 이름 Secret, 키는 data[].secretKey ∪ 파드가 찾는 키, 값은 가짜 (dockerconfigjson 은 빈 JSON)
  assert.ok(!x.apply.some((m) => (parse(m.yaml) as K8sDoc).kind === "ExternalSecret"));
  const db = applyDoc(x, `Secret/${ns}/shop-api-shop-db-app`)!;
  assert.deepEqual(Object.keys(db.stringData as object), ["password"]);
  assert.match((db.stringData as any).password, /^[0-9a-f]{48}$/);
  assert.deepEqual((applyDoc(x, `Secret/${ns}/regcred`) as any).stringData, { ".dockerconfigjson": '{"auths":{}}' });
  // 터널·Ingress·PVC 는 적용 안 함. 터널·Ingress 대상은 연결 검사로
  for (const gone of [`Deployment/${ns}/shop-api-cloudflared`, `Ingress/${ns}/shop`, `PersistentVolumeClaim/${ns}/shop-api-uploads`]) assert.equal(applyDoc(x, gone), undefined, gone);
  assert.deepEqual(x.edges.filter((e) => e.from === "shop-api-cloudflared" || e.from === "shop"), [
    { from: "shop-api-cloudflared", host: "shop-api", port: 80 }, { from: "shop", host: "shop-web", port: 80 }]);
  assert.equal(it.tunnel!.status, "not_checked");
  assert.equal(it.ingress!.status, "substituted");
  // 이미지는 다이제스트 그대로 샌드박스 자리. 복제 수 1, HPA 최소 1, 요청량 상한, 한도 그대로
  const api = applyDoc(x, `Deployment/${ns}/shop-api`)!.spec as any;
  assert.match(api.template.spec.containers[0].image, /^ecr\.example\/sandbox\/.+\/shop-api@sha256:(ab){32}$/);
  assert.equal((applyDoc(x, `Deployment/${ns}/shop-web`)!.spec as any).replicas, 1);
  assert.equal((applyDoc(x, `HorizontalPodAutoscaler/${ns}/shop-api`)!.spec as any).minReplicas, 1);
  const redis = applyDoc(x, `StatefulSet/${ns}/cache`)!.spec as any;
  assert.equal(redis.replicas, 1);
  assert.deepEqual(redis.template.spec.containers[0].resources, { limits: { cpu: "2", memory: "4Gi" }, requests: { cpu: "100m", memory: "128Mi" } });
  assert.deepEqual(redis.template.spec.volumes, [{ name: "data", emptyDir: {} }]);
  assert.equal(redis.volumeClaimTemplates, undefined);
  for (const k of ["nodeSelector", "tolerations", "priorityClassName"]) assert.equal(redis.template.spec[k], undefined, k);
  assert.deepEqual((applyDoc(x, `Deployment/${ns}/uploader`)!.spec as any).template.spec.volumes, [{ name: "uploads", emptyDir: {} }]);
  // LB → ClusterIP (샌드박스 VAP 가 다른 종류를 막는다), LB 전용 칸과 nodePort 지움
  assert.deepEqual((applyDoc(x, `Service/${ns}/public`) as any).spec, { type: "ClusterIP", selector: { app: "uploader" }, ports: [{ port: 443, targetPort: 8443 }] });
  // IRSA 주석만 뺌 (다른 주석은 그대로), 신원은 확인 못 함
  assert.deepEqual(applyDoc(x, `ServiceAccount/${ns}/uploader`)!.metadata.annotations, { keep: "yes" });
  assert.equal(it.cloud_identity!.status, "not_checked");
  assert.equal(it.secret_values!.status, "identical");
  assert.equal(x.targetPodSecurity, "privileged");
  assert.deepEqual(x.images.map((m) => m.ref).sort(), podImages(docs));
});

test("gcp: Cloud SQL 사설 IP 를 바꾸고 Workload Identity 주석을 뺀다", { skip }, () => {
  const i = inputFor("gcp");
  const { values, rendered } = render(i);
  const docs = parseManifests(rendered);
  const x = buildRehearsalInput({ target: "gcp-gke", i, values, rendered, docs, images: [], mirrored: false, runBudgetSec: 1200 });
  assert.ok(!x.apply.some((m) => m.yaml.includes(CLOUDSQL)));
  assert.ok(x.original.some((m) => m.yaml.includes(CLOUDSQL)));
  const sa = applyDoc(x, `ServiceAccount/${x.namespace}/shop-api`)!;
  assert.equal(sa.metadata.annotations?.["iam.gke.io/gcp-service-account"], undefined);
  assert.ok(items(x).cloud_identity!.refs.some((r) => r.includes('["iam.gke.io/gcp-service-account"]')));
  assert.equal(items(x).images!.status, "identical", "흉내(복사 안 함)면 이미지 주소는 그대로");
  assert.equal(x.imagesMirrored, false, "복사하지 않았다는 사실이 입력에 실린다 (진짜 agent-worker 가 거부할 근거)");
});

test("onprem: CNPG Cluster → 같은 메이저 Postgres 자리 + <이름>-app Secret, 도착 파드 보안 baseline, 비밀 값은 확인 못 함", { skip }, () => {
  const i = inputFor("onprem");
  const { values, rendered } = render(i);
  const docs = parseManifests(rendered);
  const x = buildRehearsalInput({ target: "onprem-k3s", i, values, rendered, docs, images: [], mirrored: true, runBudgetSec: 1200 });
  const ns = x.namespace;
  assert.equal(applyDoc(x, `Cluster/${ns}/shop-api-shop-db`), undefined);
  assert.deepEqual(x.databases, [{ service: "shop-api-shop-db-rw", majorVersion: "16", database: "shop_api", owner: "app",
    secretName: "shop-api-shop-db-app", secretKeys: ["dbname", "host", "jdbc-uri", "password", "pgpass", "port", "uri", "username"] }]);
  const sec = applyDoc(x, `Secret/${ns}/shop-api-shop-db-app`)!.stringData as Record<string, string>;
  assert.equal(sec.host, "shop-api-shop-db-rw");
  assert.equal(sec.uri, `postgresql://app:${sec.password}@shop-api-shop-db-rw:5432/shop_api`);
  assert.equal(x.targetPodSecurity, "baseline");
  assert.equal(items(x).secret_values!.status, "not_checked");
  assert.equal(items(x).database!.status, "substituted");
  // 도착 한도는 계획 때 Terraform 값(namespace_json) 그대로. 데모 명세는 요청량이 빠진 워크로드가 있어 도착에도 한도가 없다
  assert.equal(x.targetQuota, null);
  assert.equal(items(x).quota!.real, "네임스페이스 한도 없음");
});

test("치환 표 밖 종류는 닫힌 쪽 실패 목록으로", () => {
  const docs = [{ path: "manifests/x.yaml", doc: { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "x", namespace: "app-a" } } as K8sDoc },
    { path: "manifests/c.yaml", doc: { apiVersion: "example.io/v1", kind: "Cluster", metadata: { name: "c", namespace: "app-a" } } as K8sDoc },
    { path: "manifests/d.yaml", doc: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "d", namespace: "app-a" } } as K8sDoc }];
  assert.deepEqual(unsupportedOf(docs), ["NetworkPolicy/app-a/x", "Cluster/app-a/c"]);
});

test("수량 읽기와 이미지 짝: 명세 다이제스트 원본, 명세 밖 주소는 그대로", () => {
  assert.equal(quantity("cpu", "300m"), 300);
  assert.equal(quantity("cpu", "2"), 2000);
  assert.equal(quantity("memory", "768Mi"), 768 * 2 ** 20);
  assert.equal(quantity("memory", "1G"), 1e9);
  assert.equal(quantity("memory", "abc"), null);
  const i = inputFor("aws");
  const api = DEMO_SPEC.components.find((c) => c.id === "shop-api")!.props as { image: { repository: string; digest: string } };
  const pairs = imagePairs(i, [`${api.image.repository}@${api.image.digest}`, "cloudflare/cloudflared:2025.9.1"]);
  assert.deepEqual(pairs[0], { ref: `${api.image.repository}@${api.image.digest}`, source: `${api.image.repository}@${api.image.digest}` });
  assert.deepEqual(pairs[1], { ref: "cloudflare/cloudflared:2025.9.1", source: "cloudflare/cloudflared:2025.9.1" });
});

test("TLS 비밀: 가짜 값이 자체 서명 인증서·키라 앱이 그대로 TLS 를 연다. 같은 지문·이름이면 같은 글자", async () => {
  const es = (name: string) => ({ path: `manifests/externalsecret-${name}.yaml`, doc: { apiVersion: "external-secrets.io/v1", kind: "ExternalSecret", metadata: { name },
    spec: { secretStoreRef: { kind: "ClusterSecretStore", name: "s" }, target: { name, template: { type: "kubernetes.io/tls" } },
      data: [{ secretKey: "tls.crt", remoteRef: { key: name } }, { secretKey: "tls.key", remoteRef: { key: name } }] } } as K8sDoc });
  const run = () => substitute([es("shop-tls"), es("admin-tls")], { namespace: "app-shop", images: new Map(), managedDbs: [], seed: "a".repeat(64) });
  const sec = (name: string) => run().apply.find((m) => m.doc.kind === "Secret" && m.doc.metadata.name === name)!.doc.stringData as Record<string, string>;
  const tls = sec("shop-tls");
  const cert = new X509Certificate(tls["tls.crt"]!);
  assert.ok(cert.checkPrivateKey(createPrivateKey(tls["tls.key"]!)));
  assert.ok(cert.verify(cert.publicKey), "자체 서명");
  assert.equal(cert.subject, "CN=shop-tls");
  // 앱 자리: 그 인증서·키로 TLS 서버를 열고 붙어 본다
  const server = createServer({ cert: tls["tls.crt"], key: tls["tls.key"] }, (sock) => sock.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const got = await new Promise<string>((res, rej) => {
      const c = connect({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, rejectUnauthorized: false });
      let d = "";
      c.on("data", (x) => { d += x; }).on("end", () => res(d)).on("error", rej);
    });
    assert.equal(got, "ok");
  } finally { server.close(); }
  assert.deepEqual(sec("shop-tls"), tls, "같은 입력이면 같은 글자 (치환은 순수 함수)");
  assert.notEqual(sec("admin-tls")["tls.key"], tls["tls.key"], "비밀마다 다른 키");
});

// find-d 고침: TP-1(자리표시 풀기)·CV-1(render 칸 → 차트)·CM-2/CM-3(ConfigMap 마운트)·AN-1(annotation)·TL-1(Ingress tls)·PD-1(PDB)
//   출발 읽기 → IR → Builder Helm 값 → (helm 있으면) helm template. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppSpecV2, ChartValues, ImportResultV2, type RawInventory, type TargetEnv } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { allowAnnotations, droppedAnnotations } from "../src/import/annotations.js";
import { targetBuilderFor, type Target } from "../src/index.js";
import { V2_FIELD_COVERAGE, v2Blockers } from "../src/target/shared.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "ab".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items }) as RawInventory;
const run = (items: Raw[]) => normalizeV2(inv(items)).result;
const ok = (r: ReturnType<typeof run>) => assert.equal(ImportResultV2.safeParse(r).success, true, JSON.stringify(ImportResultV2.safeParse(r).error?.issues?.slice(0, 3)));
const dep = (name: string, pod: Raw = {}, c: Raw = {}, extra: Raw = {}): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: {
    serviceAccountName: name, containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env: [], ...c }], ...pod } } },
  ...extra,
});
const cm = (name: string, data: Record<string, string>): Raw => ({ kind: "k8s.configMapKeys", metadata: { name, namespace: "shop" }, keys: Object.keys(data).sort(), data });
const svc = (name: string, extra: Raw = {}): Raw => ({ kind: "k8s.service", metadata: { name, namespace: "shop" }, spec: { type: "ClusterIP", selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] }, ...extra });
const ing = (name: string, spec: Raw, annotations?: Record<string, string>): Raw => ({ kind: "k8s.ingress", metadata: { name, namespace: "shop", ...(annotations ? { annotations } : {}) }, spec });
const rule = (host: string, to = "api") => ({ host, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: to, port: { number: 80 } } } }] } });
const db = { kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: "shop" }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "1Gi" }, instances: 1 } };

const T = (p: TargetEnv["provider"]): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as Target;
const K8S = ["aws", "gcp", "onprem"] as const;
const values = (spec: unknown, p: (typeof K8S)[number] = "onprem") => ChartValues.parse(targetBuilderFor(p).toWorkloadValues(AppSpecV2.parse(spec), {}, T(p)));
const wl = (v: ChartValues, name: string) => v.workloads.find((w) => w.name === name)!;

// ── TP-1 ───────────────────────────────────────────────
for (const p of K8S) {
  test(`TP-1 ${p}: command·args·ConfigMap 값의 자리표시를 도착 주소로 풀고, 나머지 글자는 그대로`, () => {
    const r = run([
      dep("api", { initContainers: [{ name: "wait", image: `ghcr.io/demo/w@${D}`, args: ["--to=shop-db-rw.shop.svc:5432"] }] },
        { env: [{ name: "MODE", valueFrom: { configMapKeyRef: { name: "app-cfg", key: "MODE" } } }], command: ["/app", "--literal=${keep}"], args: ["--db=postgres://shop-db-rw.shop.svc:5432/app", "--x"] }),
      cm("app-cfg", { MODE: "p", "app.yaml": "db:\n  host: shop-db-rw.shop.svc.cluster.local\n" }),
      db,
    ]);
    ok(r);
    const v = values(r.spec, p);
    const api = wl(v, "api");
    const all = JSON.stringify(api);
    assert.ok(!all.includes("${shop-db."), `자리표시가 남음: ${all}`);
    assert.match(api.args![0]!, /^--db=postgres:\/\/[^$]+:5432\/app$/);
    assert.equal(api.args![1], "--x");
    // 표시 안 된 칸은 \${…} 글자가 있어도 안 건드린다
    assert.deepEqual(api.command, ["/app", "--literal=${keep}"]);
    assert.match(api.configs![0]!.data["app.yaml"]!, /^db:\n  host: [^$]+\n$/);
    assert.equal(api.configs![0]!.data.MODE, "p");
    assert.match(api.initContainers![0]!.args![0]!, /^--to=[^$]+:5432$/);
  });
}

test("TP-1 거부: 자리표시가 없는 명세는 command·args·ConfigMap 값이 한 글자도 안 바뀐다", () => {
  const r = run([dep("api", {}, { envFrom: [{ configMapRef: { name: "c" } }], args: ["--a=${b}"] }), cm("c", { K: "${x.host}" })]);
  ok(r);
  const api = wl(values(r.spec), "api");
  assert.deepEqual(api.args, ["--a=${b}"]);
  assert.equal(api.configs![0]!.data.K, "${x.host}");
});

// ── CM-2·CM-3 ──────────────────────────────────────────
test("CM-2: env·envFrom 으로만 쓰는 ConfigMap 은 객체만 있고 mountPath 가 없다 (null 마운트 안 생김)", () => {
  const r = run([dep("api", {}, { env: [{ name: "MODE", valueFrom: { configMapKeyRef: { name: "app-cfg", key: "MODE" } } }] }), cm("app-cfg", { MODE: "p" })]);
  ok(r);
  const api = wl(values(r.spec), "api");
  assert.deepEqual(api.configs, [{ name: "app-cfg", data: { MODE: "p" } }]);
  assert.equal(api.volumeMounts, undefined);
});

test("CM-3: 같은 ConfigMap 두 곳(subPath 포함)·보조 컨테이너 마운트 → 마운트 원문 그대로, configs·pvcs 는 객체만", () => {
  const r = run([
    dep("api", {
      volumes: [{ name: "cfg", configMap: { name: "app-cfg", defaultMode: 420 } }, { name: "tmp", emptyDir: { medium: "Memory" } }, { name: "data", persistentVolumeClaim: { claimName: "api-data" } }],
      containers: [
        { name: "api", image: "ghcr.io/demo/api:1.0", ports: [{ containerPort: 8080 }], env: [],
          volumeMounts: [{ name: "cfg", mountPath: "/etc/nginx/nginx.conf", subPath: "nginx.conf" }, { name: "cfg", mountPath: "/etc/app", readOnly: true }, { name: "tmp", mountPath: "/tmp" }, { name: "data", mountPath: "/data" }] },
        { name: "log", image: `ghcr.io/demo/log@${D}`, env: [], volumeMounts: [{ name: "cfg", mountPath: "/etc/log" }] },
      ],
    }),
    cm("app-cfg", { "nginx.conf": "x", "app.yaml": "y" }),
    { kind: "k8s.pvc", metadata: { name: "api-data", namespace: "shop" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "2Gi" } } } },
  ]);
  ok(r);
  const api = wl(values(r.spec), "api");
  assert.deepEqual(api.volumeMounts, [
    { name: "cfg", mountPath: "/etc/nginx/nginx.conf", subPath: "nginx.conf" }, { name: "cfg", mountPath: "/etc/app", readOnly: true },
    { name: "tmp", mountPath: "/tmp" }, { name: "data", mountPath: "/data" }]);
  assert.deepEqual(api.volumes, [
    { name: "cfg", configMap: { name: "app-cfg", defaultMode: 420 } }, { name: "tmp", emptyDir: { medium: "Memory" } },
    { name: "data", persistentVolumeClaim: { claimName: "api-data" } }]);
  assert.equal(api.configs![0]!.mountPath, undefined, "원문 마운트가 있으면 configs 로 또 마운트하지 않음");
  assert.equal(api.pvcs![0]!.mountPath, undefined);
  assert.deepEqual(api.sidecars![0]!.volumeMounts, [{ name: "cfg", mountPath: "/etc/log" }]);
});

// ── CV-1 ───────────────────────────────────────────────
test("CV-1: 배치·host·파드 annotation·PDB·HPA metrics/behavior·Service appProtocol/annotation·hostPort 가 Helm 값까지 간다", () => {
  const r = run([
    dep("api", {
      nodeSelector: { "kubernetes.io/arch": "amd64" }, tolerations: [{ key: "k", operator: "Exists" }], priorityClassName: "high",
      topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "ScheduleAnyway" }],
      hostNetwork: true, podAnnotations: { "prometheus.io/scrape": "true" },
      containers: [{ name: "api", image: "ghcr.io/demo/api:1.0", ports: [{ containerPort: 8080, hostPort: 8080 }], env: [] }],
    }),
    svc("api", { metadata: { name: "api", namespace: "shop", annotations: { "prometheus.io/port": "9090" } }, spec: { type: "ClusterIP", selector: { app: "api" }, ports: [{ name: "http", port: 80, targetPort: 8080, appProtocol: "http" }] } }),
    { kind: "k8s.hpa", metadata: { name: "api", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "api" }, minReplicas: 2, maxReplicas: 6,
      metrics: [{ type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 70 } } }],
      behavior: { scaleDown: { stabilizationWindowSeconds: 300 } } } },
    { kind: "k8s.pdb", metadata: { name: "api-pdb", namespace: "shop" }, spec: { selector: { matchLabels: { app: "api" } }, maxUnavailable: "50%", unhealthyPodEvictionPolicy: "AlwaysAllow" } },
  ]);
  ok(r);
  const api = wl(values(r.spec), "api");
  assert.deepEqual(api.scheduling, { nodeSelector: { "kubernetes.io/arch": "amd64" }, tolerations: [{ key: "k", operator: "Exists" }], priorityClassName: "high",
    topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "ScheduleAnyway" }] });
  assert.deepEqual(api.host, { network: true });
  assert.deepEqual(api.podAnnotations, { "prometheus.io/scrape": "true" });
  assert.deepEqual(api.ports, [{ containerPort: 8080, protocol: "TCP", hostPort: 8080 }]);
  assert.deepEqual(api.disruption, { name: "api-pdb", maxUnavailable: "50%", unhealthyPodEvictionPolicy: "AlwaysAllow" });
  assert.deepEqual(api.scale?.metrics, [{ type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 70 } } }]);
  assert.deepEqual(api.scale?.behavior, { scaleDown: { stabilizationWindowSeconds: 300 } });
  assert.equal(api.services![0]!.ports[0]!.appProtocol, "http");
  assert.deepEqual(api.services![0]!.annotations, { "prometheus.io/port": "9090" });
});

test("CV-1 거부: 칸 표에서 render 인 워크로드 칸은 전부 ChartWorkload 에 대응 칸이 있다 (새 render 칸이 조용히 빠지지 않게)", () => {
  // IR 칸 → Helm 값 칸 (이름이 다르거나 다른 칸으로 그려지는 것만 적음)
  const MAP: Record<string, string> = { podVolumes: "volumes", commandTemplates: "command", argTemplates: "args", endpoints: "services",
    runtime: "kind", schedule: "job", timeZone: "job", concurrencyPolicy: "job", suspend: "job", backoffLimit: "job", activeDeadlineSec: "job", restartPolicy: "job" };
  const chartKeys = new Set(Object.keys(ChartValues.shape.workloads.element.shape));
  const missing: string[] = [];
  for (const [kind, rules] of Object.entries(V2_FIELD_COVERAGE)) {
    if (kind !== "service" && kind !== "job") continue;
    for (const [k, rule] of Object.entries(rules)) {
      if (rule !== "render") continue;
      if (k === "volumes") { if (!chartKeys.has("pvcs")) missing.push(k); continue; }
      // M-1: 네임스페이스는 워크로드마다가 아니라 차트 값 맨 위 namespace 하나 (출발 이름 그대로, 여러 개는 계획에서 막힘)
      if (k === "namespace") { if (!("namespace" in ChartValues.shape)) missing.push(k); continue; }
      if (!chartKeys.has(MAP[k] ?? k)) missing.push(`${kind}.${k}`);
    }
  }
  assert.deepEqual(missing, []);
});

// ── AN-1 ───────────────────────────────────────────────
test("AN-1: 인증·접근 제한·인증서·고정 IP 키는 옮기고, 그 밖은 키 이름만 unmapped B (도구 기록 키는 뺌)", () => {
  const a = { "nginx.ingress.kubernetes.io/auth-url": "https://auth/x", "nginx.ingress.kubernetes.io/auth-secret": "basic", "alb.ingress.kubernetes.io/inbound-cidrs": "10.0.0.0/8",
    "alb.ingress.kubernetes.io/actions.blue": "{}", "kubernetes.io/ingress.global-static-ip-name": "ip1", "networking.gke.io/managed-certificates": "c1",
    "example.com/custom": "x", "kubectl.kubernetes.io/last-applied-configuration": "{}", "nginx.ingress.kubernetes.io/configuration-snippet": "more_set_headers" };
  assert.deepEqual(Object.keys(allowAnnotations("ingress", a) ?? {}), ["alb.ingress.kubernetes.io/actions.blue", "alb.ingress.kubernetes.io/inbound-cidrs", "kubernetes.io/ingress.global-static-ip-name",
    "networking.gke.io/managed-certificates", "nginx.ingress.kubernetes.io/auth-secret", "nginx.ingress.kubernetes.io/auth-url"]);
  assert.deepEqual(droppedAnnotations("ingress", a), ["example.com/custom", "nginx.ingress.kubernetes.io/configuration-snippet"]);
});

test("AN-1: discover 가 버린 키를 이름만 남기고 → unmapped B, 입구 인증 키가 있으면 도착 계획이 사람에게 묻는다", async () => {
  const objs: Record<string, Raw[]> = {
    deployments: [{ metadata: { name: "api", namespace: "shop" }, spec: { selector: { matchLabels: { app: "api" } }, template: {
      metadata: { labels: { app: "api" }, annotations: { "example.org/agent-inject": "true", "prometheus.io/scrape": "true", "kubectl.kubernetes.io/restartedAt": "t" } },
      spec: { containers: [{ name: "api", image: `ghcr.io/demo/api@${D}`, ports: [{ containerPort: 8080 }] }] } } } }],
    services: [{ metadata: { name: "api", namespace: "shop" }, spec: { selector: { app: "api" }, ports: [{ port: 80, targetPort: 8080 }] } }],
    ingresses: [{ metadata: { name: "web", namespace: "shop", annotations: { "nginx.ingress.kubernetes.io/auth-url": "https://auth/x", "example.com/waf": "on" } },
      spec: { ingressClassName: "nginx", rules: [rule("shop.example.com")] } }],
  };
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    const m = /^kubectl get (\S+) /.exec(line);
    if (/^kubectl api-resources /.test(line)) return { code: 0, stdout: "", stderr: "", ms: 1 };
    if (!m) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    return { code: 0, stdout: JSON.stringify({ items: objs[m[1]!] ?? [] }), stderr: "", ms: 1 };
  };
  const { items } = await readK8sNamespace({ exec, env: { IMPORT_NAMESPACE: "shop" } }, []);
  const r = run(items as Raw[]);
  ok(r);
  const u = r.unmapped.filter((x) => x.resource.endsWith(".annotations")).map((x) => [x.resource, x.grade, x.reason.match(/\((.*)\)/)?.[1]]);
  assert.deepEqual(u, [["k8s.deployment:shop/api.annotations", "B", "pod:example.org/agent-inject"], ["k8s.ingress:shop/web.annotations", "B", "example.com/waf"]]);
  const spec = AppSpecV2.parse(r.spec);
  assert.equal(spec.entry?.hosts[0]?.annotations?.["nginx.ingress.kubernetes.io/auth-url"], "https://auth/x");
  assert.ok(v2Blockers(spec, []).needsHuman.some((x) => x.includes("shop.example.com") && x.includes("auth-url")));
});

test("AN-1 거부: 인증·접근 키가 없는 입구는 사람에게 묻지 않는다", () => {
  const r = run([dep("api"), svc("api"), ing("web", { ingressClassName: "nginx", rules: [rule("shop.example.com")] }, { "nginx.ingress.kubernetes.io/proxy-body-size": "8m" })]);
  ok(r);
  assert.ok(!v2Blockers(AppSpecV2.parse(r.spec), []).needsHuman.some((x) => x.startsWith("입구 ")));
});

// ── TL-1 ───────────────────────────────────────────────
test("TL-1: 와일드카드 tls·hosts 없는 tls 도 HTTPS 로, secretName 을 source 에 남김", () => {
  const r = run([dep("api"), svc("api"),
    ing("a", { ingressClassName: "nginx", rules: [rule("a.example.com")], tls: [{ hosts: ["*.example.com"], secretName: "wild" }] }),
    ing("b", { ingressClassName: "nginx", rules: [rule("b.other.com")], tls: [{ secretName: "default-cert" }] }),
    ing("c", { ingressClassName: "nginx", rules: [rule("x.y.example.com")], tls: [{ hosts: ["*.example.com"] }] }),
  ]);
  ok(r);
  const h = (n: string) => r.spec.entry!.hosts.find((x) => x.hostnames[0] === n)!;
  assert.deepEqual(h("a.example.com").tls, { mode: "terminate", source: "ingress.spec.tls(secret wild)" });
  assert.equal(r.fieldMeta["entry.a.example.com.tls"], undefined);
  assert.deepEqual(h("b.other.com").tls, { mode: "terminate", source: "ingress.spec.tls(secret default-cert)" });
  assert.equal(r.fieldMeta["entry.b.other.com.tls"]?.confidence, 0.9);
  assert.equal(h("x.y.example.com").tls, undefined, "와일드카드는 한 단계만");
});

// ── PD-1 ───────────────────────────────────────────────
test("PD-1: 빈 셀렉터 PDB = 네임스페이스 서비스 전부(검토), matchExpressions 는 unmapped", () => {
  const r = run([dep("api"), dep("web"),
    { kind: "k8s.pdb", metadata: { name: "all", namespace: "shop" }, spec: { selector: { matchLabels: {} }, minAvailable: 1 } },
    { kind: "k8s.pdb", metadata: { name: "ex", namespace: "shop" }, spec: { selector: { matchLabels: {}, hasExpressions: true }, minAvailable: 1 } }]);
  ok(r);
  assert.equal((r.spec.components.find((c) => c.id === "api") as any).props.disruption.name, "all");
  assert.equal((r.spec.components.find((c) => c.id === "web") as any).props.disruption.name, "all");
  assert.equal(r.fieldMeta["components.api.disruption"]?.confidence, 0.6);
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.pdb:ex" && u.reason.includes("matchExpressions")));
});

test("PD-1 거부: 셀렉터 칸이 없는 PDB 는 아무것도 안 고른다", () => {
  const r = run([dep("api"), { kind: "k8s.pdb", metadata: { name: "none", namespace: "shop" }, spec: { minAvailable: 1 } }]);
  ok(r);
  assert.equal((r.spec.components.find((c) => c.id === "api") as any).props.disruption, undefined);
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.pdb:none"));
});

// ── helm template (helm 이 있는 곳: 맥·CI) ──────────────
const CHART = resolve(import.meta.dirname, "../../../gitops/charts/app");
const HELM = process.env.HELM_BIN ?? "helm";
const hasHelm = (() => { try { execFileSync(HELM, ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();
const render = (v: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "findd-"));
  const f = join(dir, "values.json");
  writeFileSync(f, JSON.stringify(v));
  return execFileSync(HELM, ["template", "rel", CHART, "-f", f], { encoding: "utf8" });
};
const doc = (out: string, kind: string, name: string) =>
  out.split(/^---$/m).find((d) => new RegExp(`^kind: ${kind}$`, "m").test(d) && new RegExp(`^  name: ${name}$`, "m").test(d));

test("helm: env 전용 ConfigMap 은 마운트 없음, 원문 마운트·PDB·host·배치·annotation·HPA metrics 가 그려진다", { skip: hasHelm ? false : "helm 없음" }, () => {
  const r = run([
    dep("api", {
      volumes: [{ name: "cfg", configMap: { name: "files" } }], hostNetwork: true, nodeSelector: { pool: "a" }, podAnnotations: { "prometheus.io/scrape": "true" },
      containers: [{ name: "api", image: "ghcr.io/demo/api:1.0", ports: [{ containerPort: 8080 }], env: [{ name: "M", valueFrom: { configMapKeyRef: { name: "envonly", key: "M" } } }],
        volumeMounts: [{ name: "cfg", mountPath: "/etc/x/a.conf", subPath: "a.conf" }] }],
    }),
    cm("envonly", { M: "1" }), cm("files", { "a.conf": "x" }),
    { kind: "k8s.hpa", metadata: { name: "api", namespace: "shop" }, spec: { scaleTargetRef: { kind: "Deployment", name: "api" }, minReplicas: 2, maxReplicas: 4,
      metrics: [{ type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 70 } } }] } },
    { kind: "k8s.pdb", metadata: { name: "api-pdb", namespace: "shop" }, spec: { selector: { matchLabels: { app: "api" } }, minAvailable: 1 } },
  ]);
  ok(r);
  const out = render(values(r.spec));
  const d = doc(out, "Deployment", "api")!;
  assert.ok(!/mountPath: null/.test(d), "null 마운트 없음");
  assert.match(d, /subPath: a\.conf/);
  assert.match(d, /hostNetwork: true/);
  assert.match(d, /nodeSelector:\n\s+pool: a/);
  assert.match(d, /prometheus\.io\/scrape: "true"/);
  assert.ok(!d.includes("cfg-envonly"));
  assert.ok(doc(out, "ConfigMap", "envonly"));
  assert.match(doc(out, "PodDisruptionBudget", "api-pdb")!, /minAvailable: 1/);
  assert.match(doc(out, "HorizontalPodAutoscaler", "api")!, /name: memory/);
});

test("helm 거부: 마운트 원문이 없는 출발(configs mountPath 만)은 예전처럼 cfg- 볼륨으로 마운트", { skip: hasHelm ? false : "helm 없음" }, () => {
  const s = structuredClone(run([dep("api", {}, { envFrom: [{ configMapRef: { name: "c" } }] }), cm("c", { K: "v" })]).spec) as any;
  s.components[0].props.configs[0].mountPath = "/etc/c";
  const d = doc(render(values(s)), "Deployment", "api")!;
  assert.match(d, /name: cfg-c\n\s+mountPath: \/etc\/c|mountPath: \/etc\/c\n\s+name: cfg-c/);
});

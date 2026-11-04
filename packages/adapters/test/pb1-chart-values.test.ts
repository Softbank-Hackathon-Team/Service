import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppSpecV2, ChartValues, type TargetEnv } from "@svc/contracts";
import { DEMO_SPEC, targetBuilderFor, type Target } from "../src/index.js";
import { toK8sProbe } from "../src/target/k8s-probe.js";

// PB-1/BV-1: Builder 가 만드는 Helm 값 = 차트가 읽는 모양 (ChartValues). 프로브는 k8s 모양. 실클라우드 호출 0

const T = (p: TargetEnv["provider"]): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as Target;
const K8S = ["aws", "gcp", "onprem"] as const;
const CHART = resolve(import.meta.dirname, "../../../gitops/charts/app");
const HELM = process.env.HELM_BIN ?? "helm";
const hasHelm = (() => { try { execFileSync(HELM, ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();

// 데모 + 차트 칸을 다 건드리는 것들 (사이드카·init·볼륨·설정·비밀 마운트·헤드리스·여러 포트·exec·tcp 프로브·잡 시간대)
function rich(): AppSpecV2 {
  const s = structuredClone(DEMO_SPEC);
  const img = { source: "registry" as const, repository: "registry.example/side", digest: `sha256:${"b".repeat(64)}` };
  s.components = s.components.map((c) => {
    if (c.id === "shop-api" && c.kind === "service") {
      return { ...c, props: { ...c.props,
        ports: [{ port: 8080, protocol: "TCP" as const }, { port: 9090 }],
        probes: { readiness: { type: "http" as const, port: 8080, periodSec: 5, failureThreshold: 3 }, liveness: { type: "tcp" as const, port: 8080, initialDelaySec: 10 }, startup: { type: "exec" as const, command: ["/bin/ok"] } },
        sidecars: [{ name: "log-agent", image: img, env: [{ name: "LEVEL", value: "info" }], resources: {}, probes: { readiness: { type: "grpc" as const, port: 7000 } } },
          { name: "istio-proxy", image: img, env: [], resources: {}, injected: true }],
        initContainers: [{ name: "migrate", image: img, command: ["/migrate"], env: [], resources: {} }],
        volumes: [{ name: "cache", mountPath: "/cache", sizeGb: 5, access: "RWX" as const }],
        configs: [{ name: "shop-config", data: { "app.yaml": "a: 1" }, sha256: "x", mountPath: "/etc/shop" }],
        secretMounts: [{ secret: "shop-tls", mountPath: "/tls" }],
        securityContext: { runAsNonRoot: true },
      } };
    }
    if (c.id === "shop-worker" && c.kind === "service") {
      return { ...c, props: { ...c.props, endpoints: [{ name: "shop-worker-hl", type: "Headless" as const, ports: [{ port: 8080, targetPort: 8080, protocol: "TCP" as const }, { port: 8081, targetPort: "metrics", protocol: "TCP" as const }] }] } };
    }
    if (c.id === "shop-cleanup" && c.kind === "job") return { ...c, props: { ...c.props, timeZone: "Asia/Seoul", activeDeadlineSec: 600, suspend: false } };
    return c;
  });
  return AppSpecV2.parse(s);
}

// base: EKS 도착은 PVC 를 못 그림(volume.pvc 가 capability 밖, ebs-csi TODO(human)) → aws 는 볼륨 없이 본다 (CL-1 시험이 막힘 자체를 봄)
const noVolumes = (s: AppSpecV2) => AppSpecV2.parse({ ...s, components: s.components.map((c) => c.kind === "service" ? { ...c, props: { ...c.props, volumes: undefined } } : c) });
const specFor = (p: (typeof K8S)[number]) => p === "aws" ? noVolumes(rich()) : rich();

test("PB-1 프로브: IR → k8s (httpGet·tcpSocket·grpc·exec, …Sec → …Seconds, 없는 path 는 안 지어냄)", () => {
  assert.deepEqual(toK8sProbe({ type: "http", path: "/healthz", port: 8080, periodSec: 5 }), { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 5 });
  assert.deepEqual(toK8sProbe({ type: "http", port: "http", scheme: "HTTPS" }), { httpGet: { port: "http", scheme: "HTTPS" } });
  assert.deepEqual(toK8sProbe({ type: "tcp", port: 5432, initialDelaySec: 3, failureThreshold: 2 }), { tcpSocket: { port: 5432 }, initialDelaySeconds: 3, failureThreshold: 2 });
  assert.deepEqual(toK8sProbe({ type: "grpc", port: 7000 }), { grpc: { port: 7000 } });
  assert.deepEqual(toK8sProbe({ type: "exec", command: ["a", "b"] }), { exec: { command: ["a", "b"] } });
});

for (const p of K8S) {
  test(`PB-1 ${p}: 값이 ChartValues 계약을 지키고, 워크로드 칸이 차트 이름(name·image 글자·containerPort·k8s 프로브)이다`, () => {
    const spec = specFor(p);
    const v = ChartValues.parse(targetBuilderFor(p).toWorkloadValues(spec, {}, T(p)));
    const api = v.workloads.find((w) => w.name === "shop-api")!;
    assert.equal(typeof api.image, "string");
    assert.match(api.image, /@sha256:/);
    assert.deepEqual(api.ports, [{ containerPort: 8080, protocol: "TCP" }, { containerPort: 9090 }]);
    assert.deepEqual(api.probes, { readiness: { httpGet: { port: 8080 }, periodSeconds: 5, failureThreshold: 3 }, liveness: { tcpSocket: { port: 8080 }, initialDelaySeconds: 10 }, startup: { exec: { command: ["/bin/ok"] } } });
    assert.deepEqual(api.sidecars?.map((c) => c.name), ["log-agent"]);   // 메시 주입형은 안 넣음
    assert.deepEqual(api.sidecars?.[0]?.readinessProbe, { grpc: { port: 7000 } });
    if (p !== "aws") assert.deepEqual(api.pvcs, [{ name: "cache", size: "5Gi", mountPath: "/cache", accessModes: ["ReadWriteMany"] }]);
    assert.deepEqual(api.secretMounts, [{ name: "shop-tls", secretName: "shop-tls", mountPath: "/tls" }]);
    assert.deepEqual(api.securityContext, { container: { runAsNonRoot: true } });
    const wk = v.workloads.find((w) => w.name === "shop-worker")!;
    assert.deepEqual(wk.services?.[0], { name: "shop-worker-hl", type: "Headless", ports: [{ name: "p-8080", port: 8080, targetPort: 8080, protocol: "TCP" }, { name: "p-8081", port: 8081, targetPort: "metrics", protocol: "TCP" }] });
    const job = v.workloads.find((w) => w.name === "shop-cleanup")!;
    assert.equal(job.job?.timeZone, "Asia/Seoul"); assert.equal(job.job?.activeDeadlineSeconds, 600);
    assert.equal("irVersion" in v, false);
  });
}

test("PB-1 거부: 옛 칸(id·image.ref·IR 프로브)이 든 값은 ChartValues 가 막는다", () => {
  const v = ChartValues.parse(targetBuilderFor("aws").toWorkloadValues(DEMO_SPEC, {}, T("aws"))) as Record<string, any>;
  const bad = structuredClone(v); bad.workloads[0].id = bad.workloads[0].name;
  assert.equal(ChartValues.safeParse(bad).success, false);
  const bad2 = structuredClone(v); bad2.workloads[0].image = { ref: "x" };
  assert.equal(ChartValues.safeParse(bad2).success, false);
  const bad3 = structuredClone(v); bad3.workloads[0].probes = { readiness: { type: "http", path: "/", port: 8080 } };
  assert.equal(ChartValues.safeParse(bad3).success, false);
});

const render = (values: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "pb1-"));
  const f = join(dir, "values.json");
  writeFileSync(f, JSON.stringify(values));
  return execFileSync(HELM, ["template", "rel", CHART, "-f", f], { encoding: "utf8" });
};
const doc = (out: string, kind: string, name: string) =>
  out.split(/^---$/m).find((d) => new RegExp(`^kind: ${kind}$`, "m").test(d) && new RegExp(`^  name: ${name}$`, "m").test(d));

for (const p of K8S) {
  test(`BV-1 ${p}: helm template 이 Builder 값으로 그려지고, 프로브·Service·잡 멈춤·비밀이 맞다`, { skip: hasHelm ? false : "helm 없음" }, () => {
    const out = render(targetBuilderFor(p).toWorkloadValues(specFor(p), {}, T(p)));
    const dep = doc(out, "Deployment", "shop-api")!;
    assert.ok(dep, "shop-api Deployment");
    assert.match(dep, /readinessProbe:\n\s+failureThreshold: 3\n\s+httpGet:\n\s+port: 8080/);
    assert.match(dep, /livenessProbe:\n\s+initialDelaySeconds: 10\n\s+tcpSocket:/);
    assert.match(dep, /startupProbe:\n\s+exec:/);
    assert.match(dep, /name: log-agent/); assert.doesNotMatch(dep, /istio-proxy/);
    assert.match(dep, /initContainers:/);
    if (p !== "aws") assert.match(dep, /claimName: shop-api-cache/);
    else assert.doesNotMatch(out, /kind: PersistentVolumeClaim/);
    assert.match(dep, /configMap:\n\s+name: shop-config/);
    assert.doesNotMatch(dep, /type: http\b/);   // IR 프로브 모양이 새지 않음
    assert.ok(doc(out, "ConfigMap", "shop-config"));
    const hl = doc(out, "Service", "shop-worker-hl")!;
    assert.match(hl, /clusterIP: None/);
    assert.ok(doc(out, "Service", "shop-api"));
    const cj = doc(out, "CronJob", "shop-cleanup")!;
    assert.match(cj, /suspend: true/);   // J-1: 컷오버 전엔 도착 잡 멈춤
    assert.match(cj, /timeZone: "Asia\/Seoul"/); assert.match(cj, /activeDeadlineSeconds: 600/);
    assert.match(out, /kind: ExternalSecret/);
    if (p === "onprem") assert.match(out, /kind: Cluster\n/);
    else assert.match(out, new RegExp(`name: ${DEMO_SPEC.app.name}-shop-db-app`));
    assert.doesNotMatch(out, /<nil>|%!/);
  });
}

test("BV-1 거부 aws: 볼륨 있는 명세는 EKS 값 만들기 전에 volume.pvc 로 막힌다 (EBS CSI 애드온 없음, TODO(human))", () => {
  assert.throws(() => targetBuilderFor("aws").toWorkloadValues(rich(), {}, T("aws")), /volume\.pvc/);
});

test("BV-1 J-1: jobOwner=target 이면 출발 suspend 값 그대로", { skip: hasHelm ? false : "helm 없음" }, () => {
  const v = targetBuilderFor("onprem").toWorkloadValues(rich(), {}, T("onprem"));
  assert.match(doc(render({ ...v, jobOwner: "target" }), "CronJob", "shop-cleanup")!, /suspend: false/);
});

test("BV-1 거부: 차트는 SA create:false(기본 default) 를 만들지 않는다", { skip: hasHelm ? false : "helm 없음" }, () => {
  const out = render(targetBuilderFor("onprem").toWorkloadValues(DEMO_SPEC, {}, T("onprem")));
  assert.equal(doc(out, "ServiceAccount", "default"), undefined);
});

// pf-d FM-TRF-23: cloudflared 입구 파드가 읽는 Secret 이름·키를 같은 렌더 안의 ExternalSecret 이 만든다 (예전엔 만드는 곳이 없어 CreateContainerConfigError)
test("FM-TRF-23 helm: cloudflared Deployment 의 secretKeyRef 와 같은 이름·키의 ExternalSecret 이 그려진다", { skip: hasHelm ? false : "helm 없음" }, () => {
  const s = AppSpecV2.parse({ ...rich(), entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"],
    routes: [{ matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "shop-api", port: 8080, weight: 1 }] }] }] } });
  const out = render(targetBuilderFor("gcp").toWorkloadValues(s, {}, T("gcp")));
  const cf = doc(out, "Deployment", `${DEMO_SPEC.app.name}-cloudflared`)!;
  assert.ok(cf, "cloudflared Deployment");
  const ref = /secretKeyRef: \{ name: (\S+), key: (\S+) \}/.exec(cf)!;
  const es = doc(out, "ExternalSecret", ref[1]!)!;
  assert.ok(es, `ExternalSecret ${ref[1]}`);
  assert.match(es, new RegExp(`secretKey: "${ref[2]}"`));
});

// C 묶음 (D6·V-1·NP-1·NS-1·M-1): 원본 → IR → 의미 검사 → 도착 요구 capability·막기. 그대로 이식(종류·볼륨·Service 동작·네임스페이스 이름)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2, requirementsV2, v2Blockers, targetNamespace, meshesOf } from "../src/index.js";

const D = "sha256:" + "ab".repeat(32);
const NS = "shop";
type O = Record<string, any>;
const pod = (labels: Record<string, string>, image: string, extra: O = {}) => ({ metadata: { labels }, spec: { containers: [{ name: "main", image, ports: [{ containerPort: 8080 }], ...extra }] } });

function inv(over: { svcs?: O[]; hpas?: O[]; ns?: O | null; extra?: O[] } = {}): RawInventory {
  const items: O[] = [
    { kind: "k8s.deployment", imageDigest: D, metadata: { name: "web", namespace: NS }, spec: { replicas: 2, template: pod({ app: "web" }, "ghcr.io/x/web:1") } },
    { kind: "k8s.statefulset", imageDigest: D, metadata: { name: "kv", namespace: NS },
      spec: { replicas: 3, serviceName: "kv", podManagementPolicy: "Parallel", persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain" },
        template: pod({ app: "kv" }, "ghcr.io/x/kv:7", { volumeMounts: [{ name: "data", mountPath: "/data" }] }),
        volumeClaimTemplates: [{ name: "data", accessModes: ["ReadWriteOnce"], storage: "20Gi", storageClassName: "gp3" }, { name: "wal", accessModes: ["ReadWriteOnce"], storage: "5Gi" }] } },
    { kind: "k8s.daemonset", imageDigest: D, metadata: { name: "agent", namespace: NS }, spec: { template: pod({ app: "agent" }, "ghcr.io/x/agent:1") }, status: { desiredNumberScheduled: 3 } },
    ...(over.svcs ?? [
      { kind: "k8s.service", metadata: { name: "kv", namespace: NS }, spec: { clusterIP: "None", publishNotReadyAddresses: true, selector: { app: "kv" }, ports: [{ port: 6379 }] } },
      { kind: "k8s.service", metadata: { name: "web", namespace: NS }, spec: { type: "NodePort", selector: { app: "web" }, sessionAffinity: "ClientIP", sessionAffinityTimeoutSec: 600,
        externalTrafficPolicy: "Local", ports: [{ port: 80, targetPort: 8080, nodePort: 30080 }] } },
      { kind: "k8s.service", metadata: { name: "pay", namespace: NS }, spec: { type: "ExternalName", externalName: "pay.partner.example.com", ports: [{ port: 443 }] } },
      { kind: "k8s.service", metadata: { name: "olddb", namespace: NS }, spec: { type: "ExternalName", externalName: "olddb.corp.internal" } },
    ]),
    ...(over.hpas ?? [{ kind: "k8s.hpa", metadata: { name: "kv", namespace: NS }, spec: { scaleTargetRef: { kind: "StatefulSet", name: "kv" }, minReplicas: 3, maxReplicas: 5 } }]),
    ...(over.ns === null ? [] : [over.ns ?? { kind: "k8s.namespace", metadata: { name: NS, labels: { "pod-security.kubernetes.io/enforce": "baseline" } } }]),
    ...(over.extra ?? []),
  ];
  return { provider: "aws", items, coverage: {} };
}
const comp = (spec: O, id: string) => spec.components.find((c: O) => c.id === id);

test("D6·V-1·NP-1·NS-1 정상: 종류·파드별 볼륨·headless·세션 고정·NodePort·ExternalName·네임스페이스 라벨이 IR 에 그대로", () => {
  const { result } = normalizeV2(inv(), { appName: "shop" });
  const spec = AppSpecV2.parse(result.spec) as O;   // Zod 모양 통과
  const kv = comp(spec, "kv");
  assert.equal(kv.props.workloadKind, "statefulset");
  assert.deepEqual(kv.props.statefulSet, { serviceName: "kv", podManagementPolicy: "Parallel", pvcRetention: { whenDeleted: "Retain" } });
  assert.deepEqual(kv.props.volumes, [
    { name: "data", mountPath: "/data", sizeGb: 20, access: "RWO", storageClass: "gp3", claimTemplate: true },
    { name: "wal", mountPath: "", sizeGb: 5, access: "RWO", claimTemplate: true },
  ]);
  assert.deepEqual(kv.props.replicas, { min: 3, max: 5 }, "HPA 가 StatefulSet 을 가리키면 그 StatefulSet 에 붙음");
  assert.equal(result.fieldMeta["components.kv.volumes.data"]?.needs_review, true, "디스크 데이터 안 따라옴 → 검토");
  assert.match(result.fieldMeta["components.kv.volumes.wal"]?.rationale ?? "", /마운트가 없음/);
  const ep = kv.props.endpoints[0];
  assert.equal(ep.type, "Headless");
  assert.equal(ep.publishNotReadyAddresses, true);
  const agent = comp(spec, "agent");
  assert.equal(agent.props.workloadKind, "daemonset");
  assert.deepEqual(agent.props.replicas, { min: 3, max: 3 });
  const web = comp(spec, "web");
  assert.equal(web.props.workloadKind, undefined, "Deployment 는 칸을 안 둠 (옛 IR·지문 그대로)");
  assert.deepEqual(web.props.podLabels, { app: "web" }, "PL-2: 출발 파드 라벨 그대로");
  assert.deepEqual(web.props.endpoints[0], { name: "web", type: "NodePort", ports: [{ port: 80, targetPort: 8080, protocol: "TCP", nodePort: 30080 }],
    sessionAffinity: "ClientIP", sessionAffinityTimeoutSec: 600, externalTrafficPolicy: "Local" });
  assert.deepEqual(spec.serviceAliases, [
    { name: "olddb", namespace: NS, externalName: "olddb.corp.internal" },
    { name: "pay", namespace: NS, externalName: "pay.partner.example.com", ports: [{ port: 443 }] },
  ]);
  assert.equal(result.fieldMeta["serviceAliases.olddb"]?.needs_review, true, "사설 주소 → 검토");
  assert.equal(result.fieldMeta["serviceAliases.pay"]?.needs_review, false);
  assert.deepEqual(spec.namespaces, [{ name: NS, labels: { "pod-security.kubernetes.io/enforce": "baseline" } }]);
  const chk = checkV2(spec as never);
  assert.deepEqual(chk.errors, []);
  assert.ok(!result.unmapped.some((u) => u.resource.includes("k8s.service:pay")), "ExternalName 은 더는 unmapped 가 아님");
});

test("NS-1 거부: 네임스페이스 객체를 못 읽었으면 이름만 남기고 검토 표시", () => {
  const { result } = normalizeV2(inv({ ns: null }), { appName: "shop" });
  assert.deepEqual(result.spec.namespaces, [{ name: NS }]);
  assert.equal(result.fieldMeta[`namespaces.${NS}`]?.needs_review, true);
});

test("D6 거부: HPA 대상 종류가 다르면 붙이지 않는다 (같은 이름의 다른 종류)", () => {
  const { result } = normalizeV2(inv({ hpas: [{ kind: "k8s.hpa", metadata: { name: "kv", namespace: NS }, spec: { scaleTargetRef: { kind: "Deployment", name: "kv" }, minReplicas: 1, maxReplicas: 9 } }] }), { appName: "shop" });
  assert.deepEqual((comp(result.spec as O, "kv") as O).props.replicas, { min: 3, max: 3 });
  assert.ok(result.unmapped.some((u) => u.resource === "k8s.hpa:kv"));
});

test("checkV2 거부: NodePort 중복·종류와 안 맞는 칸·이름 겹침·목록 밖 네임스페이스", () => {
  const spec = structuredClone(normalizeV2(inv(), { appName: "shop" }).result.spec) as O;
  comp(spec, "kv").props.endpoints[0].ports[0].nodePort = 30080;           // web 과 같은 번호
  comp(spec, "web").props.statefulSet = { serviceName: "web" };              // Deployment 에 StatefulSet 칸
  comp(spec, "web").props.volumes = [{ name: "v", mountPath: "/v", claimTemplate: true }];
  comp(spec, "agent").props.scale = { targetCpuPct: 50 };                    // DaemonSet 에 HPA
  spec.serviceAliases.push({ name: "web", namespace: NS, externalName: "x.example.com" });
  comp(spec, "agent").props.namespace = "elsewhere";
  const e = checkV2(spec as never).errors.join("\n");
  for (const want of ["NodePort 중복: TCP/30080", "web.statefulSet", "web.volumes.v claimTemplate", "agent.scale", "serviceAliases 이름 겹침: shop/web", "agent.namespace elsewhere"])
    assert.ok(e.includes(want), `${want} 없음:\n${e}`);
  // headless 가 없으면 막지는 않고 검토
  const s2 = structuredClone(normalizeV2(inv(), { appName: "shop" }).result.spec) as O;
  comp(s2, "kv").props.endpoints = [];
  assert.ok(checkV2(s2 as never).reviews.some((r) => r.includes("kv.statefulSet.serviceName")));
});

test("M-1 정상: 도착 네임스페이스 = 출발 이름 그대로, k8s 밖 출발은 app-<앱>", () => {
  const { result } = normalizeV2(inv(), { appName: "shop" });
  assert.equal(targetNamespace(result.spec), NS);
  const noNs = structuredClone(result.spec) as O;
  delete noNs.namespaces;
  for (const c of noNs.components) delete c.props.namespace;
  assert.equal(targetNamespace(noNs as never), "app-shop");
});

test("D6·NS-1·M-1 막기: 새 칸은 capability 로 요구, 메시 주입·예약 네임스페이스·여러 네임스페이스는 렌더 전에 막음", () => {
  const ns = { kind: "k8s.namespace", metadata: { name: NS, labels: { "istio-injection": "enabled" }, annotations: { "linkerd.io/inject": "disabled" } } };
  const spec = normalizeV2(inv({ ns }), { appName: "shop" }).result.spec;
  const req = requirementsV2(spec);
  for (const c of ["workload.statefulset", "workload.daemonset", "endpoint.headless", "endpoint.nodePort", "endpoint.behaviour", "endpoint.externalName", "mesh.istio"])
    assert.ok(req.includes(c), c);
  assert.ok(!req.includes("mesh.linkerd"), "disabled 는 주입 안 함");
  assert.deepEqual(meshesOf(spec), [{ namespace: NS, mesh: "istio", key: "istio-injection" }]);
  const caps = [...req].filter((c) => c !== "mesh.istio");
  assert.ok(v2Blockers(spec, caps).unsupported.some((u) => u.includes("mesh.istio")));
  assert.deepEqual(v2Blockers(spec, req).unsupported, []);
  // 예약 이름: default 는 플랫폼이 만들·지울 수 없음 → 막기
  const d = structuredClone(spec) as O;
  d.namespaces = [{ name: "default" }];
  for (const c of d.components) if (c.props.namespace) c.props.namespace = "default";
  assert.ok(v2Blockers(d as never, requirementsV2(d as never)).unsupported.some((u) => u.includes("네임스페이스 default")));
  // 여러 네임스페이스 (N9 렌더 전): namespace.multi 요구
  const m = structuredClone(spec) as O;
  m.namespaces.push({ name: "other" });
  comp(m, "agent").props.namespace = "other";
  assert.ok(requirementsV2(m as never).includes("namespace.multi"));
});

test("JB-1: 일회성 Job 은 리소스로 안 옮기고 unmapped (끝난 것 C, 도는 중 B)", () => {
  const { result } = normalizeV2(inv({ extra: [
    { kind: "k8s.job", metadata: { name: "seed", namespace: NS }, status: { active: 0, succeeded: 1, failed: 0 } },
    { kind: "k8s.job", metadata: { name: "backfill", namespace: NS }, status: { active: 2, succeeded: 0, failed: 0 } },
  ] }), { appName: "shop" });
  assert.ok(!result.spec.components.some((c) => c.id === "seed" || c.id === "backfill"));
  assert.equal(result.unmapped.find((u) => u.resource === "k8s.job:seed")?.grade, "C");
  assert.equal(result.unmapped.find((u) => u.resource === "k8s.job:backfill")?.grade, "B");
});

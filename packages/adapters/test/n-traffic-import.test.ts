// D 묶음(N 계열·SSL-1·LK-1·T2·T3·SEC-1·EV-1): 출발 읽기 → IR → 사전 점검 막기. 클라우드 CLI 는 가짜 exec 로만
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { allowAnnotations } from "../src/import/annotations.js";
import { rdsComputeOf, cloudSqlComputeOf, rdsTls, cloudSqlTls, cnpgTls } from "../src/import/mappers/pg-settings.js";
import { requirementsV2, v2Blockers, k8sEnv } from "../src/target/shared.js";
import type { Exec } from "../src/terraform/real-runner.js";

const D = "sha256:" + "ab".repeat(32);
const D2 = "sha256:" + "cd".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items }) as RawInventory;
const run = (items: Raw[]) => normalizeV2(inv(items)).result;
const dep = (name: string, pod: Raw = {}, c: Raw = {}, extra: Raw = {}): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: {
    serviceAccountName: name, containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env: [], ...c }], ...pod } } },
  ...extra,
});
const cm = (name: string, data: Record<string, string>, extra: Raw = {}): Raw => ({ kind: "k8s.configMapKeys", metadata: { name, namespace: "shop" }, keys: Object.keys(data).sort(), data, ...extra });
const comp = (r: ReturnType<typeof run>, id: string) => r.spec.components.find((c) => c.id === id) as any;
const ok = (r: ReturnType<typeof run>) => assert.equal(ImportResultV2.safeParse(r).success, true, JSON.stringify(ImportResultV2.safeParse(r).error?.issues?.slice(0, 3)));

// ── N3 ConfigMap 값 + SEC-1 ─────────────────────────────
test("N3: 쓰는 ConfigMap 만 값까지 configs 로, 평문 비밀처럼 보이는 키는 값을 빼고 검토 + unmapped B", () => {
  const r = run([
    dep("api", {}, { env: [{ name: "MODE", valueFrom: { configMapKeyRef: { name: "app-cfg", key: "MODE" } } }] }),
    cm("app-cfg", { MODE: "prod", DB_PASSWORD: "hunter2" }),
    cm("unused", { X: "1" }),
  ]);
  ok(r);
  const api = comp(r, "api");
  assert.equal(api.props.configs.length, 1, "안 쓰는 ConfigMap 은 안 담음");
  assert.deepEqual(api.props.configs[0].data, { MODE: "prod" });
  assert.match(api.props.configs[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(r.spec).includes("hunter2"), "평문 비밀 값은 명세에 없음");
  assert.equal(r.fieldMeta["components.api.configs.app-cfg"]?.confidence, 0.6);
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.configMap:app-cfg.DB_PASSWORD" && u.grade === "B"));
});

test("N3 거부: 참조한 ConfigMap 이 출발에 없으면 만들지 않고 0.6 검토, binaryData 는 계획에서 막음", () => {
  const r = run([dep("api", {}, { envFrom: [{ configMapRef: { name: "missing" } }, { configMapRef: { name: "bin" } }] }), cm("bin", { A: "1" }, { binaryKeys: ["cert.der"] })]);
  ok(r);
  assert.equal(r.fieldMeta["components.api.configs.missing"]?.confidence, 0.6);
  const spec = AppSpecV2.parse(r.spec);
  assert.ok(v2Blockers(spec, []).unsupported.some((x) => x.includes("binaryData")));
});

test("SEC-1: init 컨테이너 env·인자의 평문 비밀도 명세에서 빠진다", () => {
  const r = run([dep("api", { initContainers: [{ name: "migrate", image: `ghcr.io/demo/m@${D2}`, env: [{ name: "INIT_TOKEN", value: "INIT-SECRET" }], args: ["--db-password=ARG-SECRET", "--password", "ARG-SECRET2", "--keep=1"] }] },
    { command: ["node", "app.js", "--api-key=MAIN-SECRET"] })]);
  ok(r);
  const s = JSON.stringify(r.spec);
  for (const x of ["INIT-SECRET", "ARG-SECRET", "ARG-SECRET2", "MAIN-SECRET"]) assert.ok(!s.includes(x), x);
  const init = comp(r, "api").props.initContainers[0];
  assert.deepEqual(init.args, ["--db-password=$(PLAIN_SECRET_ARGS_0)", "--password", "$(PLAIN_SECRET_ARGS_2)", "--keep=1"]);
  assert.equal(r.fieldMeta["components.api.initContainers.migrate.args"]?.needs_review, true);
  assert.ok(r.unmapped.some((u) => u.resource.includes("env:api.migrate.INIT_TOKEN")));
});

// ── N4 사이드카·init·볼륨 ───────────────────────────────
test("N4: 사이드카·init(네이티브 사이드카 포함)·파드 볼륨·마운트·PVC 를 그대로 옮긴다", () => {
  const r = run([
    dep("api", {
      initContainers: [{ name: "log", image: `ghcr.io/demo/log@${D2}`, restartPolicy: "Always", volumeMounts: [{ name: "logs", mountPath: "/var/log/app" }] }],
      containers: [
        { name: "api", image: "ghcr.io/demo/api:1.0", ports: [{ containerPort: 8080 }], env: [], volumeMounts: [{ name: "logs", mountPath: "/logs" }, { name: "data", mountPath: "/data" }, { name: "cfg", mountPath: "/etc/app", readOnly: true }, { name: "tls", mountPath: "/tls" }] },
        { name: "proxy", image: "ghcr.io/demo/proxy:2", env: [{ name: "P", value: "1" }] },
      ],
      volumes: [{ name: "logs", emptyDir: {} }, { name: "data", persistentVolumeClaim: { claimName: "api-data" } }, { name: "cfg", configMap: { name: "app-cfg" } }, { name: "tls", secret: { secretName: "api-tls" } }],
    }, {}, { containerDigests: { api: D, proxy: D2, log: D2 } }),
    cm("app-cfg", { "app.yaml": "a: 1" }),
    { kind: "k8s.pvc", metadata: { name: "api-data", namespace: "shop" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "20Gi" } } } },
  ]);
  ok(r);
  const p = comp(r, "api").props;
  assert.equal(p.sidecars.length, 1);
  assert.equal(p.sidecars[0].image.digest, D2, "사이드카 digest 는 실행 중 Pod 에서");
  assert.equal(p.initContainers[0].restartPolicy, "Always");
  assert.deepEqual(p.podVolumes.map((v: any) => `${v.name}:${v.type}`), ["logs:emptyDir", "cfg:configMap", "tls:secret"]);
  assert.deepEqual(p.volumes, [{ name: "data", mountPath: "/data", claimName: "api-data", sizeGb: 20, access: "RWO" }]);
  assert.equal(p.volumeMounts.length, 4);
  assert.deepEqual(p.secretMounts, [{ secret: "api-tls", mountPath: "/tls" }], "비밀 이름 목록(예전 칸)도 채움");
  assert.equal(p.configs[0].mountPath, "/etc/app");
  assert.equal(r.fieldMeta["components.api.volumes"]?.needs_review, true, "디스크 데이터는 안 따라옴 → 검토");
});

test("N4 거부: hostPath 는 계획에서 막고, 모르는 볼륨 종류는 unmapped B + 검토", () => {
  const r = run([dep("api", { volumes: [{ name: "host", hostPath: { path: "/var/run" } }, { name: "nfs", other: "nfs" }] })]);
  ok(r);
  assert.ok(r.unmapped.some((u) => u.resource.endsWith(".volume:nfs") && u.grade === "B"));
  assert.equal(r.fieldMeta["components.api.podVolumes"]?.confidence, 0.6);
  const spec = AppSpecV2.parse(r.spec);
  assert.ok(requirementsV2(spec).includes("volume.hostPath"));
});

test("N4 거부: digest 를 못 찾은 태그만 사이드카·init 은 0.6 검토와 이유, 사전 점검이 막아 도착에 안 그림", () => {
  const r = run([dep("api", {
    initContainers: [{ name: "log", image: `ghcr.io/demo/log@${D2}` }, { name: "migrate", image: "ghcr.io/demo/migrate:1" }],
    containers: [
      { name: "api", image: `ghcr.io/demo/api@${D}`, ports: [{ containerPort: 8080 }], env: [] },
      { name: "proxy", image: "ghcr.io/demo/proxy:2", env: [] },
      { name: "istio-proxy", image: "docker.io/istio/proxyv2:1.22", env: [] },
    ],
  })]);
  ok(r);
  const p = comp(r, "api").props;
  assert.deepEqual(p.sidecars.map((s: any) => s.name), ["proxy", "istio-proxy"], "빼지 않는다 (인자가 연결 근거일 수 있음)");
  assert.deepEqual(p.initContainers.map((s: any) => s.name), ["log", "migrate"]);
  for (const [k, name] of [["sidecars", "proxy"], ["initContainers", "migrate"]] as const) {
    const f = r.fieldMeta[`components.api.${k}`];
    assert.deepEqual([f?.confidence, f?.needs_review], [0.6, true], k);
    assert.match(f?.rationale ?? "", new RegExp(`(^|[ ,])${name}([ ,]|$)`), k);
  }
  assert.doesNotMatch(r.fieldMeta["components.api.sidecars"]?.rationale ?? "", /istio-proxy/, "메시 주입형은 도착이 안 그려서 digest 가 없어도 검토 이유가 아님");
  const blocks = v2Blockers(AppSpecV2.parse(r.spec), []).unsupported.filter((x) => x.includes("digest"));
  assert.deepEqual(blocks.sort(), ["도착 렌더 미지원: api 이미지 digest 없음 (ghcr.io/demo/migrate)", "도착 렌더 미지원: api 이미지 digest 없음 (ghcr.io/demo/proxy)"]);
});

test("N4: 사이드카·init 이 전부 digest 로 박혀 있으면 검토 없이 신뢰도 1", () => {
  const r = run([dep("api", {
    initContainers: [{ name: "log", image: `ghcr.io/demo/log@${D2}` }],
    containers: [{ name: "api", image: `ghcr.io/demo/api@${D}`, env: [] }, { name: "proxy", image: "ghcr.io/demo/proxy:2", env: [] }],
  }, {}, { containerDigests: { proxy: D2 } })]);
  ok(r);
  assert.deepEqual(comp(r, "api").props.sidecars.map((s: any) => s.image.digest), [D2]);
  for (const k of ["sidecars", "initContainers"]) assert.deepEqual([r.fieldMeta[`components.api.${k}`]?.confidence, r.fieldMeta[`components.api.${k}`]?.needs_review], [1, false], k);
});

// ── N5 배치·PDB ─────────────────────────────────────────
test("N5: 배치 칸 원문 + PDB, 노드 이름 키는 0.6 검토", () => {
  const r = run([
    dep("api", { nodeSelector: { "kubernetes.io/hostname": "node-1" }, tolerations: [{ key: "gpu", operator: "Exists" }], priorityClassName: "high",
      topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "DoNotSchedule" }] }),
    dep("web", { affinity: { podAntiAffinity: {} } }),
    { kind: "k8s.pdb", metadata: { name: "api-pdb", namespace: "shop" }, spec: { selector: { matchLabels: { app: "api" } }, minAvailable: 1 } },
    { kind: "k8s.pdb", metadata: { name: "orphan", namespace: "shop" }, spec: { selector: { matchLabels: { app: "nope" } }, maxUnavailable: "50%" } },
  ]);
  ok(r);
  const api = comp(r, "api").props;
  assert.equal(api.scheduling.nodeSelector["kubernetes.io/hostname"], "node-1");
  assert.equal(api.scheduling.priorityClassName, "high");
  assert.equal(r.fieldMeta["components.api.scheduling"]?.confidence, 0.6);
  assert.equal(r.fieldMeta["components.web.scheduling"]?.confidence, 1);
  assert.deepEqual(api.disruption, { name: "api-pdb", minAvailable: 1 });
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.pdb:orphan"), "고르는 대상이 없는 PDB = unmapped");
});

// ── N6·N7·N10·N11·N12·T3 ───────────────────────────────
test("N6·N7·N10·N11·N12·T3: NetworkPolicy 본문, HPA 지표·behavior, annotation 허용 목록, L4 LB, CRD 목록, RBAC", () => {
  const r = run([
    dep("api"),
    { kind: "k8s.service", metadata: { name: "api", namespace: "shop", annotations: { "service.beta.kubernetes.io/aws-load-balancer-type": "nlb" } }, spec: { type: "LoadBalancer", selector: { app: "api" }, ports: [{ port: 443, targetPort: 8080, appProtocol: "kubernetes.io/h2c" }] } },
    { kind: "k8s.ingress", metadata: { name: "ing", namespace: "shop", annotations: { "nginx.ingress.kubernetes.io/proxy-body-size": "10m" } },
      spec: { rules: [{ host: "a.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { number: 443 } } } }] } }] } },
    { kind: "k8s.networkPolicy", metadata: { name: "deny", namespace: "shop" }, spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] } },
    { kind: "k8s.hpa", metadata: { name: "api", namespace: "shop" }, spec: { scaleTargetRef: { name: "api" }, minReplicas: 2, maxReplicas: 8,
      metrics: [{ type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: 80 } } }, { type: "External", external: {} }],
      behavior: { scaleDown: { stabilizationWindowSeconds: 300 } } } },
    { kind: "k8s.role", metadata: { name: "leader", namespace: "shop" }, rules: [{ apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["get", "update"] }] },
    { kind: "k8s.roleBinding", metadata: { name: "leader", namespace: "shop" }, roleRef: { kind: "Role", name: "leader" }, subjects: [{ kind: "ServiceAccount", name: "api", namespace: "shop" }] },
    { kind: "k8s.clusterRoleBinding", metadata: { name: "api-nodes" }, roleRef: { kind: "ClusterRole", name: "node-reader" }, subjects: [{ kind: "ServiceAccount", name: "api", namespace: "shop" }] },
    { kind: "k8s.crdObject", metadata: { name: "api-mon", namespace: "shop" }, resource: "servicemonitors.monitoring.coreos.com" },
  ]);
  ok(r);
  const api = comp(r, "api").props;
  assert.equal(api.endpoints[0].type, "LoadBalancer");
  assert.deepEqual(api.endpoints[0].annotations, { "service.beta.kubernetes.io/aws-load-balancer-type": "nlb" });
  assert.equal(api.endpoints[0].ports[0].appProtocol, "kubernetes.io/h2c", "V-1: appProtocol 그대로");
  assert.ok(!r.unmapped.some((u) => u.resource === "k8s.service:api"), "N11: L4 LB 는 unmapped 아님");
  assert.deepEqual(r.spec.entry?.hosts[0]?.annotations, { "nginx.ingress.kubernetes.io/proxy-body-size": "10m" });
  const net = r.spec.posture.network.find((n) => n.scope === "namespace") as any;
  assert.deepEqual(net.rules, [{ name: "deny", podSelector: {}, policyTypes: ["Ingress"], ingress: [] }]);
  assert.equal(api.scale.metrics.length, 2);
  assert.deepEqual(api.scale.behavior, { scaleDown: { stabilizationWindowSeconds: 300 } });
  assert.equal(api.scale.targetCpuPct, undefined, "CPU 지표가 없으면 옛 칸은 비움");
  assert.equal(r.spec.rbac?.roles[0]?.name, "leader");
  assert.equal(r.spec.rbac?.clusterBindings?.[0]?.name, "api-nodes");
  assert.ok(r.unmapped.some((u) => u.resource === "crd:servicemonitors.monitoring.coreos.com:shop/api-mon" && u.grade === "C"));
  const spec = AppSpecV2.parse(r.spec);
  assert.ok(requirementsV2(spec).includes("scale.customMetrics"), "External 지표 = 도착 지표 서버 필요");
  assert.ok(v2Blockers(spec, []).needsHuman.some((x) => x.includes("api-nodes")), "클러스터 단위 권한 = 사람 확인");
});

test("N10 거부: 허용 목록 밖 annotation·snippet 은 안 읽는다", () => {
  assert.equal(allowAnnotations("ingress", { "nginx.ingress.kubernetes.io/configuration-snippet": "x", "kubectl.kubernetes.io/last-applied-configuration": "{}", "a/b": "c" }), undefined);
  assert.deepEqual(allowAnnotations("pod", { "prometheus.io/scrape": "true", "x": "y" }), { "prometheus.io/scrape": "true" });
});

// ── LK-1 주소 다시 쓰기 ─────────────────────────────────
test("LK-1: ConfigMap 값·인자 안 출발 DB 주소도 링크 근거가 되고 템플릿으로 바뀐다", () => {
  const db = { kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: "shop" }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "1Gi" }, instances: 1 } };
  const r = run([
    dep("api", {}, { env: [{ name: "MODE", valueFrom: { configMapKeyRef: { name: "app-cfg", key: "MODE" } } }], args: ["--db=postgres://shop-db-rw.shop.svc:5432/app", "--x"] }),
    cm("app-cfg", { MODE: "p", "app.yaml": "db:\n  host: shop-db-rw.shop.svc.cluster.local\n  port: 5432\n" }),
    db,
  ]);
  ok(r);
  assert.ok(r.spec.links.some((l) => l.from === "api" && l.to === "shop-db"), "env 밖 주소로도 의존성");
  const p = comp(r, "api").props;
  assert.deepEqual(p.args, ["--db=postgres://${shop-db.host}:5432/app", "--x"]);
  assert.deepEqual(p.argTemplates, [0]);
  const cfg = p.configs[0];
  assert.equal(cfg.data["app.yaml"], "db:\n  host: ${shop-db.host}\n  port: 5432\n");
  assert.deepEqual(cfg.templateKeys, ["app.yaml"]);
  assert.equal(checkV2(AppSpecV2.parse(r.spec)).errors.length, 0);
});

// ── EV-1 ───────────────────────────────────────────────
test("EV-1: env 참조의 optional·containerName·divisor 를 그대로 옮기고 그린다", () => {
  const r = run([dep("api", {}, { env: [
    { name: "S", valueFrom: { secretKeyRef: { name: "s", key: "k", optional: true } } },
    { name: "M", valueFrom: { resourceFieldRef: { resource: "limits.memory", containerName: "api", divisor: "1Mi" } } },
  ], envFrom: [{ configMapRef: { name: "opt", optional: true } }] })]);
  ok(r);
  const env = comp(r, "api").props.env;
  assert.deepEqual(env[0], { name: "S", fromSecret: { secret: "s", key: "k", optional: true } });
  assert.deepEqual(env[1], { name: "M", fromResource: "limits.memory", containerName: "api", divisor: "1Mi" });
  assert.deepEqual(comp(r, "api").props.envFrom, [{ config: "opt", prefix: "", optional: true }]);
  const spec = AppSpecV2.parse(r.spec);
  assert.deepEqual(k8sEnv(spec, env[1], { namespace: "shop", out: {} }), { name: "M", valueFrom: { resourceFieldRef: { resource: "limits.memory", containerName: "api", divisor: "1Mi" } } });
});

// 경계(서비스가 닿는 DB 만)를 지나게 api 가 출발 DB 주소를 쓴다
const EP = "shop-db.abc.ap-northeast-2.rds.amazonaws.com";
const apiDb = dep("api", {}, { env: [{ name: "DB_HOST", value: EP }] });

// ── N8·SSL-1 Postgres ──────────────────────────────────
test("N8: 등급 이름 → 크기, 표 밖은 null", () => {
  assert.deepEqual(rdsComputeOf("db.m6g.xlarge"), { cpuMilli: 4000, memMiB: 16384 });
  assert.deepEqual(rdsComputeOf("db.t4g.micro"), { cpuMilli: 2000, memMiB: 1024 });
  assert.equal(rdsComputeOf("db.serverless"), null);
  assert.deepEqual(cloudSqlComputeOf("db-custom-2-7680"), { cpuMilli: 2000, memMiB: 7680 });
  assert.equal(cloudSqlComputeOf("db-perf-optimized-N-8"), null);
});

test("SSL-1: 출발 TLS 강제 여부 (RDS 파라미터·버전 기본, Cloud SQL sslMode, CNPG pg_hba)", () => {
  assert.equal(rdsTls({ "rds.force_ssl": "0" }, "custom", "16", "x").v, false);
  assert.equal(rdsTls(null, "default.postgres16", "16", "x").v, true);
  assert.equal(rdsTls(null, "default.postgres14", "14", "x").v, false);
  assert.equal(rdsTls(null, "custom", "16", "x").v, null, "사용자 그룹 값을 못 읽음 = 모름");
  assert.equal(cloudSqlTls({ sslMode: "ENCRYPTED_ONLY" }, "x").v, true);
  assert.equal(cloudSqlTls({ sslMode: "ALLOW_UNENCRYPTED_AND_ENCRYPTED" }, "x").v, false);
  assert.equal(cnpgTls(["hostnossl all all 0.0.0.0/0 reject"], "x").v, true);
  assert.equal(cnpgTls(undefined, "x").v, false);
});

test("N8·SSL-1: RDS 원본 → compute·readReplicas·databases·parameters·tlsRequired, 평문 허용이면 tls_relaxed 승인 줄 + 벤더 파라미터 capability", () => {
  const r = run([apiDb, { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Endpoint: { Address: EP, Port: 5432 }, Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 50,
    DBInstanceClass: "db.r6g.large", ReadReplicaDBInstanceIdentifiers: ["shop-db-r1"], DBName: "shop", DBParameterGroupName: "shop-pg",
    Parameters: { "rds.force_ssl": "0", work_mem: "64MB" } }]);
  ok(r);
  const db = comp(r, "shop-db").props;
  assert.deepEqual(db.compute, { cpuMilli: 2000, memMiB: 16384 });
  assert.equal(db.readReplicas, 1);
  assert.deepEqual(db.databases, ["shop"]);
  assert.deepEqual(db.parameters, { work_mem: "64MB" }, "rds.force_ssl 은 tlsRequired 로 옮겨서 parameters 에서 뺌");
  assert.equal(db.tlsRequired, false);
  const spec = AppSpecV2.parse(r.spec);
  assert.ok(checkV2(spec).approvals.some((a) => a.kind === "tls_relaxed" && a.subject === "shop-db"));
  assert.ok(!requirementsV2(spec).includes("pg.param.rds"), "옮긴 키만 있으면 다른 클라우드로도 감");
  const r2 = run([apiDb, { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Endpoint: { Address: EP, Port: 5432 }, Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 50,
    DBParameterGroupName: "shop-pg", Parameters: { "rds.logical_replication": "1", "rds.log_retention_period": "4320" } }]);
  const s2 = AppSpecV2.parse(r2.spec);
  assert.deepEqual((s2.components.find((c) => c.id === "shop-db") as any).props.parameters, { "rds.log_retention_period": "4320" });
  assert.ok(requirementsV2(s2).includes("pg.param.rds"), "남은 rds.* 는 RDS 도착만 받음 → GCP 면 막힘");
});

test("N8 거부: 파라미터 그룹을 못 읽으면 값 없이 0.6 검토, TLS 는 모름(null)", () => {
  const r = run([apiDb, { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Endpoint: { Address: EP, Port: 5432 }, Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 50,
    DBParameterGroupName: "shop-pg", Parameters: null }]);
  ok(r);
  assert.equal(comp(r, "shop-db").props.parameters, undefined);
  assert.equal(r.fieldMeta["components.shop-db.parameters"]?.confidence, 0.6);
  assert.equal(comp(r, "shop-db").props.tlsRequired, null);
  assert.ok(!checkV2(AppSpecV2.parse(r.spec)).approvals.some((a) => a.kind === "tls_relaxed"), "모름은 승인 줄 아님");
});

// ── N9 여러 네임스페이스 + discover ─────────────────────
type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const out = hit[1].out;
    return { code: hit[1].code ?? 0, stdout: typeof out === "string" ? out : JSON.stringify(out ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const kdep = (name: string, ns: string, partOf?: string) => ({ metadata: { name, namespace: ns, labels: { app: name, ...(partOf ? { "app.kubernetes.io/part-of": partOf } : {}) } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name }, annotations: { "prometheus.io/scrape": "true", secret: "NO" } },
    spec: { containers: [{ name, image: `ghcr.io/demo/${name}@${D}` }], nodeSelector: { pool: "a" }, volumes: [{ name: "v", csi: { driver: "x" } }] } } } });
const empty = { out: { items: [] } };

test("N9·N12·T3: 같은 part-of 앱의 다른 네임스페이스도 읽고, CRD 객체·RBAC·ConfigMap 값·볼륨·배치·파드 annotation(허용 목록)을 원본에 담는다", async () => {
  const { exec, calls } = fakeExec([
    [/^kubectl get deployments -A/, { out: { items: [kdep("api", "shop", "shop"), kdep("worker", "shop-jobs", "shop"), kdep("other", "zzz")] } }],
    [/^kubectl get configmaps -n shop /, { out: { items: [{ metadata: { name: "c", namespace: "shop" }, data: { A: "1" }, binaryData: { B: "AA==" } }] } }],
    [/^kubectl get roles -n shop /, { out: { items: [{ metadata: { name: "r", namespace: "shop" }, rules: [{ verbs: ["get"] }] }] } }],
    [/^kubectl get clusterrolebindings /, { out: { items: [
      { metadata: { name: "mine" }, roleRef: { kind: "ClusterRole", name: "view" }, subjects: [{ kind: "ServiceAccount", name: "api", namespace: "shop" }] },
      { metadata: { name: "notmine" }, roleRef: { kind: "ClusterRole", name: "view" }, subjects: [{ kind: "ServiceAccount", name: "x", namespace: "kube-system" }] }] } }],
    [/^kubectl api-resources /, { out: "pods\ndeployments.apps\nservicemonitors.monitoring.coreos.com\nclusters.postgresql.cnpg.io\n" }],
    [/^kubectl get servicemonitors\.monitoring\.coreos\.com -n shop /, { out: { items: [{ metadata: { name: "m", namespace: "shop" } }] } }],
    [/^kubectl get \S+ -n /, empty],
  ]);
  const r = await readK8sNamespace({ exec, env: {} }, []);
  assert.deepEqual([...(r.namespaces ?? [])].sort(), ["shop", "shop-jobs"], "part-of 같은 네임스페이스만 (zzz 는 아님)");
  assert.ok(r.notes.some((n) => n.includes("shop-jobs")));
  assert.equal(r.items.filter((i) => i.kind === "k8s.deployment").length, 2);
  const cmi = r.items.find((i) => i.kind === "k8s.configMapKeys") as any;
  assert.deepEqual(cmi.data, { A: "1" });
  assert.deepEqual(cmi.binaryKeys, ["B"], "binaryData 는 키만");
  assert.ok(!JSON.stringify(r.items).includes("AA=="), "binaryData 값은 안 읽음");
  assert.equal(r.items.filter((i) => i.kind === "k8s.role").length, 1);
  assert.deepEqual(r.items.filter((i) => i.kind === "k8s.clusterRoleBinding").map((i: any) => i.metadata.name), ["mine"]);
  assert.deepEqual(r.items.filter((i) => i.kind === "k8s.crdObject").map((i: any) => i.resource), ["servicemonitors.monitoring.coreos.com"], "내장·CNPG 는 뺌");
  assert.ok(!calls.some((c) => c.includes("get clusters.postgresql.cnpg.io")));
  const api = r.items.find((i) => i.kind === "k8s.deployment" && i.metadata.name === "api") as any;
  assert.deepEqual(api.spec.template.spec.podAnnotations, { "prometheus.io/scrape": "true" });
  assert.deepEqual(api.spec.template.spec.nodeSelector, { pool: "a" });
  assert.deepEqual(api.spec.template.spec.volumes, [{ name: "v", other: "csi" }], "모르는 볼륨 종류는 이름만");
  assert.ok(!JSON.stringify(r.items).includes("\"NO\""), "허용 목록 밖 annotation 없음");
});

test("N9·T3 거부: IMPORT_NAMESPACE 하나면 그 네임스페이스만, RBAC 목록이 403 이어도 note 만 남기고 계속", async () => {
  const F = { code: 1, err: "Error from server (Forbidden): roles is forbidden" };
  const { exec } = fakeExec([
    [/^kubectl get deployments -n shop /, { out: { items: [kdep("api", "shop", "shop")] } }],
    [/^kubectl get (roles|rolebindings|clusterrolebindings) /, F],
    [/^kubectl api-resources /, F],
    [/^kubectl get \S+ -n /, empty],
  ]);
  const r = await readK8sNamespace({ exec, env: { IMPORT_NAMESPACE: "shop" } }, []);
  assert.equal(r.namespaces, undefined);
  assert.equal(r.namespace, "shop");
  assert.ok(r.notes.some((n) => n.startsWith("Role 목록 못 읽음")));
  assert.ok(r.notes.some((n) => n.startsWith("ClusterRoleBinding 목록 못 읽음")));
  assert.ok(r.notes.some((n) => n.startsWith("CRD 종류 목록 못 읽음")));
  assert.equal(r.items.filter((i) => i.kind === "k8s.deployment").length, 1);
});

// ── VT-1·NSC-1·HN-1 ────────────────────────────────────
test("VT-1·NSC-1·HN-1: emptyDir 는 PVC 가 아니라 emptyDir 그대로(medium·sizeLimit), 기본 사이드카 restartPolicy, 노드 공유 칸 + host_access 승인", () => {
  const r = run([dep("agent", {
    hostNetwork: true, hostPID: true, tolerations: [{ operator: "Exists" }],
    initContainers: [{ name: "shipper", image: `ghcr.io/demo/ship@${D2}`, restartPolicy: "Always", volumeMounts: [{ name: "cache", mountPath: "/cache" }] }],
    volumes: [{ name: "cache", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }, { name: "logs", hostPath: { path: "/var/log" } }],
  }, { ports: [{ containerPort: 9100, hostPort: 9100 }] })]);
  ok(r);
  const p = comp(r, "agent").props;
  assert.equal(p.volumes, undefined, "emptyDir·hostPath 는 PVC 칸(volumes)에 안 들어감");
  assert.deepEqual(p.podVolumes[0], { name: "cache", type: "emptyDir", source: { medium: "Memory", sizeLimit: "64Mi" } });
  assert.equal(p.initContainers[0].restartPolicy, "Always");
  assert.deepEqual(p.initContainers[0].volumeMounts, [{ name: "cache", mountPath: "/cache" }]);
  assert.deepEqual(p.host, { network: true, pid: true });
  assert.equal(p.ports[0].hostPort, 9100);
  assert.deepEqual(p.scheduling.tolerations, [{ operator: "Exists" }]);
  const spec = AppSpecV2.parse(r.spec);
  const a = checkV2(spec).approvals.find((x) => x.kind === "host_access");
  assert.ok(a?.detail && a.detail.includes("hostNetwork") && a.detail.includes("hostPID") && a.detail.includes("hostPort 9100") && a.detail.includes("hostPath 볼륨 logs"), a?.detail);
  const req = requirementsV2(spec);
  assert.ok(req.includes("pod.nativeSidecar") && req.includes("volume.hostPath"));
});

test("NSC-1·HN-1 거부: 보통 init 컨테이너(restartPolicy 없음)는 기본 사이드카 요구 없음, 노드를 안 쓰면 host_access 승인 줄 없음", () => {
  const r = run([dep("api", { hostNetwork: false, initContainers: [{ name: "wait", image: `ghcr.io/demo/w@${D2}`, restartPolicy: "OnFailure" }] })]);
  ok(r);
  const p = comp(r, "api").props;
  assert.equal(p.host, undefined);
  assert.equal(p.initContainers[0].restartPolicy, undefined, "init 의 Always 밖 값은 k8s 가 안 받음 → 안 옮김");
  const spec = AppSpecV2.parse(r.spec);
  assert.ok(!requirementsV2(spec).includes("pod.nativeSidecar"));
  assert.ok(!checkV2(spec).approvals.some((x) => x.kind === "host_access"));
});

// ── W-1 사전 점검 경고 ──────────────────────────────────
test("W-1: L4 LB 주소 변경·빈 PVC·메시 사이드카·다른 클라우드 annotation 이 사전 점검 PC-V2-K8S warn 줄로 나온다", async () => {
  const { v2PrecheckItems, k8sRenderWarnings } = await import("../src/index.js");
  const r = run([
    dep("api", { containers: [{ name: "api", image: "ghcr.io/demo/api:1.0", ports: [{ containerPort: 8080 }], env: [], volumeMounts: [{ name: "data", mountPath: "/data" }] }, { name: "istio-proxy", image: "docker.io/istio/proxyv2:1.22", env: [] }],
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: "api-data" } }] }, {}, { containerDigests: { api: D, "istio-proxy": D2 } }),
    { kind: "k8s.service", metadata: { name: "api", namespace: "shop", annotations: { "service.beta.kubernetes.io/aws-load-balancer-type": "nlb" } }, spec: { type: "LoadBalancer", selector: { app: "api" }, ports: [{ port: 443, targetPort: 8080 }] } },
  ]);
  const spec = AppSpecV2.parse(r.spec);
  const w = k8sRenderWarnings(spec, "gcp");
  assert.ok(w.some((m) => m.includes("L4 LoadBalancer api")));
  assert.ok(w.some((m) => m.includes("빈 PVC")));
  assert.ok(w.some((m) => m.includes("istio-proxy")));
  assert.ok(w.some((m) => m.includes("aws-load-balancer-type") && m.includes("다른 클라우드")));
  assert.ok(!k8sRenderWarnings(spec, "aws").some((m) => m.includes("다른 클라우드")), "같은 클라우드면 annotation 경고 없음");
  const items = v2PrecheckItems("gcp", { specV2: spec });
  const k8s = items.filter((i) => i.id.startsWith("PC-V2-K8S-"));
  assert.equal(k8s.length, w.length);
  assert.ok(k8s.every((i) => i.level === "warn"));
});

test("W-1 거부: 달라지는 게 없는 명세는 PC-V2-K8S 줄이 없다", async () => {
  const { v2PrecheckItems } = await import("../src/index.js");
  const spec = AppSpecV2.parse(run([dep("api")]).spec);
  assert.equal(v2PrecheckItems("gcp", { specV2: spec }).filter((i) => i.id.startsWith("PC-V2-K8S-")).length, 0);
});

// ── SSL-1 도착 ─────────────────────────────────────────
test("SSL-1 도착: 출발 평문 허용이면 tf require_tls = false + 도착 사실 tlsEnforced false, 모름이면 TLS 강제 그대로", async () => {
  const { targetBuilderFor, targetFactsV2 } = await import("../src/index.js");
  const mk = (tls: boolean | null) => AppSpecV2.parse(run([apiDb, { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Endpoint: { Address: EP, Port: 5432 }, Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 50,
    DBParameterGroupName: "shop-pg", Parameters: tls === null ? null : { "rds.force_ssl": tls ? "1" : "0" } }]).spec);
  const off = mk(false), unk = mk(null);
  assert.equal((off.components.find((c) => c.id === "shop-db") as any).props.tlsRequired, false);
  const facts = (s: AppSpecV2, p: "aws" | "gcp") => targetFactsV2({ envId: "e", provider: p, region: null }, s).dbs[0]!.db.tlsEnforced.value;
  assert.equal(facts(off, "gcp"), false);
  assert.equal(facts(unk, "gcp"), true, "모름은 지금처럼 TLS 강제");
  const T = (p: "aws" | "gcp") => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111",
    migrationId: "22222222-2222-4222-8222-222222222222", ...(p === "aws" ? { accountId: "000000000000" } : { projectId: "demo-project" }) }) as any;
  const tlsVar = (s: AppSpecV2, p: "aws" | "gcp") => JSON.parse(String(targetBuilderFor(p).toTerraformV2(s, T(p)).vars.postgres_json))[0].require_tls;
  for (const p of ["aws", "gcp"] as const) {
    assert.equal(tlsVar(off, p), false, p);
    assert.equal(tlsVar(unk, p), true, `${p}: 모름은 TLS 강제`);
  }
});

// ── NM-1 ───────────────────────────────────────────────
test("NM-1: REDIS_AUTH·AUTH_KEY 값은 평문 비밀로 가림, AUTHOR·OAUTH_CALLBACK_URL 은 그대로", async () => {
  const { isPlainSecret } = await import("../src/import/env-rewrite.js");
  assert.equal(isPlainSecret("REDIS_AUTH", "x"), true);
  assert.equal(isPlainSecret("AUTH_KEY", "x"), true);
  assert.equal(isPlainSecret("cache.auth", "x"), true);
  assert.equal(isPlainSecret("AUTHOR", "kim"), false);
  assert.equal(isPlainSecret("OAUTH_CALLBACK_URL", "https://a.example.com/cb"), false);
  const r = run([dep("api", {}, { env: [{ name: "REDIS_AUTH", value: "AUTH-SECRET-1" }] })]);
  ok(r);
  assert.ok(!JSON.stringify(r.spec).includes("AUTH-SECRET-1"));
});

// ── ENT-1·G3-3 ─────────────────────────────────────────
const ingOf = (name: string, host: string, cls?: string, ann?: Record<string, string>): Raw => ({ kind: "k8s.ingress", metadata: { name, namespace: "shop", ...(ann ? { annotations: ann } : {}) },
  spec: { ...(cls ? { ingressClassName: cls } : {}), rules: [{ host, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { number: 80 } } } }] } }] } });
const svcApi: Raw = { kind: "k8s.service", metadata: { name: "api", namespace: "shop" }, spec: { selector: { app: "api" }, ports: [{ port: 80, targetPort: 8080 }] } };

test("ENT-1: 사내망 전용 Ingress(클래스 internal·ALB scheme internal)는 exposure internal → 공개 입구로 못 그려서 계획에서 막음", () => {
  const r = run([dep("api"), svcApi, ingOf("pub", "shop.example.com", "nginx"), ingOf("adm", "admin.shop.internal", "nginx-internal"),
    ingOf("alb", "ops.shop.internal", "alb", { "alb.ingress.kubernetes.io/scheme": "internal" })]);
  ok(r);
  const ex = Object.fromEntries((r.spec.entry?.hosts ?? []).map((h) => [h.hostnames[0], h.exposure]));
  assert.deepEqual(ex, { "admin.shop.internal": "internal", "ops.shop.internal": "internal", "shop.example.com": "public" });
  assert.equal(r.fieldMeta["entry.shop.example.com.exposure"], undefined, "아는 공개 클래스 = 검토 없음");
  const spec = AppSpecV2.parse(r.spec);
  assert.ok(requirementsV2(spec).includes("entry.internal"));
});

test("ENT-1 거부: 모르는 클래스는 공개로 두되 검토 표시, 같은 호스트를 공개·내부가 같이 받으면 내부 + 검토", () => {
  const r = run([dep("api"), svcApi, ingOf("a", "shop.example.com", "corp-edge"), ingOf("b", "both.example.com", "nginx"), ingOf("c", "both.example.com", "nginx-internal")]);
  ok(r);
  const h = (n: string) => r.spec.entry?.hosts.find((x) => x.hostnames[0] === n);
  assert.equal(h("shop.example.com")?.exposure, "public");
  assert.equal(r.fieldMeta["entry.shop.example.com.exposure"]?.confidence, 0.6);
  assert.equal(h("both.example.com")?.exposure, "internal");
  assert.equal(r.fieldMeta["entry.both.example.com.exposure"]?.needs_review, true);
  const pubOnly = AppSpecV2.parse(run([dep("api"), svcApi, ingOf("p", "shop.example.com", "nginx")]).spec);
  assert.ok(!requirementsV2(pubOnly).includes("entry.internal"));
});

// ── CT-1 (캐시 포트) ───────────────────────────────────
test("CT-1: 캐시 주소 뒤 :포트 는 링크 port 로, DB 주소 뒤 포트는 출발 글자 그대로", () => {
  const CE = "shop-cache.abc.ng.0001.apne1.cache.amazonaws.com";
  const r = run([dep("api", {}, { env: [{ name: "REDIS_URL", value: `rediss://${CE}:6379/0` }, { name: "DB_URL", value: `postgres://${EP}:5432/app` }] }),
    { kind: "elasticache.replicationGroup", ReplicationGroupId: "shop-cache", Engine: "redis", EngineVersion: "7.1.0", CacheNodeType: "cache.t4g.medium", ClusterEnabled: false, NodeGroups: 1,
      TransitEncryptionEnabled: true, PrimaryEndpoint: CE },
    { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Endpoint: { Address: EP, Port: 5432 }, Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 50 }]);
  ok(r);
  const env = comp(r, "api").props.env as Array<{ name: string; template?: string }>;
  assert.equal(env.find((e) => e.name === "REDIS_URL")?.template, "rediss://${shop-cache.host}:${shop-cache.port}/0");
  assert.equal(env.find((e) => e.name === "DB_URL")?.template, "postgres://${shop-db.host}:5432/app");
  assert.equal(checkV2(AppSpecV2.parse(r.spec)).errors.length, 0);
});

// ── DM-4 DB 다른 주소 ──────────────────────────────────
test("DM-4: Cloud SQL 연결 이름(/cloudsql 소켓·Auth Proxy 인자)·공개 IP 로도 DB 가 이어지고, 프록시 인자는 안 바꾸고 사람 확인", () => {
  const CN = "demo-proj:asia-northeast3:shop-db";
  const sql = { kind: "cloudsql.instance", name: "shop-db", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "20" }, connectionName: CN,
    ipAddresses: [{ type: "PRIVATE", ipAddress: "10.1.0.5" }, { type: "PRIMARY", ipAddress: "34.64.1.2" }] };
  const r = run([dep("api", { containers: [
    { name: "api", image: "ghcr.io/demo/api:1.0", ports: [{ containerPort: 8080 }], env: [{ name: "DB_SOCKET", value: `/cloudsql/${CN}` }, { name: "DB_PUB", value: "34.64.1.2" }] },
    { name: "proxy", image: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.11.0", args: ["--private-ip", `${CN}?port=5432`], env: [] }] }, {}, { containerDigests: { api: D, proxy: D2 } }), sql]);
  ok(r);
  assert.ok(r.spec.links.some((l) => l.from === "api" && l.to === "shop-db"));
  const p = comp(r, "api").props;
  assert.deepEqual(p.sidecars[0].args, ["--private-ip", `${CN}?port=5432`], "프록시 인자는 그대로");
  // base 판: 사이드카 검토 표시는 없고, 계획의 Auth Proxy 사람 확인 줄(아래)로 묻는다
  assert.equal(p.env.find((e: any) => e.name === "DB_PUB")?.fromLink?.to, "shop-db", "공개 IP 도 DB 주소");
  const spec = AppSpecV2.parse(r.spec);
  assert.ok(v2Blockers(spec, []).needsHuman.some((x) => x.includes("Auth Proxy")));
});

test("DM-4: CNPG -ro 읽기 주소도 같은 DB 로 이어지고 다시 쓰되 검토, 맨 이름은 별칭 아님(거부)", () => {
  const cn = { kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: "shop" }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "1Gi" }, instances: 2 } };
  const r = run([dep("api", {}, { env: [{ name: "DB_RO", value: "shop-db-ro.shop.svc:5432" }, { name: "DB_NAME", value: "shop-db-ro" }] }), cn]);
  ok(r);
  const env = comp(r, "api").props.env;
  // base 판 CNPG-RO: -ro 주소는 reader 출력으로 (도착 읽기 주소)
  assert.equal(env.find((e: any) => e.name === "DB_RO")?.template, "${shop-db.reader}:5432");
  assert.equal(env.find((e: any) => e.name === "DB_NAME")?.value, "shop-db-ro");
  assert.ok(r.fieldMeta["components.api.env.DB_RO"]?.needs_review, JSON.stringify(Object.keys(r.fieldMeta).filter((k) => k.includes("DB_RO"))));
});

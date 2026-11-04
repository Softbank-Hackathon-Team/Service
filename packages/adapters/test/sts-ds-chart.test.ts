// D6·PB-1·A-1: StatefulSet·DaemonSet IR → 차트 값(ChartValues) → (helm 있으면) helm template. nodeArch 는 StatefulSet·DaemonSet 도 넘김. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppSpecV2, ChartValues, type RawInventory, type TargetEnv } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { targetBuilderFor, type Target } from "../src/index.js";

const D = "sha256:" + "ef".repeat(32);
type Raw = Record<string, any>;
const T = (p: TargetEnv["provider"]): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as Target;
const CHART = resolve(import.meta.dirname, "../../../gitops/charts/app");
const HELM = process.env.HELM_BIN ?? "helm";
const hasHelm = (() => { try { execFileSync(HELM, ["version", "--short"], { stdio: "ignore" }); return true; } catch { return false; } })();
const tpl = (name: string) => ({ metadata: { labels: { app: name, tier: "data" } }, spec: { containers: [{ name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 6379 }] }] } });
const items: Raw[] = [
  { kind: "k8s.statefulset", imageDigest: D, nodeArch: ["amd64"], metadata: { name: "kv", namespace: "shop", labels: { app: "kv" } },
    spec: { replicas: 3, serviceName: "kv-hl", podManagementPolicy: "Parallel", selector: { matchLabels: { app: "kv" } }, template: tpl("kv"),
      volumeClaimTemplates: [{ name: "data", accessModes: ["ReadWriteOnce"], storage: "2Gi" }] } },
  { kind: "k8s.service", metadata: { name: "kv-hl", namespace: "shop" }, spec: { type: "ClusterIP", clusterIP: "None", selector: { app: "kv" }, ports: [{ port: 6379, targetPort: 6379 }] } },
  { kind: "k8s.daemonset", imageDigest: D, nodeArch: ["amd64", "arm64"], metadata: { name: "agent", namespace: "shop", labels: { app: "agent" } },
    spec: { selector: { matchLabels: { app: "agent" } }, template: tpl("agent") }, status: { desiredNumberScheduled: 2 } },
];
const run = (xs: Raw[]) => normalizeV2({ provider: "onprem", coverage: {}, items: xs } as RawInventory).result;

test("D6·A-1: StatefulSet·DaemonSet 의 nodeArch 가 IR 에 들어가고, 차트 값은 같은 종류(serviceName·volumeClaimTemplates, DaemonSet 은 replicas 없음)", () => {
  const r = run(items);
  const kv = r.spec.components.find((c) => c.id === "kv") as any, ag = r.spec.components.find((c) => c.id === "agent") as any;
  assert.deepEqual(kv.props.nodeArch, ["amd64"]);
  assert.deepEqual(ag.props.nodeArch, ["amd64", "arm64"]);
  const v = ChartValues.parse(targetBuilderFor("onprem").toWorkloadValues(AppSpecV2.parse(r.spec), {}, T("onprem")));
  const k = v.workloads.find((w) => w.name === "kv")!, a = v.workloads.find((w) => w.name === "agent")!;
  assert.equal(k.workloadKind, "statefulset");
  assert.equal(k.statefulSet?.serviceName, "kv-hl");
  assert.equal(k.replicas, 3);
  assert.ok(k.pvcs?.some((p) => p.name === "data" && p.claimTemplate), JSON.stringify(k.pvcs));
  assert.equal(a.workloadKind, "daemonset");
  assert.equal(a.replicas, undefined);
  assert.equal(a.scale, undefined);
  assert.deepEqual(a.podLabels?.tier, "data");
});

test("D6 거부: Deployment 는 workloadKind 칸을 안 둔다 (옛 값 모양 그대로)", () => {
  const r = run([{ kind: "k8s.deployment", imageDigest: D, metadata: { name: "api", namespace: "shop", labels: { app: "api" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "api" } }, template: tpl("api") } }]);
  const v = ChartValues.parse(targetBuilderFor("onprem").toWorkloadValues(AppSpecV2.parse(r.spec), {}, T("onprem")));
  const w = v.workloads.find((x) => x.name === "api")!;
  assert.equal(w.workloadKind, undefined);
  assert.equal(w.statefulSet, undefined);
});

test("D6 helm: StatefulSet·DaemonSet 으로 그려진다", { skip: hasHelm ? false : "helm 없음" }, () => {
  const v = targetBuilderFor("onprem").toWorkloadValues(AppSpecV2.parse(run(items).spec), {}, T("onprem"));
  const dir = mkdtempSync(join(tmpdir(), "d6-")); const f = join(dir, "values.json"); writeFileSync(f, JSON.stringify(v));
  const out = execFileSync(HELM, ["template", "rel", CHART, "-f", f], { encoding: "utf8" });
  assert.match(out, /^kind: StatefulSet$/m);
  assert.match(out, /serviceName: kv-hl/);
  assert.match(out, /volumeClaimTemplates:/);
  assert.match(out, /^kind: DaemonSet$/m);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { RehearsalInput } from "@svc/contracts";
import { asHostKube, hostAccessFromEnv, rehearsalFromEnv, sandboxFromEnv, type VclusterHost } from "../src/index.js";
import { fakeHelm, fakeHost, fakeVirtual } from "./fake-kube.js";

const RUN = "3c2b1a09-8f7e-4d6c-9b5a-493827160514";
const input: RehearsalInput = {
  version: 1, target: "aws-eks", app: "shop", namespace: "app-shop", bundleSha256: "c".repeat(64), k8sMinor: "1.35",
  original: [{ path: "m.yaml", yaml: stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg" } }) }],
  apply: [{ path: "m.yaml", yaml: stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" },
    spec: { selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "x" }] } } } }) }],
  images: [], databases: [], targetPodSecurity: "privileged", targetQuota: null, edges: [],
  fidelity: { version: 1, target: "aws-eks", bundleSha256: "c".repeat(64), items: [{ id: "manifests", status: "identical", real: "a", sandbox: "a", reason: "r", refs: [] }] },
};

test("호스트 접속: 설정이 없으면 null, 클러스터 안이면 서비스 계정 토큰·CA 파일, SANDBOX_KUBE_URL 이 먼저", () => {
  assert.equal(hostAccessFromEnv({}), null);
  const dir = mkdtempSync(join(tmpdir(), "sa-"));
  writeFileSync(join(dir, "ca.crt"), "CA");
  const inCluster = hostAccessFromEnv({ KUBERNETES_SERVICE_HOST: "10.100.0.1", KUBERNETES_SERVICE_PORT: "443", SANDBOX_KUBE_CA_FILE: join(dir, "ca.crt") })!;
  assert.equal(inCluster.server, "https://10.100.0.1:443");
  assert.equal(inCluster.tokenFile, "/var/run/secrets/kubernetes.io/serviceaccount/token");
  const explicit = hostAccessFromEnv({ SANDBOX_KUBE_URL: "https://127.0.0.1:6443", KUBERNETES_SERVICE_HOST: "10.100.0.1" })!;
  assert.deepEqual([explicit.server, explicit.tokenFile, explicit.caFile], ["https://127.0.0.1:6443", undefined, undefined]);
});

test("리허설 백엔드 고르기: MOCK_SANDBOX 는 정해진 결과, 호스트 없으면 REHEARSAL_SANDBOX_UNAVAILABLE (조용한 통과 없음)", async () => {
  const pass = rehearsalFromEnv({ MOCK_SANDBOX: "1" });
  assert.equal(pass.host, null);
  assert.equal((await pass.rehearse(input, { id: RUN })).verdict, "passed");
  const fail = await rehearsalFromEnv({ MOCK_SANDBOX: "1", MOCK_SANDBOX_RESULT: "fail" }).rehearse(input, { id: RUN });
  assert.deepEqual([fail.verdict, fail.failureCode, fail.sandbox.mock], ["failed", "REHEARSAL_CRASHLOOP", true]);

  const none = await rehearsalFromEnv({}, { host: null }).rehearse(input, { id: RUN });
  assert.deepEqual([none.verdict, none.failureCode, none.deleted], ["error", "REHEARSAL_SANDBOX_UNAVAILABLE", false]);
  assert.match(none.checks.find((c) => c.id === "sandbox_ready")!.detail, /SANDBOX_NO_HOST/);
});

test("SANDBOX_MODE=vcluster: 수정 고리 실행마다 vCluster(restricted, RuntimeClass) 를 만들고 dispose 가 지운다", async () => {
  const host = fakeHost();
  const helm = fakeHelm(host);
  const virtual = fakeVirtual();
  const h: VclusterHost = { kube: asHostKube(host.kube), helm, chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vc-")), connect: () => virtual.kube };
  const choice = sandboxFromEnv({ SANDBOX_MODE: "vcluster", SANDBOX_RUNTIME_CLASS: "gvisor" }, { host: h });
  assert.equal(choice.mode, "vcluster");
  const sb = await choice.create({ tenantId: "11111111-2222-4333-8444-555555555555", runId: RUN });
  assert.equal(sb.mode, "vcluster");
  assert.equal(sb.namespace, "sbx-remediation-3c2b1a098f7e");
  assert.equal(host.namespaces.get(sb.namespace!)?.["platform.svc/sandbox-purpose"], "remediation");
  assert.equal(helm.values[0].policies.podSecurityStandard, "restricted");
  assert.equal(helm.values[0].sync.toHost.pods.runtimeClassName, "gvisor");
  await sb.dispose!();
  assert.equal(host.namespaces.size, 0);
  assert.throws(() => sandboxFromEnv({ SANDBOX_MODE: "vcluster" }), /호스트 클러스터 접속 설정이 없음/);
});

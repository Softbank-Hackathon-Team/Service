// SG-1: IR 워크로드 securityContext·호스트 공유를 보안 판정이 본다. 출발 값을 바꾸지 않고(그대로 이식) 승인 줄(warn)로 드러낸다
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, PrecheckItem, type RawInventory } from "@svc/contracts";
import { normalizeV2, workloadSecurityV2 } from "@svc/adapters";
import { securityPrecheckItems } from "../src/jobs/precheck.js";

const D = "sha256:" + "ab".repeat(32);
const imported = (c: Record<string, unknown>, pod: Record<string, unknown> = {}): ImportResultV2 => ImportResultV2.parse(normalizeV2({ provider: "aws", coverage: {}, items: [
  { kind: "k8s.deployment", imageDigest: D, metadata: { name: "agent", namespace: "shop", labels: { app: "agent" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "agent" } }, template: { metadata: { labels: { app: "agent" } }, spec: { containers: [{
      name: "agent", image: "ghcr.io/demo/agent:1.0", ports: [{ containerPort: 8080 }], env: [], ...c }], ...pod } } } },
] } as RawInventory).result);
const SIDE = { envId: "s", provider: "aws" as const, region: "ap-northeast-2" };
const run = (r: ImportResultV2, rules?: "workload" | "nonWorkload") =>
  securityPrecheckItems({ spec: r.spec, securityFacts: r.securityFacts, source: SIDE, target: { ...SIDE, envId: "t", provider: "gcp", region: "asia-northeast3" }, ...(rules ? { rules } : {}) });

test("SG-1 정상: privileged·SYS_ADMIN·runAsUser 0·hostNetwork·hostPath 가 IR 에 그대로 남고, 보안 판정이 warn 승인 줄로 낸다", () => {
  const r = imported({ securityContext: { privileged: true, runAsUser: 0, capabilities: { add: ["SYS_ADMIN", "CHOWN"] } } },
    { hostNetwork: true, volumes: [{ name: "dock", hostPath: { path: "/var/run/docker.sock" } }] });
  const sc = (r.spec.components.find((c) => c.id === "agent")!.props as any).securityContext;
  assert.equal(sc.privileged, true, "그대로 이식: 값은 안 바꿈");
  const w = workloadSecurityV2(r.spec);
  assert.equal(w[0]?.host?.network, true);
  const items = run(r, "workload");
  for (const i of items) PrecheckItem.parse(i);
  const by = (id: string) => items.find((i) => i.id === id);
  assert.equal(by("SEC:P-WL-1:agent")?.level, "warn");
  assert.match(by("SEC:P-WL-1:agent")!.message, /privileged: true.*capabilities\.add SYS_ADMIN/);
  assert.ok(!by("SEC:P-WL-1:agent")!.message.includes("CHOWN"), "흔한 capability 는 위험 목록 밖");
  assert.equal(by("SEC:P-WL-2:agent")?.level, "warn");
  assert.match(by("SEC:P-WL-3:agent")!.message, /hostNetwork/);
  assert.ok(items.every((i) => i.id.startsWith("SEC:P-WL-")), "workload 묶음만");
  assert.ok(!run(r, "nonWorkload").some((i) => i.id.startsWith("SEC:P-WL-")), "나머지 묶음에는 안 나옴 (두 번 안 나오게)");
});

test("SG-1 거부: 평범한 컨테이너(runAsNonRoot·권한 상승 끔)는 워크로드 줄이 없다", () => {
  const r = imported({ securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } } });
  assert.deepEqual(run(r, "workload"), []);
  assert.deepEqual(run(imported({})), run(imported({})).filter((i) => !i.id.startsWith("SEC:P-WL-")), "securityContext 없음 = 줄 없음 (늘 뜨는 경고 안 만듦)");
});

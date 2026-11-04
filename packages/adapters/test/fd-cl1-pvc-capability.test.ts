// CL-1: IR 볼륨(PVC)은 볼륨 드라이버·기본 StorageClass 가 있는 도착만 받는다. EKS 도착은 지금 없어 계획 전에 막는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { requirementsV2, v2Blockers, PVC_STORAGE_CLASS } from "../src/target/shared.js";
import { targetBuilderFor } from "../src/index.js";

const D = "sha256:" + "ab".repeat(32);
const spec = (withVol: boolean) => AppSpecV2.parse(normalizeV2({ provider: "onprem", coverage: {}, items: [
  { kind: "k8s.deployment", imageDigest: D, metadata: { name: "files", namespace: "shop", labels: { app: "files" } },
    spec: { replicas: 1, selector: { matchLabels: { app: "files" } }, template: { metadata: { labels: { app: "files" } }, spec: {
      containers: [{ name: "files", image: "ghcr.io/demo/files:1", ports: [{ containerPort: 8080 }], env: [],
        ...(withVol ? { volumeMounts: [{ name: "data", mountPath: "/data" }] } : {}) }],
      ...(withVol ? { volumes: [{ name: "data", persistentVolumeClaim: { claimName: "files-data" } }] } : {}) } } } },
  ...(withVol ? [{ kind: "k8s.pvc", metadata: { name: "files-data", namespace: "shop" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } } }] : []),
] } as RawInventory).result.spec);

test("CL-1 거부: 볼륨이 있는 서비스는 EKS 도착에서 volume.pvc 로 막힘 (이유에 EBS CSI)", () => {
  const s = spec(true);
  assert.ok(requirementsV2(s).includes("volume.pvc"));
  const u = v2Blockers(s, targetBuilderFor("aws").capabilities()).unsupported.find((x) => x.includes("volume.pvc"));
  assert.match(u ?? "", /aws-ebs-csi-driver/);
});

test("CL-1 정상: GKE·온프레 도착은 받고(기본 클래스 standard-rwo·local-path), 볼륨 없는 앱은 EKS 도 안 막힘", () => {
  const s = spec(true);
  for (const p of ["gcp", "onprem"] as const) assert.ok(!v2Blockers(s, targetBuilderFor(p).capabilities()).unsupported.some((x) => x.includes("volume.pvc")), p);
  assert.deepEqual(PVC_STORAGE_CLASS, { gcp: "standard-rwo", onprem: "local-path" });
  assert.ok(!requirementsV2(spec(false)).includes("volume.pvc"));
});

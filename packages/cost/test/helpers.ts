import { readFileSync } from "node:fs";
import { AppSpecV2 } from "@svc/contracts";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

/** 시험용 명세: demo-shop 서비스 하나(k8s) + Postgres 20GB. replicas·cpuMilli·memMiB 만 바꿔 쓴다 */
export interface SpecOver { replicas?: number; cpuMilli?: number; memMiB?: number }
export const spec = (over: SpecOver = {}, db: boolean = true): AppSpecV2 => AppSpecV2.parse({
  schemaVersion: "2",
  app: { name: "demo-shop" },
  components: [
    { id: "demo-shop", kind: "service", props: {
      runtime: "k8s", origin: { runtime: "k8s", product: "unknown" },
      image: { source: "registry", repository: "ghcr.io/demo/shop", digest: `sha256:${"a".repeat(64)}` },
      ports: [{ port: 8080, protocol: "TCP" }],
      probes: { readiness: { type: "http", path: "/healthz", port: 8080 } },
      replicas: { min: over.replicas ?? 1, max: over.replicas ?? 1 },
      serviceAccount: "default",
      resources: { request: { cpuMilli: over.cpuMilli ?? 250, memMiB: over.memMiB ?? 512 } },
      env: [],
    } },
    ...(db ? [{ id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 20 } }] : []),
  ],
  links: db ? [{ from: "demo-shop", to: "db", intent: "connect" }] : [],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], routes: [{
    matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "demo-shop", port: 8080, weight: 1 }] }] }] },
  posture: { permissions: [], network: [] },
});

// PoC(cost_poc.py)와 같은 노드 종류만
export const POC_NODES = ["t3.medium", "e2-medium", "k3s-vm-2c8g"];

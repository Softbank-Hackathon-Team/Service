import { readFileSync } from "node:fs";
import type { CostEstimateRequestInput } from "../src/index.js";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

export const spec = (over: Partial<CostEstimateRequestInput["spec"]["service"]> = {},
  db: boolean = true): CostEstimateRequestInput["spec"] => ({
  schemaVersion: "1",
  app: { name: "demo-shop" },
  service: {
    image: `ghcr.io/demo/shop@sha256:${"a".repeat(64)}`, port: 8080, healthPath: "/healthz",
    replicas: 1, cpu: "250m", memory: "512Mi", env: [], secretRefs: [], ...over,
  },
  ...(db ? { database: { engine: "postgres" as const, majorVersion: "16" as const, storageGb: 20 } } : {}),
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
});

// PoC(cost_poc.py)와 같은 노드 종류만
export const POC_NODES = ["t3.medium", "e2-medium", "k3s-vm-2c8g"];

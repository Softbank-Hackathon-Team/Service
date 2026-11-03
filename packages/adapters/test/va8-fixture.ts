// VA8: a8-grants.test.ts 의 3티어 명세 (시험 공용)
import { AppSpecV2 } from "@svc/contracts";
const D = (c: string) => `sha256:${c.repeat(64)}`;

// 3티어 v2: web → api → db, + 예약 잡 (api 와 같은 SA)
const svc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "service",
  props: {
    runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop",
    image: { source: "registry", repository: `ghcr.io/demo/${id}`, digest: D(id === "web" ? "b" : "c") },
    resources: { request: { cpuMilli: 250, memMiB: 512 } }, env: [], serviceAccount: id, replicas: { min: 2, max: 2 },
    ports: [{ port: 8080, protocol: "TCP" }],
    endpoints: [{ name: id, type: "ClusterIP", ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }] }],
    ...extra,
  },
});
export const TIER3 = (): AppSpecV2 => AppSpecV2.parse({
  schemaVersion: "2", app: { name: "shop" },
  components: [
    svc("web", { env: [{ name: "API_URL", fromLink: { to: "api", output: "url" } }],
      probes: { readiness: { type: "http", path: "/", port: 8080 } } }),
    svc("api", {
      env: [
        { name: "DB_HOST", fromLink: { to: "db", output: "host" } },
        { name: "JDBC", template: "jdbc:postgresql://${db.host}:5432/shop?sslmode=require" },
        { name: "DATABASE_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } },
        { name: "LOG_LEVEL", value: "info" },
      ],
      scale: { targetCpuPct: 70 }, replicas: { min: 2, max: 4 },
    }),
    { id: "nightly", kind: "job", props: {
      image: { source: "registry", repository: "ghcr.io/demo/api", digest: D("c") }, resources: {}, env: [], serviceAccount: "api",
      schedule: "0 3 * * *", concurrencyPolicy: "Forbid" } },
    { id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 50, compute: { cpuMilli: 2000, memMiB: 4096 }, parameters: { max_connections: "200" } } },
  ],
  links: [
    { from: "web", to: "api", intent: "call" },
    { from: "api", to: "db", intent: "connect" },
    { from: "nightly", to: "db", intent: "connect" },
  ],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], tls: { mode: "terminate" },
    routes: [{ matches: [{ path: { type: "PathPrefix", value: "/api" } }], backends: [{ to: "api", port: 80, weight: 1 }] },
      { matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "web", port: 80, weight: 1 }] }] }] },
  posture: { permissions: [], network: [{ scope: "namespace", namespace: "shop", mode: "mirror", policies: [], default: "allow-all" }] },
});


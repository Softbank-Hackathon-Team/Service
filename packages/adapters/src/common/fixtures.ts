import type { AppSpec, Provider, RawInventory } from "@svc/contracts";

// 데모용 출발 환경 원본. discover가 실제 클라우드를 못 읽을 때(자격 증명 없음) 돌려준다.
// 3티어 앱(웹 → API → Postgres)의 API 층을 기준으로 한다.
const DIGEST = "sha256:" + "ab".repeat(32);

export const DEMO_SPEC: AppSpec = {
  schemaVersion: "1",
  app: { name: "demo-app" },
  service: {
    image: "registry/demo@sha256:" + "0".repeat(64),
    port: 8080, healthPath: "/healthz", replicas: 2,
    cpu: "500m", memory: "1Gi", env: [], secretRefs: [],
  },
  ingress: { hostname: "demo.example.com", entry: "cloudflare-lb" },
};

const k8sItems = (ns: string) => [
  {
    kind: "k8s.deployment", hostname: "shop.example.com", imageDigest: DIGEST,
    metadata: { name: "shop-api", namespace: ns },
    spec: { replicas: 2, template: { spec: { containers: [{
      image: "ghcr.io/demo/shop-api:1.4.2", ports: [{ containerPort: 8080 }],
      resources: { requests: { cpu: "500m", memory: "1Gi" } },
      readinessProbe: { httpGet: { path: "/healthz" } },
      env: [
        { name: "LOG_LEVEL", value: "info" },
        { name: "DATABASE_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db", key: "password" } } },
      ],
    }] } } },
  },
];

export const DEMO_INVENTORY: Record<Provider, RawInventory> = {
  aws: { provider: "aws", coverage: { "ecs.service": 1, "rds.dbInstance": 1 }, items: [
    {
      kind: "ecs.service", serviceName: "shop-api", desiredCount: 2, imageDigest: DIGEST,
      hostname: "shop.example.com", healthCheckPath: "/healthz",
      taskDefinition: { cpu: "512", memory: "1024", containerDefinitions: [{
        image: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shop-api:1.4.2",
        portMappings: [{ containerPort: 8080 }],
        environment: [{ name: "LOG_LEVEL", value: "info" }],
        secrets: [{ name: "DATABASE_PASSWORD", valueFrom: "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shop-db:password" }],
      }] },
    },
    { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20 },
  ] },
  gcp: { provider: "gcp", coverage: { "k8s.deployment": 1, "cloudsql.instance": 1 }, items: [
    ...k8sItems("shop"),
    { kind: "cloudsql.instance", name: "shop-db", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "20" } },
  ] },
  onprem: { provider: "onprem", coverage: { "k8s.deployment": 1, "cnpg.cluster": 1 }, items: [
    ...k8sItems("shop"),
    { kind: "cnpg.cluster", metadata: { name: "shop-db" }, spec: { postgresVersion: "16", storage: { size: "20Gi" } } },
  ] },
  azure_mock: { provider: "azure_mock", coverage: {}, items: [] },
};

// I2: 공통 명세 v2 용 데모 원본 (gcp·onprem 만. aws 는 ECS 데모를 그대로 쓴다). 3티어 = web·api·worker Deployment + Service + Ingress + HPA 1 + CronJob 1 + DB
const tier = (ns: string, name: string, env: Array<Record<string, unknown>> = [], port = 8080) => ({
  kind: "k8s.deployment", imageDigest: DIGEST, metadata: { name, namespace: ns, labels: { app: name } },
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.4.2`, ports: [{ containerPort: port }],
    resources: { requests: { cpu: "300m", memory: "768Mi" } }, readinessProbe: { httpGet: { path: "/healthz", port } }, env,
  }] } } },
});
const tierSvc = (ns: string, name: string) => ({
  kind: "k8s.service", metadata: { name, namespace: ns },
  spec: { selector: { app: name }, ports: [{ name: "http", port: 80, targetPort: 8080 }] },
});
const k8sItemsV2 = (ns: string, dbHost: string) => [
  tier(ns, "shop-web", [{ name: "API_URL", value: `http://shop-api.${ns}.svc` }]),
  tier(ns, "shop-api", [
    { name: "DB_HOST", value: dbHost },
    { name: "DATABASE_PASSWORD", valueFrom: { secretKeyRef: { name: "shop-db", key: "password" } } },
  ]),
  tier(ns, "shop-worker", [{ name: "DB_HOST", value: dbHost }]),
  tierSvc(ns, "shop-web"), tierSvc(ns, "shop-api"),
  { kind: "k8s.ingress", metadata: { name: "shop", namespace: ns }, spec: { rules: [{ host: "shop.example.com", http: { paths: [
    { path: "/api", pathType: "Prefix", backend: { service: { name: "shop-api" } } },
    { path: "/", pathType: "Prefix", backend: { service: { name: "shop-web" } } }] } }] } },
  { kind: "k8s.hpa", metadata: { name: "shop-api", namespace: ns }, spec: { scaleTargetRef: { kind: "Deployment", name: "shop-api" }, minReplicas: 2, maxReplicas: 6,
    metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }] } },
  { kind: "k8s.cronjob", imageDigest: DIGEST, metadata: { name: "shop-cleanup", namespace: ns }, spec: { schedule: "0 3 * * *", concurrencyPolicy: "Forbid",
    jobTemplate: { spec: { backoffLimit: 2, template: { spec: { restartPolicy: "OnFailure", serviceAccountName: "shop-worker", containers: [{
      name: "cleanup", image: "ghcr.io/demo/shop-worker:1.4.2", command: ["node", "cleanup.js"], env: [{ name: "DB_HOST", value: dbHost }] }] } } } } } },
];

export const DEMO_INVENTORY_V2: Partial<Record<Provider, RawInventory>> = {
  gcp: { provider: "gcp", coverage: { "k8s.deployment": 3, "k8s.service": 2, "k8s.ingress": 1, "k8s.hpa": 1, "k8s.cronjob": 1, "cloudsql.instance": 1 }, items: [
    ...k8sItemsV2("shop", "10.20.0.5"),
    { kind: "cloudsql.instance", name: "shop-db", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "20", availabilityType: "ZONAL" },
      ipAddresses: [{ type: "PRIVATE", ipAddress: "10.20.0.5" }] },
  ] },
  onprem: { provider: "onprem", coverage: { "k8s.deployment": 3, "k8s.service": 2, "k8s.ingress": 1, "k8s.hpa": 1, "k8s.cronjob": 1, "cnpg.cluster": 1 }, items: [
    ...k8sItemsV2("shop", "shop-db-rw.shop.svc"),
    { kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: "shop" }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "20Gi" }, instances: 1 } },
  ] },
};

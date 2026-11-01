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

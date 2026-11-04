import type { Provider, RawInventory } from "@svc/contracts";

// 데모용 출발 환경 원본. MOCK_SEED=1(시험·e2e 전용)일 때 discover 가 실제 클라우드 대신 돌려준다.
// 3티어 앱(웹 → API → Postgres) + 워커 + 잡.
const DIGEST = "sha256:" + "ab".repeat(32);

// I2: 데모 원본 (I9 부터 aws 는 ECS 데모). 3티어 = web·api·worker Deployment + Service + Ingress + HPA 1 + CronJob 1 + DB
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
  // NS-1: 진짜 가져오기는 네임스페이스 객체도 읽는다 (라벨 없음 = 파드 보안·메시 주입 라벨 없음 → 검토 줄 없음)
  { kind: "k8s.namespace", metadata: { name: ns } },
];

// I9: aws 데모 v2 = ECS(Fargate) 3티어. web·api·worker 서비스 + ALB 규칙 + Service Connect + Auto Scaling 1 + RDS
const ECR = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com";
const RDS_HOST = "shop-db.c1abcdefgh.ap-northeast-2.rds.amazonaws.com";
const ecsSvc = (name: string, env: Array<{ name: string; value: string }>, extra: Record<string, unknown> = {}, secrets: Array<{ name: string; valueFrom: string }> = []) => ({
  kind: "ecs.service", serviceName: name, clusterName: "shop", launchType: "FARGATE", desiredCount: 2, imageDigest: DIGEST,
  serviceArn: `arn:aws:ecs:ap-northeast-2:123456789012:service/shop/${name}`,
  taskDefinition: { family: name, cpu: "512", memory: "1024", taskRoleArn: `arn:aws:iam::123456789012:role/${name}-task`, containerDefinitions: [{
    name, image: `${ECR}/${name}:1.4.2`, essential: true, portMappings: [{ containerPort: 8080, protocol: "tcp", name: "http" }],
    environment: env, secrets,
  }] },
  serviceConnect: { namespace: "shop.local", aliases: [{ dnsName: `${name}.shop.local`, port: 8080 }] },
  loadBalancers: [{ containerName: name, containerPort: 8080, healthCheckPath: "/healthz" }],
  ...extra,
});
const AWS_V2_ITEMS = [
  ecsSvc("shop-web", [{ name: "API_URL", value: "http://shop-api.shop.local:8080" }], { routes: [{ host: "shop.example.com", path: "/*", priority: 20 }] }),
  ecsSvc("shop-api", [{ name: "LOG_LEVEL", value: "info" }, { name: "DB_HOST", value: RDS_HOST }],
    { routes: [{ host: "shop.example.com", path: "/api/*", priority: 10 }], autoscaling: { min: 2, max: 6, targetCpuPct: 70 } },
    [{ name: "DATABASE_PASSWORD", valueFrom: "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:shop-db:password" }]),
  { ...ecsSvc("shop-worker", [{ name: "DB_HOST", value: RDS_HOST }]), loadBalancers: [], serviceConnect: null, desiredCount: 1 },
  { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20,
    Endpoint: RDS_HOST, MultiAZ: false, PubliclyAccessible: false, DBInstanceArn: "arn:aws:rds:ap-northeast-2:123456789012:db:shop-db" },
  { kind: "ecs.cluster", name: "shop" },
];

export const DEMO_INVENTORY: Record<Provider, RawInventory> = {
  aws: { provider: "aws", coverage: { "ecs.service": 3, "rds.dbInstance": 1, "ecs.cluster": 1 }, items: AWS_V2_ITEMS },
  gcp: { provider: "gcp", coverage: { "k8s.deployment": 3, "k8s.service": 2, "k8s.ingress": 1, "k8s.hpa": 1, "k8s.cronjob": 1, "cloudsql.instance": 1 }, items: [
    ...k8sItemsV2("shop", "10.20.0.5"),
    { kind: "cloudsql.instance", name: "shop-db", databaseVersion: "POSTGRES_16", settings: { dataDiskSizeGb: "20", availabilityType: "ZONAL" },
      ipAddresses: [{ type: "PRIVATE", ipAddress: "10.20.0.5" }] },
  ] },
  onprem: { provider: "onprem", coverage: { "k8s.deployment": 3, "k8s.service": 2, "k8s.ingress": 1, "k8s.hpa": 1, "k8s.cronjob": 1, "cnpg.cluster": 1 }, items: [
    ...k8sItemsV2("shop", "shop-db-rw.shop.svc"),
    { kind: "cnpg.cluster", metadata: { name: "shop-db", namespace: "shop" }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "20Gi" }, instances: 1 } },
  ] },
  azure_mock: { provider: "azure_mock", coverage: {}, items: [] },
};

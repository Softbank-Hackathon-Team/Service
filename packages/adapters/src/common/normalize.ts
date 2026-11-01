import type { AppSpec, FieldMeta, RawInventory } from "@svc/contracts";
import { AdapterError } from "./errors.js";

// 가져오기 결과(RawInventory.items) → 공통 명세(AppSpec) + 칸별 출처(fieldMeta).
// 순수 함수. 네트워크는 discover만 쓴다.
// 지원하는 원본 모양 (discover가 이 모양으로 넣는다):
//   ecs.service      : AWS ECS 서비스 + 작업 정의 (DescribeServices + DescribeTaskDefinition)
//   k8s.deployment   : EKS·GKE·k3s의 Deployment (+ 같은 이름 Service, Ingress 호스트)
//   rds.dbInstance   : AWS RDS DescribeDBInstances 한 줄
//   cloudsql.instance: GCP Cloud SQL instances.get
//   cnpg.cluster     : 온프레 CloudNativePG Cluster
type Spec = Partial<AppSpec>;
type Svc = AppSpec["service"];
type Item = { kind: string; [k: string]: unknown };

const SECRET_ENV_NAME = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential/i;
const SECRET_ENV_VALUE = [/AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /sk-ant-[A-Za-z0-9_-]{10,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /:\/\/[^/\s:@]+:[^/\s@]+@/];
const CPU = ["250m", "500m", "1"] as const;
const MEM = ["512Mi", "1Gi", "2Gi"] as const;

// 값을 명세 단계(enum)에 올림으로 맞춘다. 정확히 맞으면 1, 올렸으면 0.9 + 검토 필요
function stepUp<T extends string>(steps: readonly T[], milli: number[], v: number): { v: T; exact: boolean } {
  for (let i = 0; i < steps.length; i++) if (v <= milli[i]!) return { v: steps[i]!, exact: v === milli[i] };
  return { v: steps[steps.length - 1]!, exact: false };
}
export const cpuFromMilli = (m: number) => stepUp(CPU, [250, 500, 1000], m);
export const memFromMiB = (m: number) => stepUp(MEM, [512, 1024, 2048], m);
export function parseCpu(q: string): number { return q.endsWith("m") ? Number(q.slice(0, -1)) : Number(q) * 1000; }
export function parseMiB(q: string): number {
  if (q.endsWith("Gi")) return Number(q.slice(0, -2)) * 1024;
  if (q.endsWith("Mi")) return Number(q.slice(0, -2));
  return Math.ceil(Number(q) / (1024 * 1024));
}
const major = (v: string) => {
  const m = String(v).split(".")[0]!;
  if (m !== "15" && m !== "16" && m !== "17") throw new AdapterError("PG_VERSION_UNSUPPORTED", `지원하지 않는 Postgres 버전: ${v}`);
  return m;
};

export function normalizeInventory(raw: RawInventory, fallback: AppSpec): { spec: Spec; fieldMeta: FieldMeta } {
  const meta: FieldMeta = {};
  const set = (path: string, source: string, exact = true) => {
    meta[path] = exact ? { source, confidence: 1, needs_review: false }
      : { source, confidence: 0.9, needs_review: true, rationale: "명세 단계로 올림" };
  };
  const items = raw.items as Item[];
  const svcItem = items.find((i) => i.kind === "ecs.service" || i.kind === "k8s.deployment");
  const dbItem = items.find((i) => ["rds.dbInstance", "cloudsql.instance", "cnpg.cluster"].includes(i.kind));

  // 원본이 비어 있으면(연결 전 데모·테스트) 고정 예시를 쓰고 모든 칸을 검토 필요로 표시한다
  if (!svcItem) {
    for (const k of ["app.name", "service.image", "service.port", "ingress.hostname"])
      meta[k] = { source: "fixture", confidence: 0.6, needs_review: true, rationale: "원본 자원 없음" };
    return { spec: fallback, fieldMeta: meta };
  }

  let name: string; let service: Svc; let hostname: string;
  if (svcItem.kind === "ecs.service") {
    const s = svcItem as unknown as EcsService;
    const c = s.taskDefinition.containerDefinitions[0]!;
    const src = `ecs:${s.serviceName}`;
    const cpu = cpuFromMilli(Math.round((c.cpu ?? Number(s.taskDefinition.cpu)) / 1024 * 1000));
    const mem = memFromMiB(c.memory ?? Number(s.taskDefinition.memory));
    name = s.serviceName; set("app.name", `${src}.serviceName`);
    service = {
      image: `${c.image.split("@")[0]!.split(":")[0]}@${s.imageDigest}`,
      port: c.portMappings[0]!.containerPort,
      healthPath: s.healthCheckPath ?? "/healthz",
      replicas: s.desiredCount,
      cpu: cpu.v, memory: mem.v,
      env: (c.environment ?? []).map((e) => ({ name: e.name, value: e.value })),
      secretRefs: (c.secrets ?? []).map((e) => ({ name: e.name, key: e.valueFrom.split(":").pop()! })),
    };
    set("service.image", `${src}.containerDefinitions[0].image+digest`);
    set("service.port", `${src}.containerDefinitions[0].portMappings[0]`);
    set("service.replicas", `${src}.desiredCount`);
    set("service.cpu", `${src}.cpu`, cpu.exact); set("service.memory", `${src}.memory`, mem.exact);
    if (s.healthCheckPath) set("service.healthPath", `${src}.targetGroup.healthCheckPath`);
    else meta["service.healthPath"] = { source: "default", confidence: 0.6, needs_review: true };
    hostname = s.hostname;
    set("ingress.hostname", `${src}.loadBalancer.dns`);
  } else {
    const d = svcItem as unknown as K8sDeployment;
    const c = d.spec.template.spec.containers[0]!;
    const src = `k8s:${d.metadata.namespace}/${d.metadata.name}`;
    const cpu = cpuFromMilli(parseCpu(c.resources?.requests?.cpu ?? "500m"));
    const mem = memFromMiB(parseMiB(c.resources?.requests?.memory ?? "1Gi"));
    name = d.metadata.name; set("app.name", `${src}.metadata.name`);
    service = {
      image: c.image.includes("@sha256:") ? c.image : `${c.image.split(":")[0]}@${d.imageDigest}`,
      port: c.ports[0]!.containerPort,
      healthPath: c.readinessProbe?.httpGet?.path ?? "/healthz",
      replicas: d.spec.replicas,
      cpu: cpu.v, memory: mem.v,
      env: (c.env ?? []).filter((e) => e.value !== undefined).map((e) => ({ name: e.name, value: e.value! })),
      secretRefs: (c.env ?? []).filter((e) => e.valueFrom?.secretKeyRef)
        .map((e) => ({ name: e.name, key: e.valueFrom!.secretKeyRef!.key })),
    };
    set("service.image", `${src}.containers[0].image`);
    set("service.port", `${src}.containers[0].ports[0]`);
    set("service.replicas", `${src}.spec.replicas`);
    set("service.cpu", `${src}.resources.requests.cpu`, cpu.exact);
    set("service.memory", `${src}.resources.requests.memory`, mem.exact);
    set("service.healthPath", `${src}.readinessProbe`, Boolean(c.readinessProbe?.httpGet?.path));
    hostname = d.hostname;
    set("ingress.hostname", `${src}.ingress.host`);
  }
  // Z3-F5: 평문 비밀처럼 보이는 환경변수는 명세에 옮기지 않는다. 명세는 GitOps 저장소 값으로 렌더링되므로 평문이 커밋된다.
  // 칸은 검토 필요로 남기고, 사람이 도착 비밀 저장소에 넣은 뒤 secretRefs 로 잇는다
  // DRAFT(ai): 이름·모양 규칙 (packages/agent/src/draft/redact.ts 와 같은 기준). 이름 규칙이 넓어 오탐(예: TOKENIZER_MODE)이 날 수 있다
  const plain = service.env.filter((e) => SECRET_ENV_NAME.test(e.name) || SECRET_ENV_VALUE.some((r) => r.test(e.value)));
  service.env = service.env.filter((e) => !plain.includes(e));
  for (const e of service.env) set(`service.env.${e.name}`, "source.env");
  for (const e of plain) meta[`service.env.${e.name}`] = { source: "source.env", confidence: 0.6, needs_review: true,
    rationale: "평문 비밀로 보여 명세에서 뺐다. 도착 비밀 저장소에 등록 후 secretRefs 로 연결" };

  const spec: Spec = {
    schemaVersion: "1",
    app: { name },
    service,
    ingress: { hostname, entry: "cloudflare-lb" },
  };
  if (dbItem) {
    if (dbItem.kind === "rds.dbInstance") {
      const r = dbItem as unknown as { DBInstanceIdentifier: string; Engine: string; EngineVersion: string; AllocatedStorage: number };
      if (r.Engine !== "postgres") throw new AdapterError("DB_ENGINE_UNSUPPORTED", `RDS 엔진 ${r.Engine}은 아직 지원 안 함 (Postgres 먼저)`);
      spec.database = { engine: "postgres", majorVersion: major(r.EngineVersion), storageGb: Math.min(100, r.AllocatedStorage) };
      set("database", `rds:${r.DBInstanceIdentifier}`, r.AllocatedStorage <= 100);
    } else if (dbItem.kind === "cloudsql.instance") {
      const r = dbItem as unknown as { name: string; databaseVersion: string; settings: { dataDiskSizeGb: string } };
      spec.database = { engine: "postgres", majorVersion: major(r.databaseVersion.replace("POSTGRES_", "")),
        storageGb: Math.min(100, Number(r.settings.dataDiskSizeGb)) };
      set("database", `cloudsql:${r.name}`);
    } else {
      const r = dbItem as unknown as { metadata: { name: string }; spec: { imageName?: string; postgresVersion?: string; storage: { size: string } } };
      const ver = r.spec.postgresVersion ?? r.spec.imageName?.split(":").pop() ?? "16";
      spec.database = { engine: "postgres", majorVersion: major(ver),
        storageGb: Math.min(100, Math.ceil(parseMiB(r.spec.storage.size) / 1024)) };
      set("database", `cnpg:${r.metadata.name}`);
    }
  }
  return { spec, fieldMeta: meta };
}

// --- 원본 모양 (필요한 칸만)
export interface EcsService {
  kind: "ecs.service"; serviceName: string; desiredCount: number; imageDigest: string;
  hostname: string; healthCheckPath?: string;
  taskDefinition: {
    cpu: string; memory: string;
    containerDefinitions: Array<{
      image: string; cpu?: number; memory?: number;
      portMappings: Array<{ containerPort: number }>;
      environment?: Array<{ name: string; value: string }>;
      secrets?: Array<{ name: string; valueFrom: string }>;
    }>;
  };
}
export interface K8sDeployment {
  kind: "k8s.deployment"; imageDigest?: string; hostname: string;
  metadata: { name: string; namespace: string };
  spec: {
    replicas: number;
    template: { spec: { containers: Array<{
      image: string; ports: Array<{ containerPort: number }>;
      resources?: { requests?: { cpu?: string; memory?: string } };
      readinessProbe?: { httpGet?: { path?: string } };
      env?: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }>;
    }> } };
  };
}


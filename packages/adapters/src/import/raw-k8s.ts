// I2: 쿠버네티스 네임스페이스 전체 읽기의 "원본" 모양 (kube 원문에 가깝게, 허용 목록 방식).
// 규칙: metadata.annotations 는 넣지 않는다 · Pod 항목 없음 · Secret 객체는 안 읽는다 · ConfigMap 은 키 이름만.
// 이 파일은 spec-v2(contracts)에 의존하지 않는다. 원본 → 공통 명세 변환(매퍼)은 다른 묶음 몫이다.

// 종류 문자열 상수. RawInventory.items[].kind 로 쓴다 (DB 종류는 기존 값 그대로)
export const K8S_RAW_KINDS = {
  deployment: "k8s.deployment",
  service: "k8s.service",
  ingress: "k8s.ingress",
  hpa: "k8s.hpa",
  cronjob: "k8s.cronjob",
  networkPolicy: "k8s.networkPolicy",
  serviceAccount: "k8s.serviceAccount",
  configMapKeys: "k8s.configMapKeys",
} as const;
export type K8sRawKind = (typeof K8S_RAW_KINDS)[keyof typeof K8S_RAW_KINDS];

export const DB_RAW_KINDS = { rds: "rds.dbInstance", cloudsql: "cloudsql.instance", cnpg: "cnpg.cluster" } as const;

export interface RawK8sMeta { name: string; namespace?: string; labels?: Record<string, string> }

export interface RawK8sEnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
    configMapKeyRef?: { name: string; key: string };
    fieldRef?: { fieldPath: string };
    resourceFieldRef?: { resource: string; containerName?: string };
  };
}
export interface RawK8sProbe {
  httpGet?: { path?: string; port?: number | string; scheme?: string };
  tcpSocket?: { port?: number | string };
  grpc?: { port?: number; service?: string };
  exec?: { command?: string[] };
  initialDelaySeconds?: number; periodSeconds?: number; timeoutSeconds?: number;
  successThreshold?: number; failureThreshold?: number;
}
export interface RawK8sResources { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } }
export interface RawK8sContainer {
  name?: string; image: string; command?: string[]; args?: string[];
  ports?: Array<{ name?: string; containerPort: number; protocol?: string }>;
  env?: RawK8sEnvVar[];
  envFrom?: Array<{ configMapRef?: { name: string }; secretRef?: { name: string }; prefix?: string }>;
  resources?: RawK8sResources;
  readinessProbe?: RawK8sProbe; livenessProbe?: RawK8sProbe; startupProbe?: RawK8sProbe;
  securityContext?: Record<string, unknown>;
}
export interface RawK8sPodSpec {
  serviceAccountName?: string; restartPolicy?: string;
  initContainers?: RawK8sContainer[]; containers: RawK8sContainer[];
}

export interface RawK8sDeployment {
  kind: "k8s.deployment";
  /** containers[0] 이미지의 digest. 못 찾으면 null (멈추지 않고 import.note 에 이유) */
  imageDigest: string | null;
  metadata: RawK8sMeta;
  spec: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template: { metadata?: { labels?: Record<string, string> }; spec: RawK8sPodSpec };
  };
}
export interface RawK8sService {
  kind: "k8s.service";
  metadata: RawK8sMeta;
  spec: { type?: string; selector?: Record<string, string>; ports?: Array<{ name?: string; port: number; targetPort?: number | string; protocol?: string }> };
  status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } };
}
export interface RawK8sIngress {
  kind: "k8s.ingress";
  metadata: RawK8sMeta;
  spec: {
    ingressClassName?: string;
    rules?: Array<{ host?: string; http?: { paths?: Array<{ path?: string; pathType?: string; backend?: { service?: { name: string; port?: { number?: number; name?: string } } } }> } }>;
    tls?: Array<{ hosts?: string[]; secretName?: string }>;
  };
}
export interface RawK8sHpa {
  kind: "k8s.hpa";
  metadata: RawK8sMeta;
  spec: { scaleTargetRef: { kind?: string; name: string }; minReplicas?: number; maxReplicas: number; metrics?: Array<Record<string, unknown>> };
}
export interface RawK8sCronJob {
  kind: "k8s.cronjob";
  /** containers[0] 이미지의 digest (Job 이 만든 Pod 에서). 못 찾으면 null */
  imageDigest: string | null;
  metadata: RawK8sMeta;
  spec: {
    schedule: string; timeZone?: string; concurrencyPolicy?: string; suspend?: boolean;
    jobTemplate: { spec: { backoffLimit?: number; activeDeadlineSeconds?: number; template: { metadata?: { labels?: Record<string, string> }; spec: RawK8sPodSpec } } };
  };
}
export interface RawK8sNetworkPolicy {
  kind: "k8s.networkPolicy";
  metadata: RawK8sMeta;
  spec: { podSelector?: { matchLabels?: Record<string, string> }; policyTypes?: string[]; ingress?: unknown[]; egress?: unknown[] };
}
/** I4: irsaRoleArn = 주석 eks.amazonaws.com/role-arn (IRSA). 없으면 칸 없음 */
export interface RawK8sServiceAccount { kind: "k8s.serviceAccount"; metadata: RawK8sMeta; irsaRoleArn?: string }
/** ConfigMap 은 키 이름만. 값은 버린다 */
export interface RawK8sConfigMapKeys { kind: "k8s.configMapKeys"; metadata: RawK8sMeta; keys: string[] }

export type RawK8sItem =
  | RawK8sDeployment | RawK8sService | RawK8sIngress | RawK8sHpa
  | RawK8sCronJob | RawK8sNetworkPolicy | RawK8sServiceAccount | RawK8sConfigMapKeys;

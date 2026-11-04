// I2: 쿠버네티스 네임스페이스 전체 읽기의 "원본" 모양 (kube 원문에 가깝게, 허용 목록 방식).
// 규칙: metadata.annotations 는 허용 목록 키만(N10, import/annotations.ts) · Pod 항목 없음 · Secret 객체는 안 읽는다 · ConfigMap 은 data 값까지(N3, 평문 비밀 검사는 파이프라인), binaryData 는 키 이름만.
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
  pvc: "k8s.pvc",                                 // N4
  pdb: "k8s.pdb",                                 // N5
  role: "k8s.role",                               // T3
  roleBinding: "k8s.roleBinding",                 // T3
  clusterRoleBinding: "k8s.clusterRoleBinding",   // T3 (이 네임스페이스 SA 를 가리키는 것만)
  crdObject: "k8s.crdObject",                     // N12 (이름만, 안 옮김)
  unread: "k8s.unread",            // F-1: 목록을 못 읽은 종류 (값 없음, 이유만)
  // D6: 도착에서도 같은 종류 (롤백·정리 스레드가 이 이름에 기댐)
  statefulset: "k8s.statefulset",
  daemonset: "k8s.daemonset",
  // NS-1: 앱 네임스페이스 객체 (허용 목록 라벨·annotation 만)
  namespace: "k8s.namespace",
  // JB-1: 일회성 Job (CronJob 이 만든 것 빼고). 옮기지 않고 unmapped 로만 보인다 (끝난 Job 을 다시 돌리면 해로움)
  job: "k8s.job",
  gateway: "k8s.gateway",                         // GW-1 Gateway API (gateway.networking.k8s.io)
  httpRoute: "k8s.httpRoute",                     // GW-1
  grpcRoute: "k8s.grpcRoute",                     // GW-1
  externalSecret: "k8s.externalSecret",           // SS-V (External Secrets Operator)
  secretStore: "k8s.secretStore",                 // SS-V
} as const;
export type K8sRawKind = (typeof K8S_RAW_KINDS)[keyof typeof K8S_RAW_KINDS];

// NS-1 DRAFT(ai): 네임스페이스에서 옮기는 키 허용 목록 (동작이 바뀌는 것만: 파드 보안 수준·메시 주입). 나머지는 안 읽음
export const NS_LABEL_KEYS = [
  "pod-security.kubernetes.io/enforce", "pod-security.kubernetes.io/enforce-version",
  "pod-security.kubernetes.io/audit", "pod-security.kubernetes.io/audit-version",
  "pod-security.kubernetes.io/warn", "pod-security.kubernetes.io/warn-version",
  "istio-injection", "istio.io/rev", "istio.io/dataplane-mode", "kuma.io/sidecar-injection",
] as const;
export const NS_ANNOTATION_KEYS = ["linkerd.io/inject", "scheduler.alpha.kubernetes.io/node-selector"] as const;

export const DB_RAW_KINDS = { rds: "rds.dbInstance", cloudsql: "cloudsql.instance", cnpg: "cnpg.cluster" } as const;

export interface RawK8sMeta { name: string; namespace?: string; labels?: Record<string, string>; /** N10: 허용 목록 키만 */ annotations?: Record<string, string>;
  /** AN-1: 허용 목록 밖이라 안 읽은 annotation 키 이름 (값 없음). 파드 템플릿 것은 "pod:" 앞붙임 */ droppedAnnotations?: string[] }

export interface RawK8sEnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string; optional?: boolean };
    configMapKeyRef?: { name: string; key: string; optional?: boolean };
    fieldRef?: { fieldPath: string };
    resourceFieldRef?: { resource: string; containerName?: string; divisor?: string | number };
  };
}
export interface RawK8sProbe {
  httpGet?: { path?: string; port?: number | string; scheme?: string; httpHeaders?: Array<{ name: string; value: string }> };
  tcpSocket?: { port?: number | string };
  grpc?: { port?: number; service?: string };
  exec?: { command?: string[] };
  initialDelaySeconds?: number; periodSeconds?: number; timeoutSeconds?: number;
  successThreshold?: number; failureThreshold?: number; terminationGracePeriodSeconds?: number;
}
// G-1: cpu·memory 말고 다른 이름(nvidia.com/gpu·ephemeral-storage·hugepages-*)도 그대로 들어온다
export interface RawK8sResources { requests?: { cpu?: string; memory?: string; [name: string]: string | undefined }; limits?: { cpu?: string; memory?: string; [name: string]: string | undefined } }
export interface RawK8sContainer {
  name?: string; image: string; command?: string[]; args?: string[];
  ports?: Array<{ name?: string; containerPort: number; protocol?: string; hostPort?: number }>;
  env?: RawK8sEnvVar[];
  envFrom?: Array<{ configMapRef?: { name: string; optional?: boolean }; secretRef?: { name: string; optional?: boolean }; prefix?: string }>;
  resources?: RawK8sResources;
  readinessProbe?: RawK8sProbe; livenessProbe?: RawK8sProbe; startupProbe?: RawK8sProbe;
  securityContext?: Record<string, unknown>;
  volumeMounts?: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>;
  /** N4: 네이티브 사이드카 (initContainers 안 Always) */
  restartPolicy?: string;
}
/** N4: 파드 볼륨 원문. 종류 키 하나만 (configMap·secret·emptyDir·persistentVolumeClaim·projected·downwardAPI·hostPath, 나머지는 other = 종류 이름만) */
export interface RawK8sVolume { name: string; [type: string]: unknown }
export interface RawK8sPodSpec {
  serviceAccountName?: string; restartPolicy?: string;
  imagePullSecrets?: string[];   // SC-1: 이름만
  initContainers?: RawK8sContainer[]; containers: RawK8sContainer[];
  volumes?: RawK8sVolume[];
  /** N5 */
  nodeSelector?: Record<string, string>; tolerations?: Array<Record<string, unknown>>; affinity?: Record<string, unknown>;
  topologySpreadConstraints?: Array<Record<string, unknown>>; priorityClassName?: string;
  hostNetwork?: boolean; hostPID?: boolean; hostIPC?: boolean;   // HN-1
  /** N10: 파드 템플릿 annotation (허용 목록 키만) */
  podAnnotations?: Record<string, string>;
}

export interface RawK8sDeployment {
  kind: "k8s.deployment";
  /** containers[0] 이미지의 digest. 못 찾으면 null (멈추지 않고 import.note 에 이유) */
  imageDigest: string | null;
  /** N4: 컨테이너 이름(사이드카·init 포함) → 실행 중 Pod 의 digest. 못 찾은 이름은 없음 */
  containerDigests?: Record<string, string>;
  /** G3-4: digest 를 고른 근거가 약함(파드끼리 digest 가 다름·지금 판 파드를 못 가림). 있으면 매퍼가 신뢰도 0.6 + 검토 */
  digestReview?: string;
  /** A-1: 파드가 돈 노드 CPU 종류 (정렬). 노드를 못 읽었으면 칸 없음 */
  nodeArch?: string[];
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
  spec: {
    type?: string; selector?: Record<string, string>;
    ports?: Array<{ name?: string; port: number; targetPort?: number | string; protocol?: string; appProtocol?: string; nodePort?: number }>;
    // V-1·NP-1: 동작 칸 (없으면 칸 없음)
    clusterIP?: string;                     // "None" = headless
    sessionAffinity?: string;               // ClientIP | None
    sessionAffinityTimeoutSec?: number;     // sessionAffinityConfig.clientIP.timeoutSeconds
    externalTrafficPolicy?: string;         // Cluster | Local
    internalTrafficPolicy?: string;
    publishNotReadyAddresses?: boolean;
    loadBalancerSourceRanges?: string[];
    loadBalancerIP?: string;
    externalName?: string;                  // type ExternalName
  };
  status?: { loadBalancer?: { ingress?: Array<{ hostname?: string; ip?: string }> } };
}
export interface RawK8sIngressBackend {
  service?: { name: string; port?: { number?: number; name?: string } };
  resource?: { apiGroup?: string; kind?: string; name?: string };
}
export interface RawK8sIngress {
  kind: "k8s.ingress";
  metadata: RawK8sMeta;
  spec: {
    ingressClassName?: string;
    rules?: Array<{ host?: string; http?: { paths?: Array<{ path?: string; pathType?: string; backend?: RawK8sIngressBackend }> } }>;
    /** G3-2: rules 에 안 맞는 요청을 받는 기본 백엔드 */
    defaultBackend?: RawK8sIngressBackend;
    tls?: Array<{ hosts?: string[]; secretName?: string }>;
  };
}
export interface RawK8sHpa {
  kind: "k8s.hpa";
  metadata: RawK8sMeta;
  spec: { scaleTargetRef: { kind?: string; name: string }; minReplicas?: number; maxReplicas: number; metrics?: Array<Record<string, unknown>>; behavior?: Record<string, unknown> };
}
export interface RawK8sCronJob {
  kind: "k8s.cronjob";
  /** containers[0] 이미지의 digest (Job 이 만든 Pod 에서). 못 찾으면 null */
  imageDigest: string | null;
  /** N4: 컨테이너 이름 → digest (사이드카·init 포함) */
  containerDigests?: Record<string, string>;
  /** G3-4: 가장 최근 Job 파드끼리 digest 가 다름 → 매퍼가 신뢰도 0.6 + 검토 */
  digestReview?: string;
  nodeArch?: string[];
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
/** D6: StatefulSet. 파드 모양은 Deployment 와 같고 파드별 PVC(volumeClaimTemplates)·고정 이름(serviceName)이 더 있음 */
export interface RawK8sVolumeClaimTemplate { name: string; accessModes?: string[]; storage?: string; storageClassName?: string }
export interface RawK8sStatefulSet {
  kind: "k8s.statefulset";
  imageDigest: string | null;
  nodeArch?: string[];   // A-1
  metadata: RawK8sMeta;
  spec: {
    replicas?: number;
    serviceName?: string;
    podManagementPolicy?: string;
    persistentVolumeClaimRetentionPolicy?: { whenDeleted?: string; whenScaled?: string };
    selector?: { matchLabels?: Record<string, string> };
    template: { metadata?: { labels?: Record<string, string> }; spec: RawK8sPodSpec };
    volumeClaimTemplates?: RawK8sVolumeClaimTemplate[];
  };
}
/** D6: DaemonSet. 개수는 노드 수를 따름 → status.desiredNumberScheduled 는 참고값 */
export interface RawK8sDaemonSet {
  kind: "k8s.daemonset";
  imageDigest: string | null;
  nodeArch?: string[];   // A-1
  metadata: RawK8sMeta;
  spec: {
    selector?: { matchLabels?: Record<string, string> };
    template: { metadata?: { labels?: Record<string, string> }; spec: RawK8sPodSpec };
  };
  status?: { desiredNumberScheduled?: number };
}
/** NS-1: 네임스페이스 객체. 허용 목록 키만 (discover/k8s.ts NS_LABEL_KEYS·NS_ANNOTATION_KEYS) */
export interface RawK8sNamespace { kind: "k8s.namespace"; metadata: RawK8sMeta & { annotations?: Record<string, string> } }

/** JB-1: 일회성 Job. 이름·상태 개수만 (파드 모양은 안 읽음) */
export interface RawK8sJob { kind: "k8s.job"; metadata: RawK8sMeta; status: { active: number; succeeded: number; failed: number } }

/** I4: irsaRoleArn = 주석 eks.amazonaws.com/role-arn (IRSA). 없으면 칸 없음 */
export interface RawK8sServiceAccount { kind: "k8s.serviceAccount"; metadata: RawK8sMeta; irsaRoleArn?: string; /** WI-1 */ gcpServiceAccount?: string }
/** N3: ConfigMap. keys = data·binaryData 키 전부, data = 글자 값 그대로(평문 비밀 검사는 파이프라인), binaryKeys = binaryData 키(값은 안 읽음) */
export interface RawK8sConfigMapKeys { kind: "k8s.configMapKeys"; metadata: RawK8sMeta; keys: string[]; data?: Record<string, string>; binaryKeys?: string[] }
/** N4: PVC 객체 (크기·접근·클래스만) */
export interface RawK8sPvc { kind: "k8s.pvc"; metadata: RawK8sMeta; spec: { accessModes?: string[]; storageClassName?: string; resources?: { requests?: { storage?: string } } } }
/** N5: PodDisruptionBudget */
export interface RawK8sPdb { kind: "k8s.pdb"; metadata: RawK8sMeta; spec: { selector?: { matchLabels?: Record<string, string>; hasExpressions?: true }; minAvailable?: number | string; maxUnavailable?: number | string;
  unhealthyPodEvictionPolicy?: string } }
/** T3: Role·RoleBinding·ClusterRoleBinding 원문 */
export interface RawK8sRole { kind: "k8s.role"; metadata: RawK8sMeta; rules: Array<Record<string, unknown>> }
export interface RawK8sRoleRef { kind: string; name: string }
export interface RawK8sSubject { kind: string; name: string; namespace?: string }
export interface RawK8sRoleBinding { kind: "k8s.roleBinding" | "k8s.clusterRoleBinding"; metadata: RawK8sMeta; roleRef: RawK8sRoleRef; subjects: RawK8sSubject[] }
/** N12: 네임스페이스 안 다른 CRD 객체 (이름만). resource = "<복수형>.<그룹>" */
export interface RawK8sCrdObject { kind: "k8s.crdObject"; metadata: RawK8sMeta; resource: string }

/** F-1: 목록 읽기가 실패한 종류. pipeline 이 "못 읽음" 검토 줄(0.6)로 올린다 */
export interface RawK8sUnread { kind: "k8s.unread"; resource: string; reason: string; /** ID-5: 읽은 곳 (없으면 k8s 목록) */ source?: string }
/** GW-1: Gateway API 원문 (라우팅에 쓰는 칸만). 값 모양은 gateway.networking.k8s.io/v1 그대로 */
export interface RawK8sGateway {
  kind: "k8s.gateway"; metadata: RawK8sMeta;
  spec: { gatewayClassName?: string; listeners?: Array<{ name: string; hostname?: string; port?: number; protocol?: string;
    tls?: { mode?: string; certificateRefs?: Array<{ name: string; kind?: string; namespace?: string }> } }> };
}
export interface RawK8sParentRef { name: string; namespace?: string; kind?: string; sectionName?: string }
export interface RawK8sBackendRef { name: string; namespace?: string; kind?: string; group?: string; port?: number; weight?: number; filters?: Array<{ type: string }> }
export interface RawK8sHttpRoute {
  kind: "k8s.httpRoute"; metadata: RawK8sMeta;
  spec: { parentRefs?: RawK8sParentRef[]; hostnames?: string[]; rules?: Array<{
    matches?: Array<{ path?: { type?: string; value?: string }; headers?: Array<{ type?: string; name: string; value: string }>; queryParams?: unknown[]; method?: string }>;
    filters?: Array<{ type: string }>; backendRefs?: RawK8sBackendRef[]; timeouts?: Record<string, unknown>; sessionPersistence?: Record<string, unknown> }> };
}
export interface RawK8sGrpcRoute {
  kind: "k8s.grpcRoute"; metadata: RawK8sMeta;
  spec: { parentRefs?: RawK8sParentRef[]; hostnames?: string[]; rules?: Array<{
    matches?: Array<{ method?: { type?: string; service?: string; method?: string }; headers?: Array<{ type?: string; name: string; value: string }> }>;
    filters?: Array<{ type: string }>; backendRefs?: RawK8sBackendRef[]; sessionPersistence?: Record<string, unknown> }> };
}

/** SS-V: ExternalSecret (값 없음). target = 만들어지는 k8s Secret 이름 */
export interface RawK8sExternalSecret { kind: "k8s.externalSecret"; metadata: RawK8sMeta;
  spec: { store: { kind: string; name: string }; target: string; data: Array<{ key: string; remote: string; property?: string }>; dataFrom: string[] } }
export interface RawK8sSecretStore { kind: "k8s.secretStore"; metadata: RawK8sMeta; provider: string }

export type RawK8sItem =
  | RawK8sDeployment | RawK8sService | RawK8sIngress | RawK8sHpa
  | RawK8sCronJob | RawK8sNetworkPolicy | RawK8sServiceAccount | RawK8sConfigMapKeys
  | RawK8sPvc | RawK8sPdb | RawK8sRole | RawK8sRoleBinding | RawK8sCrdObject | RawK8sUnread
  | RawK8sStatefulSet | RawK8sDaemonSet | RawK8sNamespace | RawK8sJob
  | RawK8sGateway | RawK8sHttpRoute | RawK8sGrpcRoute | RawK8sExternalSecret | RawK8sSecretStore;

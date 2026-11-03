// I9: AWS ECS 서비스 원본 모양 (DescribeServices + DescribeTaskDefinition + DescribeTasks digest + ALB 규칙 + Auto Scaling 을 한 줄로).
//   reader(readers/aws-ecs.ts)가 이 모양으로 넣고, 매퍼(mappers/ecs-service.ts)가 읽는다. v1 데모 원본(hostname·healthCheckPath)도 같은 종류로 받는다.
//   규칙: 비밀 값은 안 읽는다(secrets 는 ARN 만) · 태그·주석 안 넣음.

export const ECS_RAW_KIND = "ecs.service" as const;

export interface RawEcsContainer {
  name?: string;
  image: string;
  essential?: boolean;
  cpu?: number;                       // CPU 단위 (1024 = 1 vCPU)
  memory?: number;                    // MiB (hard limit)
  memoryReservation?: number;         // MiB (soft)
  entryPoint?: string[];
  command?: string[];
  portMappings?: Array<{ containerPort: number; protocol?: string; name?: string }>;
  environment?: Array<{ name: string; value: string }>;
  secrets?: Array<{ name: string; valueFrom: string }>;   // Secrets Manager ARN(…:secret:<이름>[:<json 키>::]) 또는 SSM 파라미터 ARN
  healthCheck?: { command?: string[]; interval?: number; retries?: number; startPeriod?: number };
}

export interface RawEcsService {
  kind: typeof ECS_RAW_KIND;
  serviceName: string;
  serviceArn?: string | null;
  clusterName?: string | null;
  desiredCount: number;
  launchType?: string | null;         // FARGATE | EC2 | EXTERNAL
  imageDigest?: string | null;        // 실행 중 작업 containers[].imageDigest (주 컨테이너)
  taskDefinition: {
    family?: string;
    cpu?: string;                     // 작업 크기 (CPU 단위 문자열)
    memory?: string;                  // 작업 크기 (MiB 문자열)
    taskRoleArn?: string | null;
    containerDefinitions: RawEcsContainer[];
  };
  /** Service Connect: 다른 서비스가 부르는 이름 (discoveryName·clientAliases.dnsName) */
  serviceConnect?: { namespace?: string | null; aliases: Array<{ dnsName: string; port?: number }> } | null;
  /** ALB 대상 그룹 (DescribeTargetGroups) */
  loadBalancers?: Array<{ containerName?: string; containerPort: number; healthCheckPath?: string | null }>;
  /** 이 서비스 대상 그룹으로 가는 ALB 리스너 규칙 (host-header · path-pattern). reader 가 펼쳐 넣는다 */
  routes?: Array<{ host: string; path?: string | null; priority?: number | null }>;
  /** Application Auto Scaling (DescribeScalableTargets + 대상 추적 CPU 정책) */
  autoscaling?: { min: number; max: number; targetCpuPct?: number | null } | null;
  /** v1 데모 원본 칸 (진짜 reader 는 routes·loadBalancers 로 넣는다) */
  hostname?: string;
  healthCheckPath?: string;
}

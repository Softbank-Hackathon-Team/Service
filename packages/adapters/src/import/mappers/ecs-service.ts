import { splitImage } from "./k8s-deployment.js";
import { ECS_RAW_KIND, type RawEcsContainer, type RawEcsService } from "../raw-ecs.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai) I9: ECS 서비스 → service 리소스 (설계 23번 4장 ② 열, 27번 A7).
//   runtime = managedContainer, origin = { managedContainer, ecs } — 재현성 기본(ECS → ECS급). 도착 Builder 가 managedContainer 를
//   못 그리면 capability 로 막힌다(UNSUPPORTED_V2). k8s 로 바꿔 옮길지는 사람이 명세에서 runtime 을 바꾼다(runtime_change 승인 줄)
//   TODO(human): N8 — ECS 출발의 기본 도착 실행 방식 (ECS·Cloud Run 유지 vs EKS·GKE 로 바꿈). 지금은 유지
//   원칙: 출발에 있는 것만 (프로브·요청량 없으면 비움). digest 없으면 unmapped B (k8s 매퍼와 같은 R9)

const m = (source: string, confidence: 1 | 0.9 | 0.6 = 1, rationale?: string): MetaTuple =>
  rationale === undefined ? [source, confidence] : [source, confidence, rationale];

/** 주 컨테이너: essential 인 첫 번째 → 없으면 첫 번째 */
export const mainContainer = (s: RawEcsService): RawEcsContainer | undefined =>
  s.taskDefinition.containerDefinitions.find((c) => c.essential !== false) ?? s.taskDefinition.containerDefinitions[0];

/** secrets[].valueFrom → { secret, key }.
 *  Secrets Manager: arn:…:secret:<이름>[:<json 키>[:…]] → 이름 + (json 키 또는 env 이름)
 *  SSM 파라미터: arn:…:parameter/<경로> → 경로 마지막 조각 + env 이름. ARN 이 아니면 값 그대로 이름으로
 *  DRAFT(ai): Secrets Manager 이름 끝 무작위 6자(-AbCdEf)는 떼지 않는다 (이름 자체가 그렇게 끝날 수 있어 구별 불가) */
export function secretRefOf(envName: string, valueFrom: string): { secret: string; key: string } {
  const sm = /:secret:([^:]+)(?::([^:]*))?/.exec(valueFrom);
  if (sm) return { secret: sm[1]!, key: sm[2] || envName };
  const ssm = /:parameter\/?(.+)$/.exec(valueFrom);
  if (ssm) return { secret: ssm[1]!.split("/").filter(Boolean).pop()!, key: envName };
  return { secret: valueFrom.split("/").filter(Boolean).pop() ?? valueFrom, key: envName };
}
/** v1 normalize.ts 와 같은 key 규칙 (투영이 지금 v1 과 같은 값을 내게) */
const v1SecretKey = (valueFrom: string) => valueFrom.split(":").pop()!;

/** 작업 역할 ARN → 이름 (신원 묶기용). 없으면 "default" (k8s 규칙과 같은 자리) */
export const roleNameOf = (arn: string | null | undefined): string | null => {
  const x = arn ? /:role\/(?:.*\/)?([^/]+)$/.exec(arn)?.[1] : undefined;
  return x ?? null;
};

export const ecsServiceMapper: KindMapper = {
  nativeTypes: [ECS_RAW_KIND],
  kind: "service",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const s = item as unknown as RawEcsService;
    if (!s.serviceName || !s.taskDefinition?.containerDefinitions) return { skip: "serviceName·작업 정의 없음 (깨진 원본)", grade: "C" };
    const c = mainContainer(s);
    if (!c) return { skip: "컨테이너 없음", grade: "C" };
    const digest = s.imageDigest ?? null;
    if (!digest && !c.image.includes("@sha256:")) return { skip: `이미지 digest 를 못 읽음 (실행 중 작업 없음, 태그 ${c.image}) → 사람이 확인`, grade: "B" };
    const src = `ecs:${s.clusterName ?? ""}/service/${s.serviceName}`;
    const td = s.taskDefinition;
    const others = td.containerDefinitions.filter((x) => x !== c);

    // 자원: 컨테이너 값 → 없으면 작업 크기. ECS 예약값 = k8s requests 자리 (DRAFT(ai))
    const cpuUnits = c.cpu ?? (td.cpu != null ? Number(td.cpu) : null);
    const memMiB = c.memory ?? c.memoryReservation ?? (td.memory != null ? Number(td.memory) : null);
    const cpuMilli = cpuUnits != null && Number.isFinite(cpuUnits) && cpuUnits > 0 ? Math.round((cpuUnits / 1024) * 1000) : null;
    const mem = memMiB != null && Number.isFinite(memMiB) && memMiB > 0 ? memMiB : null;
    const resources = cpuMilli != null || mem != null ? { request: { cpuMilli, memMiB: mem } } : {};

    const env: Array<Record<string, unknown>> = [
      ...(c.environment ?? []).map((e) => ({ name: e.name, value: e.value })),
      ...(c.secrets ?? []).map((e) => ({ name: e.name, fromSecret: secretRefOf(e.name, e.valueFrom) })),
    ];
    const ports = (c.portMappings ?? []).map((p) => ({ ...(p.name ? { name: p.name } : {}), port: p.containerPort,
      protocol: (p.protocol ?? "tcp").toUpperCase() === "UDP" ? "UDP" : "TCP" }));
    // 프로브: ALB 대상 그룹 확인 경로 → readiness http (대상 그룹 포트), 컨테이너 healthCheck → liveness exec
    const lb = (s.loadBalancers ?? []).find((l) => !l.containerName || l.containerName === c.name) ?? s.loadBalancers?.[0];
    const healthPath = lb?.healthCheckPath ?? s.healthCheckPath ?? null;
    const probePort = lb?.containerPort ?? c.portMappings?.[0]?.containerPort;
    const readiness = healthPath && probePort ? { type: "http", path: healthPath, port: probePort } : undefined;
    const hc = c.healthCheck?.command;
    const liveness = hc?.length ? { type: "exec", command: hc[0] === "CMD-SHELL" ? ["sh", "-c", hc.slice(1).join(" ")] : hc[0] === "CMD" ? hc.slice(1) : hc,
      ...(c.healthCheck?.interval ? { periodSec: c.healthCheck.interval } : {}), ...(c.healthCheck?.retries ? { failureThreshold: c.healthCheck.retries } : {}),
      ...(c.healthCheck?.startPeriod ? { initialDelaySec: c.healthCheck.startPeriod } : {}) } : undefined;
    const probes = { ...(readiness ? { readiness } : {}), ...(liveness ? { liveness } : {}) };

    const role = roleNameOf(td.taskRoleArn);
    const as = s.autoscaling;
    const replicas = as ? { min: as.min, max: as.max } : { min: s.desiredCount, max: s.desiredCount };
    const img = splitImage(c.image, digest);
    const sidecars = others.map((x) => {
      const xi = splitImage(x.image, null);
      return { name: x.name ?? "sidecar", image: { source: "registry", repository: xi.repository, digest: xi.digest },
        env: (x.environment ?? []).map((e) => ({ name: e.name, value: e.value })), resources: {} };
    });
    const props: Record<string, unknown> = {
      runtime: "managedContainer",
      origin: { runtime: "managedContainer", product: "ecs" },
      image: { source: "registry", repository: img.repository, digest: img.digest },
      ...(c.entryPoint?.length ? { command: c.entryPoint } : {}),
      ...(c.command?.length ? { args: c.command } : {}),
      resources, env,
      serviceAccount: role ?? "default",
      ...(ports.length ? { ports } : {}),
      ...(Object.keys(probes).length ? { probes } : {}),
      replicas,
      ...(as?.targetCpuPct ? { scale: { targetCpuPct: as.targetCpuPct } } : {}),
      // DRAFT(ai): digest 를 못 박는 사이드카(태그만)는 넣지 않고 unmapped 로 (아래 skip 이 아니라 pipeline 이 아닌 여기서 버림)
      ...(sidecars.filter((x) => x.image.digest).length ? { sidecars: sidecars.filter((x) => x.image.digest) } : {}),
    };
    // 라우팅 재료: ALB 규칙(host·path) → 없으면 v1 데모 원본 hostname 의 "/" 한 줄. 포트 = 대상 그룹 컨테이너 포트
    const rport = lb?.containerPort ?? c.portMappings?.[0]?.containerPort;
    const routes = rport == null ? [] : (s.routes?.length ? [...s.routes].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((r) => ({ host: r.host, path: r.path ?? null, port: rport }))
      : s.hostname ? [{ host: s.hostname, path: null, port: rport }] : []);
    const aliases = [...new Set((s.serviceConnect?.aliases ?? []).map((a) => a.dnsName.toLowerCase()))].sort();
    return {
      name: s.serviceName, kind: "service",
      native: { type: ECS_RAW_KIND, name: s.serviceName, uid: s.serviceArn ?? null, ...(s.clusterName ? { scope: s.clusterName } : {}),
        ...(aliases.length ? { aliases } : {}) },
      props,
      ...(routes.length ? { routes } : {}),
      meta: {
        origin: m(src, 1, "ECS 출발 → 도착도 관리형 컨테이너 (재현성 기본, N8 미정)"),
        image: c.image.includes("@") ? m(`${src}.image`) : m(`${src}.image + running task imageDigest`),
        resources: cpuMilli != null || mem != null ? m(`${src}.cpu·memory`, 0.9, "ECS 예약값(작업 크기)을 요청량으로 옮김")
          : m(`${src}.cpu·memory`, 0.9, "출발에 크기 없음"),
        probes: Object.keys(probes).length ? m(`${src}.targetGroup.healthCheck·container.healthCheck`) : m(`${src}.healthCheck`, 0.9, "출발에 확인 없음 → 만들지 않음"),
        serviceAccount: role ? m(`${src}.taskRoleArn`) : m(`${src}.taskRoleArn`, 0.9, "작업 역할 없음 → default"),
        ports: ports.length ? m(`${src}.portMappings`) : m(`${src}.portMappings`, 0.9, "포트 없음 (워커)"),
        replicas: as ? m(`${src}.autoscaling.min/max`) : m(`${src}.desiredCount`),
        ...(others.some((x) => !splitImage(x.image, null).digest) ? { sidecars: m(`${src}.containerDefinitions`, 0.6, "태그만 있는 보조 컨테이너는 digest 를 못 박아 뺐다 → 사람이 확인") } : {}),
      },
      projection: {
        name: s.serviceName,
        env: (c.environment ?? []).map((e) => ({ name: e.name, value: e.value })),
        plainSecretNames: [],
        secretRefs: (c.secrets ?? []).map((e) => ({ name: e.name, key: v1SecretKey(e.valueFrom) })),
        specReplicas: s.desiredCount,
        port: c.portMappings?.[0]?.containerPort ?? null,
        // v1 데모 원본 칸 → ALB 규칙 첫 호스트 → (모름) null 이면 투영이 기본 이름
        hostname: s.hostname ?? [...(s.routes ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0]?.host ?? null,
        image: c.image,
        imageDigest: digest,
        healthPath,
      },
    };
  },
};

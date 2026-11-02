import { cpuMilliOf, mibOf, splitImage } from "./k8s-deployment.js";
import { CLOUDRUN_RAW_KINDS, type RawCloudRunContainer, type RawCloudRunJob, type RawCloudRunProbe, type RawCloudRunService } from "../raw-cloudrun.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai) CRIMPORT: Cloud Run 서비스 → service, Cloud Run 잡(+Cloud Scheduler 일정) → job (설계 23번 4장 ② 열, 27번 A7). ECS 매퍼와 같은 틀.
//   서비스: runtime = managedContainer, origin = { managedContainer, cloudRun } — 재현성 기본(Cloud Run → Cloud Run급).
//   TODO(human): N8 — 관리형 출발의 기본 도착 실행 방식 (유지 vs k8s 로 바꿈). 지금은 유지 (ECS 와 같음)
//   원칙: 출발에 있는 것만. digest 없으면 unmapped B (k8s·ECS 매퍼와 같은 R9). Cloud Run 은 요청량이 없고 한도(limits)만 있음 → limit 으로, 검토 표시

const m = (source: string, confidence: 1 | 0.9 | 0.6 = 1, rationale?: string): MetaTuple =>
  rationale === undefined ? [source, confidence] : [source, confidence, rationale];

/** SA 이메일 → 이름 (신원 묶기용). 없거나 기본 컴퓨트 SA(…-compute@developer…)면 "default" (k8s 규칙과 같은 자리) */
export const saNameOf = (email: string | null | undefined): string | null => {
  if (!email || /-compute@developer\.gserviceaccount\.com$/.test(email)) return null;
  return email.split("@")[0] || null;
};

/** Cloud Run env 한 줄 → IR env. 비밀은 이름만 참조 (값은 원본에도 없음)
 *  DRAFT(ai): Secret Manager 비밀 = 값 하나 → key 는 env 이름 (ECS SSM 과 같은 규칙). 버전은 meta 에만 (latest 아니면 검토) */
const envOf = (c: RawCloudRunContainer): Array<Record<string, unknown>> =>
  (c.env ?? []).map((e) => e.secret ? { name: e.name, fromSecret: { secret: e.secret.name, key: e.name } } : { name: e.name, value: e.value ?? "" });

function probeOf(p: RawCloudRunProbe | null | undefined, fallbackPort: number | undefined): Record<string, unknown> | undefined {
  if (!p) return undefined;
  const timing = {
    ...(p.periodSeconds ? { periodSec: p.periodSeconds } : {}), ...(p.failureThreshold ? { failureThreshold: p.failureThreshold } : {}),
    ...(p.initialDelaySeconds ? { initialDelaySec: p.initialDelaySeconds } : {}), ...(p.timeoutSeconds ? { timeoutSec: p.timeoutSeconds } : {}),
  };
  const port = (x: number | null | undefined) => x ?? fallbackPort;
  if (p.httpGet && port(p.httpGet.port) != null) return { type: "http", ...(p.httpGet.path ? { path: p.httpGet.path } : {}), port: port(p.httpGet.port), ...timing };
  if (p.grpc && port(p.grpc.port) != null) return { type: "grpc", port: port(p.grpc.port), ...timing };
  if (p.tcpSocket && port(p.tcpSocket.port) != null) return { type: "tcp", port: port(p.tcpSocket.port), ...timing };
  return undefined;
}

function workload(c: RawCloudRunContainer, digest: string | null, sa: string | null) {
  const cpu = cpuMilliOf(c.limits?.cpu), mem = mibOf(c.limits?.memory);
  const img = splitImage(c.image, digest);
  return {
    image: { source: "registry", repository: img.repository, digest: img.digest },
    ...(c.command?.length ? { command: c.command } : {}),
    ...(c.args?.length ? { args: c.args } : {}),
    resources: cpu != null || mem != null ? { limit: { cpuMilli: cpu, memMiB: mem } } : {},
    env: envOf(c),
    serviceAccount: saNameOf(sa) ?? "default",
  };
}

const pinned = (c: RawCloudRunContainer) => (c.env ?? []).filter((e) => e.secret && e.secret.version !== "latest").map((e) => e.name);

export const cloudRunServiceMapper: KindMapper = {
  nativeTypes: [CLOUDRUN_RAW_KINDS.service],
  kind: "service",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const s = item as unknown as RawCloudRunService;
    if (!s.name || !Array.isArray(s.containers)) return { skip: "이름·컨테이너 없음 (깨진 원본)", grade: "C" };
    // Cloud Run 다중 컨테이너: 포트가 있는 컨테이너가 주 컨테이너(들어오는 요청을 받음). 나머지는 보조
    const c = s.containers.find((x) => x.ports?.length) ?? s.containers[0];
    if (!c) return { skip: "컨테이너 없음", grade: "C" };
    const digest = s.imageDigest ?? null;
    if (!digest && !c.image.includes("@sha256:")) return { skip: `이미지 digest 를 못 읽음 (준비된 판 없음, 태그 ${c.image}) → 사람이 확인`, grade: "B" };
    const src = `cloudrun:${s.region}/service/${s.name}`;
    const others = s.containers.filter((x) => x !== c);
    const port = c.ports?.[0]?.containerPort;
    const ports = port != null ? [{ ...(c.ports![0]!.name ? { name: c.ports![0]!.name } : {}), port, protocol: "TCP" }] : [];
    const readiness = probeOf(c.startupProbe, port);
    const liveness = probeOf(c.livenessProbe, port);
    // DRAFT(ai): Cloud Run startupProbe = "준비됐나"(트래픽 받기 전) → readiness 자리 (도착 관리형 모듈의 health_path 재료)
    const probes = { ...(readiness ? { readiness } : {}), ...(liveness ? { liveness } : {}) };
    // DRAFT(ai): 최소 인스턴스 기본 0, 최대 기본 100 (Cloud Run 기본값). IR replicas 상한 100 에 맞춰 자름
    const min = Math.max(0, Math.min(100, s.minScale ?? 0)), max = Math.max(min, Math.min(100, s.maxScale ?? 100));
    const sidecars = others.map((x) => {
      const xi = splitImage(x.image, null);
      return { name: x.name ?? "sidecar", image: { source: "registry", repository: xi.repository, digest: xi.digest }, env: envOf(x), resources: {} };
    });
    const w = workload(c, digest, s.serviceAccount ?? null);
    const props: Record<string, unknown> = {
      runtime: "managedContainer",
      origin: { runtime: "managedContainer", product: "cloudRun" },
      ...w,
      ...(ports.length ? { ports } : {}),
      ...(Object.keys(probes).length ? { probes } : {}),
      replicas: { min, max },
      ...(sidecars.filter((x) => x.image.digest).length ? { sidecars: sidecars.filter((x) => x.image.digest) } : {}),
    };
    // 라우팅: 사용자 도메인만 (…run.app 주소는 출발 프로젝트에 묶여 도착에서 못 씀). 공개 = ingress all + allUsers 호출 권한
    const routes = port == null ? [] : (s.domains ?? []).map((host) => ({ host, path: null, port }));
    const isPublic = s.ingress === "all" || s.ingress == null ? (s.invokerAllUsers ?? null) : false;
    // posture: ingress all 이면 인터넷(0.0.0.0/0), internal 계열이면 출발 원본 이름 그대로 (도착에 못 옮김 → 사람이 정함)
    const ingress = s.ingress == null || s.ingress === "all"
      ? [{ from: "0.0.0.0/0", ...(port != null ? { port } : {}) }]
      : [{ from: `cloudrun-ingress:${s.ingress}`, ...(port != null ? { port } : {}) }];
    const pins = pinned(c);
    return {
      name: s.name, kind: "service",
      native: { type: CLOUDRUN_RAW_KINDS.service, name: s.name, uid: s.uid ?? null, scope: s.region,
        ...(s.labels && Object.keys(s.labels).length ? { labels: s.labels } : {}),
        ...(s.urlHost ? { aliases: [s.urlHost.toLowerCase()] } : {}) },
      props,
      network: { ingress, public: isPublic },
      ...(routes.length ? { routes } : {}),
      meta: {
        origin: m(src, 1, "Cloud Run 출발 → 도착도 관리형 컨테이너 (재현성 기본, N8 미정)"),
        image: c.image.includes("@") ? m(`${src}.image`) : m(`${src}.image + revision imageDigest`),
        resources: m(`${src}.resources.limits`, 0.9, "Cloud Run 은 한도(limits)만 있음 → limit 으로 옮김, 요청량은 비움"),
        probes: Object.keys(probes).length ? m(`${src}.startupProbe·livenessProbe`, 0.9, "startupProbe 를 readiness 자리로 옮김")
          : m(`${src}.probes`, 0.9, "출발에 확인 없음 → 만들지 않음"),
        serviceAccount: saNameOf(s.serviceAccount) ? m(`${src}.serviceAccountName`) : m(`${src}.serviceAccountName`, 0.9, "기본 컴퓨트 SA → default"),
        ports: ports.length ? m(`${src}.ports`) : m(`${src}.ports`, 0.9, "포트 없음"),
        replicas: m(`${src}.autoscaling.knative.dev/minScale·maxScale`, s.minScale == null || s.maxScale == null ? 0.9 : 1,
          s.minScale == null || s.maxScale == null ? "적히지 않은 쪽은 Cloud Run 기본값(최소 0·최대 100)" : undefined),
        ...(s.invokerAllUsers == null ? { network: m(`${src}.iam`, 0.6, "호출 권한(run.invoker)을 못 읽어 공개 여부 모름 → 사람이 확인") } : {}),
        ...(pins.length ? { env: m(`${src}.env.secretKeyRef`, 0.9, `비밀 버전을 고정해 씀(${pins.join(",")}) → 도착은 최신 값 하나로 옮김`) } : {}),
        ...(others.some((x) => !splitImage(x.image, null).digest) ? { sidecars: m(`${src}.containers`, 0.6, "태그만 있는 보조 컨테이너는 digest 를 못 박아 뺐다 → 사람이 확인") } : {}),
      },
      projection: {
        name: s.name,
        env: (c.env ?? []).filter((e) => !e.secret).map((e) => ({ name: e.name, value: e.value ?? "" })),
        plainSecretNames: [],
        secretRefs: (c.env ?? []).filter((e) => e.secret).map((e) => ({ name: e.name, key: e.name })),
        specReplicas: min,
        port: port ?? null,
        hostname: (s.domains ?? [])[0] ?? null,
        image: c.image,
        imageDigest: digest,
        healthPath: c.startupProbe?.httpGet?.path ?? null,
      },
    };
  },
};

export const cloudRunJobMapper: KindMapper = {
  nativeTypes: [CLOUDRUN_RAW_KINDS.job],
  kind: "job",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const j = item as unknown as RawCloudRunJob;
    if (!j.name || !Array.isArray(j.containers)) return { skip: "이름·컨테이너 없음 (깨진 원본)", grade: "C" };
    const c = j.containers[0];
    if (!c) return { skip: "컨테이너 없음", grade: "C" };
    // DRAFT(ai): IR job 은 일정(cron)이 있는 잡. 일정 없는(수동·이벤트로 부르는) 잡은 카탈로그에 없음 → unmapped B
    if (!j.schedule) return { skip: "Cloud Scheduler 일정이 없는 잡 (수동·이벤트 실행) → IR job 은 일정 잡만. 사람이 확인", grade: "B" };
    if (!j.imageDigest && !c.image.includes("@sha256:")) return { skip: `잡 이미지 digest 를 못 읽음 (태그 ${c.image}) → 사람이 확인`, grade: "B" };
    if (j.containers.length > 1) return { skip: `잡 컨테이너 ${j.containers.length}개 → 보조 컨테이너 잡은 아직 못 옮김`, grade: "B" };
    const src = `cloudrun:${j.region}/job/${j.name}`;
    const w = workload(c, j.imageDigest ?? null, j.serviceAccount ?? null);
    const run: Record<string, unknown> = {
      schedule: j.schedule.cron,
      ...(j.schedule.timeZone ? { timeZone: j.schedule.timeZone } : {}),
      ...(j.schedule.paused ? { suspend: true } : {}),
      // DRAFT(ai): Cloud Run maxRetries = 작업(task)마다 재시도 → k8s backoffLimit 자리. 실행은 기본 겹치지 않게(Forbid)는 출발에 없는 값이라 안 넣음
      ...(j.maxRetries != null ? { backoffLimit: j.maxRetries } : {}),
      ...(j.timeoutSec != null ? { activeDeadlineSec: j.timeoutSec } : {}),
    };
    const parallel = (j.taskCount ?? 1) > 1 || (j.parallelism ?? 0) > 1;
    return {
      name: j.name, kind: "job",
      native: { type: CLOUDRUN_RAW_KINDS.job, name: j.name, uid: j.uid ?? null, scope: j.region,
        ...(j.labels && Object.keys(j.labels).length ? { labels: j.labels } : {}) },
      props: { ...w, ...run },
      meta: {
        image: c.image.includes("@") ? m(`${src}.image`) : m(`${src}.image`, 0.9),
        resources: m(`${src}.resources.limits`, 0.9, "Cloud Run 은 한도(limits)만 있음 → limit 으로 옮김"),
        serviceAccount: saNameOf(j.serviceAccount) ? m(`${src}.serviceAccountName`) : m(`${src}.serviceAccountName`, 0.9, "기본 컴퓨트 SA → default"),
        schedule: m(`cloudscheduler:${j.region}→${j.name}.schedule`),
        ...(parallel ? { run: m(`${src}.taskCount·parallelism`, 0.6, `작업 ${j.taskCount ?? 1}개·동시 ${j.parallelism ?? 0} → IR job 은 작업 하나 실행 모양이라 못 옮김. 사람이 확인`) } : {}),
      },
    };
  },
};

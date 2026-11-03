import type { AppSpec, AppSpecV2, Capability, ComponentV2, EnvVarV2, ModuleInstance, ModuleRef, TfOutputs } from "@svc/contracts";
import { LINK_OUTPUTS, TF_KIND_VARS } from "@svc/contracts";
import { AdapterError } from "../common/errors.js";
import { boundedName } from "../common/names.js";
import { fromOut, nameSeed, type Target } from "../common/target.js";
import { MODULE_DIGEST } from "../module-digests.js";

// DRAFT(ai): 도착 Builder v2 공통 조각 (설계 27번 3.1·3.3·3.4·3.6, A1 = 24번 I5).
//   네 Builder(aws·gcp·onprem·azure-mock)가 같이 쓰는 순수 함수만. 네트워크·DB·환경변수 읽기 없음.
//   원칙: IR 에 있는 칸은 도착에 그대로 옮긴다. 못 옮기는 칸은 버리지 않고 v2Blockers 로 막는다. 없는 값은 안 만든다.

type Service = Extract<ComponentV2, { kind: "service" }>;
type Job = Extract<ComponentV2, { kind: "job" }>;
type Postgres = Extract<ComponentV2, { kind: "postgres" }>;
export type WorkloadV2 = Service | Job;

// ── 오류 코드 ──────────────────────────────────────────
// UNSUPPORTED_V2 = 도착이 이 명세를 못 그림 (capability 밖). NEEDS_HUMAN 은 precheck 가 내는 쪽(A3)이라 Builder 는 안 던진다
export const UNSUPPORTED_V2 = "UNSUPPORTED_V2";
export const LINK_OUTPUT_UNKNOWN = "LINK_OUTPUT_UNKNOWN";

// ── 칸 대응표 (3.3 표를 코드로) ─────────────────────────
// render  = 도착 값·변수에 그대로 들어감
// info    = 도착 변수엔 안 들어가지만 버리지 않음(precheck 대조·화면 표시·"출발과 달라짐" 줄)
// block:x = capability x 가 있어야 그림. 없으면 v2Blockers 가 막는다
// DRAFT(ai): 칸마다 분류는 A1 기준. A5(cache·…)·A8(grants·permissions)에서 늘어남. 시험이 Zod 모양 키 ⊂ 이 표를 확인한다
export type FieldRule = "render" | "info" | `block:${string}`;
const WORKLOAD_FIELDS: Record<string, FieldRule> = {
  namespace: "info",            // 도착 네임스페이스는 app-<앱> (H-A5 기본). 출발 이름은 "출발과 달라짐" 줄로
  image: "render", command: "render", args: "render", resources: "render", env: "render", envFrom: "render",
  configs: "render", secretMounts: "render", serviceAccount: "render", securityContext: "render",
  sidecars: "render", initContainers: "render", volumes: "render",
};
export const V2_FIELD_COVERAGE: Record<string, Record<string, FieldRule>> = {
  service: { ...WORKLOAD_FIELDS, runtime: "render", origin: "info", ports: "render", endpoints: "render",
    probes: "render", replicas: "render", scale: "render" },
  job: { ...WORKLOAD_FIELDS, schedule: "render", timeZone: "render", concurrencyPolicy: "render", suspend: "render",
    backoffLimit: "render", activeDeadlineSec: "render", restartPolicy: "render" },
  postgres: { majorVersion: "render", storageGb: "render", storageMaxGb: "render", compute: "render", ha: "render",
    readReplicas: "render", parameters: "render",
    logicalReplication: "info",  // 도착은 CDC 때문에 항상 켬 (플랫폼 요구)
    databases: "info", extensions: "info" },   // precheck 대조만 (도착 지원 여부, 3.1)
  cache: { engine: "block:kind.cache", version: "block:kind.cache", memoryMiB: "block:kind.cache", clusterMode: "block:kind.cache",
    shards: "block:kind.cache", tls: "block:kind.cache", auth: "block:kind.cache", ha: "block:kind.cache" },
  objectStore: { versioning: "block:kind.objectStore", public: "block:kind.objectStore", sizeGb: "block:kind.objectStore",
    lifecycle: "block:kind.objectStore", cors: "block:kind.objectStore" },
  queue: { model: "block:kind.queue", ordered: "block:kind.queue", retentionSec: "block:kind.queue",
    ackTimeoutSec: "block:kind.queue", deadLetter: "block:kind.queue" },
  // 최상위
  spec: { schemaVersion: "info", app: "render", availability: "info", components: "render", links: "render",
    entry: "render", posture: "render", security: "info" },
};

// k8s 출발 서비스·잡이 쓰는 렌더 capability. Builder 가 이걸 capabilities() 에 넣는다
export const K8S_RENDER_CAPS: Capability[] = [
  "runtime.k8s", "kind.service", "kind.job",
  "link.connect", "link.call", "link.external", "link.unmapped",
  "entry.ingress", "posture.allowAll", "posture.component", "image.registry",
];

// ── 이 명세가 도착에 요구하는 capability ────────────────
export function requirementsV2(spec: AppSpecV2): Capability[] {
  const r = new Set<Capability>();
  const pg = spec.components.filter((c): c is Postgres => c.kind === "postgres");
  for (const c of spec.components) {
    switch (c.kind) {
      case "service": r.add(`runtime.${c.props.runtime}`); r.add("kind.service"); break;
      // DRAFT(ai): job 엔 runtime 칸이 없다 → k8s CronJob(Helm)으로 그림.
      //   JOBBUILD DRAFT(ai): 관리형 서비스가 있는 앱의 잡은 관리형 예약 잡(ECS 예약 작업·Cloud Run job, root job_json)으로 그림 → 관리형 capability
      case "job": r.add(managedServicesOf(spec).length ? "runtime.managedContainer" : "runtime.k8s"); r.add("kind.job"); break;
      case "postgres": r.add(c.props.majorVersion ? `kind.postgres.${c.props.majorVersion}` : "kind.postgres"); break;
      case "cache": r.add(`kind.cache.${c.props.engine}`); if (c.props.clusterMode) r.add("kind.cache.cluster"); break;   // TA12: 클러스터 모드는 별도 capability
      case "queue": {
        r.add("kind.queue");
        // VTA12 DRAFT(ai): 순서 보장(ordered) 큐와 DLQ 의 순서 보장이 다르면 별도 capability. SQS 는 FIFO 큐의 DLQ 도 FIFO(표준은 표준)여야 해서
        //   AWS 는 apply 에서야 실패한다 → AWS 는 이 capability 를 안 가져 계획 전에 막는다. Pub/Sub 은 DLQ 가 토픽이라 상관없음
        const dl = c.props.deadLetter?.to;
        const t = dl ? spec.components.find((x) => x.id === dl) : undefined;
        if (t?.kind === "queue" && (c.props.ordered === true) !== (t.props.ordered === true)) r.add("kind.queue.dlqMixedOrder");
        break;
      }
      default: r.add(`kind.${c.kind}`);
    }
    if (c.kind === "service" || c.kind === "job") {
      for (const img of [c.props.image, ...(c.props.sidecars ?? []).filter((s) => !s.injected).map((s) => s.image), ...(c.props.initContainers ?? []).map((s) => s.image)])
        r.add(`image.${img.source}`);
    }
  }
  if (pg.length > 1) r.add("kind.postgres.multi");   // 지금 복제 코드는 DB 하나 (3.2)
  for (const l of spec.links) {
    r.add(typeof l.to === "string" ? `link.${l.intent}` : "unmapped" in l.to ? "link.unmapped" : "link.external");
    if (l.grants?.length) r.add("render.grants");    // A8: Builder 가 target/grants.ts 로 그림. 대응표 밖은 grantBlockers 가 막음
  }
  if (spec.entry) {
    r.add("entry.ingress");
    if (spec.entry.hosts.some((h) => h.tls?.mode === "passthrough")) r.add("entry.tlsPassthrough");
  }
  if (spec.posture.permissions.length) r.add("posture.permissions");   // A8: 위와 같음 (3.3)
  for (const n of spec.posture.network) {
    if (n.scope === "namespace") r.add(n.default === "allow-all" ? "posture.allowAll" : "posture.networkPolicy");
    else r.add("posture.component");
  }
  return [...r].sort();
}

// capability 밖(unsupported) + 사람이 봐야 하는 것(needsHuman). precheck(A3)가 그대로 쓴다
export function v2Blockers(spec: AppSpecV2, caps: Capability[]): { unsupported: string[]; needsHuman: string[] } {
  const have = new Set(caps);
  // I9: 관리형 컨테이너(ECS·Cloud Run) 렌더는 아직 없음 → 막고, 어느 서비스인지·어떻게 풀지 적는다 (모듈은 kinds/service-ecs·service-cloudrun 카탈로그만)
  // RUNTIMEMAP v2: VM 출발은 VM 도착이 기본 (재현성). VM 모듈이 없는 도착(온프레·Azure 가짜)은 막고, 컨테이너로 옮기려면 runtime 을 바꾸고 승인 (opt-in)
  const hint = (x: Capability) => x === "runtime.managedContainer"
    ? ` (서비스 ${spec.components.filter((c) => c.kind === "service" && c.props.runtime === "managedContainer").map((c) => c.id).sort().join(",")} — 명세 검토에서 runtime 을 k8s 로 바꾸면 EKS·GKE·k3s 로 옮김, 실행 방식 바뀜 승인)`
    : x === "runtime.vm"
      ? ` (서비스 ${spec.components.filter((c) => c.kind === "service" && c.props.runtime === "vm").map((c) => c.id).sort().join(",")} — 이 도착엔 VM 모듈이 없음. 컨테이너로 옮기려면 명세 검토에서 runtime 을 k8s 로 바꿈 (실행 방식 바뀜 승인). 온프레 VM 은 TODO(human))`
      : "";
  const unsupported = requirementsV2(spec).filter((x) => !have.has(x)).map((x) => `도착 렌더 미지원: ${x}${hint(x)}`);
  if (have.has("runtime.managedContainer")) unsupported.push(...managedBlockers(spec));
  if (have.has("runtime.vm")) unsupported.push(...vmBlockers(spec));
  const needsHuman: string[] = [];
  for (const c of spec.components) {
    if (c.kind === "postgres") {
      if (c.props.majorVersion === null) unsupported.push(`도착 렌더 미지원: postgres ${c.id} majorVersion 모름`);
      if (c.props.storageGb === null) unsupported.push(`도착 렌더 미지원: postgres ${c.id} storageGb 모름`);
    }
    if (c.kind === "service" || c.kind === "job") {
      for (const img of [c.props.image, ...(c.props.sidecars ?? []).filter((s) => !s.injected).map((s) => s.image), ...(c.props.initContainers ?? []).map((s) => s.image)])
        if (img.source === "registry" && !img.digest) unsupported.push(`도착 렌더 미지원: ${c.id} 이미지 digest 없음 (${img.repository})`);
    }
  }
  // TA12: 데이터 자원. DLQ 는 같은 명세 안의 다른 queue(model=queue)여야 하고, 대상은 또 DLQ 를 갖지 않는다 (루트·모듈 검증과 같은 규칙 — 계획 전에 거부)
  for (const c of spec.components) {
    if (c.kind === "queue" && c.props.deadLetter) {
      const to = c.props.deadLetter.to;
      if (to === undefined) needsHuman.push(`${c.id}: 죽은 편지 큐(DLQ)를 출발에서 찾지 못함 → 도착에 DLQ 를 만들지 사람이 정함`);
      else {
        const t = spec.components.find((x) => x.id === to);
        if (!t || t.kind !== "queue" || t.id === c.id) unsupported.push(`도착 렌더 미지원: ${c.id} DLQ 대상 ${to} 이(가) 같은 명세의 다른 queue 가 아님`);
        else if (t.props.model !== "queue") unsupported.push(`도착 렌더 미지원: ${c.id} DLQ 대상 ${to} 은 topic 이라 DLQ 가 될 수 없음`);
        else if (t.props.deadLetter?.to !== undefined) unsupported.push(`도착 렌더 미지원: ${c.id} DLQ 대상 ${to} 이(가) 또 DLQ 를 가짐 (한 단계만)`);
      }
    }
    if (c.kind === "objectStore" && c.props.public === null) needsHuman.push(`${c.id}: 버킷 공개 여부를 못 읽음 → 도착은 비공개로 만들고 사람이 정함`);
    // VTA12: 출발이 공개 버킷이어도 도착 모듈은 공개 차단을 늘 켠다(TODO(human) 보안 승인). 조용히 비공개로 바꾸지 않게 사람에게 알림
    // VTA12fix DRAFT(ai): 출발 캐시에 AUTH 가 켜져 있는데 도착이 AUTH 를 못 옮기면(capability kind.cache.auth 없음 = 지금 AWS) 조용히 AUTH 없이
    //   그리지 않고 사람에게 묻는다. 명세 검토에서 auth 를 false 로 바꾸면(= AUTH 없이 네트워크로만 막는 것에 동의) 통과.
    //   AWS 에 auth token 을 만들지(state 에 남는 비밀)는 infra/modules/aws/kinds/cache TODO(human) — Claude 가 정하지 않음
    if (c.kind === "cache" && c.props.auth === true && !have.has("kind.cache.auth"))
      needsHuman.push(`${c.id}: 출발 캐시는 AUTH 를 씀 → 이 도착은 AUTH 를 아직 못 옮겨 네트워크(보안 그룹)로만 막힘. 그대로 갈지(auth=false) 사람이 정함`);
    if (c.kind === "objectStore" && c.props.public === true) needsHuman.push(`${c.id}: 출발은 공개 버킷 → 도착은 비공개로 만들고 공개 여부는 사람이 정함`);
  }
  for (const n of spec.posture.network) {
    if (n.scope !== "component") continue;
    if (n.ingress === "unknown") { needsHuman.push(`${n.subject}: 출발 방화벽을 못 읽음 → 의존성만 열지 사람이 정함`); continue; }
    const other = n.ingress.filter((i) => !isCidr(i.from)).map((i) => i.from);
    if (other.length) needsHuman.push(`${n.subject}: 출발 방화벽 원본 ${other.sort().join(",")} 은 도착에 그대로 못 옮김`);
    if (n.public === true && !n.ingress.some((i) => isCidr(i.from)))
      needsHuman.push(`${n.subject}: 출발은 공개였는데 허용 주소(CIDR)가 없음 → 도착은 비공개로 두고 사람이 정함`);
  }
  return { unsupported: [...new Set(unsupported)].sort(), needsHuman: needsHuman.sort() };
}

// TA13: 관리형 컨테이너(ECS·Cloud Run) 도착이 못 그리는 것. capability 가 있는 도착(aws·gcp)에서만 본다
//   DRAFT(ai): 한 명세 안에 k8s 워크로드와 섞으면 막는다 (신원·비밀·Helm 값이 두 갈래가 됨). 칸 대응은 kinds/service-* 가 받는 것만
export const managedServicesOf = (spec: AppSpecV2): Service[] =>
  workloadsOf(spec).filter((w): w is Service => w.kind === "service" && w.props.runtime === "managedContainer");
// JOBBUILD DRAFT(ai): 관리형 서비스가 있는 앱의 잡 = 관리형 예약 잡 (k8s CronJob 이 아니라 root job_json → kinds/job).
//   이유: IR job 엔 runtime 칸이 없고, 관리형 앱엔 k8s 클러스터·Helm 값이 없어 CronJob 으로 그릴 곳이 없다. 같은 앱의 서비스와 같은 실행 방식이 재현성 기본.
//   잡만 있는 앱(관리형 서비스 0)은 지금처럼 k8s CronJob — 관리형인지 알 근거가 없음 (TODO(human): IR job 에 runtime 칸을 둘지)
export const managedJobsOf = (spec: AppSpecV2): Job[] =>
  managedServicesOf(spec).length ? workloadsOf(spec).filter((w): w is Job => w.kind === "job") : [];
/** 루트 job_json 검사와 같은 cron 규칙 (계획 전에 막음): 5필드, 요일 칸 간격(/) 금지, 날짜·요일 칸 동시 지정 금지 */
export function managedCronProblem(schedule: string): string | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return "schedule 은 cron 5필드여야 함";
  if (f[4]!.includes("/")) return "요일 칸의 간격(/) 은 아직 못 옮김";
  if (!["*", "?"].includes(f[2]!) && !["*", "?"].includes(f[4]!)) return "날짜 칸과 요일 칸을 둘 다 정한 schedule 은 못 옮김";
  return null;
}
/** 관리형 잡 env 한 줄이 job_json 으로 갈 수 있나: 값 · fromLink · 자리표시 하나뿐인 template (루트가 한 덩어리 자리표시만 풂) */
export const managedJobEnvOk = (e: EnvVarV2): boolean =>
  "value" in e || "fromLink" in e || ("template" in e && new RegExp(`^${TEMPLATE.source}$`).test(e.template));
export function managedBlockers(spec: AppSpecV2): string[] {
  const m = managedServicesOf(spec);
  if (!m.length) return [];
  const out: string[] = [];
  // JOBBUILD: 잡은 관리형 예약 잡으로 그리므로 "섞임"이 아니다 (아래에서 잡 칸만 따로 봄)
  const k8s = workloadsOf(spec).filter((w) => !(w.kind === "service" && w.props.runtime === "managedContainer") && w.kind !== "job").map((w) => w.id);
  if (k8s.length) out.push(`도착 렌더 미지원: 관리형 서비스(${m.map((x) => x.id).join(",")})와 k8s 워크로드(${k8s.join(",")})를 한 명세에 섞음 — 명세 검토에서 runtime 을 한쪽으로 맞춤`);
  for (const w of m) {
    const p = w.props;
    const bad: string[] = [];
    if ((p.sidecars ?? []).some((s) => !s.injected)) bad.push("sidecars");
    if (p.initContainers?.length) bad.push("initContainers");
    if (p.volumes?.length) bad.push("volumes");
    if (p.configs?.length) bad.push("configs");
    if (p.secretMounts?.length) bad.push("secretMounts");
    if (p.envFrom?.length) bad.push("envFrom");
    if (p.env.some((e) => "fromConfig" in e || "fromField" in e || "fromResource" in e)) bad.push("env(fromConfig·fromField·fromResource)");
    if ((p.ports?.length ?? 0) > 1) bad.push("ports 2개 이상");
    if (bad.length) out.push(`도착 렌더 미지원: ${w.id} 관리형 서비스에 ${bad.join("·")} 못 그림`);
  }
  // JOBBUILD: 관리형 예약 잡이 못 그리는 칸 (kinds/job 이 받는 것 = JobTfVars). 비밀 칸이 없음(모듈 TODO(human)) → fromSecret 은 막음
  for (const j of managedJobsOf(spec)) {
    const p = j.props;
    const bad: string[] = [];
    if (p.sidecars?.length) bad.push("sidecars");
    if (p.initContainers?.length) bad.push("initContainers");
    if (p.volumes?.length) bad.push("volumes");
    if (p.configs?.length) bad.push("configs");
    if (p.secretMounts?.length) bad.push("secretMounts");
    if (p.envFrom?.length) bad.push("envFrom");
    if (p.env.some((e) => "fromSecret" in e)) bad.push("env(fromSecret: 관리형 잡 모듈에 비밀 칸 없음)");
    if (p.env.some((e) => !("fromSecret" in e) && !managedJobEnvOk(e))) bad.push("env(fromConfig·fromField·fromResource·조각 여러 개 template)");
    const cron = managedCronProblem(p.schedule);
    if (cron) bad.push(`schedule(${cron})`);
    if (bad.length) out.push(`도착 렌더 미지원: ${j.id} 관리형 예약 잡에 ${bad.join("·")} 못 그림`);
  }
  // A8 권한 대응(grants.ts)은 k8s 신원 모듈에 붙는다 → 관리형 역할엔 아직 없음
  if (spec.links.some((l) => l.grants?.length && [...m, ...managedJobsOf(spec)].some((x) => x.id === l.from)) || spec.posture.permissions.length)
    out.push("도착 렌더 미지원: 관리형 서비스의 권한 대응(grants·posture.permissions)은 아직 없음");
  return out;
}

// RUNTIMEMAP v2: VM(EC2·GCE) 도착이 못 그리는 것. capability(runtime.vm)가 있는 도착(aws·gcp)에서만 본다
//   DRAFT(ai): 한 명세 안에서 VM 서비스는 다른 실행 방식(k8s·관리형·잡)과 섞지 않는다 (신원·비밀·Helm 값이 갈라짐). 칸 대응은 kinds/vm 이 받는 것만
//   VM 주소는 apply 뒤에야 알아서 다른 서비스를 가리키는 env·링크는 막는다 (TODO(human): 사설 DNS 이름 규칙)
export const vmServicesOf = (spec: AppSpecV2): Service[] =>
  workloadsOf(spec).filter((w): w is Service => w.kind === "service" && w.props.runtime === "vm");
export function vmBlockers(spec: AppSpecV2): string[] {
  const m = vmServicesOf(spec);
  if (!m.length) return [];
  const out: string[] = [];
  const other = workloadsOf(spec).filter((w) => !(w.kind === "service" && w.props.runtime === "vm")).map((w) => w.id);
  if (other.length) out.push(`도착 렌더 미지원: VM 서비스(${m.map((x) => x.id).join(",")})와 다른 실행 방식 워크로드(${other.join(",")})를 한 명세에 섞음 — 명세 검토에서 runtime 을 한쪽으로 맞춤`);
  const ids = new Set(spec.components.filter((c) => c.kind === "service" || c.kind === "job").map((c) => c.id));
  for (const w of m) {
    const p = w.props;
    const bad: string[] = [];
    if ((p.sidecars ?? []).some((s) => !s.injected)) bad.push("sidecars");
    if (p.initContainers?.length) bad.push("initContainers");
    if (p.volumes?.length) bad.push("volumes");
    if (p.configs?.length) bad.push("configs");
    if (p.secretMounts?.length) bad.push("secretMounts");
    if (p.envFrom?.length) bad.push("envFrom");
    if (p.env.some((e) => "fromConfig" in e || "fromField" in e || "fromResource" in e)) bad.push("env(fromConfig·fromField·fromResource)");
    if ((p.ports?.length ?? 0) > 1) bad.push("ports 2개 이상");
    const toService = p.env.some((e) => ("fromLink" in e && ids.has(e.fromLink.to)) || ("template" in e && [...e.template.matchAll(TEMPLATE)].some((x) => ids.has(x[1]!))));
    if (toService) bad.push("다른 서비스 주소를 가리키는 env");
    if (bad.length) out.push(`도착 렌더 미지원: ${w.id} VM 서비스에 ${bad.join("·")} 못 그림`);
  }
  if (spec.links.some((l) => typeof l.to === "string" && ids.has(l.to) && m.some((x) => x.id === l.from)))
    out.push("도착 렌더 미지원: VM 서비스 사이 링크는 아직 (VM 주소가 apply 뒤에 정해짐, TODO(human))");
  // A8 권한 대응(grants.ts)은 k8s 신원 모듈에 붙는다 → VM 역할엔 아직 없음
  if (spec.links.some((l) => l.grants?.length && m.some((x) => x.id === l.from)) || spec.posture.permissions.length)
    out.push("도착 렌더 미지원: VM 서비스의 권한 대응(grants·posture.permissions)은 아직 없음");
  return out;
}

export function assertRenderable(spec: AppSpecV2, caps: Capability[]): void {
  const { unsupported } = v2Blockers(spec, caps);
  if (unsupported.length) throw new AdapterError(UNSUPPORTED_V2, unsupported.join("; "));
}

const isCidr = (s: string) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s);

// ── 이름 ───────────────────────────────────────────────
// v1 이름 함수(dbInstanceName 등)는 AppSpec 을 받지만 app.name 만 본다 → 같은 해시가 나오게 그대로 넘긴다
export const asV1Name = (spec: AppSpecV2) => ({ app: { name: spec.app.name } }) as unknown as AppSpec;

// 신원 = 출발 serviceAccount 하나. 같은 SA 를 쓰던 서비스·잡은 도착에서도 한 신원을 같이 쓴다 (재현성)
// id = 그 SA 를 쓰는 워크로드 id 중 가장 앞선 것 (for_each 키가 IR id 여야 해서)
export interface IdentityPlan { id: string; serviceAccount: string; workloads: string[] }
export function identitiesOf(spec: AppSpecV2): IdentityPlan[] {
  const by = new Map<string, string[]>();
  for (const w of workloadsOf(spec)) by.set(w.props.serviceAccount, [...(by.get(w.props.serviceAccount) ?? []), w.id]);
  return [...by.entries()].map(([sa, ids]) => ({ id: [...ids].sort()[0]!, serviceAccount: sa, workloads: [...ids].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export const identityOf = (spec: AppSpecV2, workloadId: string) =>
  identitiesOf(spec).find((i) => i.workloads.includes(workloadId))!;

// 실행 역할·SA 이름. IR id 를 그대로 쓰면 길이·접두어 규칙(app-, aws 64 / gcp 30)에 걸림 → boundedName
// DRAFT(ai): id 가 앱 이름과 같으면 v1 과 같은 seed → v1 이름 그대로 (upconvert 판이 v1 과 같은 역할 이름)
export function identityName(spec: AppSpecV2, id: string, t: Target, max: number): string {
  const seed = id === spec.app.name ? [nameSeed(t), spec.app.name] : [nameSeed(t), spec.app.name, id];
  return boundedName({ prefix: "app-", app: id, seed, max });
}

export const workloadsOf = (spec: AppSpecV2): WorkloadV2[] =>
  spec.components.filter((c): c is WorkloadV2 => c.kind === "service" || c.kind === "job").sort((a, b) => a.id.localeCompare(b.id));
export const postgresOf = (spec: AppSpecV2): Postgres[] =>
  spec.components.filter((c): c is Postgres => c.kind === "postgres").sort((a, b) => a.id.localeCompare(b.id));

// 워크로드가 쓰는 비밀 이름 (env fromSecret · envFrom secret · secretMounts). 정렬·중복 없음
export function secretNamesOf(w: WorkloadV2): string[] {
  const s = new Set<string>();
  const fromEnv = (env: EnvVarV2[]) => env.forEach((e) => { if ("fromSecret" in e) s.add(e.fromSecret.secret); });
  fromEnv(w.props.env);
  for (const c of [...(w.props.sidecars ?? []), ...(w.props.initContainers ?? [])]) fromEnv(c.env);
  for (const f of w.props.envFrom ?? []) if ("secret" in f) s.add(f.secret);
  for (const m of w.props.secretMounts ?? []) s.add(m.secret);
  return [...s].sort();
}

// connect 의존성으로 이 postgres 에 붙는 신원 id (루트가 이 신원에 DB 비밀 읽기를 준다)
export function connectIdentities(spec: AppSpecV2, toId: string): string[] {
  const ids = spec.links.filter((l) => l.to === toId && l.intent === "connect").map((l) => identityOf(spec, l.from)?.id).filter((x): x is string => !!x);
  return [...new Set(ids)].sort();
}

// 출발 DB 방화벽(mirror) 중 CIDR 만 도착 peer 로. 나머지(SG id 등)는 v2Blockers.needsHuman
export function postureOfComponent(spec: AppSpecV2, id: string): { public: boolean; cidrs: string[] } {
  const n = spec.posture.network.find((x) => x.scope === "component" && x.subject === id);
  if (!n || n.scope !== "component" || n.ingress === "unknown") return { public: false, cidrs: [] };
  const cidrs = [...new Set(n.ingress.map((i) => i.from).filter(isCidr))].sort();
  // 공개였어도 허용 주소가 없으면 공개로 열지 않는다 (사람이 정함)
  return { public: n.public === true && cidrs.length > 0, cidrs };
}

// ── 모듈 참조 ──────────────────────────────────────────
// STUB: root·kinds 지문은 TA2 가 module-digest MODULES 에 넣으면 생김. 그전엔 Target.moduleSha 또는 "content-pending"
export const refV2 = (key: string, t: Target): ModuleRef =>
  ({ path: `infra/modules/${key}`, gitSha: t.moduleSha ?? (MODULE_DIGEST as Record<string, string>)[key] ?? "content-pending" });

// 항목을 계약(tf-kinds.ts)으로 검사해서 *_json 문자열로. 정렬은 부르는 쪽이 id 순으로 넘긴다
export function kindJson<K extends keyof typeof TF_KIND_VARS>(kind: K, items: unknown[]): string {
  return JSON.stringify(items.map((x) => TF_KIND_VARS[kind].parse(x)));
}

export function instancesOf(provider: "aws" | "gcp" | "onprem", rows: Array<{ kind: ModuleInstance["kind"]; id: string }>): ModuleInstance[] {
  // TA13: service 는 프로바이더마다 모듈이 다름 (ECS · Cloud Run)
  const dir: Record<string, string> = { objectStore: "object-store", service: provider === "gcp" ? "service-cloudrun" : "service-ecs" };
  return rows.map((r) => ({ kind: r.kind, id: r.id, module: `${provider}/kinds/${dir[r.kind] ?? r.kind}` }))
    .sort((a, b) => a.module.localeCompare(b.module) || a.id.localeCompare(b.id));
}

// ── 의존성 출력 값 ─────────────────────────────────────
// 서비스끼리 주소 = 도착 k8s Service DNS (순수 계산). 데이터 리소스 = Terraform link_outputs 자리표시 또는 Builder 가 아는 값
export interface LinkCtx {
  namespace: string;
  out: TfOutputs;
  // 클라우드 Builder 는 비움 → <tf-output:link.<id>.<출력>>. 온프레는 CNPG 주소를 직접 계산
  local?: (c: ComponentV2, output: string) => string | undefined;
}
export function serviceAddress(c: Service, ns: string): { host: string; port: number | null } {
  const ep = [...(c.props.endpoints ?? [])].sort((a, b) => a.name.localeCompare(b.name))[0];
  const port = ep?.ports[0]?.port ?? c.props.ports?.[0]?.port ?? null;
  return { host: `${ep?.name ?? c.id}.${ns}.svc`, port };
}
export function linkTarget(spec: AppSpecV2, to: string, output: string): ComponentV2 {
  const c = spec.components.find((x) => x.id === to);
  if (!c) throw new AdapterError(LINK_OUTPUT_UNKNOWN, `의존성 대상 없음: ${to}`);
  const allowed = (LINK_OUTPUTS as Record<string, readonly string[]>)[c.kind] ?? [];
  if (!allowed.includes(output)) throw new AdapterError(LINK_OUTPUT_UNKNOWN, `${c.kind} 에 없는 출력: ${to}.${output}`);
  return c;
}
export function linkValue(spec: AppSpecV2, to: string, output: string, ctx: LinkCtx): string {
  const c = linkTarget(spec, to, output);
  if (c.kind === "service") {
    const a = serviceAddress(c, ctx.namespace);
    if (output === "host") return a.host;
    if (output === "port") return a.port === null ? "" : String(a.port);
    // DRAFT(ai): url = http://<host>[:port] (80 이면 포트 생략)
    return a.port === null || a.port === 80 ? `http://${a.host}` : `http://${a.host}:${a.port}`;
  }
  return ctx.local?.(c, output) ?? fromOut(ctx.out, `link.${to}.${output}`);
}
export const TEMPLATE = /\$\{([a-z][a-z0-9-]{0,39})\.(host|port|url|name|user)\}/g;
export const renderTemplate = (spec: AppSpecV2, tpl: string, ctx: LinkCtx) =>
  tpl.replace(TEMPLATE, (_m, id: string, o: string) => linkValue(spec, id, o, ctx));

// IR env 한 줄 → k8s env 한 줄. 순서는 IR 그대로($(VAR) 참조 순서가 뜻을 가짐)
export function k8sEnv(spec: AppSpecV2, e: EnvVarV2, ctx: LinkCtx): Record<string, unknown> {
  if ("value" in e) return { name: e.name, value: e.value };
  if ("template" in e) return { name: e.name, value: renderTemplate(spec, e.template, ctx) };
  if ("fromLink" in e) return { name: e.name, value: linkValue(spec, e.fromLink.to, e.fromLink.output, ctx) };
  if ("fromSecret" in e) return { name: e.name, valueFrom: { secretKeyRef: { name: e.fromSecret.secret, key: e.fromSecret.key } } };
  if ("fromConfig" in e) return { name: e.name, valueFrom: { configMapKeyRef: { name: e.fromConfig.config, key: e.fromConfig.key } } };
  if ("fromField" in e) return { name: e.name, valueFrom: { fieldRef: { fieldPath: e.fromField } } };
  return { name: e.name, valueFrom: { resourceFieldRef: { resource: e.fromResource } } };
}

// ── k8s 값 조각 ────────────────────────────────────────
type Amount = { cpuMilli: number | null; memMiB: number | null } | undefined;
const qty = (a: Amount) => {
  const o: Record<string, string> = {};
  if (a?.cpuMilli != null) o.cpu = `${a.cpuMilli}m`;
  if (a?.memMiB != null) o.memory = `${a.memMiB}Mi`;
  return Object.keys(o).length ? o : undefined;
};
// 없는 값은 키 자체를 안 둔다 (requests·limits 지어내지 않음)
export function k8sResources(r: { request?: Amount; limit?: Amount }): Record<string, unknown> | undefined {
  const o: Record<string, unknown> = {};
  const req = qty(r.request), lim = qty(r.limit);
  if (req) o.requests = req;
  if (lim) o.limits = lim;
  return Object.keys(o).length ? o : undefined;
}
// undefined 칸은 지운다 (차트 `with` 가 없는 키를 안 그림. JSON 지문도 키가 안 남음)
export const compact = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

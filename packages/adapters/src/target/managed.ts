import { ServiceEnvVar, ServiceSecretVar, type AppSpecV2, type EnvVarV2, type HelmValues, type TfOutputs } from "@svc/contracts";
import { appNamespace } from "../common/base.js";
import { boundedName } from "../common/names.js";
import { fromOut, nameSeed, migrationSeed, tenantOf, type Target } from "../common/target.js";
import { AdapterError } from "../common/errors.js";
import { compact, identityOf, kindJson, linkTarget, managedCronProblem, subOutput, managedJobEnvOk, managedJobsOf, managedServicesOf, TEMPLATE, UNSUPPORTED_V2 } from "./shared.js";

// TA13 DRAFT(ai): 관리형 컨테이너(ECS Fargate · Cloud Run) 도착 = Terraform 이 서비스까지 만든다 (Helm 값 없음).
//   Builder 는 순수 함수: IR 서비스 → ServiceTfVars(service_json). DB·서비스 주소는 같은 apply 안에서 생겨서 env 를 조각으로 넘기고 루트가 합친다.
//   못 그리는 칸은 shared.managedBlockers 가 계획 전에 막는다 (여기 오면 그릴 수 있는 명세).

export type ManagedProvider = "aws" | "gcp";
type Service = ReturnType<typeof managedServicesOf>[number];

const srcOf = (img: { repository: string; digest: string | null }) => `${img.repository}@${img.digest}`;
const lit = (s: string) => ({ lit: s, ref: null });
const ref = (spec: AppSpecV2, to: string, out: string) => { linkTarget(spec, to, out); return { lit: null, ref: `${to}.${out}` }; };

// IR env 한 줄 → 조각. 비밀은 따로 (값이 아니라 저장소 이름)
export function envParts(spec: AppSpecV2, e: EnvVarV2): Array<{ lit: string | null; ref: string | null }> {
  if ("value" in e) return [lit(e.value)];
  if ("fromLink" in e) return [{ ...ref(spec, e.fromLink.to, e.fromLink.output), ref: `${e.fromLink.to}.${subOutput(e.fromLink.output, e.fromLink.subscription)}` }];
  if ("template" in e) {
    const parts: Array<{ lit: string | null; ref: string | null }> = [];
    let at = 0;
    for (const m of e.template.matchAll(TEMPLATE)) {
      if (m.index! > at) parts.push(lit(e.template.slice(at, m.index)));
      parts.push(ref(spec, m[1]!, m[2]!));
      at = m.index! + m[0].length;
    }
    if (at < e.template.length) parts.push(lit(e.template.slice(at)));
    return parts;
  }
  throw new Error(`관리형 env 에 못 그리는 줄: ${e.name}`);   // managedBlockers 가 먼저 막음
}

// 도착 비밀 저장소 이름. aws = k8s 신원 모듈과 같은 platform/<tenant>/<app>/<비밀> (JSON 키는 valueFrom 이 고름)
//   gcp = Cloud Run 은 JSON 키를 못 고름 → 키마다 secret 하나 app-<앱>-<비밀>-<키>
// TODO(human): 값 복사 단계가 gcp 관리형이면 키별 secret 에 써야 함 (지금 복사 코드는 k8s 규칙 app-<앱>-<비밀> 하나)
export function managedSecretName(p: ManagedProvider, spec: AppSpecV2, t: Target, secret: string, key: string): string {
  if (p === "aws") return `platform/${tenantOf(t)}/${spec.app.name}/${secret}`;
  const s = (x: string) => x.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `app-${spec.app.name}-${s(secret)}-${s(key)}`;
}

export const entryTargets = (spec: AppSpecV2) => new Set((spec.entry?.hosts ?? []).flatMap((h) => h.routes.flatMap((r) => r.backends.map((b) => b.to))));

export function managedServiceVars(p: ManagedProvider, spec: AppSpecV2, t: Target, imageRef: (src: string) => string) {
  const pub = entryTargets(spec);
  return managedServicesOf(spec).map((w: Service) => {
    const x = w.props;
    const seed = [nameSeed(t), spec.app.name, w.id, "svc", ...migrationSeed(t)];
    const env = x.env.filter((e) => !("fromSecret" in e)).map((e) => ({ name: e.name, parts: envParts(spec, e) }));
    const secrets = x.env.flatMap((e) => "fromSecret" in e
      ? [{ name: e.name, secret: managedSecretName(p, spec, t, e.fromSecret.secret, e.fromSecret.key), key: e.fromSecret.key }] : []);
    const cpu = x.resources.request?.cpuMilli ?? x.resources.limit?.cpuMilli ?? null;
    const mem = x.resources.request?.memMiB ?? x.resources.limit?.memMiB ?? null;
    const ready = x.probes?.readiness;
    return {
      id: w.id,
      // ECS 이름은 길어도 되지만 Cloud Run 은 49자·소문자 시작 → 둘 다 같은 규칙 (이전마다 해시)
      name: boundedName({ app: w.id, seed, max: p === "gcp" ? 49 : 63 }),
      role_name: boundedName({ prefix: "app-", app: w.id, seed, max: p === "gcp" ? 30 : 61 }),
      image: imageRef(srcOf(x.image)),
      command_json: x.command ? JSON.stringify(x.command) : null,
      args_json: x.args ? JSON.stringify(x.args) : null,
      cpu_milli: cpu,
      mem_mib: mem,
      port: x.ports?.[0]?.port ?? null,
      min_instances: x.replicas.min,
      max_instances: x.replicas.max,
      target_cpu_pct: x.scale?.targetCpuPct ?? null,
      health_path: ready && ready.type === "http" ? ready.path : null,
      env_json: JSON.stringify(ServiceEnvVar.array().parse(env)),
      secrets_json: JSON.stringify(ServiceSecretVar.array().parse(secrets)),
      identity: identityOf(spec, w.id).id,
      public: pub.has(w.id),
    };
  });
}
export const managedServiceJson = (p: ManagedProvider, spec: AppSpecV2, t: Target, imageRef: (src: string) => string) =>
  kindJson("service", managedServiceVars(p, spec, t, imageRef));

// JOBBUILD DRAFT(ai): 관리형 예약 잡 → JobTfVars(job_json). kinds/job (aws = EventBridge Scheduler → ECS RunTask, gcp = Cloud Scheduler → Cloud Run job)
//   env 는 [{name, value}] — 값 그대로, 의존성은 <tf-output:link.<id>.<출력>> 한 덩어리 (루트 job_env_rows 가 같은 apply 값으로 풂).
//   비밀·조각 여러 개 template 은 managedBlockers 가 먼저 막음 (여기 오면 그릴 수 있는 잡)
const placeholder = (spec: AppSpecV2, to: string, out: string) => { linkTarget(spec, to, out); return `<tf-output:link.${to}.${out}>`; };
function jobEnvValue(spec: AppSpecV2, e: EnvVarV2): string {
  if (!managedJobEnvOk(e)) throw new AdapterError(UNSUPPORTED_V2, `관리형 잡 env 에 못 그리는 줄: ${e.name}`);
  if ("value" in e) return e.value;
  if ("fromLink" in e) { placeholder(spec, e.fromLink.to, e.fromLink.output); return `<tf-output:link.${e.fromLink.to}.${subOutput(e.fromLink.output, e.fromLink.subscription)}>`; }
  const m = new RegExp(`^${TEMPLATE.source}$`).exec((e as { template: string }).template)!;
  return placeholder(spec, m[1]!, m[2]!);
}
export function managedJobVars(p: ManagedProvider, spec: AppSpecV2, t: Target, imageRef: (src: string) => string) {
  const jobs = managedJobsOf(spec);
  const seen = new Set<string>();
  for (const id of spec.components.map((c) => c.id)) {
    if (seen.has(id)) throw new AdapterError(UNSUPPORTED_V2, `관리형 잡: IR id ${id} 가 겹침 (IR id 는 전역 유일)`);
    seen.add(id);
  }
  return jobs.map((j) => {
    const x = j.props;
    const cron = managedCronProblem(x.schedule);
    if (cron) throw new AdapterError(UNSUPPORTED_V2, `관리형 잡 ${j.id}: ${cron}`);
    return {
      id: j.id,
      // aws: 역할 이름 = 이름 + -task·-ex·-sch (64자) → 58자 / gcp: SA·스케줄러 이름 파생 → 49자 소문자
      name: boundedName({ prefix: "app-", app: j.id, seed: [nameSeed(t), spec.app.name, j.id, "job", ...migrationSeed(t)], max: p === "gcp" ? 49 : 58 }),
      schedule: x.schedule.trim().split(/\s+/).join(" "),
      time_zone: x.timeZone ?? null,
      concurrency_policy: x.concurrencyPolicy ?? null,
      suspend: x.suspend ?? null,
      backoff_limit: x.backoffLimit ?? null,
      active_deadline_sec: x.activeDeadlineSec ?? null,
      restart_policy: x.restartPolicy ?? null,
      image: imageRef(srcOf(x.image)),
      command_json: x.command ? JSON.stringify(x.command) : null,
      args_json: x.args ? JSON.stringify(x.args) : null,
      cpu_milli: x.resources.request?.cpuMilli ?? x.resources.limit?.cpuMilli ?? null,
      mem_mib: x.resources.request?.memMiB ?? x.resources.limit?.memMiB ?? null,
      env_json: JSON.stringify(x.env.map((e) => ({ name: e.name, value: jobEnvValue(spec, e) }))),
      identity: identityOf(spec, j.id).id,
    };
  });
}
export const managedJobJson = (p: ManagedProvider, spec: AppSpecV2, t: Target, imageRef: (src: string) => string) =>
  kindJson("job", managedJobVars(p, spec, t, imageRef));

// 관리형 도착은 Helm 으로 띄울 워크로드가 없다 → 값은 화면·대조용 (서비스 이름은 루트 출력 service_names)
export function managedWorkloadValues(p: ManagedProvider, spec: AppSpecV2, out: TfOutputs, t: Target, postgres: Array<Record<string, unknown>>): HelmValues {
  const warnings = [`관리형 도착(${p === "aws" ? "ECS" : "Cloud Run"}): 서비스는 Terraform 이 띄움 → Helm 워크로드 없음`];
  if (spec.entry) warnings.push("입구(entry) → 관리형 서비스 연결은 아직 (TODO(human): ALB·서버리스 NEG·Cloudflare 원점)");
  return compact({
    irVersion: "2",
    app: { name: spec.app.name },
    namespace: appNamespace({ app: spec.app } as never),
    labels: { "managed-by": "platform", tenant: tenantOf(t) },
    workloads: [],
    managed: managedServicesOf(spec).map((w) => ({
      id: w.id, runtime: p === "aws" ? "ecs" : "cloudrun", service: fromOut(out, `service.${w.id}.name`),
    })),
    // JOBBUILD: 관리형 예약 잡 (이름은 루트 출력 job_names)
    ...(managedJobsOf(spec).length ? { managedJobs: managedJobsOf(spec).map((j) => ({ id: j.id, runtime: p === "aws" ? "ecs-scheduled" : "cloudrun-job", schedule: j.props.schedule })) } : {}),
    postgres,
    warnings: warnings.sort(),
  });
}

// precheck 경고 (막지는 않음): 출발과 달라지는 것. 사람이 승인 화면에서 본다
export function managedWarnings(p: ManagedProvider, spec: AppSpecV2): string[] {
  const m = managedServicesOf(spec);
  if (!m.length) return [];
  const out: string[] = [];
  if (spec.entry) out.push("입구(entry) → 관리형 서비스 연결은 아직 없음: 서비스는 뜨지만 외부 트래픽 전환 전에 원점 연결이 필요");
  // TF4-3: ECS 모듈(aws/kinds/service-ecs)은 health_path·public 칸을 받기만 하고 안 쓴다 → 조용히 버리지 않고 알림 (Cloud Run 은 씀)
  if (p === "aws") for (const w of m) {
    const r = w.props.probes?.readiness;
    if (r?.type === "http") out.push(`${w.id}: 준비 확인 http ${r.path} 는 ECS 모듈이 아직 안 씀 (상태 검사 없이 뜸)`);
    if (entryTargets(spec).has(w.id)) out.push(`${w.id}: 입구 대상(public)이지만 ECS 모듈이 공개 설정을 아직 안 씀`);
  }
  if (p === "gcp") {
    // Cloud Run 주소는 https://<서비스>-<번호>.<리전>.run.app:443. 출발 env 가 host 에 스킴·포트를 붙였으면(http://${x.host}:8080) 앱이 못 부름
    const ids = new Set(m.map((x) => x.id));
    for (const w of m) for (const e of w.props.env) {
      const hit = "template" in e ? [...e.template.matchAll(TEMPLATE)].some((x) => ids.has(x[1]!) && x[2] !== "url")
        : "fromLink" in e ? ids.has(e.fromLink.to) && e.fromLink.output !== "url" : false;
      if (hit) out.push(`${w.id}.${e.name}: Cloud Run 서비스 주소는 https·443 — 출발의 host·port 조합이 그대로면 못 부를 수 있음 (url 로 바꿀지 확인)`);
    }
  }
  return out.sort();
}

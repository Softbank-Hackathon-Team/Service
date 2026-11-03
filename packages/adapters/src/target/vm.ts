import { ServiceEnvVar, ServiceSecretVar, type AppSpecV2, type HelmValues, type TfOutputs } from "@svc/contracts";
import { appNamespace } from "../common/base.js";
import { boundedName } from "../common/names.js";
import { fromOut, nameSeed, tenantOf, type Target } from "../common/target.js";
import { compact, identityOf, kindJson, vmServicesOf } from "./shared.js";
import { entryTargets, envParts, managedSecretName, type ManagedProvider } from "./managed.js";

// RUNTIMEMAP v2 DRAFT(ai): VM 도착(EC2 · GCE) = Terraform 이 VM 까지 만들고 앱은 user-data / startup-script 가 설치한다 (Helm 값 없음).
//   출발이 VM 이면 도착도 VM 이 기본 (Jeong 결정: 최대한 출발 환경과 같게). Builder 는 순수 함수: IR 서비스 → VmTfVars(vm_json).
//   managed.ts 와 같은 규칙(이름 해시·env 조각·비밀 저장소 이름)을 쓴다. 못 그리는 칸은 shared.vmBlockers 가 계획 전에 막는다.
// STUB: 자동 확장(ASG·MIG)·로드밸런서는 없음 → 대수 = replicas.min 고정 (replicas.max·scale 은 도착에 안 옮겨짐: vmWarnings 가 알림)

type Service = ReturnType<typeof vmServicesOf>[number];
const srcOf = (img: { repository: string; digest: string | null }) => `${img.repository}@${img.digest}`;

export function vmServiceVars(p: ManagedProvider, spec: AppSpecV2, t: Target, imageRef: (src: string) => string) {
  const pub = entryTargets(spec);
  return vmServicesOf(spec).map((w: Service) => {
    const x = w.props;
    const seed = [nameSeed(t), spec.app.name, w.id, "vm"];
    const env = x.env.filter((e) => !("fromSecret" in e)).map((e) => ({ name: e.name, parts: envParts(spec, e) }));
    const secrets = x.env.flatMap((e) => "fromSecret" in e
      ? [{ name: e.name, secret: managedSecretName(p, spec, t, e.fromSecret.secret, e.fromSecret.key), key: e.fromSecret.key }] : []);
    const cpu = x.resources.request?.cpuMilli ?? x.resources.limit?.cpuMilli ?? null;
    const mem = x.resources.request?.memMiB ?? x.resources.limit?.memMiB ?? null;
    const ready = x.probes?.readiness;
    return {
      id: w.id,
      // GCE 이름은 소문자 시작 49자 (뒤에 -번호) → 둘 다 같은 규칙 (이전마다 해시)
      name: boundedName({ app: w.id, seed, max: p === "gcp" ? 49 : 63 }),
      role_name: boundedName({ prefix: "app-", app: w.id, seed, max: p === "gcp" ? 30 : 61 }),
      image: imageRef(srcOf(x.image)),
      command_json: x.command ? JSON.stringify(x.command) : null,
      args_json: x.args ? JSON.stringify(x.args) : null,
      cpu_milli: cpu,
      mem_mib: mem,
      port: x.ports?.[0]?.port ?? null,
      instances: Math.max(1, x.replicas.min),
      health_path: ready && ready.type === "http" ? ready.path : null,
      env_json: JSON.stringify(ServiceEnvVar.array().parse(env)),
      secrets_json: JSON.stringify(ServiceSecretVar.array().parse(secrets)),
      identity: identityOf(spec, w.id).id,
      public: pub.has(w.id),
    };
  });
}
export const vmServiceJson = (p: ManagedProvider, spec: AppSpecV2, t: Target, imageRef: (src: string) => string) =>
  kindJson("vm", vmServiceVars(p, spec, t, imageRef));

// VM 도착은 Helm 으로 띄울 워크로드가 없다 → 값은 화면·대조용 (인스턴스는 루트 출력 vm_instance_ids·vm_instance_names)
export function vmWorkloadValues(p: ManagedProvider, spec: AppSpecV2, out: TfOutputs, t: Target, postgres: Array<Record<string, unknown>>): HelmValues {
  const warnings = [`VM 도착(${p === "aws" ? "EC2" : "GCE"}): 앱은 user-data·startup-script 가 설치함 → Helm 워크로드 없음`];
  if (spec.entry) warnings.push("입구(entry) → VM 연결은 아직 (TODO(human): 로드밸런서·Cloudflare 원점)");
  return compact({
    irVersion: "2",
    app: { name: spec.app.name },
    namespace: appNamespace({ app: spec.app } as never),
    labels: { "managed-by": "platform", tenant: tenantOf(t) },
    workloads: [],
    vm: vmServicesOf(spec).map((w) => ({
      id: w.id, runtime: p === "aws" ? "ec2" : "gce", instances: Math.max(1, w.props.replicas.min), machine: fromOut(out, `vm.${w.id}.machine`),
    })),
    postgres,
    warnings: warnings.sort(),
  });
}

// precheck 경고 (막지는 않음): 출발과 달라지는 것. 사람이 승인 화면에서 본다
export function vmWarnings(p: ManagedProvider, spec: AppSpecV2): string[] {
  const m = vmServicesOf(spec);
  if (!m.length) return [];
  const out: string[] = [];
  if (spec.entry) out.push("입구(entry) → VM 연결은 아직 없음: VM 은 뜨지만 외부 트래픽 전환 전에 앞단(로드밸런서·원점) 연결이 필요");
  for (const w of m) {
    if (w.props.replicas.max > w.props.replicas.min || w.props.scale)
      out.push(`${w.id}: 자동 확장(ASG·MIG)은 아직 없음 → VM ${Math.max(1, w.props.replicas.min)}대 고정 (출발 최대 ${w.props.replicas.max}대)`);
    if (w.props.image.source === "registry" && !/@sha256:[0-9a-f]{64}$/.test(srcOf(w.props.image))) out.push(`${w.id}: 이미지 digest 가 없음`);
  }
  out.push(`앱 설치는 컨테이너 이미지를 VM 위에서 docker 로 돌림 (${p === "aws" ? "user-data" : "startup-script"}). 출발 VM 의 설치 방식(패키지·스크립트)은 안 읽음`);
  return out.sort();
}

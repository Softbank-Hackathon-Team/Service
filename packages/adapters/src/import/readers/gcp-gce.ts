import { arr, get, runJson, str, type CliDeps } from "../../common/cli.js";
import { VM_RAW_KIND, type RawVmGroup, type RawVmIngress } from "../raw-vm.js";
import { gceSize, groupNameOf, secretLooking } from "./vm-common.js";
import type { VmRead } from "./aws-ec2.js";

// DRAFT(ai) VMIMPORT: GCP GCE 출발 읽기. gcloud compute instances list(+ 라벨 필터) · compute firewall-rules list. 읽기만, 인자 배열.
//   안 읽는 것: metadata(startup-script 에 비밀이 있을 수 있음)·SSH 키·IP 값·라벨 값(묶는 이름 빼고)
//   묶음 고르기: IMPORT_GCP_VM_LABEL="key=value" · IMPORT_GCP_VM_GROUP_LABEL (묶는 라벨 이름, 기본 인스턴스 이름에서 끝 번호 뗌)
type Obj = Record<string, unknown>;
export const GCE_OBSERVE_PERMISSIONS = ["compute.instances.list", "compute.firewalls.list"];
const LABEL_RE = /^([a-z][a-z0-9_-]{0,62})=([a-z0-9_-]{0,63})$/;
const tail = (u: unknown) => String(u ?? "").split("/").pop() ?? "";
// 비밀 같은 서비스 계정 이메일 방지: 기본 계산 계정(<번호>-compute@developer…)은 프로젝트 번호를 담으므로 "default" 로, 그 밖엔 @ 앞 이름
const saName = (email: string | null) => (!email ? null : /^\d+-compute@developer\.gserviceaccount\.com$/.test(email) ? "default" : email.split("@")[0]!);

export async function readGce(d: CliDeps, project: string, env: NodeJS.ProcessEnv): Promise<VmRead> {
  const p = ["--project", project, "--format", "json"];
  const notes: string[] = [];
  const want = env.IMPORT_GCP_VM_LABEL?.trim();
  const filt = want ? LABEL_RE.exec(want) : null;
  if (want && !filt) notes.push(`IMPORT_GCP_VM_LABEL "${want.slice(0, 40)}" 모양이 key=value 아님 → 필터 없이 읽음`);
  const all = arr(await runJson(d, "gcloud", ["compute", "instances", "list", ...(filt ? ["--filter", `labels.${filt[1]}=${filt[2]}`] : []), ...p]));
  const insts = all.filter((i) => i.status === "RUNNING");
  if (!insts.length) return { items: [], counts: {}, notes };
  const groupLabel = env.IMPORT_GCP_VM_GROUP_LABEL?.trim() || undefined;

  let rules: Obj[] = [];
  let rulesKnown = true;
  try { rules = arr(await runJson(d, "gcloud", ["compute", "firewall-rules", "list", ...p])); }
  catch (e) { rulesKnown = false; notes.push(`방화벽 규칙 못 읽음: ${(e as Error).message.slice(0, 160)}`); }

  const groups = new Map<string, Obj[]>();
  let droppedLabels = 0;
  for (const i of insts) {
    const labels = (i.labels && typeof i.labels === "object" ? i.labels : {}) as Record<string, string>;
    droppedLabels += Object.keys(labels).filter((k) => k !== groupLabel).length;
    const raw = groupLabel ? labels[groupLabel] : String(i.name);
    const name = raw && !secretLooking(raw) ? groupNameOf(raw, !!groupLabel) : String(i.name);
    groups.set(name, [...(groups.get(name) ?? []), i]);
  }
  if (droppedLabels) notes.push(`VM 라벨 ${droppedLabels}개는 가져오지 않음 (묶는 이름 말고는 안 읽음)`);

  const items: Obj[] = [];
  for (const [name, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const typesIn = [...new Set(list.map((i) => tail(i.machineType)))].sort();
    const sizes = typesIn.map(gceSize).filter((x): x is { cpuMilli: number; memMiB: number } => !!x).sort((a, b) => b.cpuMilli - a.cpuMilli || b.memMiB - a.memMiB);
    const tags = new Set(list.flatMap((i) => (get(i, "tags", "items") as string[] | undefined) ?? []));
    const ingress: RawVmIngress[] = [];
    for (const f of rules) {
      if (f.disabled === true || f.direction !== "INGRESS") continue;
      const target = (f.targetTags as string[] | undefined) ?? [];
      if (target.length && !target.some((t) => tags.has(t))) continue;
      const srcs = [...((f.sourceRanges as string[] | undefined) ?? []), ...((f.sourceTags as string[] | undefined) ?? []).map((t) => `tag:${t}`)].sort();
      for (const a of arr(f.allowed)) {
        const proto = String(a.IPProtocol);
        if (proto === "all") { ingress.push({ protocol: "tcp", fromPort: 0, toPort: 65535, sources: srcs }); continue; }
        if (proto !== "tcp" && proto !== "udp") continue;
        const ports = (a.ports as string[] | undefined) ?? ["0-65535"];
        for (const pr of ports) { const [lo, hi] = pr.split("-"); ingress.push({ protocol: proto, fromPort: Number(lo), toPort: Number(hi ?? lo), sources: srcs }); }
      }
    }
    const ids = [...new Set(list.map((i) => saName(str(get(i, "serviceAccounts", "0", "email")) ?? str((arr(i.serviceAccounts)[0] ?? {}).email))).filter((x): x is string => !!x))].sort();
    if (ids.length > 1) notes.push(`${name}: 서비스 계정이 ${ids.length}종 → 첫째(${ids[0]}) 만 씀`);
    const raw: RawVmGroup = {
      kind: VM_RAW_KIND, product: "gce", name, scope: project ? "project" : null, count: list.length,
      instances: list.map((i) => String(i.name)).sort(), instanceTypes: typesIn,
      zones: [...new Set(list.map((i) => tail(i.zone)).filter(Boolean))].sort(),
      cpuMilli: sizes[0]?.cpuMilli ?? null, memMiB: sizes[0]?.memMiB ?? null, identity: ids[0] ?? null,
      hasPublicIp: list.some((i) => arr(i.networkInterfaces).some((n) => arr(n.accessConfigs).some((a) => !!str(a.natIP)))),
      ingress: rulesKnown ? ingress : null,
    };
    items.push(raw as unknown as Obj);
  }
  return { items, counts: { [VM_RAW_KIND]: items.length }, notes };
}

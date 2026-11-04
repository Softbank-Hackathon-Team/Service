import { arr, get, runJson, str, type CliDeps } from "../common/cli.js";
import type { RawGcpIamBinding } from "../import/mappers/gcp-iam-grants.js";

// WI-1: GKE 출발 앱 신원(Workload Identity)의 IAM 바인딩 읽기 (get-iam-policy 만. 바꾸는 명령 없음). AWS 는 aws-iam.ts
//   신원 찾기: KSA 주석 iam.gke.io/gcp-service-account (discover/k8s.ts 가 gcpServiceAccount 칸으로 넘김)
//   바인딩: 프로젝트 정책 + 이 가져오기에서 읽은 버킷·토픽 정책. 폴더·조직 상속 정책은 안 읽는다 (STUB)
// 관찰 역할 권한: resourcemanager.projects.getIamPolicy(이미 있음), storage.buckets.getIamPolicy, pubsub.topics.getIamPolicy
// STUB: 폴더·조직에서 상속된 역할, 거부 정책(deny policy)은 출발 실제 범위를 바꾼다. 지금은 프로젝트·자원 정책만 읽는다

type Obj = Record<string, unknown>;
export interface GkeIdentity { namespace: string; serviceAccount: string; gsa: string }

/** 앱 워크로드가 쓰는 KSA 중 GSA 주석이 있는 것 */
export function gkeIdentities(items: Obj[]): GkeIdentity[] {
  const gsaOf = new Map<string, string>();
  for (const i of items) if (i.kind === "k8s.serviceAccount") {
    const g = str(i.gcpServiceAccount);
    if (g) gsaOf.set(`${str(get(i, "metadata", "namespace")) ?? ""}/${str(get(i, "metadata", "name")) ?? ""}`, g);
  }
  const out = new Map<string, GkeIdentity>();
  for (const i of items) {
    const pod = i.kind === "k8s.deployment" ? get(i, "spec", "template", "spec")
      : i.kind === "k8s.cronjob" ? get(i, "spec", "jobTemplate", "spec", "template", "spec") : undefined;
    const ns = str(get(i, "metadata", "namespace"));
    if (!pod || !ns) continue;
    const sa = str(get(pod, "serviceAccountName")) ?? "default";
    const gsa = gsaOf.get(`${ns}/${sa}`);
    if (gsa) out.set(`${ns}/${sa}`, { namespace: ns, serviceAccount: sa, gsa });
  }
  return [...out.values()].sort((a, b) => `${a.namespace}/${a.serviceAccount}`.localeCompare(`${b.namespace}/${b.serviceAccount}`));
}

const bindingsOf = (policy: unknown, member: string, resource: string) =>
  arr(get(policy, "bindings")).filter((b) => (Array.isArray(b.members) ? b.members : []).includes(member))
    .map((b) => ({ role: String(b.role), resource, ...(b.condition && typeof b.condition === "object" ? { condition: b.condition as Record<string, unknown> } : {}) }));

/**
 * @param project GCP 프로젝트
 * @param data    이 가져오기가 읽은 데이터 원본 (gcs.bucket·pubsub.topic) → 그 자원 정책도 읽는다
 */
export async function readGcpIam(d: CliDeps, project: string, ids: GkeIdentity[], data: Obj[], notes: string[]): Promise<RawGcpIamBinding[]> {
  if (!ids.length) return [];
  const p = ["--project", project, "--format", "json"];
  const policies: Array<{ resource: string; policy: unknown }> = [];
  const read = async (label: string, resource: string, get: () => Promise<unknown>) => {
    try { policies.push({ resource, policy: await get() }); }
    catch (e) { notes.push(`${label} IAM 정책 못 읽음: ${(e as Error).message.slice(0, 160)}`); }
  };
  await read("프로젝트", `//cloudresourcemanager.googleapis.com/projects/${project}`, () => runJson(d, "gcloud", ["projects", "get-iam-policy", project, "--format", "json"]));
  for (const b of data.filter((x) => x.kind === "gcs.bucket").map((x) => str(x.name)).filter((x): x is string => !!x).sort())
    await read(`버킷 ${b}`, `//storage.googleapis.com/projects/_/buckets/${b}`, () => runJson(d, "gcloud", ["storage", "buckets", "get-iam-policy", `gs://${b}`, "--format", "json"]));
  for (const t of data.filter((x) => x.kind === "pubsub.topic").map((x) => str(x.name)).filter((x): x is string => !!x).sort())
    await read(`토픽 ${t.split("/").pop()}`, `//pubsub.googleapis.com/${t}`, () => runJson(d, "gcloud", ["pubsub", "topics", "get-iam-policy", t, ...p]));
  return ids.map((i) => ({
    kind: "gcp.iamBinding" as const, gsa: i.gsa, serviceAccount: i.serviceAccount, namespace: i.namespace,
    bindings: policies.flatMap((x) => bindingsOf(x.policy, `serviceAccount:${i.gsa}`, x.resource)),
  }));
}

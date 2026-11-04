import { parse, stringify } from "yaml";
import { RehearsalInput, type AppSpecV2, type FidelityMatrix, type HelmValues, type RehearsalTarget, type TfOutputs } from "@svc/contracts";
import { adapterFor, dbIdentityFor, flattenTfOutputsV2, targetBuilderFor } from "@svc/adapters";
import { appNamespace, envFacts, fillPlaceholders, type DeployInput, type RenderedBundle } from "../gitops/index.js";
import type { MirrorImage } from "./image-mirror.js";
import { substitute, type K8sDoc, type ManagedDb, type Manifest } from "./substitute.js";
import { workerFidelity } from "./fidelity.js";

// 리허설 입력(RehearsalInput) 만들기. 순수 함수만 (렌더 결과·값·명세 → 입력). 상태 기계는 gate.ts


/** 렌더 결과 글자 → 문서. manifests/*.yaml 은 파일 하나에 문서 하나 (gitops tools/lib.mjs writeBundle) */
export function parseManifests(r: RenderedBundle): Manifest[] {
  return r.manifests.map((m) => ({ path: m.path, doc: parse(m.yaml) as K8sDoc }));
}

/** 렌더 주소 → 고객 원본 짝 (image-mirror 입력). 명세 image.repository@digest 를 어댑터 imageRef 로 렌더 주소로 만들어 맞춘다.
 *  명세에 없는 주소(차트가 넣은 이미지)는 그 주소를 원본으로 둔다 → 다이제스트가 없으면 복사가 not_by_digest 로 막는다 */
export function imagePairs(i: DeployInput, refs: readonly string[]): MirrorImage[] {
  const bySrc = new Map<string, string>();
  if (i.spec) {
    const t = { envId: i.target.envId, provider: i.target.provider, region: i.target.region, migrationId: i.plan.migrationId };
    const facts = { tf: flattenTfOutputsV2(i.tfOutputs), env: envFacts(i) };
    for (const c of i.spec.components) {
      if (c.kind !== "service" && c.kind !== "job") continue;
      const p = c.props as { image: { repository: string; digest: string | null }; sidecars?: Array<{ image: { repository: string; digest: string | null } }>; initContainers?: Array<{ image: { repository: string; digest: string | null } }> };
      for (const img of [p.image, ...(p.sidecars ?? []).map((x) => x.image), ...(p.initContainers ?? []).map((x) => x.image)]) {
        if (!img?.digest) continue;
        const src = `${img.repository}@${img.digest}`;
        const ref = fillPlaceholders({ ref: adapterFor(i.target.provider).imageRef(src, t) }, facts).values.ref as string;
        bySrc.set(ref, src);
      }
    }
  }
  return refs.map((ref) => ({ ref, source: bySrc.get(ref) ?? ref }));
}

/** 클라우드 관리형 DB (값 postgres[] mode external, 채운 실제 주소) → 샌드박스 Postgres 로 바꿀 짝 */
export function managedDbsOf(values: HelmValues, spec: AppSpecV2 | null): ManagedDb[] {
  const pg = (values.postgres as Array<{ id: string; mode: string; host?: string; secretName?: string }> | undefined) ?? [];
  return pg.filter((p) => p.mode === "external" && p.host && p.secretName).map((p) => {
    const c = spec?.components.find((x) => x.id === p.id && x.kind === "postgres");
    const who = c && spec && c.kind === "postgres" ? dbIdentityFor(spec, c) : { db: "app", user: "app" };
    const major = c?.kind === "postgres" ? c.props.majorVersion : null;
    // DRAFT(ai): 명세에 메이저 판이 없으면 16 (플랫폼 기본 Postgres 판)
    return { id: p.id, host: p.host!, majorVersion: major ?? "16", database: who.db, owner: who.user, secretName: p.secretName! };
  });
}

// DRAFT(ai): 도착 쿠버네티스 마이너는 apply 출력 cluster_version 이 있을 때만 안다. 없으면 vCluster 기본 1.35 (설계 7장 질문 10)
const DEFAULT_K8S_MINOR = "1.35";
export function k8sMinorOf(tf: TfOutputs | undefined): { value: string; known: boolean } {
  const m = /^v?(1\.\d{2})(?:\.|$)/.exec(String((tf as Record<string, unknown> | undefined)?.cluster_version ?? ""));
  return m ? { value: m[1]!, known: true } : { value: DEFAULT_K8S_MINOR, known: false };
}

/** 도착 네임스페이스 한도 = 계획 때 Terraform 값(namespace_json)의 quota. 없거나 못 읽으면 null (한도 없음) */
export function targetQuotaOf(i: DeployInput): RehearsalInput["targetQuota"] {
  if (!i.spec) return null;
  try {
    const t = { envId: i.target.envId, provider: i.target.provider, region: i.target.region, migrationId: i.plan.migrationId };
    const raw = targetBuilderFor(i.target.provider).toTerraformV2(i.spec, t).vars?.namespace_json;
    const ns = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ quota_cpu_m?: number | null; quota_memory_mi?: number | null }> | undefined;
    const q = ns?.[0];
    if (!q || (q.quota_cpu_m == null && q.quota_memory_mi == null)) return null;
    return { limitsCpuM: q.quota_cpu_m ?? null, limitsMemoryMi: q.quota_memory_mi ?? null };
  } catch { return null; }
}

// k3s = Kyverno platform-namespace-pod-security (infra/permissions/onprem-kyverno-platform.yaml). 어긋나면 rehearsal-pod-security 시험이 깨진다
export const TARGET_POD_SECURITY: Record<RehearsalTarget, RehearsalInput["targetPodSecurity"]> = {
  "aws-eks": "privileged", "gcp-gke": "privileged", "onprem-k3s": "baseline",
};

export interface BuildArgs {
  target: RehearsalTarget; i: DeployInput; values: HelmValues; rendered: RenderedBundle; docs: Manifest[];
  images: RehearsalInput["images"]; mirrored: boolean; runBudgetSec: number;
}
export function buildRehearsalInput(a: BuildArgs): RehearsalInput {
  const ns = appNamespace({ tenant: "", app: a.i.spec!.app.name, env: a.target });
  const managedDbs = managedDbsOf(a.values, a.i.spec);
  const sub = substitute(a.docs, { namespace: ns, images: new Map(a.images.map((x) => [x.ref, x.sandboxRef])), managedDbs, seed: a.rendered.bundleSha256 });
  const k8sMinor = k8sMinorOf(a.i.tfOutputs);
  const targetQuota = targetQuotaOf(a.i);
  const fidelity: FidelityMatrix = workerFidelity({ target: a.target, bundleSha256: a.rendered.bundleSha256, refs: sub.refs, present: sub.present,
    databases: sub.databases.length, k8sMinor, imagesMirrored: a.mirrored, quota: targetQuota });
  return RehearsalInput.parse({
    version: 1, target: a.target, app: a.i.spec!.app.name, namespace: ns, bundleSha256: a.rendered.bundleSha256, k8sMinor: k8sMinor.value,
    original: a.rendered.manifests, apply: sub.apply.map((m) => ({ path: m.path, yaml: stringify(m.doc) })),
    images: a.images, imagesMirrored: a.mirrored, runBudgetSec: a.runBudgetSec, databases: sub.databases, targetPodSecurity: TARGET_POD_SECURITY[a.target], targetQuota, edges: sub.edges, fidelity,
  });
}

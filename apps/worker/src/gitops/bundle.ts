import type { HelmValues, PlanDoc, Provider } from "@svc/contracts";

// gitops 레포 계약 (notes/skeleton/parallel/N/gitops/WORKER-CONTRACT.md) 중 순수 함수 부분.
// 파일·git·helm을 만지는 부분은 repo.ts에 있다.

export type GitopsEnv = "aws-eks" | "gcp-gke" | "onprem-k3s" | "azure-mock";
export type Delivery = "argocd-push" | "agent-pull" | "mock";

export const ENV_DIR: Record<Provider, GitopsEnv> = {
  aws: "aws-eks", gcp: "gcp-gke", onprem: "onprem-k3s", azure_mock: "azure-mock",
};
export const DELIVERY: Record<GitopsEnv, Delivery> = {
  "aws-eks": "argocd-push", "gcp-gke": "argocd-push", "onprem-k3s": "agent-pull", "azure-mock": "mock",
};

// DRAFT(ai): 회사 폴더 이름 = "t-" + 회사 uuid 앞 8글자. 회사가 수천 곳이 되면 겹칠 수 있다
export function tenantSlug(tenantId: string): string {
  return "t-" + tenantId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export interface BundleRef { tenant: string; app: string; env: GitopsEnv }
export const bundlePath = (b: BundleRef) => `tenants/${b.tenant}/apps/${b.app}/${b.env}`;
// Z66: 앱 구역 = app-<앱>. Terraform 어댑터 4개(k8s_namespace)·EKS Pod Identity·GKE WIF·GCP IAM 조건(app- 접두어)과 같은 이름.
// 회사 구분은 회사 전용 클러스터(<회사>-<env>)와 울타리 목적지 이름이 한다
export const APP_NS_PREFIX = "app-";
export const appNamespace = (b: BundleRef) => `${APP_NS_PREFIX}${b.app}`;
export const clusterName = (b: BundleRef) => (DELIVERY[b.env] === "agent-pull" ? null : `${b.tenant}-${b.env}`);
export const argoAppName = (b: BundleRef) => `${b.tenant}-${b.app}-${b.env}`;

// 자리표시 채우기. 승인 때 만든 값의 "<tf-output:키>", "<env:키>"만 바꾼다. 어댑터는 다시 부르지 않는다
// TA3: 키에 . 과 - 도 받는다 (v2 link.<IR id>.<출력>, 예: link.shop-db.host). 예전 키([A-Za-z0-9_]+)는 그대로 맞는다
const PH = /<(tf-output|env):([A-Za-z0-9_.-]+)>/g;
export interface FillFacts { tf: Record<string, string>; env: Record<string, string | undefined> }

export function fillPlaceholders(values: HelmValues, f: FillFacts): { values: HelmValues; missing: string[] } {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(PH, (m, kind: string, key: string) => {
        const got = kind === "tf-output" ? f.tf[key] : f.env[key];
        if (got === undefined || got === "") { missing.add(m); return m; }
        return got;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { values: walk(values) as HelmValues, missing: [...missing].sort() };
}

export function approvedWeights(plan: PlanDoc): number[] {
  return plan.steps.find((s) => s.id === "shift")?.weights ?? [];
}

// 트래픽 기록 자리. 배포 직후는 0 (아직 안 나눔)
export function withTraffic(values: HelmValues, weights: number[], weightPct = 0): HelmValues {
  return { ...values, traffic: weights.length ? { role: "target", weightPct, approvedSteps: weights } : null };
}

export interface PlanFile {
  schema: "platform-gitops/plan@1";
  tenant: string; app: string; env: GitopsEnv;
  migrationId: string; planId: string; planHash: string; adapterVersion: string;
  chart: { path: "charts/app"; version: string };
  target: { delivery: Delivery; cluster: string | null; namespace: string };
  approvedWeights: number[];
  bundleSha256: string;
}

export function planFile(b: BundleRef, plan: PlanDoc, chartVersion: string): PlanFile {
  return {
    schema: "platform-gitops/plan@1",
    tenant: b.tenant, app: b.app, env: b.env,
    migrationId: plan.migrationId, planId: plan.planId, planHash: plan.planHash,
    adapterVersion: plan.adapterVersion,
    chart: { path: "charts/app", version: chartVersion },
    target: { delivery: DELIVERY[b.env], cluster: clusterName(b), namespace: appNamespace(b) },
    approvedWeights: approvedWeights(plan),
    bundleSha256: "",
  };
}

export function commitMessage(kind: "deploy" | "traffic" | "cleanup", b: BundleRef, p: PlanFile, title: string): string {
  return `${kind}(${b.tenant}/${b.app}/${b.env}): ${title}\n\n` +
    `Plan-Id: ${p.planId}\nMigration-Id: ${p.migrationId}\nBundle-Sha256: ${p.bundleSha256}\n`;
}

// manifests/*.yaml 한 파일에서 "Kind/namespace/name" (렌더 도구가 yaml.stringify로 쓴 모양을 전제)
export function resourceId(yamlText: string): string | null {
  const kind = yamlText.match(/^kind: (\S+)$/m)?.[1];
  const meta = yamlText.match(/^metadata:\n((?: {2}.*\n?)*)/m)?.[1] ?? "";
  const name = meta.match(/^ {2}name: (\S+)$/m)?.[1];
  const ns = meta.match(/^ {2}namespace: (\S+)$/m)?.[1];
  if (!kind || !name) return null;
  return ns ? `${kind}/${ns}/${name}` : `${kind}/${name}`;
}

// 회사 울타리 (tenants/<t>/argocd/appproject.yaml). 처음 배포 때 워커가 만들고, 새 클러스터가 오면 목적지를 더한다.
// JSON으로 쓴다 (JSON은 그대로 YAML)
export function fenceDoc(tenant: string, repoUrl: string, clusters: string[]) {
  return {
    apiVersion: "argoproj.io/v1alpha1", kind: "AppProject",
    metadata: { name: tenant, namespace: "argocd", labels: { tenant } },
    spec: {
      description: `DRAFT(ai): 회사 ${tenant} 울타리. 이 회사 전용 클러스터(${tenant}-<env>)의 ${APP_NS_PREFIX}* 구역에만 넣을 수 있다`,
      sourceRepos: [repoUrl],
      destinations: [...new Set(clusters)].sort().map((name) => ({ name, namespace: `${APP_NS_PREFIX}*` })),
      clusterResourceWhitelist: [],
      namespaceResourceBlacklist: [
        { group: "", kind: "ResourceQuota" }, { group: "", kind: "LimitRange" },
        { group: "networking.k8s.io", kind: "NetworkPolicy" },
        { group: "rbac.authorization.k8s.io", kind: "Role" }, { group: "rbac.authorization.k8s.io", kind: "RoleBinding" },
      ],
    },
  };
}

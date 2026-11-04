// FM-CLD-14: IR 종류 → GCP 도착에서 켜야 할 API. 짝: infra/modules/gcp/root/main.tf locals.required_apis (같은 표, 시험이 맞는지 본다)
//   gcp/root 가 google_project_service 로 켜고, env 층(gcp/env)은 앱 층 전에 필요한 것(container·sqladmin·iam·iamcredentials…)을 켠다
// DRAFT(ai): 종류별 API 는 각 kinds 모듈이 쓰는 google_* 자원 기준
export const GCP_KIND_APIS = {
  postgres: ["sqladmin.googleapis.com", "secretmanager.googleapis.com"],
  identity: ["iam.googleapis.com", "secretmanager.googleapis.com"],
  cache: ["redis.googleapis.com", "secretmanager.googleapis.com"],
  object_store: ["storage.googleapis.com"],
  queue: ["pubsub.googleapis.com"],
  service: ["run.googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com", "compute.googleapis.com"],
  job: ["run.googleapis.com", "cloudscheduler.googleapis.com", "iam.googleapis.com"],
  vm: ["compute.googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com"],
} as const satisfies Record<string, readonly string[]>;
export type GcpApiKind = keyof typeof GCP_KIND_APIS;
// env 층이 켜는 것 (gcp/env google_project_service.apis)
export const GCP_ENV_APIS = ["artifactregistry.googleapis.com", "compute.googleapis.com", "container.googleapis.com", "iam.googleapis.com",
  "iamcredentials.googleapis.com", "secretmanager.googleapis.com", "servicenetworking.googleapis.com", "sqladmin.googleapis.com"] as const;

/** 쓰는 종류 → 필요한 API (정렬, 중복 없음) */
export function gcpRequiredApis(kinds: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const k of kinds) for (const a of (GCP_KIND_APIS as Record<string, readonly string[]>)[k] ?? []) out.add(a);
  return [...out].sort();
}
/** terraform 변수(toTerraformV2 의 vars)에서 종류 고르기: *_json 이 빈 배열이 아니면 그 종류를 씀 */
export function gcpKindsOfVars(vars: Record<string, unknown>): GcpApiKind[] {
  const on = (k: string) => { try { const v = vars[k]; return typeof v === "string" && (JSON.parse(v) as unknown[]).length > 0; } catch { return false; } };
  const m: [string, GcpApiKind][] = [["postgres_json", "postgres"], ["identity_json", "identity"], ["cache_json", "cache"], ["object_store_json", "object_store"],
    ["queue_json", "queue"], ["service_json", "service"], ["job_json", "job"], ["vm_json", "vm"]];
  return m.filter(([k]) => on(k)).map(([, kind]) => kind);
}

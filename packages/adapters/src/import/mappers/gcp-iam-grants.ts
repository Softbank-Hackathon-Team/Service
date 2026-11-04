import type { LinkV2, UnmappedV2 } from "@svc/contracts";
import type { MappedComponent } from "../types.js";
import type { IamGrantsOut, IamLinkAdd, PermissionV2 } from "./iam-grants.js";
import { DATA_RAW_KINDS } from "../raw-data.js";
import { DB_RAW_KINDS } from "../raw-k8s.js";

// WI-1 DRAFT(ai): GKE 출발 앱 신원(Workload Identity: KSA 주석 iam.gke.io/gcp-service-account → GSA)의 IAM 바인딩 → grants 원문 + 기준선.
//   AWS(iam-grants.ts)와 같은 규칙: 근거 = 그 GSA 에 걸린 역할. grants 의 actions = 역할 이름 원문(roles/…), resources = GCP 전체 자원 이름 원문.
//   - 자원 단위 바인딩(버킷·토픽 getIamPolicy)이 IR 자원을 가리키면 그 의존성에 grants (신뢰도 1, 조건 있으면 0.9)
//   - 프로젝트 단위 바인딩은 프로젝트 안 모든 자원 = AWS Resource "*" 와 같다 → 다른 근거로 이미 이어진 의존성에만 grants, 범위는 기준선에도
//   - 대응 표에 없는 역할·IR 밖 자원은 기준선(posture.permissions, mirror)에만. 빼거나 넓히지 않는다
//   순수 함수. 같은 입력 → 같은 출력 (목록 정렬)

/** 원본 항목: discover(gcp-iam.ts) 가 GSA 하나마다 하나 만든다 */
export interface RawGcpIamBinding {
  kind: "gcp.iamBinding";
  gsa: string;                       // <이름>@<프로젝트>.iam.gserviceaccount.com
  serviceAccount: string;            // KSA 이름
  namespace?: string;
  bindings: Array<{ role: string; resource: string; condition?: Record<string, unknown> }>;   // resource = //cloudresourcemanager.googleapis.com/projects/<p> · //storage.googleapis.com/projects/_/buckets/<b> · //pubsub.googleapis.com/projects/<p>/topics/<t>
}
export const GCP_IAM_KIND = "gcp.iamBinding";

type Intent = LinkV2["intent"];
// 역할 → (대상 종류, 의도). 대상 종류가 맞는 자원에만 붙는다
const ROLE_INTENT: Array<[RegExp, "objectStore" | "queue" | "postgres" | "cache", Intent]> = [
  [/^roles\/storage\.(objectViewer|legacyObjectReader|legacyBucketReader)$/, "objectStore", "read"],
  [/^roles\/storage\.(objectCreator|legacyBucketWriter)$/, "objectStore", "write"],
  [/^roles\/storage\.(objectUser|objectAdmin|legacyObjectOwner)$/, "objectStore", "readwrite"],
  [/^roles\/storage\.(admin|legacyBucketOwner)$/, "objectStore", "admin"],
  [/^roles\/pubsub\.publisher$/, "queue", "write"],
  [/^roles\/pubsub\.(subscriber|viewer)$/, "queue", "read"],
  [/^roles\/pubsub\.(editor|admin)$/, "queue", "admin"],
  [/^roles\/cloudsql\.(client|instanceUser|editor|admin)$/, "postgres", "connect"],
  [/^roles\/redis\.(viewer|editor|admin|dbConnectionUser)$/, "cache", "connect"],
];
const PROJECT = /^\/\/cloudresourcemanager\.googleapis\.com\/projects\/[^/]+$/;
const sortStr = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** 자원 이름이 IR 자원을 가리키나 (원본 이름 그대로 비교) */
function pointsAt(resource: string, t: MappedComponent): boolean {
  const n = t.native.name;
  if (t.native.type === DATA_RAW_KINDS.gcs) return resource === `//storage.googleapis.com/projects/_/buckets/${n}`;
  if (t.native.type === DATA_RAW_KINDS.pubsub) return resource === `//pubsub.googleapis.com/${t.native.uid ?? ""}`;
  if (t.native.type === DB_RAW_KINDS.cloudsql) return resource.endsWith(`/instances/${n}`) && resource.startsWith("//sqladmin.googleapis.com/");
  if (t.native.type === DATA_RAW_KINDS.memorystore) return resource === `//redis.googleapis.com/${t.native.uid ?? ""}`;
  return false;
}

export function gcpIamGrants(components: MappedComponent[], raws: RawGcpIamBinding[], hasLink: (from: string, to: string) => boolean): IamGrantsOut {
  const adds: IamLinkAdd[] = [];
  const permissions: PermissionV2[] = [];
  const unmapped: UnmappedV2[] = [];
  const workloads = components.filter((c) => c.kind === "service" || c.kind === "job");
  const targets = components.filter((c) => c.kind === "objectStore" || c.kind === "queue" || c.kind === "postgres" || c.kind === "cache");
  const sorted = [...raws].sort((a, b) => `${a.namespace ?? ""}/${a.serviceAccount}/${a.gsa}`.localeCompare(`${b.namespace ?? ""}/${b.serviceAccount}/${b.gsa}`));
  for (const p of sorted) {
    if (!p.namespace) { unmapped.push({ resource: `gcp.iamBinding:${p.gsa}`, grade: "B", reason: "KSA 네임스페이스를 모름 → 어느 서비스 권한인지 사람이 확인" }); continue; }
    const subs = workloads.filter((w) => w.props.serviceAccount === p.serviceAccount && w.native.namespace === p.namespace);
    if (!subs.length) { unmapped.push({ resource: `gcp.iamBinding:${p.gsa}`, grade: "B", reason: `${p.namespace}/${p.serviceAccount} 를 쓰는 워크로드가 없음 → 이전 대상 밖 신원` }); continue; }
    const source = `gcp-iam:${p.gsa}`;
    const bs = [...p.bindings].sort((a, b) => `${a.resource}\0${a.role}`.localeCompare(`${b.resource}\0${b.role}`));
    for (const s of subs) for (const b of bs) {
      const cond = b.condition && Object.keys(b.condition).length ? b.condition : undefined;
      const rule = ROLE_INTENT.find(([re]) => re.test(b.role));
      const project = PROJECT.test(b.resource);
      const hits = rule ? targets.filter((t) => t.kind === rule[1] && (project ? hasLink(s.id!, t.id!) : pointsAt(b.resource, t))) : [];
      for (const t of hits) {
        const conn = t.kind === "postgres" || t.kind === "cache";
        const why = [
          project && "프로젝트 단위 역할 → 프로젝트 안 같은 종류 자원 전부. 같은 범위는 기준선에도 기록",
          cond && "조건 있음 → 도착도 같은 조건으로 옮겨야 함(검토)",
          conn && "DB·캐시 접속 역할 → 의도는 connect, 크기는 grants 원문으로",
        ].filter((x): x is string => Boolean(x)).join(" / ");
        adds.push({ from: s.id!, to: t.id!, intent: rule![2], source, confidence: cond ? 0.9 : 1, ...(why ? { rationale: why } : {}),
          grant: { effect: "Allow", actions: [b.role], resources: [b.resource], ...(cond ? { conditions: cond } : {}) } });
      }
      // 기준선: 프로젝트 단위·대응 표 밖 역할·IR 밖 자원·조건 있는 바인딩
      if (project || !rule || !hits.length || cond)
        permissions.push({
          subject: s.id!, source, effect: "Allow", actions: [b.role], resources: [b.resource],
          ...(cond ? { conditions: cond } : {}),
          ...(project && hits.length ? { covers: sortStr(hits.map((h) => h.id!)) } : {}),
          mode: "mirror",
          note: project ? "프로젝트 단위 역할 → 도착에서도 같은 범위. 좁히기는 권장안"
            : !rule ? "대응 표에 없는 역할 → 원문 그대로, 도착 권한은 사람이 고름"
            : !hits.length ? "IR 밖 자원 → 대응 자원을 사람이 고름"
            : "조건 있는 바인딩 → 의존성 grants 와 같은 조건을 도착에도",
        });
    }
  }
  const pk = (x: PermissionV2) => `${x.subject}\0${x.source}\0${x.resources.join(",")}\0${x.actions.join(",")}`;
  permissions.sort((a, b) => (pk(a) < pk(b) ? -1 : pk(a) > pk(b) ? 1 : 0));
  return { adds, permissions, unmapped };
}

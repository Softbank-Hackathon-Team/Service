import type { FieldMetaV2, LinkV2 } from "@svc/contracts";
import type { MappedComponent, MetaTuple, RawItem } from "./types.js";
import { majorOf } from "./mappers/rds.js";

// INCL DRAFT(ai): 클러스터 안(k8s 워크로드)으로 띄운 데이터 서비스(MinIO·Redis/Valkey·RabbitMQ·Kafka·Postgres)를 데이터 자원으로 알아본다.
//   워크로드는 그대로 두고(도착 Builder 기본 = 워크로드 그대로), 같은 출발을 가리키는 데이터 자원을 하나 더 만든다 (props.inCluster.workload = 워크로드 id).
//   알아보는 근거와 신뢰도: 이미지 이름(마지막 경로 조각) = 0.9 / 라벨(app.kubernetes.io/name)·잘 알려진 포트 = 0.6 (사람 확인)
//   앱 env 가 그 워크로드 주소를 가리키면(규칙 1b) 이 데이터 자원으로도 의존성을 잇는다. env 글자는 바꾸지 않음(워크로드 주소 그대로)
//   데이터는 따라가지 않는다 → "데이터 복사 필요" 검토 줄 (components.<id>.dataCopy)
// TODO(human): 도착 매핑(출발과 같은 워크로드 / D7 대체물 / XC-1 호환 API)과 데이터 복사 방식은 사람이 정함. 여기서는 정하지 않는다

export type InClusterProduct = "postgres" | "redis" | "valkey" | "minio" | "rabbitmq" | "kafka";
type Kind = "postgres" | "cache" | "objectStore" | "queue";
const KIND_OF: Record<InClusterProduct, Kind> = { postgres: "postgres", redis: "cache", valkey: "cache", minio: "objectStore", rabbitmq: "queue", kafka: "queue" };

// 이미지 마지막 경로 조각 → 종류. 정확히 같은 이름만 (redis-exporter·redis-commander 같은 도구는 아님)
const BY_IMAGE: Record<string, InClusterProduct> = {
  postgres: "postgres", postgresql: "postgres", "postgresql-repmgr": "postgres", postgis: "postgres",
  redis: "redis", "redis-stack-server": "redis", "redis-cluster": "redis",
  valkey: "valkey", "valkey-cluster": "valkey",
  minio: "minio",
  rabbitmq: "rabbitmq",
  kafka: "kafka", "cp-kafka": "kafka", "cp-server": "kafka",
};
// app.kubernetes.io/name 값(헬름 차트 관례) → 종류
const BY_LABEL: Record<string, InClusterProduct> = {
  postgresql: "postgres", postgres: "postgres", redis: "redis", valkey: "valkey", minio: "minio", rabbitmq: "rabbitmq", kafka: "kafka",
};
// 잘 알려진 포트. 9000 하나만으로는 MinIO 로 안 봄(다른 앱도 흔히 씀) → 9000 + 9001(콘솔) 둘 다
const hasPorts = (ports: number[], ...need: number[]) => need.every((p) => ports.includes(p));
const byPorts = (ports: number[]): InClusterProduct | null =>
  hasPorts(ports, 5432) ? "postgres" : hasPorts(ports, 6379) ? "redis" : hasPorts(ports, 5672) ? "rabbitmq" : hasPorts(ports, 9092) ? "kafka"
  : hasPorts(ports, 9000, 9001) ? "minio" : null;

type RawContainer = { image?: string; ports?: Array<{ containerPort?: number }> };
type RawWorkload = RawItem & { metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { template?: { metadata?: { labels?: Record<string, string> }; spec?: { containers?: RawContainer[] } } } };

export interface Detected { product: InClusterProduct; confidence: 0.9 | 0.6; source: string; tag: string | null; why: string }

/** 이미지 참조 → 마지막 경로 조각과 태그 */
const imageParts = (ref: string): { last: string; tag: string | null } => {
  const noDigest = ref.split("@")[0]!;
  const m = /^(.*?)(?::([^/:]+))?$/.exec(noDigest)!;
  return { last: (m[1] ?? "").split("/").pop()!.toLowerCase(), tag: m[2] ?? null };
};

/** k8s 워크로드 원본 하나 → 데이터 서비스면 무엇인지. 주 컨테이너(첫 컨테이너)만 본다 */
export function detectInCluster(raw: RawItem): Detected | null {
  const it = raw as RawWorkload;
  const c0 = it.spec?.template?.spec?.containers?.[0];
  const name = it.metadata?.name ?? "?";
  if (c0?.image) {
    const { last, tag } = imageParts(c0.image);
    const p = BY_IMAGE[last];
    if (p) return { product: p, confidence: 0.9, source: `k8s:${name}.image`, tag, why: `이미지 이름 ${last} → 클러스터 안 ${p}` };
  }
  const labels = { ...(it.metadata?.labels ?? {}), ...(it.spec?.template?.metadata?.labels ?? {}) };
  const lp = BY_LABEL[(labels["app.kubernetes.io/name"] ?? "").toLowerCase()];
  if (lp) return { product: lp, confidence: 0.6, source: `k8s:${name}.labels`, tag: c0?.image ? imageParts(c0.image).tag : null,
    why: `라벨 app.kubernetes.io/name=${labels["app.kubernetes.io/name"]} 로만 추정 (이미지 이름은 다름) → 사람 확인` };
  const ports = (c0?.ports ?? []).map((p) => p.containerPort).filter((x): x is number => typeof x === "number");
  const pp = byPorts(ports);
  if (pp) return { product: pp, confidence: 0.6, source: `k8s:${name}.ports`, tag: null, why: `포트 ${ports.join(",")} 로만 추정 → 사람 확인` };
  return null;
}

/** 워크로드 매퍼 결과 + 알아본 것 → 데이터 자원 (id 는 파이프라인이 정함, inCluster.workload 는 id 가 정해진 뒤 채움) */
export function inClusterComponent(w: MappedComponent, d: Detected): MappedComponent {
  const kind = KIND_OF[d.product];
  const src = (k: string) => `${d.source}#${k}`;
  const volGb = ((w.props.volumes ?? []) as Array<{ sizeGb?: number }>).map((v) => v.sizeGb).find((x): x is number => typeof x === "number" && x >= 1);
  const memMiB = (w.props.resources as { limit?: { memMiB?: number | null } } | undefined)?.limit?.memMiB ?? null;
  const props: Record<string, unknown> = {};
  const meta: Record<string, MetaTuple> = {};
  const unknown = (k: string, why: string) => { meta[k] = [src(k), 0.6, why]; };
  switch (kind) {
    case "postgres": {
      const major = d.tag ? majorOf(d.tag) : null;
      props.majorVersion = major; props.storageGb = volGb ? Math.ceil(volGb) : null;
      if (!major) unknown("majorVersion", "이미지 태그에서 버전을 못 읽음");
      if (!volGb) unknown("storageGb", "볼륨 크기를 못 읽음");
      break;
    }
    case "cache":
      props.engine = d.product === "valkey" ? "valkey" : "redis";
      if (d.tag && /^\d/.test(d.tag)) props.version = d.tag.split("-")[0];
      props.memoryMiB = memMiB; props.tls = null; props.auth = null;
      if (memMiB === null) unknown("memoryMiB", "메모리 한도가 없음");
      unknown("auth", "클러스터 안 캐시의 TLS·AUTH 는 설정 파일·인자에 있어 못 읽음");
      break;
    case "objectStore":
      props.versioning = false; props.public = null; props.sizeGb = volGb ?? null;
      unknown("versioning", "MinIO 버킷·버전 관리 설정은 MinIO 안에 있어 못 읽음 (버킷 목록도 모름)");
      break;
    case "queue":
      props.model = d.product === "kafka" ? "topic" : "queue";
      meta.model = [src("model"), 0.9, d.product === "kafka" ? "Kafka 는 토픽(로그) 모델" : "RabbitMQ 는 큐 모델 (교환기·라우팅은 못 읽음)"];
      break;
  }
  props.inCluster = { workload: "", product: d.product };
  meta.inCluster = [d.source, d.confidence, d.why];
  meta.dataCopy = [d.source, 0.6, `데이터 복사 필요: 클러스터 안 ${d.product} 의 데이터(볼륨)는 워크로드를 옮겨도 따라가지 않음 → 복사 방식·도착 종류는 사람이 정함`];
  return {
    name: w.name, ...(w.ns ? { ns: w.ns } : {}), kind, props, meta,
    // 주소는 비워 둔다: env 다시 쓰기(fromLink)는 워크로드 쪽 그대로 두고, 의존성만 linkInCluster 가 잇는다
    native: { type: `k8s.inCluster.${d.product}`, name: w.native.name, ...(w.native.namespace ? { namespace: w.native.namespace } : {}), endpoint: null },
  };
}

const intentOf = (k: string): LinkV2["intent"] => (k === "postgres" || k === "cache" ? "connect" : "readwrite");

/** 앱 → 워크로드(call) 의존성이 있으면 앱 → 그 데이터 자원 의존성도 (근거·신뢰도는 워크로드 쪽 그대로). links·fieldMeta 제자리 */
export function linkInCluster(components: MappedComponent[], links: LinkV2[], fieldMeta: FieldMetaV2): void {
  const twins = components.filter((c) => (c.props.inCluster as { workload?: string } | undefined)?.workload);
  for (const t of twins) {
    const wid = (t.props.inCluster as { workload: string }).workload;
    // 자기 워크로드 → 자기 데이터 자원 (이름 추측 규칙이 이을 수 있음)은 뜻이 없어 뺀다
    for (let i = links.length - 1; i >= 0; i--) if (links[i]!.from === wid && links[i]!.to === t.id) { links.splice(i, 1); delete fieldMeta[`links.${wid}->${t.id}`]; }
    for (const l of [...links]) {
      if (l.to !== wid || l.from === wid) continue;
      const key = `${l.from}->${t.id}`;
      if (links.some((x) => x.from === l.from && x.to === t.id)) continue;
      const intent = intentOf(t.kind);
      links.push({ from: l.from, to: t.id!, intent });
      const m = fieldMeta[`links.${l.from}->${wid}`];
      const why = [`클러스터 안 ${String((t.props.inCluster as { product: string }).product)} 워크로드 ${wid} 를 가리킴`,
        ...(intent === "readwrite" ? ["읽기·쓰기 근거 없음 → 넓게 둠"] : [])].join(" / ");
      const conf = m?.confidence ?? 0.6;
      fieldMeta[`links.${key}`] = { source: m?.source ?? `incluster:${wid}`, confidence: conf, needs_review: conf < 1 || intent === "readwrite", rationale: why };
    }
  }
  links.sort((a, b) => { const ka = `${String(a.from)}\0${String(a.to)}`, kb = `${String(b.from)}\0${String(b.to)}`; return ka < kb ? -1 : ka > kb ? 1 : 0; });
}

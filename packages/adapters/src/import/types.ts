import type { ComponentKindV2, FieldMetaV2, ImportResultV2, Provider, RawInventory } from "@svc/contracts";

// DRAFT(ai): 가져오기 v2 의 내부 모양. 출발 갈래(ECS·Cloud Run·VM 등)는 나중에 SourceReader·KindMapper 로 붙인다(설계 23번 3.2장).
//   공통 명세 v2(AppSpecV2) 는 contracts 몫, 여기는 "원본 → 리소스" 사이의 adapters 안 모양.

/** 원본 항목 하나. kind = 원본 종류 문자열 (k8s.deployment, rds.dbInstance …) */
export type RawItem = { kind: string; [k: string]: unknown };

/** 출발에서 원본을 읽는 쪽. discover 가 이 모양을 지키면 normalizeV2 가 그대로 받는다 */
export interface SourceReader {
  provider: Provider;
  /** 읽는 원본 종류 (커버리지 표) */
  nativeTypes: string[];
  read(): Promise<RawInventory>;
}

/** 리소스 하나의 출발 정체. id 정하기·연결 추론에 쓴다 (명세에는 안 들어감) */
export interface NativeRef {
  type: string;                    // k8s.deployment, AWS::RDS::DBInstance …
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  /** PARTOF: 앱 묶음 라벨만 (k8s 는 metadata.labels 의 app.kubernetes.io/part-of·name). 선택자 맞추기엔 안 씀 */
  appLabels?: Record<string, string>;
  endpoint?: string | null;        // 다른 워크로드가 값으로 적었을 주소 (연결 추론 근거)
  aliases?: string[];              // 같은 대상의 다른 주소 (예: CNPG …-rw.ns.svc.cluster.local)
  uid?: string | null;             // 벤더 고유 ID (ARN, selfLink). 있으면 id 열쇠로 씀
  scope?: string;                  // 계정·리전·클러스터. 같은 이름이 둘일 때 가름
}

/** [출처, 신뢰도, 이유?] */
export type MetaTuple = [source: string, confidence: 1 | 0.9 | 0.6, rationale?: string];

/** 매퍼 결과 (리소스 한 개, id 는 아직 없음) */
export interface MappedComponent {
  name: string;
  ns?: string;
  kind: ComponentKindV2;
  props: Record<string, unknown>;
  meta: Record<string, MetaTuple>;
  native: NativeRef;
  /** 데이터 리소스의 출발 방화벽 (posture.network component 줄 재료) */
  network?: { ingress: Array<{ from: string; port?: number }> | "unknown"; public: boolean | null };
  /** I9: k8s Ingress 밖 라우팅 재료 (ECS 의 ALB 규칙). pipeline 이 entry 로 합친다 */
  routes?: Array<{ host: string; path: string | null; port: number }>;
  /** v1 투영 재료 (서비스만) */
  projection?: ProjectionSource;
  /** I6: 큐의 DLQ 가 가리키는 다른 큐(ARN·토픽 이름). 파이프라인이 id 가 정해진 뒤 props.deadLetter.to 로 바꾼다 (저장 안 함) */
  deadLetterRef?: { arn: string; name: string };
  /** 파이프라인이 채움: 정한 id, 이 서비스를 고르는 k8s Service 이름들 */
  id?: string;
  svcNames?: string[];
}

/** 매퍼: 원본 종류 하나 → 리소스 하나 (순수). 못 옮기면 skip 이유 */
export interface KindMapper {
  nativeTypes: string[];
  kind: ComponentKindV2;
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" };
}

/** v1 투영에만 쓰는 출발 값. 저장하지 않는다(spec_v2 에 안 들어감) */
export interface ProjectionSource {
  /** 원래 이름 (v1 app.name) */
  name: string;
  namespace?: string;
  /** 원래 env 값 (평문 비밀 가리기 뒤, 원래 순서, value 가 있는 것만) */
  env: Array<{ name: string; value: string }>;
  /** 평문 비밀로 보여 뺀 env 이름 (v1 field_meta 0.6 용) */
  plainSecretNames: string[];
  /** secretKeyRef env (원래 순서) */
  secretRefs: Array<{ name: string; key: string }>;
  /** Deployment.spec.replicas (HPA 와 상관없이) */
  specReplicas: number;
  /** 첫 컨테이너 포트 → 없으면 Service targetPort(숫자) */
  port: number | null;
  /** v1 호스트 (같은 네임스페이스 Ingress 중 이 서비스로 가는 첫 규칙 → LB 주소 → 클러스터 안 이름) */
  hostname: string | null;
  /** 이미지 원문 (v1 은 tag 를 split(":")[0] 으로 뗌) */
  image: string;
  imageDigest: string | null;
  /** readinessProbe.httpGet.path 원문 (v1 healthPath) */
  healthPath: string | null;
}

/** v1 투영용 보관 (저장 안 함). 키 = 리소스 id */
export interface ProjectionEnv {
  workloads: Record<string, ProjectionSource>;
  /** postgres 원본 종류 (v1 이 못 읽은 값을 채우던 기본값이 종류마다 다름) */
  postgres: Record<string, { nativeType: string }>;
}

export interface NormalizeV2Options {
  /** 이전 판 ImportResultV2.ids. 같은 자원 = 같은 id */
  previousIds?: Record<string, string>;
  /** 앱 이름 (없으면 첫 서비스 id) */
  appName?: string;
  /** PARTOF: 연결 화면에서 고른 앱 묶음 값 (app.kubernetes.io/part-of 등). 없으면 라벨이 가장 많은 묶음 */
  partOf?: string;
}

export interface NormalizeV2Output {
  result: ImportResultV2;
  projectionEnv: ProjectionEnv;
}

export type { FieldMetaV2 };

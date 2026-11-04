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
  /** DM-4: 호스트가 아닌 연결 식별자 (Cloud SQL 연결 이름·/cloudsql/<이름> 소켓). 연결 근거로는 쓰되, 주소 다시 쓰기는 안 하고 사람이 도착 연결 방식을 정한다 */
  proxyAliases?: string[];
  /** G3b-4: 주소(소문자)별 다시 쓰기 출력. null = 의존성 근거로만 쓰고 값은 안 바꿈(도착에 같은 모양 출력이 없음, 검토 줄). 없으면 종류 기본값 */
  aliasOutputs?: Record<string, "host" | "url" | "name" | null>;
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
  /** EA-1: hostUnknown = 출발 규칙에 호스트 조건이 없어 임시 호스트(ALB 주소)를 씀, tls = 출발 리스너가 HTTPS */
  routes?: Array<{ host: string; path: string | null; port: number; hostUnknown?: boolean; tls?: boolean }>;
  /** I6: 큐의 DLQ 가 가리키는 다른 큐(ARN·토픽 이름). 파이프라인이 id 가 정해진 뒤 props.deadLetter.to 로 바꾼다 (저장 안 함) */
  deadLetterRef?: { arn: string; name: string };
  /** B-1b·B-2: 버킷 알림·토픽 구독 대상 (props.notifications|topicSubscriptions[index].to 를 파이프라인이 uid 로 채움) */
  notifyRefs?: Array<{ field: "notifications" | "topicSubscriptions"; index: number; uid: string }>;
  /** 파이프라인이 채움: 정한 id, 이 서비스를 고르는 k8s Service 이름들 */
  id?: string;
  svcNames?: string[];
  /** N4: 매퍼가 리소스는 만들었지만 일부 칸(볼륨 종류 등)을 못 옮김 → 파이프라인이 unmapped B 로 */
  partial?: Array<{ resource: string; reason: string }>;
}

/** 매퍼: 원본 종류 하나 → 리소스 하나 (순수). 못 옮기면 skip 이유 */
export interface KindMapper {
  nativeTypes: string[];
  kind: ComponentKindV2;
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" };
}

export interface NormalizeV2Options {
  /** 이전 판 ImportResultV2.ids. 같은 자원 = 같은 id */
  previousIds?: Record<string, string>;
  /** 앱 이름 (G3b-5: 이전 만들 때 받은 값. 순서 = 앞 판에서 사람이 고친 이름 → 이것 → 앞 판 이름 → 고른 앱 묶음 값 → 첫 서비스 id) */
  appName?: string;
  /** G3b-5: 같은 이전의 앞 판 앱 이름 (human = 사람이 PATCH 로 고친 이름). 다시 가져와도 이름이 안 바뀌게 */
  previousApp?: { name: string; meta?: FieldMetaV2[string] };
  /** PARTOF: 연결 화면에서 고른 앱 묶음 값 (app.kubernetes.io/part-of 등). 없으면 라벨이 가장 많은 묶음 */
  partOf?: string;
}

export interface NormalizeV2Output {
  result: ImportResultV2;
}

export type { FieldMetaV2 };

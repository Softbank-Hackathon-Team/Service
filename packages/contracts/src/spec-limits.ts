// 공통 명세(IR) 개수 상한 한 곳 (L-1)
// DRAFT(ai): 상한은 "남용 막기"(잘못된 입력·폭주로 JSON 이 끝없이 커지는 것) 용도로만 둔다.
//   실제 앱 크기를 거르는 값이 아니다. 출발 워크로드를 그대로 이식하는 게 먼저라, 큰 앱(마이크로서비스 수백 개,
//   사이드카 여러 개 붙은 파드, 링크 수천 개)도 통과해야 한다. 값은 흔한 큰 앱의 10배쯤 + 근거 문서 예시(리소스 500, 링크 5000).
//   클라우드 제품 자체의 한도(예: RDS 읽기 복제본 15)는 개수 상한이 아니라 제품 사실이라 여기 넣지 않는다.
//   Zod 4 too_big 문제는 path·maximum 을 갖고 있어 specIssueLines 가 "어느 칸이 몇 개 넘었는지"로 바꿔 준다.
export const SPEC_LIMITS = {
  components: 500,          // 리소스 (예전 30)
  links: 5000,              // 의존성 (예전 100)
  grantsPerLink: 500,       // 링크 하나의 세부 권한 (예전 50, 가져오기가 50에서 조용히 잘랐음)
  env: 1000,                // 컨테이너 하나의 env (예전 200)
  envFrom: 100,             // (예전 20)
  configs: 200,             // ConfigMap 마운트 (예전 20)
  secretMounts: 200,        // (예전 20)
  volumes: 200,             // (예전 10)
  sidecars: 50,             // 보조 컨테이너 (예전 5. 메시 + 로그 + 모니터링 붙은 파드가 흔함)
  initContainers: 50,       // (예전 5)
  command: 1000,            // command 줄 수 (예전 50)
  args: 1000,               // args 줄 수 (예전 100)
  ports: 1000,              // 컨테이너 포트 (예전 10)
  endpoints: 200,           // 서비스 하나 앞의 k8s Service (예전 5)
  replicas: 10000,          // 복제 수 (예전 100. HPA·Cloud Run maxScale 은 100을 넘을 수 있음)
  databases: 1000,          // (예전 50)
  extensions: 500,          // (예전 100)
  lifecycle: 1000,          // 버킷 수명 규칙 (예전 50. S3 한 버킷 최대 1000)
  subscriptions: 1000,      // PS-1 토픽 하나의 구독 (Pub/Sub 토픽당 최대 10000, 남용 막기만)
  corsRules: 1000,          // DM-1 버킷 CORS 규칙 (S3 한 버킷 최대 100, 남용 막기만)
  hosts: 1000,              // 입구 호스트 묶음 (예전 10)
  hostnames: 1000,          // 묶음 하나의 호스트 이름 (예전 10)
  routes: 5000,             // 묶음 하나의 경로 (예전 20)
  matches: 100,             // 경로 하나의 조건 (예전 8)
  headers: 100,             // 조건 하나의 헤더 (예전 8)
  backends: 100,            // 경로 하나의 뒤쪽 서비스 (예전 4)
  permissions: 10000,       // 보안 기준선 권한 줄 (예전 200)
  network: 5000,            // 보안 기준선 네트워크 줄 (예전 50)
  included: 5000,           // 사람이 끌어온 경계 밖 자원 (예전 200)
  // PF-A7 DRAFT(ai): A 묶음 칸(비밀 표·k8s 권한·버킷 알림·토픽 구독·사설 DNS·나가는 IP)도 같은 표로. 예전 50~200 은 실제 서비스 한도보다 훨씬 작아
  //   구독 60개 토픽·비밀 230개 앱이 가져오기 전체 영구 실패(IMPORT_SPEC_INVALID)였다. 남용 막기만
  secrets: 1000,            // 비밀 표 (예전 200)
  secretKeys: 1000,         // 비밀 하나의 키 (예전 200)
  rbacRoles: 1000,          // Role (예전 100)
  rbacRules: 1000,          // Role 하나의 규칙 (예전 200)
  rbacBindings: 1000,       // RoleBinding·ClusterRoleBinding (예전 200·100)
  rbacSubjects: 1000,       // 바인딩 하나의 대상 (예전 100)
  notifications: 1000,      // 버킷 이벤트 알림 규칙 (예전 50)
  topicSubscriptions: 1000, // SNS 토픽 구독 (예전 50)
  privateDns: 1000,         // 출발 사설 DNS 레코드 (예전 100)
  egressIps: 100,           // 나가는 고정 IP (예전 20)
} as const;
export type SpecLimitKey = keyof typeof SPEC_LIMITS;

// 칸 이름 → 사람이 읽는 이름 (마지막 path 조각 기준)
const LABEL: Partial<Record<string, string>> = {
  components: "리소스", links: "의존성", grants: "링크 세부 권한", env: "env", envFrom: "envFrom", configs: "ConfigMap 마운트",
  secretMounts: "비밀 마운트", volumes: "볼륨", sidecars: "보조 컨테이너", initContainers: "init 컨테이너", command: "command",
  args: "args", ports: "포트", endpoints: "k8s Service", databases: "데이터베이스", extensions: "확장", lifecycle: "수명 규칙", cors: "CORS 규칙", subscriptions: "구독",
  hosts: "입구 호스트 묶음", hostnames: "호스트 이름", routes: "경로", matches: "경로 조건", headers: "헤더", backends: "뒤쪽 서비스",
  permissions: "권한 줄", network: "네트워크 줄", included: "끌어온 자원",
  secrets: "비밀", keys: "비밀 키", roles: "Role", rules: "규칙", roleBindings: "RoleBinding", clusterBindings: "ClusterRoleBinding", subjects: "바인딩 대상",
  notifications: "버킷 알림", topicSubscriptions: "토픽 구독", privateDns: "사설 DNS 레코드", ips: "나가는 IP",
};

// Zod issue 중 여기서 쓰는 칸만 (zod 를 직접 의존하지 않는 쪽도 넘길 수 있게 좁은 모양)
export type SpecIssueLike = { code: string; path: readonly PropertyKey[]; message: string; origin?: string; maximum?: number | bigint };

const at = (input: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Record<PropertyKey, unknown>)[k] : undefined), input);

// DRAFT(ai): 값은 안 내보낸다(비밀일 수 있음). 칸 경로·상한·지금 개수만. 개수 상한 넘김은 "어느 칸이 몇 개 넘었는지"로 바꾼다
export function specIssueLines(issues: readonly SpecIssueLike[], input?: unknown): string[] {
  return issues.map((x) => {
    const path = x.path.map(String).join(".") || "(최상위)";
    if (x.code === "too_big" && x.origin === "array") {
      const key = [...x.path].reverse().find((k) => typeof k === "string") as string | undefined;
      const now = input === undefined ? undefined : at(input, x.path);
      const count = Array.isArray(now) ? ` (지금 ${now.length}개)` : "";
      return `${path}: ${key && LABEL[key] ? `${LABEL[key]} ` : ""}개수 상한 ${String(x.maximum)} 넘음${count}`;
    }
    return `${path}: ${x.message}`;
  });
}

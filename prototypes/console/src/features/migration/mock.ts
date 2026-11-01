// 화면에 보이는 모든 값은 예시다. 실제 API가 생기면 이 파일만 걷어 내면 된다.
import type { DotMapRow, SecurityStatus } from '../../components/ui/Security';
import type { TimelineEntry } from '../../components/ui/Timeline';

export const APP_NAME = 'shop-api';

export type EnvId = 'AWS' | 'GCP' | '온프레' | 'Azure';

// DRAFT(ai): 팀 명세의 Azure는 Mock이지만, 출발·도착 네 환경을 다 지원하는 방향으로 화면을 만든다.
export const ENVS: EnvId[] = ['AWS', 'GCP', '온프레', 'Azure'];

/** 3티어(웹, API, DB)와 PostgreSQL 16으로 고정한다. */
export const STACK_BY_ENV: Record<EnvId, [string, string][]> = {
  AWS: [
    ['웹', 'ECS 2개'],
    ['API', 'ECS 2개'],
    ['DB', 'RDS PostgreSQL 16'],
  ],
  GCP: [
    ['웹', 'GKE 2개'],
    ['API', 'GKE 2개'],
    ['DB', 'Cloud SQL PostgreSQL 16'],
  ],
  온프레: [
    ['웹', 'k3s 2개'],
    ['API', 'k3s 2개'],
    ['DB', 'CloudNativePG 16'],
  ],
  Azure: [
    ['웹', 'AKS 2개'],
    ['API', 'AKS 2개'],
    ['DB', 'Azure Database PostgreSQL 16'],
  ],
};

export const CONNECT_METHOD: Record<EnvId, { how: string; detail: string }> = {
  AWS: { how: '링크 한 번', detail: '읽기용과 변경용 역할이 생깁니다. 계정 번호만 입력하면 됩니다.' },
  GCP: { how: 'Cloud Shell 스크립트 한 번', detail: '서비스 계정을 가장합니다. 키 파일은 만들지 않습니다.' },
  온프레: { how: '설치 명령 한 줄', detail: 'Agent가 바깥으로만 접속합니다. 여는 포트는 없습니다.' },
  // DRAFT(ai): Azure 연결 방식은 설계에 없다. 정해지면 바꾼다.
  Azure: { how: '링크 한 번', detail: '역할 할당으로 권한을 빌립니다. 방식은 아직 정하지 않았습니다.' },
};

export const INITIAL_CONNECTED: Record<EnvId, boolean> = { AWS: true, GCP: false, 온프레: true, Azure: false };

export const CONNECT_FAILURES = [
  ['ASSUME_DENIED', '권한 빌리기 거부'],
  ['ACCOUNT_MISMATCH', '계정 번호 불일치'],
  ['PERMISSION_MISSING', '권한 부족'],
  ['ORG_POLICY', '조직 정책이 막음'],
  ['ROLE_NOT_FOUND', '권한 묶음 없음'],
] as const;

export const SPEC_READ: { name: string; value: string; confidence: string }[] = [
  { name: '포트', value: '8080', confidence: '1.0' },
  { name: 'DB', value: 'PostgreSQL 16', confidence: '1.0' },
  { name: '이미지', value: 'shop-api@sha256:ab12…', confidence: '1.0' },
  { name: '비밀 이름', value: 'DB_PASSWORD (값은 읽지 않음)', confidence: '0.9' },
];

export const REPLICA_OPTIONS = ['2개', '3개', '4개'];
export const RESOURCE_OPTIONS = ['0.5 CPU · 1GiB', '1 CPU · 2GiB', '2 CPU · 4GiB'];

export const COVERAGE = { found: 23, movable: 9, unsupported: ['Lambda 2개', 'SQS 1개'] };
export const FINDINGS = ['레포에 비밀번호 평문 1건', '기본 키 없는 표 0개'];

export const PRECHECK_ITEMS: { id: string; name: string; result: 'pass' | 'warning' | 'info' }[] = [
  { id: 'PC-01', name: '대응 서비스', result: 'pass' },
  { id: 'PC-02', name: 'DB 버전', result: 'pass' },
  { id: 'PC-03', name: '리전과 한도', result: 'warning' },
  { id: 'PC-04', name: '변경 권한', result: 'pass' },
  { id: 'PC-05', name: '비밀 이름', result: 'pass' },
  { id: 'PC-06', name: '보안 서비스', result: 'info' },
  { id: 'PC-07', name: '고정 진입점', result: 'pass' },
  { id: 'DB-01~13', name: 'DB 복제 가능', result: 'pass' },
];

export const PRECHECK_BLOCKER = {
  id: 'DB-03',
  name: '기본 키 없는 표',
  detail: '기본 키가 없으면 수정과 삭제가 복제되지 않습니다.',
  tables: ['audit_logs', 'session_events'],
};

export const PLAN_CHANGES: [string, string][] = [
  ['생성', '5'],
  ['변경', '0'],
  ['삭제', '0'],
];

export const PLAN_STEPS: { name: string; gate: string }[] = [
  { name: '자원 만들기', gate: '예상 600초, 지문 일치' },
  { name: '앱 배포', gate: '도착 앱 정상, 보안 수준 유지' },
  { name: 'DB 복제', gate: '지연 1초 이하 3번 연속' },
  { name: '트래픽 이동', gate: '10·50·100%, 판정 3번 이상' },
  { name: 'DB 전환', gate: '100%에서 30초 문제 없음' },
  { name: '롤백 대기', gate: '15분' },
  { name: '정리', gate: '임시 자원 0개, 권한 회수' },
];

export const PLAN_EXTRAS = {
  exception: '복제용 포트 5432, 주소 하나(/32), 암호화 연결, 2시간',
  tempResources: 8,
  warning: '리전 한도가 빠듯합니다. CPU 할당을 확인하세요.',
};

export const SECURITY_SERVICE_MAP: Record<EnvId, string> = {
  AWS: 'GuardDuty',
  GCP: 'Security Command Center',
  온프레: 'Falco',
  Azure: 'Defender for Cloud',
};

export const COST_ROWS: { name: string; source: number; target: number }[] = [
  { name: '컴퓨트', source: 210, target: 168 },
  { name: 'DB', source: 180, target: 150 },
  { name: '네트워크', source: 60, target: 52 },
  { name: '보안·감사', source: 30, target: 24 },
];

export const COST_PROFILE_EXTRA = { basic: 0, strict: 42 };

/** 실제 지문이 아니다. 칸을 고치면 지문도 바뀐다는 것만 보여 준다. */
export function planHash(values: string[]): string {
  let seed = 5381;
  for (const char of values.join('|')) seed = (seed * 33 + char.charCodeAt(0)) >>> 0;
  const hex = seed.toString(16).padStart(8, '0');
  return `sha256:${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

const CONTROLS: { id: string; name: string; area: string; tools: string }[] = [
  { id: 'IAM-01', name: '관리자 2단계 인증', area: '권한', tools: 'Prowler / 사람 확인 / Agent' },
  { id: 'IAM-02', name: '모든 권한 정책 0개', area: '권한', tools: 'Prowler' },
  { id: 'IAM-03', name: '기본 계정 토큰 자동 부착 안 함', area: '권한', tools: 'Kyverno' },
  { id: 'ENC-01', name: 'DB 저장·전송 암호화', area: '암호화', tools: 'Prowler / Agent / Trivy' },
  { id: 'ENC-02', name: '외부 노출은 암호화 연결만', area: '암호화', tools: 'Kyverno' },
  { id: 'ENC-03', name: '코드·이미지·환경 변수에 비밀 없음', area: '암호화', tools: 'Trivy / Prowler' },
  { id: 'AUD-01', name: '감사 로그 켜짐', area: '감사', tools: 'Prowler' },
  { id: 'AUD-02', name: '플랫폼 조작 기록과 무결성', area: '감사', tools: '플랫폼 감사 검증' },
  { id: 'VIO-01', name: '관리·DB 포트 전 세계 공개 0', area: '위반', tools: 'Prowler / SCC / Agent / Trivy' },
  { id: 'VIO-02', name: '우리 저장소 이미지만, 심각 취약점 0', area: '위반', tools: 'Kyverno / Trivy' },
  { id: 'VIO-03', name: 'root·특권 실행 0', area: '위반', tools: 'Kyverno' },
  { id: 'VIO-04', name: '활성 위협 0건', area: '위반', tools: 'GuardDuty / SCC / Falco' },
];

const CODE: Record<string, SecurityStatus> = { P: 'pass', F: 'fail', U: 'unknown', N: 'na', A: 'attested' };
const statuses = (codes: string) => [...codes].map((code) => CODE[code]);

const ENV_STATUS: Record<EnvId, SecurityStatus[]> = {
  AWS: statuses('PPPPPPPPPUPU'),
  GCP: statuses('APPPPPPPPUPU'),
  온프레: statuses('APPUPPPPPUPU'),
  Azure: statuses('UPPUPPUPUUPU'),
};

const TARGET_STATUS = {
  none: statuses('NNNNNNNNNNNN'),
  planned: statuses('APPPPPPPPUPU'),
  blocked: statuses('APPPPPPPFUPU'),
  verified: statuses('APPPPPPPPUPU'),
};

export type SecurityPhase = keyof typeof TARGET_STATUS;

export type SecurityRow = { id: string; name: string; area: string; tools: string; byEnv: Record<EnvId, SecurityStatus> };

export const ENV_SHORT: Record<EnvId, string> = { AWS: 'AWS', GCP: 'GCP', 온프레: '온프', Azure: 'Az' };

export const attestKey = (controlId: string, env: EnvId) => `${controlId}:${env}`;

export function securityRows(
  source: EnvId,
  target: EnvId,
  phase: SecurityPhase,
  attested: Record<string, boolean> = {},
): SecurityRow[] {
  return CONTROLS.map((control, index) => {
    const byEnv = {} as Record<EnvId, SecurityStatus>;
    for (const env of ENVS) {
      const status = env === target ? TARGET_STATUS[phase][index] : ENV_STATUS[env][index];
      byEnv[env] = attested[attestKey(control.id, env)] && status === 'unknown' ? 'attested' : status;
    }
    if (source === target) byEnv[source] = ENV_STATUS[source][index];
    return { ...control, byEnv };
  });
}

/** 점 지도는 이번 이전에 관련된 환경만 칠하고 나머지는 '해당 없음'으로 둔다. */
export function dotMapRows(rows: SecurityRow[], source: EnvId, target: EnvId, phase: SecurityPhase): DotMapRow[] {
  return rows.map((row) => ({
    name: `${row.id} ${row.name}`,
    statuses: ENVS.map((env) => (env === source || (env === target && phase !== 'none') ? row.byEnv[env] : 'na')),
  }));
}

const isOk = (status: SecurityStatus) => status === 'pass' || status === 'attested';

export function okCount(rows: SecurityRow[], env: EnvId): number {
  return rows.filter((row) => isOk(row.byEnv[env])).length;
}

export function countStatus(rows: SecurityRow[], env: EnvId, status: SecurityStatus): number {
  return rows.filter((row) => row.byEnv[env] === status).length;
}

/** 출발이 괜찮았는데 도착이 괜찮지 않으면 후퇴다. '모름'도 괜찮지 않은 것으로 본다. */
export function regressions(rows: SecurityRow[], source: EnvId, target: EnvId): SecurityRow[] {
  return rows.filter((row) => {
    const after = row.byEnv[target];
    return isOk(row.byEnv[source]) && after !== 'na' && !isOk(after);
  });
}

export const CELL_BLIND_SPOT: Partial<Record<EnvId, string>> = {
  AWS: 'GuardDuty는 컨테이너 안 실행을 보지 못합니다.',
  GCP: 'SCC 표준은 실행 중 위협을 보지 못합니다.',
  온프레: 'Falco는 네트워크 바깥 위협을 보지 못합니다.',
  Azure: '탐지 범위를 아직 확인하지 못했습니다.',
};

export type Threat = { id: string; env: EnvId; source: string; title: string; severity: string; time: string };

export const THREATS: Threat[] = [
  { id: 'th-1', env: 'AWS', source: 'GuardDuty', title: '알려진 악성 IP에서 API 호출', severity: '높음', time: '12:18:22' },
  { id: 'th-2', env: '온프레', source: 'Falco', title: '컨테이너 안에서 터미널 열림', severity: '중간', time: '12:19:40' },
  { id: 'th-3', env: 'GCP', source: 'SCC', title: 'SSH 포트 전 세계 공개', severity: '높음', time: '12:20:05' },
];

export type GuardrailRule = { name: string; control: string; layer: string };

export const GUARDRAIL_STAGES: { name: string; state: 'done' | 'active' | 'pending'; rules: GuardrailRule[] }[] = [
  {
    name: '새 환경',
    state: 'done',
    rules: [
      { name: '모든 권한 정책 없음', control: 'IAM-02', layer: '예방' },
      { name: '특권 컨테이너 없음', control: 'VIO-03', layer: '예방' },
      { name: '보안 수준 후퇴 없음', control: 'VIO-04', layer: '탐지' },
    ],
  },
  {
    name: '데이터 이전',
    state: 'active',
    rules: [
      { name: 'DB 포트 전 세계 공개 없음', control: 'VIO-01', layer: '탐지' },
      { name: '복제 평문 없음', control: 'ENC-01', layer: '예방' },
      { name: '행 수·체크섬 일치', control: 'AUD-02', layer: '탐지' },
    ],
  },
  {
    name: '전환',
    state: 'pending',
    rules: [
      { name: '양쪽 DB 동시 쓰기 없음', control: 'AUD-02', layer: '탐지' },
      { name: '도착 로그가 들어옴', control: 'AUD-01', layer: '탐지' },
      { name: '5xx·p95 정상', control: 'VIO-04', layer: '탐지' },
    ],
  },
  {
    name: '정리',
    state: 'pending',
    rules: [
      { name: '복제 슬롯 0개', control: 'AUD-02', layer: '탐지' },
      { name: '임시 방화벽 0개', control: 'VIO-01', layer: '탐지' },
      { name: '변경 권한 회수', control: 'IAM-02', layer: '탐지' },
    ],
  },
];

export const ROLLBACK_STEPS = ['판정과 이유 저장', '상태를 롤백 중으로', 'Cloudflare 출발 100%', '도착 요청 0 확인', '복귀 시간 저장'];

export const ROLLBACK_CAUSE = {
  manual: { title: '사람이 롤백을\n시작했습니다', code: '수동 롤백', detail: '쓰기는 계속 출발 DB로 갑니다' },
  error: { title: '오류가 늘어\n자동으로 되돌립니다', code: '도착 5xx 1.4% · 21건', detail: '기준: 1% 초과, 3건 이상, 출발의 3배 초과' },
  latency: { title: '응답이 느려져\n자동으로 되돌립니다', code: '도착 p95 2.3배', detail: '기준: 출발 p95의 2배 초과, 2번 연속' },
} as const;

export const CLEANUP_STEPS = ['임시 자원 장부 확인', '복제 슬롯 지우기', '임시 방화벽 지우기', '변경 권한 회수'];

export const FAILED_INFO = {
  at: '자원 만들기',
  code: 'STEP_FAILED',
  detail: 'Terraform apply가 리전 한도에 걸렸습니다.',
  leftovers: ['VPC 1개', '서브넷 2개', '보안 그룹 1개'],
};

export const MIGRATION_LIST = [
  { id: 'mg-104', app: 'billing-api', route: 'GCP → AWS', status: '승인 대기', progress: 40 },
  { id: 'mg-101', app: 'auth-api', route: '온프레 → GCP', status: '완료', progress: 100 },
];

export const ENV_APP: Record<EnvId, { up: boolean; version: string }> = {
  AWS: { up: true, version: 'v1.8.2' },
  GCP: { up: false, version: '-' },
  온프레: { up: true, version: 'v1.8.0' },
  Azure: { up: false, version: '-' },
};

export const MEMBERS = [
  { name: '멤버 A', handle: 'member-a' },
  { name: '멤버 B', handle: 'member-b' },
  { name: '멤버 C', handle: 'member-c' },
];

export const AGENT_LIMITS: [string, string][] = [
  ['동시 실행', '회사당 1개'],
  ['하루', '20번'],
  ['실행당', '30단계 · 900초'],
  ['자격 증명', '0개'],
];

export const AGENT_RUNS = [
  { kind: '명세 초안', status: '끝남', detail: '빈 칸 2개를 추측함. 사람이 고르기 전에는 안 씀', time: '12:01:40' },
  { kind: '장애 점검', status: '제안', detail: '메모리 256Mi → 512Mi 수정안', time: '12:23:49' },
];

export const AGENT_TIMELINE: TimelineEntry[] = [
  { kind: 'guardrail', title: '가드레일 발동', detail: 'DB 포트 전체 공개 감지 · 전환 멈춤', time: '12:21:04' },
  { kind: 'tool', title: '에이전트 시작', detail: '샌드박스(vCluster)에서 원인 분석', time: '12:21:40' },
  { kind: 'denied', title: '거부됨', detail: 'Secret 변경 시도 · 허용 목록 위반', time: '12:22:13' },
  { kind: 'tool', title: '수정안 적용', detail: 'apply_manifest · 샌드박스 적용', time: '12:22:58' },
  { kind: 'tool', title: '다시 점검', detail: '보안 표 12개 통제 재검사', time: '12:23:31' },
  { kind: 'system', title: 'PR 생성', detail: '오케스트레이터가 대신 올림 · #12', time: '12:23:49' },
];

export const MERGE_ENTRY: TimelineEntry = {
  kind: 'human',
  title: '사람이 합침',
  detail: 'GitHub에서 #12 합침 감지',
  time: '12:25:02',
};

export const RUN_LOG: TimelineEntry[] = [
  { kind: 'system', title: '구성 읽기', detail: '읽기 전용 역할로 12개 자원 확인', time: '12:01:12' },
  { kind: 'human', title: '명세 확정', detail: '복제 수, CPU·메모리 두 칸 확인', time: '12:09:40' },
  { kind: 'human', title: '계획 승인', detail: 'sha256:9f2c41…a41e', time: '12:10:05' },
  { kind: 'human', title: '실행 시작', detail: '환경 잠금 인수', time: '12:10:31' },
  { kind: 'system', title: '데이터 복제 시작', detail: 'CDC 복제 · 지연 0.4초', time: '12:12:31' },
  { kind: 'system', title: '트래픽 10% 전환', detail: 'Cloudflare 가중치 90:10', time: '12:20:11' },
  ...AGENT_TIMELINE,
  MERGE_ENTRY,
  { kind: 'system', title: '트래픽 50% 전환', detail: 'Cloudflare 가중치 50:50', time: '12:27:44' },
];

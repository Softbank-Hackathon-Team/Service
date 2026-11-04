// VMIMPORT: VM 출발 원본 모양 (AWS EC2 · GCP GCE). 앱 하나(같은 역할의 VM 묶음)가 한 줄이다.
//   reader(readers/aws-ec2.ts · gcp-gce.ts)가 이 모양으로 넣고, 매퍼(mappers/vm-instance.ts)가 읽는다.
//   규칙: 사용자 데이터(user-data)·키 이름·IP 주소·태그/라벨 값(묶는 이름 빼고)은 원본에 넣지 않는다. 읽기 명령 결과 중 허용 목록 칸만 남긴다.

export const VM_RAW_KIND = "vm.group" as const;

export interface RawVmIngress {
  protocol: "tcp" | "udp";
  fromPort: number;
  toPort: number;
  /** 출발 허용 대상: CIDR(IPv4·IPv6) · 같은 방화벽 묶음 참조("sg:<id>"·"tag:<이름>"·"sa:<서비스 계정 이름>") · 접두어 목록("pl:<id>", FW-1) */
  sources: string[];
}

export interface RawVmGroup {
  kind: typeof VM_RAW_KIND;
  /** FW-1: 들어오는 규칙을 그대로 못 옮기는 이유 (예: GCE deny 규칙). 있으면 매퍼가 검토 0.6 */
  ingressReview?: string;
  product: "ec2" | "gce";
  /** 묶음 이름 (Name 태그/인스턴스 이름에서 끝 번호를 뗀 것, 또는 지정한 묶음 태그 값) */
  name: string;
  /** 리전(ec2) · 프로젝트가 아닌 존 목록(gce). 계정·프로젝트 번호는 넣지 않는다 */
  scope?: string | null;
  /** 묶음에 든 VM 수 (실행 중인 것만) */
  count: number;
  /** VM 식별자 (증거용, 비밀 아님) — 이름만, 정렬 */
  instances: string[];
  /** 서로 다른 크기 종류 (정렬). 둘 이상이면 매퍼가 검토 표시 */
  instanceTypes: string[];
  zones?: string[];
  /** 크기를 읽은 값 (가장 큰 종류 기준). 못 읽으면 null */
  cpuMilli?: number | null;
  memMiB?: number | null;
  /** 인스턴스 프로파일/서비스 계정 이름 (ARN·이메일의 이름 조각). 없으면 null */
  identity?: string | null;
  /** FM-IR-C06: 묶음 VM 에 붙은 보안 그룹 id (AWS). RDS 방화벽에서 "옮기는 앱 자신" 을 가리는 데만 쓴다 (없으면 칸 없음) */
  securityGroups?: string[];
  hasPublicIp?: boolean;
  /** 방화벽(보안 그룹/방화벽 규칙)이 허용한 들어오는 쪽. 읽지 못했으면 null */
  ingress?: RawVmIngress[] | null;
  /** 운영 접속 포트(22·3389)만 열려 있었는지 등 읽는 쪽 메모 */
  notes?: string[];
}

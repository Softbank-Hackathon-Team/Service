import type { RehearsalInput } from "@svc/contracts";
import { REHEARSAL_KINDS, subjectOf, type K8sObject, type Manifest } from "./manifests.js";

// 샌드박스 DB 대체물. 워커는 databases[] 로 "이 Service 이름에 Postgres 가 있어야 한다"고 적기만 하고, 객체는 여기서 만든다
//   (CNPG Cluster → <cluster>-rw, 관리형 RDS·Cloud SQL → sbx-db-<id>. 워커 치환 표 substitute.ts)
// 한 줄 = Deployment + Service, 이름은 둘 다 service. 포트 5432, trust 인증이라 앱의 가짜 비밀번호와 안 맞아도 붙는다.
// 플랫폼이 고르는 이미지(vCluster 제어판·검사 파드·Postgres)는 이 패키지에 둔다

// 대체물 표시. 값 = service 이름 (Service 선택자도 이 라벨 하나). 결과·클러스터에서 고객 객체와 가른다
export const STAND_IN_LABEL = "platform.svc/rehearsal-stand-in";

// DRAFT(ai): 지원 메이저 = 도착 어댑터가 받는 Postgres 판 (adapters target aws·gcp·onprem CAPS kind.postgres.15~17,
//   infra aws·gcp postgres_json 검사 15·16·17). 공식 이미지 메이저 태그를 멀티 아키텍처 인덱스 다이제스트로 고정 (11-04 crane digest)
// TODO(human): 검사 파드 이미지처럼 플랫폼 ECR 샌드박스 자리로 옮길지
export const POSTGRES_IMAGES: Readonly<Record<string, string>> = {
  "15": "docker.io/library/postgres:15@sha256:40e8c839f86c404f9bd1c456bb83f11b205f2cd95d753b34c2d074e89ecee786",
  "16": "docker.io/library/postgres:16@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a",
  "17": "docker.io/library/postgres:17@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1",
};
// DRAFT(ai): 빈 DB 하나 몫. 메모리 한도는 LimitRange 기본(512Mi)과 같게
//   임시 저장소: PGDATA 가 emptyDir 이라 DB 파일·WAL 도 파드 한도(컨테이너 한도 합)에 든다. LimitRange 기본(1Gi)보다 넉넉히 2Gi
export const STAND_IN_RESOURCES = {
  requests: { cpu: "50m", memory: "128Mi", "ephemeral-storage": "256Mi" }, limits: { memory: "512Mi", "ephemeral-storage": "2Gi" },
} as const;
// 공식 이미지(데비안)의 postgres 사용자. 처음부터 이 사용자로 돌면 root·chown 이 필요 없어 restricted 에도 맞는다
const POSTGRES_UID = 999;
const DATA = "/var/lib/postgresql/data";

export interface StandIns { manifests: Manifest[]; problems: string[] }

// 이름이 적용 묶음과 겹치거나 메이저가 표 밖이면 problems (부르는 쪽이 REHEARSAL_UNSUPPORTED_KIND 로 닫는다)
export function databaseStandIns(dbs: RehearsalInput["databases"], apply: readonly Manifest[]): StandIns {
  const manifests: Manifest[] = [];
  const problems: string[] = [];
  const taken = new Set(apply.map(subjectOf));
  for (const d of dbs) {
    const image = POSTGRES_IMAGES[d.majorVersion];
    if (!image) {
      problems.push(`DB 대체물 ${d.service}: Postgres ${d.majorVersion} 은 지원 목록(${Object.keys(POSTGRES_IMAGES).join("·")}) 밖`);
      continue;
    }
    for (const obj of postgres(d, image)) {
      const key = `${obj.apiVersion}/${obj.kind}`;
      const m: Manifest = { path: `stand-in/${d.service}.yaml`, key, info: REHEARSAL_KINDS[key]!, obj };
      if (taken.has(subjectOf(m))) { problems.push(`DB 대체물 ${subjectOf(m)}: 같은 이름이 적용 묶음에 이미 있음`); continue; }
      taken.add(subjectOf(m));
      manifests.push(m);
    }
  }
  return { manifests, problems };
}

function postgres(d: RehearsalInput["databases"][number], image: string): K8sObject[] {
  const labels = { [STAND_IN_LABEL]: d.service };
  return [
    {
      apiVersion: "apps/v1", kind: "Deployment", metadata: { name: d.service, labels },
      spec: {
        replicas: 1, selector: { matchLabels: labels }, strategy: { type: "Recreate" },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            // 서비스 링크 env(<SERVICE>_PORT=tcp://…)가 POSTGRES_* 이름과 겹치지 않게
            enableServiceLinks: false,
            securityContext: { runAsNonRoot: true, runAsUser: POSTGRES_UID, runAsGroup: POSTGRES_UID, fsGroup: POSTGRES_UID, seccompProfile: { type: "RuntimeDefault" } },
            containers: [{
              name: "postgres", image,
              ports: [{ name: "postgres", containerPort: 5432 }],
              env: [
                { name: "POSTGRES_DB", value: d.database }, { name: "POSTGRES_USER", value: d.owner },
                { name: "POSTGRES_HOST_AUTH_METHOD", value: "trust" },
                // 빈 디렉터리 바로 아래는 root 소유라 initdb 가 하위 폴더를 만들게 한다 (플랫폼 EKS 에 EBS CSI 가 없어 emptyDir)
                { name: "PGDATA", value: `${DATA}/pgdata` },
              ],
              // 초기화 중 임시 서버는 소켓만 연다. TCP 로 물어야 진짜 서버가 뜬 뒤에 준비가 된다
              readinessProbe: { exec: { command: ["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", d.owner, "-d", d.database] }, periodSeconds: 2, failureThreshold: 3 },
              resources: STAND_IN_RESOURCES,
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              volumeMounts: [{ name: "data", mountPath: DATA }],
            }],
            volumes: [{ name: "data", emptyDir: {} }],
          },
        },
      },
    },
    {
      apiVersion: "v1", kind: "Service", metadata: { name: d.service, labels },
      spec: { type: "ClusterIP", selector: labels, ports: [{ name: "postgres", port: 5432, targetPort: "postgres" }] },
    },
  ];
}

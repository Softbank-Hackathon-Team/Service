import { FidelityItemId, FidelityMatrix, fidelityOwner, type FidelityItem, type FidelityStatus, type RehearsalInput, type RehearsalTarget } from "@svc/contracts";
import { REQUEST_CAP, type Presence } from "./substitute.js";

// 충실도 표의 워커 몫 (설계 2.6 "나머지 고정 항목" + 치환 표). 콘솔은 이 글을 그대로 보인다.
// 항목마다 "실제 배포에서는 / 리허설에서는 / 이유" 한 줄. refs 는 치환이 바꾼 자리 (substitute.ts)
export interface FidelityFacts {
  target: RehearsalTarget;
  bundleSha256: string;
  refs: Partial<Record<FidelityItemId, string[]>>;
  present: ReadonlySet<Presence>;
  databases: number;
  k8sMinor: { value: string; known: boolean };
  imagesMirrored: boolean;               // false = MOCK_SANDBOX (복사 안 함)
  quota: RehearsalInput["targetQuota"];
}
type Row = Omit<FidelityItem, "id" | "refs">;
type WorkerItem = Exclude<FidelityItemId, "sandbox_pod_security" | "runtime_isolation">;

const row = (status: FidelityStatus, real: string, sandbox: string, reason: string): Row => ({ status, real, sandbox, reason });
const same = (real: string, reason = "도착과 같다") => row("identical", real, "같음", reason);
const DB_NAME: Record<RehearsalTarget, string> = { "aws-eks": "RDS Postgres", "gcp-gke": "Cloud SQL Postgres", "onprem-k3s": "CNPG Cluster" };

const ITEMS: Record<WorkerItem, (f: FidelityFacts, changed: boolean) => Row> = {
  manifests: () => row("identical", "렌더한 묶음을 그대로 커밋", "같은 묶음 원본을 서버 dry-run", "지문 bundleSha256 을 커밋 직전에 다시 비교한다"),
  namespace: () => row("identical", "app-<앱> 네임스페이스", "가상 클러스터에 같은 이름", "서비스 DNS 이름이 같다"),
  k8s_version: (f) => f.k8sMinor.known
    ? row("identical", `쿠버네티스 ${f.k8sMinor.value}`, `가상 클러스터 ${f.k8sMinor.value}`, "도착 마이너와 같은 판")
    : row("substituted", "도착 클러스터 판 (모름)", `가상 클러스터 ${f.k8sMinor.value}`, "도착 판 출력이 없어 기본 판으로 돈다"),
  objects: () => row("identical", "묶음의 모든 객체", "아래 바꾼 항목 말고 그대로 적용", "치환 표에 없는 바꿈은 없다"),
  target_pod_security: (f) => f.target === "onprem-k3s"
    ? row("identical", "Kyverno 파드 보안 baseline", "파드 틀을 baseline 네임스페이스에 dry-run", "같은 PSS 규칙으로 판정한다")
    : row("identical", "파드 보안 라벨 없음 (privileged)", "privileged 로 dry-run", "도착에 파드 보안 강제가 없다"),
  images: (f, c) => c
    ? row("substituted", "도착 레지스트리 주소 @digest", "플랫폼 샌드박스 레지스트리 주소, 같은 다이제스트", "샌드박스에 고객 자격을 넣지 않으려고 다이제스트 그대로 복사했다")
    : row("identical", "렌더한 이미지 주소", f.imagesMirrored ? "같음" : "같음 (흉내: 복사 안 함)", "주소가 바뀐 이미지가 없다"),
  replicas: (_f, c) => c ? row("substituted", "원래 복제 수 (HPA 최소 포함)", "1", "샌드박스 노드 하나에 올린다. 롤아웃·준비 판정은 같다") : same("원래 복제 수", "1 보다 큰 복제 수가 없다"),
  requests: (_f, c) => c
    ? row("substituted", "원래 요청량", `요청량 상한 cpu ${REQUEST_CAP.cpu}, memory ${REQUEST_CAP.memory} (한도 그대로)`, "작은 노드에서 스케줄 실패를 없앤다. 한도가 그대로라 OOM 판정은 같다")
    : same("원래 요청량", "상한을 넘는 요청량이 없다"),
  scheduling: (_f, c) => c
    ? row("substituted", "nodeSelector·affinity·tolerations·topologySpread·priorityClass", "지움", "샌드박스 노드에는 도착 노드 라벨·우선순위 클래스가 없다")
    : same("배치 규칙 없음"),
  service_type: (_f, c) => c
    ? row("substituted", "LoadBalancer·NodePort Service", "ClusterIP", "샌드박스 정책이 ClusterIP 만 받는다. 바깥 LB 는 확인 못 함")
    : same("ClusterIP·Headless Service"),
  storage: (_f, c) => c
    ? row("substituted", "PVC (도착 StorageClass)", "emptyDir", "플랫폼 클러스터에 블록 저장소 드라이버가 없다. 마운트 경로는 같다")
    : same("PVC 없음"),
  secrets: (f, c) => c
    ? row("substituted", secretSources(f) || "ExternalSecret → 도착 비밀 저장소 값", "같은 이름·같은 키의 Secret, 가짜 값 (TLS 는 자체 서명 인증서)", "고객 비밀 값은 샌드박스에 넣지 않는다")
    : same(f.present.has("external_secret") ? "ExternalSecret" : "ExternalSecret 없음"),
  secret_values: (f) => f.target === "onprem-k3s"
    ? row("not_checked", "Vault 비밀 그릇 값", "가짜 값", "온프레 비밀 그릇 값은 커밋 전에 보지 못한다")
    : row("identical", "도착 비밀 그릇 값", "커밋 전 비밀 값 확인을 지남", "값이 빈 그릇이 있으면 리허설 전에 멈춘다 (SECRET_VALUES_MISSING)"),
  database: (f, c) => c || f.databases
    ? row("substituted", DB_NAME[f.target], "같은 메이저 Postgres, 빈 DB, emptyDir", "샌드박스 안에서 접속 주소·비밀만 바꿔 연결을 본다")
    : same("DB 없음"),
  ingress: (f) => f.present.has("ingress")
    ? row("substituted", "Ingress → LB·DNS·TLS", "적용 안 함, 백엔드 Service 를 ClusterIP 로 직접 확인", "샌드박스 정책이 Ingress 를 막는다. LB·DNS·TLS 는 확인 못 함")
    : same("Ingress 없음"),
  tunnel: (f) => f.present.has("tunnel") || f.present.has("db_tunnel")
    ? row("not_checked", [f.present.has("tunnel") ? "cloudflared 터널" : "", f.present.has("db_tunnel") ? "DB 이전 SSH 터널(db-tunnel)" : ""].filter(Boolean).join(" · "),
      "돌리지 않음, 터널 대상 Service 연결만 본다", "터널 토큰·SSH 키·중계기와 바깥 연결은 샌드박스에 없다")
    : same("터널 없음"),
  cloud_identity: (f, c) => f.target === "onprem-k3s" && !c
    ? same("클라우드 신원 없음")
    : row("not_checked", f.target === "aws-eks" ? "EKS Pod Identity·IRSA" : f.target === "gcp-gke" ? "GKE Workload Identity" : "클라우드 신원 주석",
      "신원 주석을 빼고 돌림, 클라우드 권한 없음", "가상 클러스터 안에서는 클라우드 신원이 효과가 없다"),
  network: () => row("substituted", "도착 네트워크 그대로", "바깥 연결 막음, 앱 안 Service 끼리는 열림", "더 엄격하다. 바깥 API 를 부르는 앱은 실패할 수 있다"),
  quota: (f) => {
    if (!f.quota) return same("네임스페이스 할당량 없음", "도착 네임스페이스에 할당량이 없다");
    const q = f.quota, real = `${q.basis}.cpu ${q.cpuM ?? "-"}m · ${q.basis}.memory ${q.memoryMi ?? "-"}Mi`;
    return f.present.has("resource_quota")
      ? row("identical", `ResourceQuota ${real}`, `같은 ResourceQuota 를 가상 앱 네임스페이스에 적용 + 원본 ${q.basis} 합을 셈`,
        "가상 API 서버가 도착과 같은 할당량 검사로 파드를 받거나 거부한다. 리허설은 요청량 상한·복제 1 로 돌아서 합 초과는 원본 합으로 본다")
      : row("identical", real, `같은 값으로 원본 ${q.basis} 합을 셈`, "도착 네임스페이스 할당량 값과 같다. 할당량 객체는 Terraform 이 만들어 묶음에 없다");
  },
  hpa_scaling: (f) => f.present.has("hpa") ? row("not_checked", "HPA 가 지표로 늘림", "늘지 않음", "가상 클러스터에 지표 서버가 없다") : same("HPA 없음"),
  cronjob_runs: (f) => f.present.has("cronjob") ? row("not_checked", "일정대로 실행", "적용만, 실행은 안 봄", "컷오버 전에는 도착 CronJob 이 멈춰 있다") : same("CronJob 없음"),
  daemonsets: (f) => f.present.has("daemonset") ? row("not_checked", "노드마다 하나씩", "적용만, 롤아웃은 안 봄", "가상 노드라 노드별 롤아웃을 볼 수 없다") : same("DaemonSet 없음"),
  data: () => row("not_checked", "출발에서 복제한 데이터", "빈 DB", "리허설은 데이터를 옮기지 않는다"),
  traffic: () => row("not_checked", "실제 사용자 트래픽", "검사 요청만", "실제 트래픽은 카나리 10% 와 자동 롤백이 마지막 안전장치다"),
  node_arch: () => row("not_checked", "도착 노드풀 CPU 종류", "플랫폼 노드 amd64", "도착 노드 CPU 종류와 다를 수 있다"),
};

// 바꾼 비밀의 출처 (ExternalSecret · SealedSecret)
const secretSources = (f: FidelityFacts) => [f.present.has("external_secret") ? "ExternalSecret → 도착 비밀 저장소 값" : "",
  f.present.has("sealed_secret") ? "SealedSecret → 도착 sealed-secrets 컨트롤러가 푼 값" : ""].filter(Boolean).join(" · ");

const MAX_REFS = 50;
const capRefs = (r: string[]) => (r.length <= MAX_REFS ? r : [...r.slice(0, MAX_REFS - 1), `+${r.length - MAX_REFS + 1} more`]);

/** 워커 몫 충실도 표 (agent-worker 몫 sandbox_pod_security·runtime_isolation 은 결과에서 더해진다) */
export function workerFidelity(f: FidelityFacts): FidelityMatrix {
  const items = FidelityItemId.options.filter((id): id is WorkerItem => fidelityOwner(id) === "worker").map((id) => {
    const refs = f.refs[id] ?? [];
    return { id, ...ITEMS[id](f, refs.length > 0), refs: capRefs(refs) };
  });
  return FidelityMatrix.parse({ version: 1, target: f.target, bundleSha256: f.bundleSha256, items });
}

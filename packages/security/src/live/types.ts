// Z91: 실제 점검 타입. packages/contracts/src/security.ts (Zod) 와 같은 모양을 손으로 옮겼다.
// 이 패키지는 zod 를 런타임에 안 쓰게 두어 점검 코드를 의존성 없이 시험한다. 두 모양이 같은지는 apps/api 시험에서 서로 대입해 본다
import type { Provider } from "@svc/contracts";

export type LiveCheckState = "pass" | "warn" | "fail" | "unavailable" | "n_a";
export type LiveCheckCategory = "public_ports" | "storage_encryption" | "tls" | "iam" | "secrets";
export type LiveCheckKey =
  | "public_ports.db" | "public_ports.network" | "public_ports.cluster_api" | "public_ports.services"
  | "storage_encryption.db" | "storage_encryption.k8s_secrets"
  | "tls.db" | "tls.ingress"
  | "iam.app_identity" | "iam.k8s_rbac"
  | "secrets.db_credential" | "secrets.workload";

export interface LiveCheck {
  key: LiveCheckKey; category: LiveCheckCategory; title: string; resource: string;
  state: LiveCheckState; evidence: string; source: string;
}
export interface LiveSecurityReport {
  side: "source" | "target"; provider: Provider; envId: string; checkedAt: string; durationMs: number;
  origin: "live" | "snapshot"; credentials: "ok" | "unavailable" | "n_a"; reason: string | null;
  summary: { pass: number; warn: number; fail: number; unavailable: number; na: number };
  checks: LiveCheck[];
}
export type RegressionChange = "worse" | "better" | "same" | "unknown";
export interface RegressionItem {
  key: LiveCheckKey; category: LiveCheckCategory; title: string;
  before: LiveCheckState | null; after: LiveCheckState | null; change: RegressionChange;
  beforeEvidence: string | null; afterEvidence: string | null;
}

// 열쇠마다 영역·제목 (한 곳에서만 정한다)
export const CHECK_META: Record<LiveCheckKey, { category: LiveCheckCategory; title: string }> = {
  "public_ports.db": { category: "public_ports", title: "DB 가 인터넷에 열려 있나" },
  "public_ports.network": { category: "public_ports", title: "보안그룹·방화벽 전체 공개 포트" },
  "public_ports.cluster_api": { category: "public_ports", title: "클러스터 API 서버 공개 범위" },
  "public_ports.services": { category: "public_ports", title: "앱 네임스페이스 LoadBalancer·NodePort" },
  "storage_encryption.db": { category: "storage_encryption", title: "DB 저장소 암호화" },
  "storage_encryption.k8s_secrets": { category: "storage_encryption", title: "k8s Secret 저장 암호화(봉투)" },
  "tls.db": { category: "tls", title: "DB 접속 TLS 강제" },
  "tls.ingress": { category: "tls", title: "앱 진입점 TLS 종단" },
  "iam.app_identity": { category: "iam", title: "앱 클라우드 신원 과다 권한" },
  "iam.k8s_rbac": { category: "iam", title: "앱 네임스페이스 RBAC 과다 권한" },
  "secrets.db_credential": { category: "secrets", title: "DB 비밀번호 보관 위치" },
  "secrets.workload": { category: "secrets", title: "Pod env·ConfigMap 평문 비밀값" },
};
export const ALL_KEYS = Object.keys(CHECK_META) as LiveCheckKey[];

export const check = (key: LiveCheckKey, state: LiveCheckState, resource: string, evidence: string, source: string): LiveCheck =>
  ({ key, ...CHECK_META[key], resource, state, evidence, source });

// 12자리 AWS 계정 번호는 응답에 안 싣는다 (ARN·오류 문구 안)
export const maskAccount = (s: string) => s.replace(/\b\d{12}\b/g, "<계정>");

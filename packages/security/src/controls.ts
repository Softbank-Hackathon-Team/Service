import type { Finding, Provider } from "@svc/contracts";

// 보안 통제 12개. 매트릭스의 행이다.
// DRAFT(ai): 목록·소스는 보안·거버넌스 설계 v1(controls.yaml, Prowler 5.47.0 기준)에서 옮겼다. 팀 검토 전
export type Tool = Finding["tool"] | "attest";
export type EnvKind = Exclude<Provider, "azure_mock"> | "azure_mock";

export interface Control {
  id: string;
  area: "IAM" | "ENC" | "AUD" | "VIO";
  title: string;
  // 환경 종류마다 이 통제의 결과를 내는 도구. 비어 있으면 그 환경에서는 "적용 안 됨"
  sources: Partial<Record<EnvKind, Tool[]>>;
}

const cloud = (aws: Tool[], gcp: Tool[], onprem: Tool[]) => ({ aws, gcp, onprem });

export const CONTROLS: readonly Control[] = [
  { id: "SEC-IAM-01", area: "IAM", title: "관리자 계정 MFA", sources: cloud(["prowler"], ["prowler"], ["attest"]) },
  { id: "SEC-IAM-02", area: "IAM", title: "관리자 전권(*:*) 정책 0개", sources: cloud(["prowler"], ["prowler"], ["kyverno"]) },
  { id: "SEC-IAM-03", area: "IAM", title: "앱 Pod는 기본 서비스 계정 토큰을 안 붙임", sources: cloud(["kyverno"], ["kyverno"], ["kyverno"]) },
  { id: "SEC-ENC-01", area: "ENC", title: "DB 저장·전송 암호화", sources: cloud(["prowler"], ["prowler"], ["agent_script"]) },
  { id: "SEC-ENC-02", area: "ENC", title: "외부 노출은 TLS만", sources: cloud(["prowler"], ["prowler"], ["agent_script"]) },
  { id: "SEC-ENC-03", area: "ENC", title: "시크릿이 코드·이미지·환경 변수에 없음", sources: cloud(["trivy"], ["trivy"], ["trivy"]) },
  { id: "SEC-AUD-01", area: "AUD", title: "클라우드·클러스터 감사 로그 켜짐", sources: cloud(["prowler"], ["prowler"], ["agent_script"]) },
  { id: "SEC-AUD-02", area: "AUD", title: "플랫폼 조작 100% 기록 + 체인 무결", sources: cloud(["audit_verify"], ["audit_verify"], ["audit_verify"]) },
  { id: "SEC-VIO-01", area: "VIO", title: "0.0.0.0/0 관리·DB 포트 없음", sources: cloud(["prowler"], ["prowler"], ["kyverno"]) },
  { id: "SEC-VIO-02", area: "VIO", title: "이미지는 우리 레지스트리 + critical CVE 0", sources: cloud(["trivy"], ["trivy"], ["trivy"]) },
  { id: "SEC-VIO-03", area: "VIO", title: "root·privileged 컨테이너 0", sources: cloud(["kyverno"], ["kyverno"], ["kyverno"]) },
  { id: "SEC-VIO-04", area: "VIO", title: "활성 위협 0건", sources: cloud(["guardduty"], ["scc"], ["falco"]) },
];

// Azure는 모양+Mock만이라 소스가 없다 → 모든 칸이 "적용 안 됨"
export const sourcesFor = (c: Control, env: EnvKind): Tool[] => c.sources[env] ?? [];
export const controlById = (id: string) => CONTROLS.find((c) => c.id === id);

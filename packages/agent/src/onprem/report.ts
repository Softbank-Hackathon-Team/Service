import { DeployResult, type AgentReport } from "@svc/contracts";

// 온프레 k3s Agent → 플랫폼 보고 (HTTP POST /api/v1/agent/reports).
// 온프레는 밖에서 클러스터로 들어갈 길이 없으므로 Agent가 안에서 밖으로 보고한다.
// Z92: 보고 모양은 packages/contracts/src/agent.ts, 서명·검증은 packages/contracts/src/agent-sig.ts 로 옮겼다 (api 와 같이 쓰려고).
//   예전 import 경로(@svc/agent)가 그대로 되게 다시 내보낸다
export { AgentReport } from "@svc/contracts";
export * from "@svc/contracts/agent-sig";

// "넣었음" 보고 → GitOps 배포 결과 계약
export function toDeployResult(r: Extract<AgentReport, { kind: "deploy" }>): DeployResult {
  return DeployResult.parse({ bundleHash: r.bundleHash, status: r.status, resources: r.resources, reason: r.reason });
}

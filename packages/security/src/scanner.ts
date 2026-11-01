import { Finding, type Provider } from "@svc/contracts";
import { CONTROLS, sourcesFor } from "./controls.js";

// 환경 하나의 보안 결과를 모으는 수집기. security-scan 큐 처리기가 부른다
export interface SecurityScanner {
  readonly provider: Provider;
  scan(env: { envId: string; resourcePrefix: string }, now: Date): Promise<Finding[]>;
}

// STUB: 진짜 수집기는 Prowler(AWS/GCP), Kyverno 보고서, Trivy, GuardDuty/SCC, 온프레 Agent 보고를 읽는다.
// 지금은 클라우드를 부르지 않고 고정 결과를 돌려준다. evidence 앞에 "STUB:"을 붙여 화면에서도 구분된다.
// demoFail 에 통제 번호를 넣으면 그 통제만 fail 로 만든다 (데모·시험용)
export function stubScanner(provider: Provider, demoFail: string[] = []): SecurityScanner {
  return {
    provider,
    async scan(env, now) {
      const out: Finding[] = [];
      for (const c of CONTROLS) {
        for (const tool of sourcesFor(c, provider)) {
          if (tool === "attest") continue; // 사람 확인은 수집기가 만들지 않는다
          const fail = demoFail.includes(c.id);
          out.push(Finding.parse({
            tool,
            toolCheckId: `stub_${c.id.toLowerCase().replaceAll("-", "_")}`,
            controlId: c.id,
            resource: `${env.resourcePrefix}/${c.area.toLowerCase()}`,
            status: fail ? "fail" : "pass",
            severity: fail ? (c.id === "SEC-VIO-04" ? "critical" : "high") : "info",
            kind: c.id === "SEC-VIO-04" ? "threat" : "posture",
            observedAt: now.toISOString(),
            evidence: `STUB: ${provider} ${c.title} ${fail ? "위반 (가짜)" : "통과 (가짜)"}`,
          }));
        }
      }
      return out;
    },
  };
}

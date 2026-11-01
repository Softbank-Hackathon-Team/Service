import { z } from "zod";

// DRAFT(ai): N2 추가안 반영 (통합).
// gitops 레포 plan.json 모양 (WORKER-CONTRACT.md 2절). 워커(apps/worker/src/gitops)와 온프레 Agent가 같이 쓴다.
// 지금 워커는 같은 모양의 TS interface(PlanFile)를 쓴다. 이게 들어오면 interface 대신 이 타입을 import 한다
export const GitopsEnv = z.enum(["aws-eks", "gcp-gke", "onprem-k3s", "azure-mock"]);
export const GitopsPlanFile = z.object({
  schema: z.literal("platform-gitops/plan@1"),
  tenant: z.string().regex(/^t-[0-9a-f]{8}$/),
  app: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  env: GitopsEnv,
  migrationId: z.uuid(),
  planId: z.uuid(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  adapterVersion: z.string(),
  chart: z.object({ path: z.literal("charts/app"), version: z.string() }).strict(),
  target: z.object({
    delivery: z.enum(["argocd-push", "agent-pull", "mock"]),
    cluster: z.string().nullable(),
    namespace: z.string(),
  }).strict(),
  approvedWeights: z.array(z.number().int().min(1).max(100)),
  bundleSha256: z.string().regex(/^([0-9a-f]{64})?$/),
}).strict();
export type GitopsPlanFile = z.infer<typeof GitopsPlanFile>;

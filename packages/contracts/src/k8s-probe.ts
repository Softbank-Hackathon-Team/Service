import { z } from "zod";

// PB-1·PR-1 (base0800 위 최소 이식): 차트가 toYaml 로 그대로 넣는 k8s 프로브 모양. ChartValues 전체 계약(d8-pb1)은 아직 이 계열에 없음
export const K8sProbe = z.object({
  httpGet: z.object({ path: z.string().optional(), port: z.union([z.number().int(), z.string()]), scheme: z.enum(["HTTP", "HTTPS"]).optional() }).strict().optional(),
  tcpSocket: z.object({ port: z.union([z.number().int(), z.string()]) }).strict().optional(),
  grpc: z.object({ port: z.number().int() }).strict().optional(),
  exec: z.object({ command: z.array(z.string()) }).strict().optional(),
  initialDelaySeconds: z.number().int().optional(),
  periodSeconds: z.number().int().optional(),
  timeoutSeconds: z.number().int().optional(),        // PR-1
  successThreshold: z.number().int().optional(),      // PR-1
  failureThreshold: z.number().int().optional(),
  terminationGracePeriodSeconds: z.number().int().optional(),   // PR-1: 프로브별 종료 유예 (k8s 1.25+)
}).strict();
export type K8sProbe = z.infer<typeof K8sProbe>;

import { z } from "zod";

// DRAFT(ai): 이미지가 없는 출발(VM·소스)에서 도착 이미지를 만드는 계획의 모양만 둔다.
//   실제 빌드는 계획 승인 뒤 provisioning 의 image-build 큐가 맡는다(설계 23번 3.3장). 여기는 계약만.
//   필드는 설계 23번 3.2장 BuildPlan 그대로. 결과(BuildResult)는 빌드 구현 때 더한다.
export const BuildPlan = z.object({
  repo: z.string().min(1),                              // 소스 레포 (예: github.com/acme/shop)
  commit: z.string().min(1),                            // 운영 버전에 맞춘 커밋
  path: z.string(),                                     // 레포 안 위치 ("." = 맨 위)
  method: z.enum(["dockerfile", "buildpacks"]),
  builder: z.string().optional(),                       // buildpacks builder 이미지@digest
  startCommand: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  evidence: z.array(z.string()).max(50),                // 어느 파일에서 알아냈나 (Dockerfile, package.json …)
}).strict();
export type BuildPlan = z.infer<typeof BuildPlan>;

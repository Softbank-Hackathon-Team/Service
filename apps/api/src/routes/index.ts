import type { FastifyInstance } from "fastify";
import { migrationRoutes } from "./migrations.js";
import { planRoutes } from "./plans.js";
import { environmentRoutes } from "./environments.js";
import { envInventoryRoutes } from "./env-inventory.js";
import { envPermissionRoutes } from "./env-permissions.js";
import { costRoutes } from "./cost.js";
import { agentReviewRoutes } from "./agent-review.js";
import { docsRoutes } from "./docs.js";
import { migrationCostRoutes } from "./migration-cost.js";
import { controlRoutes } from "./control.js";
import { reportRoutes } from "./report.js";
import { timelineRoutes } from "./timeline.js";
import { securityRoutes } from "./security.js";
import { liveTrafficRoutes } from "./live-traffic.js";
import { authRoutes } from "./auth.js";
import { signupRoutes } from "./signup.js";
import { agentReportRoutes } from "./agent-reports.js";
import { specRoutes } from "./spec.js";
import { tokenRoutes } from "./tokens.js";
import { agentEnrollRoutes } from "./agent-enroll.js";
import { onpremInstallRoutes } from "./onprem-install.js";
import { eventRoutes } from "./events.js";
import { rehearsalRoutes } from "./rehearsal.js";
import { envCostRoutes } from "./env-cost.js";

// Z81: 업무 경로 목록 한 곳. 예전엔 main.ts 와 tools/openapi/gen-openapi.ts 가 같은 목록을 따로 적었다
//   (main.ts 가 import 하자마자 listen 해서 명세 생성기가 불러 쓸 수 없었다). 새 경로 파일은 여기에 한 줄만 넣는다.
// file = 명세 x-source-file 칸에 쓰는 경로. 순서 = 서버 등록 순서(main.ts 예전 순서 그대로)
// DECISION(team): 모든 업무 경로는 /api/v1 아래 (10/31). healthz·readyz는 루트에 둔다
export const API_PREFIX = "/api/v1";
export const ROUTE_PLUGINS: ReadonlyArray<{ file: string; plugin: (app: FastifyInstance) => Promise<void> }> = [
  { file: "apps/api/src/routes/migrations.ts", plugin: migrationRoutes },
  { file: "apps/api/src/routes/plans.ts", plugin: planRoutes },
  { file: "apps/api/src/routes/environments.ts", plugin: environmentRoutes },
  { file: "apps/api/src/routes/env-inventory.ts", plugin: envInventoryRoutes }, // Z86: 환경별 자원 (읽기 전용)
  { file: "apps/api/src/routes/env-permissions.ts", plugin: envPermissionRoutes }, // PERM-GATE: 고객 권한 묶음 상태·다시 확인
  { file: "apps/api/src/routes/cost.ts", plugin: costRoutes },
  { file: "apps/api/src/routes/agent-review.ts", plugin: agentReviewRoutes }, // Z58: AI 점검 결과 (S7)
  { file: "apps/api/src/routes/docs.ts", plugin: docsRoutes },
  { file: "apps/api/src/routes/migration-cost.ts", plugin: migrationCostRoutes },
  { file: "apps/api/src/routes/control.ts", plugin: controlRoutes },
  { file: "apps/api/src/routes/report.ts", plugin: reportRoutes },
  { file: "apps/api/src/routes/timeline.ts", plugin: timelineRoutes },
  { file: "apps/api/src/routes/security.ts", plugin: securityRoutes },
  { file: "apps/api/src/routes/live-traffic.ts", plugin: liveTrafficRoutes },
  { file: "apps/api/src/routes/auth.ts", plugin: authRoutes }, // Z93: 로그인·갱신·로그아웃
  { file: "apps/api/src/routes/signup.ts", plugin: signupRoutes }, // 팀 가입 명부(docs/team-env/registry.yaml)로 초대 코드 가입
  { file: "apps/api/src/routes/agent-reports.ts", plugin: agentReportRoutes }, // Z92: 온프레 Agent 보고 받기·보기
  { file: "apps/api/src/routes/spec.ts", plugin: specRoutes }, // Z100: 이전의 최신 명세 한 판 (읽기 전용)
  { file: "apps/api/src/routes/tokens.ts", plugin: tokenRoutes }, // L8b: CLI 개인 토큰
  { file: "apps/api/src/routes/agent-enroll.ts", plugin: agentEnrollRoutes }, // L6: 온프레 등록 토큰 → Agent 키
  { file: "apps/api/src/routes/onprem-install.ts", plugin: onpremInstallRoutes }, // 온프레 설치 한 줄이 받는 스크립트·묶음 (인증 없음)
  { file: "apps/api/src/routes/events.ts", plugin: eventRoutes }, // 화면 신호 (SSE, GET /events)
  { file: "apps/api/src/routes/rehearsal.ts", plugin: rehearsalRoutes }, // vCluster 리허설 줄 읽기 (GET /migrations/:id/rehearsal)
  { file: "apps/api/src/routes/env-cost.ts", plugin: envCostRoutes }, // 근거 있는 비용: 환경 지금 월 비용·옮긴 뒤 한 달·1년 + 프로모션
];

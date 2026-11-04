import { z } from "zod";
import { Finding } from "./results.js";

// Z92: 온프레 Agent → 플랫폼 보고 (POST /api/v1/agent/reports). api ↔ agent 경계라 contracts 로 옮겼다 (예전 packages/agent/src/onprem/report.ts)
// 회사·환경은 본문이 아니라 Agent 키(agent_keys 표)로 정한다. 본문에 tenantId 를 넣으면 strict 가 막는다
const Common = { agentVersion: z.string().max(40), sentAt: z.iso.datetime({ offset: true }) };

export const AgentReport = z.discriminatedUnion("kind", [
  // Kyverno 정책 보고서(PolicyReport)·Falco 경보·점검 스크립트 결과를 Finding 모양으로
  z.object({ kind: z.literal("security"), ...Common, findings: z.array(Finding).max(500) }).strict(),
  // GitOps: 온프레의 "배포 끝" 기준은 Agent 의 "넣었음" 보고다
  //   W4 자동 보고: Agent 가 클러스터 안 Argo Application 을 읽어 app(= 워커 argoAppName) + bundleHash(= Argo 가 적용한 커밋)로 보낸다.
  //   Agent 는 이전 번호를 모른다 → migrationId 는 손으로 보내는 CLI 보고(deploy --migration)에만 있다. 워커는 app + 커밋으로 짝짓는다
  z.object({
    kind: z.literal("deploy"), ...Common,
    migrationId: z.uuid().optional(), bundleHash: z.string().max(200),
    app: z.string().max(253).optional(),
    status: z.enum(["applied", "failed"]),
    resources: z.array(z.string().max(300)).max(200),
    reason: z.string().max(2000).optional(),
  }).strict(),
  // 살아 있음 + CloudNativePG 상태 (컷오버 전 복제 지연 확인용)
  z.object({
    kind: z.literal("heartbeat"), ...Common,
    k3sVersion: z.string().max(100),
    cnpg: z.object({
      cluster: z.string().max(100), ready: z.boolean(),
      replicationLagBytes: z.number().int().nonnegative().nullable(),
    }).strict().nullable(),
  }).strict(),
  // W5: 온프레 보안 사실 (보안 판정의 온프레 칸, ADR-005 D3). Agent 가 읽기 권한으로 잰 것만. 못 읽으면 null (지어내지 않는다)
  //   grants.level: Agent 가 실제로 받은 권한 단계 (L1 = 클러스터 범위 읽기도 됨). 판정이 "왜 모름인가"를 설명할 때 쓴다
  //   dbs: CloudNativePG Cluster 마다 한 줄. 이름은 앱 차트가 만든 이름(<앱>-<IR id>, onprem.ts cnpgName) 그대로
  z.object({
    kind: z.literal("facts"), ...Common,
    grants: z.object({ level: z.enum(["L0", "L1"]) }).strict(),
    dbs: z.array(z.object({
      namespace: z.string().max(63), cluster: z.string().max(63),
      majorVersion: z.number().int().positive().nullable(),
      // pg_hba 에 "hostnossl ... reject" 가 앞에 있으면 true. CNPG 기본 규칙은 비TLS 접속도 받는다(false)
      tlsEnforced: z.boolean().nullable(),
      authMethods: z.array(z.string().max(40)).max(20).nullable(),
      // 이 Cluster 파드를 가리키는 NodePort·LoadBalancer Service 가 있으면 true (클러스터 밖에서 닿음)
      exposed: z.boolean().nullable(),
    }).strict()).max(50),
  }).strict(),
]);
export type AgentReport = z.infer<typeof AgentReport>;
export type AgentReportKind = AgentReport["kind"];
// 보고 종류 목록 한 곳 (받음 응답·목록 화면·API 질의·DB CHECK 0047 이 같은 값을 쓴다)
export const AgentReportKinds = z.enum(["security", "deploy", "heartbeat", "facts"]);

// 받음 응답 (201)
export const AgentReportAccepted = z.object({
  id: z.uuid(),
  kind: AgentReportKinds,
  envId: z.uuid(),
  receivedAt: z.string(),
}).strict();
export type AgentReportAccepted = z.infer<typeof AgentReportAccepted>;

// 화면·운영자가 보는 받은 보고 (GET /api/v1/environments/:id/agent-reports)
export const AgentReportView = z.object({
  id: z.uuid(),
  kind: AgentReportKinds,
  keyId: z.string(),
  sentAt: z.string(),
  receivedAt: z.string(),
  migrationId: z.uuid().nullable(),
  report: AgentReport,
}).strict();
export const AgentReportList = z.object({
  envId: z.uuid(),
  // 마지막 heartbeat 받은 시각. 한 번도 안 왔으면 null
  lastHeartbeatAt: z.string().nullable(),
  // 마지막 heartbeat 가 AGENT_STALE_SEC(기본 120초)보다 오래됐으면 true
  stale: z.boolean(),
  items: z.array(AgentReportView),
}).strict();
export type AgentReportList = z.infer<typeof AgentReportList>;

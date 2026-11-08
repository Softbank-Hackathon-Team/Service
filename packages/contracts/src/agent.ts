import { z } from "zod";
import { Finding } from "./results.js";

// Z92: 온프레 Agent → 플랫폼 보고 (POST /api/v1/agent/reports). api ↔ agent 경계라 contracts 로 옮겼다 (예전 packages/agent/src/onprem/report.ts)
// 회사·환경은 본문이 아니라 Agent 키(agent_keys 표)로 정한다. 본문에 tenantId 를 넣으면 strict 가 막는다
const Common = { agentVersion: z.string().max(40), sentAt: z.iso.datetime({ offset: true }) };

// 온프레 출발 가져오기용 인벤토리 스냅숏 (kind "inventory"). pull 모드에서 워커는 고객 클러스터에 들어갈 길이 없다(들어오는 포트 0)
//   → Agent 가 안에서 읽기 전용 kubectl 목록을 클러스터 범위로 모아 밖으로 보내고, 워커 가져오기는 이 목록으로 같은 discover 를 다시 돌린다
//   DECISION(team): 온프레 출발 가져오기는 Agent 인벤토리 스냅숏으로 한다. 플랫폼은 VM 안으로 들어가지 않는다 (온프레 영역 결정, 2026-11-07)
// DRAFT(ai): 본문 상한 4 MiB (서명한 JSON 한 덩어리. API 받기 상한·Agent 보내기 전 검사가 같은 값을 쓴다)
export const AGENT_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;
// kubectl 이 실패한 읽기 (권한 없음·CRD 없음 등). 워커가 같은 종료 코드·오류 글로 다시 재생해 discover 가 직접 읽을 때와 같은 판단(검토 줄·재시도)을 한다
const InventoryReadError = z.object({ exitCode: z.number().int(), stderr: z.string().max(2000) }).strict();
// 자원 이름 = kubectl get 의 첫 인자 (deployments, clusters.postgresql.cnpg.io …)
const InventoryResource = z.string().min(1).max(253).regex(/^[a-z0-9][a-z0-9.-]*$/);
/** Secret(core secrets, 같은 이름의 CRD 포함)은 어떤 경우에도 목록 내용을 담지 않는다. Agent 는 안 읽고 오류 칸으로만 남긴다 (받는 쪽에서도 막음) */
export const isSecretResource = (r: string) => /^secrets?($|\.)/.test(r);
export const AgentInventoryList = z.union([
  // DRAFT(ai): 자원 하나당 5000개 (데모 k3s 는 수십 개. 넘으면 Agent 가 보내기 전에 크기 상한에 먼저 걸린다)
  z.object({ resource: InventoryResource.refine((r) => !isSecretResource(r), { message: "Secret 은 인벤토리에 담지 않는다" }),
    items: z.array(z.record(z.string(), z.unknown())).max(5000) }).strict(),
  z.object({ resource: InventoryResource, error: InventoryReadError }).strict(),
]);
export type AgentInventoryList = z.infer<typeof AgentInventoryList>;
export const AgentInventorySnapshot = z.object({
  kind: z.literal("inventory"), ...Common,
  // Agent 가 kubectl 로 다 읽은 시각. 신선도는 플랫폼이 받은 시각(received_at)으로 판단한다 (Agent 시계를 믿지 않는다)
  collectedAt: z.iso.datetime({ offset: true }),
  // kubectl api-resources --namespaced=true --verbs=list -o name 결과 (discover 가 앱 CRD·Gateway API·ExternalSecret 을 고르는 재료)
  apiResources: z.union([
    z.object({ names: z.array(z.string().max(253)).max(2000) }).strict(),
    z.object({ error: InventoryReadError }).strict(),
  ]),
  // 자원별 클러스터 범위 목록 (get <자원> -A -o json 의 items). DRAFT(ai): 300종
  lists: z.array(AgentInventoryList).max(300),
}).strict();
export type AgentInventorySnapshot = z.infer<typeof AgentInventorySnapshot>;

// #373 D2: 진행 중(progressing) deploy 보고의 Argo 상태. 예전엔 끝난 것(applied·failed)만 보내서 플랫폼이
//   "앱이 아직 뜨는 중"(예: CNPG Cluster 준비 대기)과 "Agent·온프레 Argo 가 멈춤"을 가르지 못하고 600초를 다 기다렸다
//   waitingOn = Application status.resources 중 Healthy 가 아닌 첫 자원 (없으면 OutOfSync 인 첫 자원). resource 는 resources 칸과 같은 "종류/네임스페이스/이름"
// DRAFT(ai): 글자 상한 (Argo 상태 이름은 짧다. 메시지는 사람이 읽는 한두 문장)
export const AgentDeployProgress = z.object({
  sync: z.string().max(40),
  health: z.string().max(40),
  message: z.string().max(500).optional(),
  waitingOn: z.object({
    resource: z.string().max(300),
    health: z.string().max(40).optional(),
    sync: z.string().max(40).optional(),
    message: z.string().max(500).optional(),
  }).strict().optional(),
}).strict();
export type AgentDeployProgress = z.infer<typeof AgentDeployProgress>;

export const AgentReport = z.discriminatedUnion("kind", [
  // Kyverno 정책 보고서(PolicyReport)·Falco 경보·점검 스크립트 결과를 Finding 모양으로
  z.object({ kind: z.literal("security"), ...Common, findings: z.array(Finding).max(500) }).strict(),
  // GitOps: 온프레의 "배포 끝" 기준은 Agent 의 "넣었음" 보고다
  //   W4 자동 보고: Agent 가 클러스터 안 Argo Application 을 읽어 app(= 워커 argoAppName) + bundleHash(= Argo 가 적용한 커밋)로 보낸다.
  //   Agent 는 이전 번호를 모른다 → migrationId 는 손으로 보내는 CLI 보고(deploy --migration)에만 있다. 워커는 app + 커밋으로 짝짓는다
  //   #373 D2: progressing = 아직 끝나지 않음 (progress 칸에 Argo 상태). 워커는 이걸 끝으로 보지 않고, 멈출 때 이유에만 싣는다.
  //   더하기만 한 칸이라 예전 Agent(applied·failed 만) 보고는 그대로 받는다. 거꾸로 새 Agent 를 예전 API 에 붙이면 progressing 이 400 이다
  //   → 플랫폼 API 를 먼저 올리고 Agent 를 올린다 (Agent 는 400 을 받으면 progressing 을 한동안 안 보낸다, packages/agent deploys.ts)
  z.object({
    kind: z.literal("deploy"), ...Common,
    migrationId: z.uuid().optional(), bundleHash: z.string().max(200),
    app: z.string().max(253).optional(),
    status: z.enum(["applied", "failed", "progressing"]),
    resources: z.array(z.string().max(300)).max(200),
    reason: z.string().max(2000).optional(),
    progress: AgentDeployProgress.optional(),
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
    // 클러스터 안 sealed-secrets 컨트롤러의 공개 봉인 인증서 (GET /v1/cert.pem). 워커가 이전별 비밀을 SealedSecret 으로 봉인할 때 쓴다
    //   못 받으면 칸이 없다 (보고 실패 아님). 선택 칸이라 이 칸을 모르는 예전 Agent 보고도 그대로 받는다
    // DRAFT(ai): 최대 16384자 (RSA 4096 인증서 PEM 은 약 1.8KB)
    sealing: z.object({
      certPem: z.string().max(16384).startsWith("-----BEGIN CERTIFICATE-----"),
      fetchedAt: z.iso.datetime({ offset: true }),
    }).strict().optional(),
    // 온프레 클러스터가 밖으로 나갈 때 쓰는 공인 IPv4 (Agent 가 EGRESS_IP_URL 에 물어본 값). 워커가 출발 계정 중계기 SSH(22)를 이 /32 에만 연다
    //   못 받으면 칸이 없다 (보고 실패 아님). 없으면 중계기를 만들지 않고 ONPREM_EGRESS_UNKNOWN 으로 멈춘다 (22 를 세상에 열지 않는다)
    egressIp: z.ipv4().optional(),
  }).strict(),
  // 온프레 출발 가져오기 재료 (위 AgentInventorySnapshot). 크다 → 받은 보고 목록 화면에는 안 싣는다 (apps/api agent-reports.ts)
  AgentInventorySnapshot,
]);
export type AgentReport = z.infer<typeof AgentReport>;
export type AgentReportKind = AgentReport["kind"];
// 보고 종류 목록 한 곳 (받음 응답·목록 화면·API 질의·DB CHECK 0047·0058 이 같은 값을 쓴다)
export const AgentReportKinds = z.enum(["security", "deploy", "heartbeat", "facts", "inventory"]);
// 받은 보고 목록(GET agent-reports)에서 고를 수 있는 종류. inventory 는 본문이 수 MB 라 목록에 싣지 않는다 (워커 가져오기만 읽는다)
export const AgentReportListKinds = AgentReportKinds.exclude(["inventory"]);

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

import type { MigrationStatus } from "./types";
import { t } from './i18n';

// 멈춘 이유 (서버 failure_code → 사람 말). 코드 목록은 packages/core/src/failure-codes.ts 한 곳에 있다.
// 화면은 코드를 큰 카드에 그대로 쓰지 않는다. 이 표의 문장으로 말하고, 코드는 "멈춘 이유" 카드 안에 둔다.
//   kind: guardrail = 지표·규칙이 멈춤(되돌릴지 정하는 근거가 지표다) / step = 단계 작업이 실패 / system = 설정·워커 문제
// 모르는 코드는 지어내지 않고 "알 수 없는 사유"로 두며, 코드는 그대로 보여 준다.

export type StopKind = "guardrail" | "step" | "system";
export interface StopReason {
  kind: StopKind;
  label: string;   // 카드 머리줄 오른쪽에 쓰는 짧은 말
  title: string;   // 큰 카드 헤드라인 (두 줄)
  hint: string;    // 무엇이 일어났는지 한 문장
}

type Rule = { match: RegExp } & StopReason;

// 위에서부터 먼저 맞는 줄을 쓴다. 넓은 접두어(TRAFFIC_, GITOPS_ …)는 좁은 것 뒤에 둔다
const RULES: Rule[] = [
  { match: /^TRAFFIC_ERROR_RATE$/, kind: "guardrail", label: t('오류율 기준 넘음'), title: t('도착 쪽 오류가\n기준을 넘었습니다'), hint: t('도착 환경의 오류율이 계획서의 되돌림 기준을 넘었습니다.') },
  { match: /^TRAFFIC_LATENCY$/, kind: "guardrail", label: t('응답 시간 기준 넘음'), title: t('도착 쪽 응답이\n기준보다 느립니다'), hint: t('도착 환경의 p95 응답 시간이 계획서의 기준 배수를 넘었습니다.') },
  { match: /^TRAFFIC_SHARE_NOT_REACHED$/, kind: "guardrail", label: t('목표 비율 못 미침'), title: t('트래픽이 목표 비율까지\n퍼지지 않았습니다'), hint: t('도착으로 간 실제 요청 비율이 다시 봐도 목표 범위 밖이었습니다.') },
  { match: /^TRAFFIC_INSUFFICIENT_SAMPLES$/, kind: "guardrail", label: t('판단할 요청 부족'), title: t('판단할 요청이\n모자랍니다'), hint: t('오류율을 판단할 만큼 요청이 들어오지 않아 더 옮기지 않았습니다.') },
  { match: /^TRAFFIC_METRICS_UNAVAILABLE$/, kind: "system", label: t('지표 못 읽음'), title: t('지표를 읽지 못해\n멈췄습니다'), hint: t('오류율과 응답 시간 지표를 읽지 못해 더 옮기지 않았습니다.') },
  { match: /^TRAFFIC_(SWITCH_FAILED|PROVIDER_ERROR|LB_MISCONFIGURED|PREFLIGHT_FAILED)$/, kind: "step", label: t('비율 변경 실패'), title: t('트래픽 비율을\n바꾸지 못했습니다'), hint: t('로드 밸런서 가중치를 바꾸거나 바뀐 값을 확인하지 못했습니다.') },
  // 워커 _fail-traffic.ts: 컷오버가 실패해 출발을 DB 주인으로 두고 트래픽을 출발 100% 로 되돌리려 했는데 재시도 뒤에도 못 함 → failed.
  //   트래픽 판정 문제가 아니다. 원래 실패 코드는 감사 detail.originalFailureCode. 롤백을 고르면 롤백 작업이 트래픽 되돌리기를 다시 한다
  { match: /^TRAFFIC_RESTORE_FAILED$/, kind: "step", label: t('트래픽 되돌리기 실패'), title: t('트래픽을 출발로\n되돌리지 못했습니다'), hint: t('DB 전환이 실패해 트래픽을 출발로 모두 되돌리려 했지만 다시 시도해도 못 했습니다. 요청 일부가 아직 도착으로 갈 수 있습니다.') },
  { match: /^TRAFFIC_/, kind: "guardrail", label: t('트래픽 이동 멈춤'), title: t('트래픽 이동이\n멈췄습니다'), hint: t('트래픽 판정이 다음 단계로 넘어가지 않았습니다.') },
  // vCluster 리허설 (워커 deploy 리허설 문). 실패하면 GitOps 에 커밋하지 않고 deploying → paused. 고객 클러스터에는 아무것도 반영하지 않았다.
  // 문장은 contracts REHEARSAL_FAILURE_CLASS 로 갈린다: 실제도 실패(would_fail) / 샌드박스가 보증 못 함(cannot_vouch) / 플랫폼 문제(platform)
  { match: /^REHEARSAL_DRY_RUN_REJECTED$/, kind: "step", label: t('리허설 · 도착이 거부'), title: t('도착 클러스터가\n매니페스트를 거부합니다'), hint: t('쿠버네티스 API 서버가 원본 매니페스트를 받지 않았습니다. 실제 배포도 거부됩니다. 고객 클러스터에는 아무것도 반영하지 않았습니다.') },
  { match: /^REHEARSAL_TARGET_POLICY_DENIED$/, kind: "step", label: t('리허설 · 도착 파드 보안'), title: t('도착 클러스터 규칙이\n이 파드를 막습니다'), hint: t('도착 환경의 파드 보안 규칙이 이 파드를 거부합니다. 실제 배포도 같은 이유로 실패합니다.') },
  // 할당량은 두 경우에 파드를 거부한다: 합이 넘음, 또는 할당량이 세는 칸(온프레 requests.*, EKS·GKE limits.*)이 빈 컨테이너 (contracts sandbox.ts QuotaBasis)
  { match: /^REHEARSAL_QUOTA_EXCEEDED$/, kind: "step", label: t('리허설 · 한도에 걸림'), title: t('도착 네임스페이스 한도에\n걸립니다'), hint: t('CPU·메모리 합이 도착 네임스페이스 한도를 넘거나, 한도가 세는 값이 비어 있는 컨테이너가 있습니다. 온프레 도착은 requests, 클라우드 도착은 limits 를 셉니다. 실제 배포도 같은 이유로 실패합니다.') },
  { match: /^REHEARSAL_CRASHLOOP$/, kind: "step", label: t('리허설 · 계속 재시작'), title: t('리허설에서 앱이\n계속 다시 시작합니다'), hint: t('실제 배포와 같은 매니페스트를 샌드박스에 올렸더니 앱이 재시작을 멈추지 않았습니다. 고객 클러스터에는 아무것도 반영하지 않았습니다.') },
  { match: /^REHEARSAL_(ROLLOUT_FAILED|NOT_READY)$/, kind: "step", label: t('리허설 · 준비 안 됨'), title: t('리허설에서 앱이\n준비되지 않았습니다'), hint: t('실제 배포와 같은 매니페스트를 샌드박스에 올렸더니 앱이 정해진 시간 안에 준비 상태가 되지 않았습니다. 고객 클러스터에는 아무것도 반영하지 않았습니다.') },
  { match: /^REHEARSAL_JOB_FAILED$/, kind: "step", label: t('리허설 · Job 실패'), title: t('리허설에서 작업(Job)이\n실패했습니다'), hint: t('샌드박스에서 돌린 Job 이 실패로 끝났습니다. 실제 배포도 같은 이유로 실패할 것입니다.') },
  { match: /^REHEARSAL_CONNECTIVITY_FAILED$/, kind: "step", label: t('리허설 · 연결 실패'), title: t('리허설에서 서비스끼리\n닿지 않았습니다'), hint: t('샌드박스 안에서 서비스 사이 연결이나 서비스 응답을 확인하지 못했습니다. 실제 배포도 같은 이유로 실패할 것입니다.') },
  { match: /^REHEARSAL_POLICY_DENIED$/, kind: "step", label: t('리허설 · 보증 못 함'), title: t('샌드박스가 이 앱을\n보증하지 못했습니다'), hint: t('샌드박스 보안 규칙(root 실행 금지 등)이 파드를 막았습니다. 앱이 고장 났다는 뜻은 아닙니다.') },
  { match: /^REHEARSAL_UNSUPPORTED_KIND$/, kind: "step", label: t('리허설 · 모르는 종류'), title: t('리허설이 모르는 자원이\n있어 멈췄습니다'), hint: t('리허설이 지원하지 않는 쿠버네티스 종류가 배포 묶음에 있어 보증하지 못했습니다. 앱이 고장 났다는 뜻은 아닙니다.') },
  { match: /^REHEARSAL_IMAGE_MIRROR_FAILED$/, kind: "system", label: t('리허설 · 이미지 복사 실패'), title: t('이미지를 샌드박스로\n복사하지 못했습니다'), hint: t('출발 레지스트리에서 샌드박스 자리로 이미지를 복사하지 못했습니다. 고객 클러스터에는 아무것도 반영하지 않았습니다.') },
  { match: /^REHEARSAL_SANDBOX_UNAVAILABLE$/, kind: "system", label: t('리허설 · 샌드박스 없음'), title: t('샌드박스를\n띄우지 못했습니다'), hint: t('플랫폼 샌드박스가 바쁘거나 없습니다. 재개하면 새 샌드박스에서 처음부터 돕니다.') },
  { match: /^REHEARSAL_TIMEOUT$/, kind: "system", label: t('리허설 · 시간 초과'), title: t('리허설이 정해진 시간 안에\n끝나지 않았습니다'), hint: t('샌드박스가 바쁘거나 멈췄습니다. 다시 재개하면 새 샌드박스에서 처음부터 돕니다.') },
  { match: /^REHEARSAL_BUNDLE_MISMATCH$/, kind: "system", label: t('리허설 · 묶음 다름'), title: t('리허설한 내용과\n올릴 내용이 달랐습니다'), hint: t('커밋 직전에 다시 만든 배포 묶음이 리허설한 것과 달라 올리지 않았습니다.') },
  // 배포 커밋 전 비밀 값 확인 (워커 deploy.ts secretValuesGate) → paused. 플랫폼은 비밀 값을 복사하지 않는다
  { match: /^SECRET_VALUES_MISSING$/, kind: "step", label: t('비밀 값 비어 있음'), title: t('도착 비밀 저장소에\n값이 비어 있습니다'), hint: t('앱을 올리기 전에 보니 도착 비밀 저장소의 그릇에 값이 없어 멈췄습니다. 플랫폼은 값을 복사하지 않습니다. 고객 도구로 값을 넣은 뒤 재개해 주세요.') },
  { match: /^SECRET_VALUES_UNKNOWN$/, kind: "step", label: t('비밀 값 확인 못 함'), title: t('도착 비밀 저장소를\n읽지 못했습니다'), hint: t('앱을 올리기 전에 도착 비밀 저장소의 그릇에 값이 들었는지 읽지 못해 멈췄습니다. 자격과 권한을 확인한 뒤 재개해 주세요.') },
  // DRAFT(ai) #253 이 더하는 코드 (온프레 CNPG 이전, 아직 main 에 없다). 문장은 그 PR 의 코드 주석으로 썼다
  { match: /^SEALING_CERT_MISSING$/, kind: "step", label: t('봉인 인증서 없음'), title: t('비밀을 봉인할\n인증서가 없습니다'), hint: t('도착 Agent 보고에 sealed-secrets 봉인 인증서가 없어 배포 커밋 전에 멈췄습니다. 설치 묶음으로 sealed-secrets 컨트롤러를 깔고 Agent 가 보고한 뒤 재개해 주세요.') },
  { match: /^REPL_DELIVERY_FAILED$/, kind: "step", label: t('복제 연결 준비 실패'), title: t('DB 복제 연결을\n준비하지 못했습니다'), hint: t('DB 복제에 쓸 서버 인증서·봉인한 비밀·터널 값을 만들지 못해 멈췄습니다.') },
  { match: /^(GITOPS|ARGO)_NOT_CONFIGURED$/, kind: "system", label: t('배포 설정 없음'), title: t('배포 설정이\n없습니다'), hint: t('서버에 GitOps 저장소나 Argo CD 설정이 없어 배포를 시작하지 못했습니다.') },
  // 승인 뒤 바뀜 (워커 gitops approvedValues): 앱을 올리기 전에 멈춘다. 도착 자원(앞 단계)은 이미 만들어져 있다
  { match: /^GITOPS_VALUES_DRIFT$/, kind: "step", label: t('승인 뒤 배포 값 바뀜'), title: t('승인한 뒤 계획이 바뀌어\n앱을 올리지 않았습니다'), hint: t('승인한 배포 값과 지금 만든 값이 달라 앱을 올리기 전에 멈췄습니다. 도착 자원은 앞 단계에서 이미 만들었습니다.') },
  { match: /^GITOPS_/, kind: "step", label: t('배포 저장소 반영 실패'), title: t('배포 저장소에\n반영하지 못했습니다'), hint: t('도착 환경 배포 내용을 GitOps 저장소에 쓰지 못했습니다.') },
  { match: /^(ARGO|DEPLOY)_/, kind: "step", label: t('배포 확인 실패'), title: t('도착 클러스터 배포가\n끝나지 않았습니다'), hint: t('앱이 도착 클러스터에 정상으로 올라왔는지 확인하지 못했습니다.') },
  // ECS·Cloud Run·VM 도착 배포 확인 (adapters runtime-health). 셋 다 paused 로 멈추고 재개할 수 있다
  { match: /^RUNTIME_OUTPUT_MISSING$/, kind: "step", label: t('배포 결과 빠짐'), title: t('도착 앱을 확인할\n출력이 없습니다'), hint: t('자원 생성 결과에 앱을 확인할 출력(서비스 이름·주소)이 빠져 정상으로 떴는지 보지 못했습니다.') },
  { match: /^RUNTIME_UNHEALTHY$/, kind: "step", label: t('앱이 정상으로 안 뜸'), title: t('도착 앱이\n정상으로 뜨지 않았습니다'), hint: t('ECS·Cloud Run·VM에 올린 앱이 정해진 시간 안에 정상 상태가 되지 않았습니다.') },
  { match: /^RUNTIME_CHECK_FAILED$/, kind: "system", label: t('앱 상태 못 읽음'), title: t('도착 앱 상태를\n읽지 못했습니다'), hint: t('도착 앱 상태를 읽는 명령이 실패해 정상으로 떴는지 확인하지 못했습니다.') },
  // 계획 단계(PLAN_IR=v2)에서 바로 failed. 계획을 만들지 않았으므로 도착에는 아무것도 생기지 않았다
  { match: /^UNSUPPORTED_V2$/, kind: "step", label: t('도착이 못 만드는 구성'), title: t('도착 환경이 이 구성을\n만들 수 없습니다'), hint: t('도착 환경이 지원하지 않는 자원이나 실행 방식이 명세에 있어 계획을 만들지 않았습니다. 아무것도 만들지 않았습니다.') },
  { match: /^NEEDS_HUMAN$/, kind: "step", label: t('사람이 정할 것 남음'), title: t('사람이 정해야 할 것이\n남아 있습니다'), hint: t('명세에 사람이 골라야 하는 값이 남아 있어 계획을 만들지 않았습니다. 아무것도 만들지 않았습니다.') },
  { match: /^PLAN_RECHECK_FAILED$/, kind: "step", label: t('계획 전 확인 실패'), title: t('계획을 만들기 전\n확인이 맞지 않았습니다'), hint: t('받아들인 명세가 없거나 도착 환경이 없거나 연결되어 있지 않아 계획을 만들지 않았습니다. 아무것도 만들지 않았습니다.') },
  { match: /^APPLY_RECHECK_FAILED$/, kind: "step", label: t('실행 직전 확인 실패'), title: t('실행 직전에\n계획이 맞지 않았습니다'), hint: t('승인한 계획의 지문·유효 시간·도착 환경을 다시 보니 맞지 않아 만들지 않았습니다.') },
  // 승인 뒤 바뀜 (워커 apply): Terraform 을 돌리기 전에 멈춘다. 아래 TF_ 줄("일부만 생겼을 수 있음")보다 먼저 와야 한다
  { match: /^TF_PLAN_DRIFT$/, kind: "step", label: t('승인 뒤 계획 바뀜'), title: t('승인한 뒤 계획이 바뀌어\n만들기 전에 멈췄습니다'), hint: t('승인한 계획과 지금 만든 계획이 달라 자원을 만들기 전에 멈췄습니다. 이번 실행으로 생긴 자원은 없습니다.') },
  { match: /^TF_BIN_MISSING$/, kind: "system", label: t('Terraform 없음'), title: t('도착 자원을 만들\n도구가 없습니다'), hint: t('서버에 Terraform 실행 파일이 없습니다.') },
  // 도착 앱이 컷오버 전까지 쓸 출발 DB 경로 (워커 db-writer.ts, apply 안 Terraform 전)
  { match: /^APP_LINK_SOURCE_MISSING$/, kind: "system", label: t('출발 DB 경로 없음'), title: t('도착 앱이 쓸\n출발 DB 경로가 없습니다'), hint: t('컷오버 전까지 도착 앱이 붙을 출발 DB 경로 설정이 플랫폼에 없어 도착 자원을 만들기 전에 멈췄습니다.') },
  { match: /^APP_LINK_SECRET_FAILED$/, kind: "step", label: t('접속 정보 저장 실패'), title: t('출발 DB 접속 정보를\n저장하지 못했습니다'), hint: t('도착 비밀 저장소에 출발 DB 접속 정보를 넣지 못해 도착 자원을 만들기 전에 멈췄습니다.') },
  // DRAFT(ai) #253: 온프레 CNPG 이전 중계기 (출발 AWS 계정에 apply 가 만들고 정리가 지운다)
  { match: /^ONPREM_EGRESS_UNKNOWN$/, kind: "step", label: t('온프레 나가는 주소 모름'), title: t('온프레의 나가는 주소를\n모릅니다'), hint: t('Agent 보고에 온프레의 나가는 IP 가 없어 중계기를 만들지 않았습니다. SSH(22)를 모든 주소에 열지 않으려고 멈췄습니다.') },
  { match: /^RELAY_CONFIG_MISSING$/, kind: "system", label: t('중계 설정 없음'), title: t('DB 중계 설정이\n없습니다'), hint: t('플랫폼의 나가는 주소 설정(PLATFORM_EGRESS_CIDRS)이 없거나 틀려 중계기를 만들지 않았습니다. 고객 쪽은 고칠 것이 없습니다. 플랫폼 운영자에게 알려 주세요.') },
  { match: /^RELAY_SOURCE_DB_UNKNOWN$/, kind: "step", label: t('출발 DB 못 정함'), title: t('중계할 출발 DB를\n정하지 못했습니다'), hint: t('명세에서 출발 RDS 를 찾지 못했거나, Postgres 가 둘 이상이거나, RDS 포트가 5432 가 아니라 중계기를 만들지 않았습니다.') },
  { match: /^RELAY_ROLE_DENIED$/, kind: "step", label: t('중계 권한 거부'), title: t('출발 계정이\n중계 권한을 거부했습니다'), hint: t('출발 실행 역할을 중계기 권한으로 빌리지 못했습니다. 고객 연결 스택에 중계기 권한이 있는지 확인해 주세요.') },
  { match: /^RELAY_PROVISION_FAILED$/, kind: "step", label: t('중계기 만들기 실패'), title: t('DB 중계기를\n만들지 못했습니다'), hint: t('출발 계정에 DB 중계기를 만들다 실패했습니다. 이미 만든 부분은 태그를 단 채 남아 있을 수 있습니다.') },
  { match: /^RELAY_TEARDOWN_FAILED$/, kind: "step", label: t('중계기 지우기 실패'), title: t('DB 중계기를\n지우지 못했습니다'), hint: t('출발 계정의 DB 중계기를 지우다 실패해 정리를 멈췄습니다.') },
  // 워커 relay/aws-relay.ts: 출발 RDS 보안 그룹 규칙을 열 권한이 연결 스택에 없음
  { match: /^RELAY_DB_EGRESS_DENIED$/, kind: "step", label: t('출발 DB 나가기 막힘'), title: t('출발 DB 보안 그룹을\n열 수 없습니다'), hint: t('출발 RDS 보안 그룹에 중계기로 나가는 5432 규칙이 없고, 연결 스택에 그 규칙을 열 권한도 없습니다. 연결 스택에 출발 DB 보안 그룹을 지정한 뒤 다시 시도해 주세요.') },
  { match: /^RELAY_DB_INGRESS_DENIED$/, kind: "step", label: t('출발 DB 들어오기 막힘'), title: t('출발 DB 보안 그룹을\n열 수 없습니다'), hint: t('출발 RDS 보안 그룹이 중계기에서 들어오는 5432 를 받지 않고, 연결 스택에 그 규칙을 열 권한도 없습니다. 연결 스택을 새 템플릿으로 업데이트한 뒤 다시 시도해 주세요.') },
  // 워커 env-layer.ts: 도착 환경 층(gcp/env: VPC·GKE·ESO)
  { match: /^ENV_LAYER_APPLY_FAILED$/, kind: "step", label: t('환경 층 만들기 실패'), title: t('도착 환경 층을\n만들지 못했습니다'), hint: t('도착 VPC·클러스터·비밀 연동(환경 층)을 만들다 실패했습니다. 만들다 만 자원은 지우지 않고 남겨 둡니다.') },
  { match: /^ENV_LAYER_BUSY$/, kind: "step", label: t('환경 층 만드는 중'), title: t('다른 마이그레이션이\n환경 층을 만들고 있습니다'), hint: t('같은 도착 환경의 환경 층을 다른 마이그레이션이 만드는 중입니다. 끝난 뒤 다시 시도해 주세요.') },
  { match: /^ENV_LAYER_CRED_MISSING$/, kind: "step", label: t('환경 층 권한 없음'), title: t('환경 층을 만들\n권한이 없습니다'), hint: t('도착 GCP 실행 역할을 빌리지 못해 환경 층을 만들지 않았습니다. 플랫폼은 자기 자격으로 고객 자원을 만들지 않습니다.') },
  { match: /^(TF|APPLY|AZURE_MOCK)_/, kind: "step", label: t('자원 생성 실패'), title: t('도착 자원을\n만들지 못했습니다'), hint: t('도착 클러스터와 DB를 만드는 중에 멈췄습니다. 일부만 생겼을 수 있습니다.') },
  { match: /^CRED_RENEW_FAILED$/, kind: "step", label: t('임시 권한 재발급 실패'), title: t('임시 권한을\n다시 받지 못했습니다'), hint: t('이 단계에 필요한 임시 역할을 다시 빌리지 못해 멈췄습니다.') },
  // DRAFT(ai) #253: 복제 끝점 기록 (db 0050) → sync paused
  { match: /^REPL_ENDPOINT_INCOMPLETE$/, kind: "system", label: t('복제 끝점 빠짐'), title: t('DB 복제 끝점이\n한쪽만 있습니다'), hint: t('이 마이그레이션의 복제 끝점 기록에 출발·도착 중 한쪽만 있어 DB 복제를 멈췄습니다.') },
  { match: /^REPL_SECRET_UNRESOLVED$/, kind: "system", label: t('복제 비밀번호 못 찾음'), title: t('DB 복제 비밀번호를\n찾지 못했습니다'), hint: t('플랫폼 설정에서 복제 비밀번호를 풀지 못해 DB 복제를 멈췄습니다. 고객 쪽은 고칠 것이 없습니다. 플랫폼 운영자에게 알려 주세요.') },
  // 워커 sync.ts: 출발 끝점(중계기 출발 입구 포함) TCP 실패, 재시도 소진 → sync paused
  { match: /^REPL_SOURCE_UNREACHABLE$/, kind: "step", label: t('출발 DB에 못 닿음'), title: t('출발 DB에\n닿지 못했습니다'), hint: t('출발 DB 주소와 포트(중계기 입구 포함)로 다시 시도해도 연결되지 않아 DB 복제를 멈췄습니다.') },
  { match: /^REPL_TARGET_UNREACHABLE$/, kind: "step", label: t('도착 DB에 못 닿음'), title: t('도착 DB에\n닿지 못했습니다'), hint: t('도착 DB 주소와 포트로 다시 시도해도 연결되지 않아 DB 복제를 멈췄습니다.') },
  { match: /^SYNC_FAILED$/, kind: "step", label: t('DB 복제 실패'), title: t('DB 복제가\n이어지지 않습니다'), hint: t('출발 DB에서 도착 DB로 가는 논리 복제가 다시 시도해도 실패했습니다.') },
  { match: /^APP_LINK_UNAVAILABLE$/, kind: "system", label: t('앱 DB 주소 못 바꿈'), title: t('도착 앱의 DB 주소를\n바꿀 길이 없습니다'), hint: t('도착 앱이 쓸 DB 주소를 도착으로 바꿀 길(GitOps 설정·연결 프록시)이 없어 출발 DB 쓰기를 막기 전에 멈췄습니다. 출발 DB 가 그대로 주인이라 서비스는 그대로 돕니다.') },
  { match: /^CUTOVER_UNFENCE_FAILED$/, kind: "step", label: t('출발 쓰기 막힘 남음'), title: t('출발 DB 쓰기 막힘을\n풀지 못했습니다'), hint: t('컷오버를 되돌리다 출발 DB의 쓰기 막힘을 풀지 못했습니다. 바로 확인해야 합니다.') },
  { match: /^CUTOVER_/, kind: "step", label: t('DB 전환 실패'), title: t('DB 전환 중에\n문제가 생겼습니다'), hint: t('DB 쓰기 담당을 도착으로 넘기는 중에 멈췄습니다.') },
  { match: /^ROLLBACK_FAILED$/, kind: "step", label: t('되돌리기 실패'), title: t('되돌리기가\n끝나지 않았습니다'), hint: t('출발로 되돌리는 작업이 다시 시도해도 끝나지 않았습니다.') },
  { match: /^IMPORT_SOURCE_UNAVAILABLE$/, kind: "step", label: t('출발 환경 못 읽음'), title: t('출발 환경에\n닿지 못했습니다'), hint: t('출발 환경을 읽지 못했습니다(자격·명령 도구·클러스터 연결). 다시 시도해도 같았습니다. 연결과 읽기 권한을 고친 뒤 다시 가져와 주세요.') },
  { match: /^IMPORT_SOURCE_INCOMPLETE$/, kind: "step", label: t('앱 재료 부족'), title: t('옮길 앱을\n다 찾지 못했습니다'), hint: t('출발 환경에서 배포·포트 같은 앱 재료를 다 찾지 못했습니다.') },
  // 워커 import.ts: 명세 모양 오류는 다시 해도 같다 (재시도 안 함). IMPORT_FAILED 는 그 밖의 오류로 재시도를 다 쓴 것
  { match: /^IMPORT_SPEC_INVALID$/, kind: "step", label: t('명세 모양 오류'), title: t('읽은 구성이\n공통 명세에 맞지 않습니다'), hint: t('출발 구성을 읽었지만 공통 명세 규칙에 맞지 않았습니다. 같은 범위로 다시 가져와도 같습니다.') },
  { match: /^IMPORT_/, kind: "step", label: t('구성 읽기 실패'), title: t('구성을\n읽지 못했습니다'), hint: t('출발 환경의 구성을 읽다가 다시 시도해도 실패했습니다.') },
  { match: /^(WORKER_LOST|JOB_NOT_PICKED|STEP_FAILED|JOB_FAILED_.+)$/, kind: "system", label: t('작업자 응답 없음'), title: t('작업자가\n응답하지 않았습니다'), hint: t('이 단계를 맡은 워커가 끝을 알리지 않았습니다.') },
  { match: /^APP_LINK_UPSTREAM_FAILED$/, kind: "step", label: t('앱 연결 실패'), title: t('앱 연결이\n끊겼습니다'), hint: t('도착 앱으로 가는 연결의 상류가 응답하지 않았습니다.') },
  // Terraform 이 띄운 도착 앱(ECS·Cloud Run·VM)의 DB 주소 바꾸기 (워커 app-link.ts switchRuntimeWriter). 지금은 컷오버·롤백 결과에만 남는다
  { match: /^APP_LINK_(STATE_MISSING|REAPPLY_FAILED)$/, kind: "step", label: t('앱 DB 주소 못 바꿈'), title: t('도착 앱의 DB 주소를\n바꾸지 못했습니다'), hint: t('Terraform 이 띄운 도착 앱(ECS·Cloud Run·VM)의 DB 주소를 바꾸려고 다시 적용했지만 끝나지 않았습니다.') },
  // core advance 기본값: 실패로 옮기면서 사유를 넘기지 않은 것
  { match: /^UNSPECIFIED$/, kind: "system", label: t('사유 없음'), title: t('작업이\n끝나지 못했습니다'), hint: t('서버가 사유 코드를 남기지 않고 실패로 옮겼습니다. 감사 기록에서 실패 직전 줄을 확인해 주세요.') },
];

// 실패 코드 없이 멈춘 이전 = 가드레일 규칙이 멈췄다 (apps/api control.ts: 이때만 재개에 ruleCleared 가 필요하다)
const BY_RULE: StopReason = {
  kind: "guardrail", label: t('가드레일 규칙'), title: t('가드레일이\n마이그레이션을 멈췄습니다'), hint: t('가드레일 규칙이 이 마이그레이션을 멈췄습니다. 규칙이 다시 지켜졌는지 확인한 뒤 고릅니다.'),
};
const UNKNOWN: Omit<StopReason, "kind"> = {
  label: t('알 수 없는 사유'), title: t('작업이\n끝나지 못했습니다'), hint: t('화면이 모르는 사유 코드입니다. 코드는 감사 기록에도 남아 있습니다.'),
};

/** 멈춘 이유. 사람이 직접 롤백·취소해서 코드가 없으면 null 이다. 일시 정지는 코드가 없어도 가드레일 규칙으로 본다. */
export function stopReasonOf(code: string | null | undefined, status: MigrationStatus): StopReason | null {
  if (!code) return status === "paused" ? BY_RULE : null;
  const rule = RULES.find((r) => r.match.test(code));
  if (!rule) return { kind: "system", ...UNKNOWN };
  const { match: _match, ...reason } = rule;
  return reason;
}

// ---- 환경 연결 실패 이유 (environments.failure_reason → 사람 말) ----
// 서버는 contracts ConnectionFailure 코드나 "PERMISSION_MISSING:<동작>"을 적는다 (워커 verify-connection, api environments).
// 뒤에 붙은 동작 이름은 고칠 곳이라 문장에 그대로 넣는다. 모르는 코드는 지어내지 않고 코드를 그대로 보인다.
// 코드 모양이 아닌 글(코드로 바뀌기 전의 옛 기록)은 그대로 둔다.
const CONNECTION: Record<string, string> = {
  ROLE_ASSUME_DENIED: t('임시 역할을 빌리지 못했습니다. 역할의 신뢰 정책과 확인 문구(ExternalId)를 확인해 주세요.'),
  ORG_POLICY_BLOCKED: t('조직 정책이 이 역할의 동작을 막았습니다. 조직 관리자에게 확인해 주세요.'),
  ROLE_NOT_FOUND: t('고객 계정에서 역할을 찾지 못했습니다. 연결 스크립트를 다시 실행해 주세요.'),
  LINK_EXPIRED: t('연결 링크가 만료됐습니다. 새 링크로 다시 연결해 주세요.'),
  K8S_ACCESS_MISSING: t('클러스터를 읽을 권한이 없습니다. 클러스터 이름과 접근 설정을 확인해 주세요.'),
  ACCOUNT_MISMATCH: t('처음 확인한 계정과 다른 계정에 연결됐습니다. 연결한 계정을 확인해 주세요.'),
  // 온프레 Agent (worker verify-connection.ts)
  AGENT_KEY_MISSING: t('온프레 Agent 키가 모두 끊겨 다시 붙을 수 없습니다. 새로 등록해 Agent 를 다시 설치해 주세요.'),
  AGENT_HEARTBEAT_STALE: t('온프레 Agent 신호가 끊겼습니다. 고객 클러스터에서 Agent 가 돌고 있는지 확인해 주세요.'),
  // 플랫폼 쪽 문제. 고객이 고칠 것은 없고, 운영자가 고친 뒤 다시 확인하면 된다
  PLATFORM_CREDENTIALS_INVALID: t('플랫폼 자격이 만료돼 연결을 확인하지 못했습니다. 고객 쪽은 고칠 것이 없습니다. 플랫폼 운영자가 고친 뒤 다시 확인해 주세요.'),
  PLATFORM_CLI_MISSING: t('플랫폼에 클라우드 명령 도구가 없어 연결을 확인하지 못했습니다. 고객 쪽은 고칠 것이 없습니다. 플랫폼 운영자에게 알려 주세요.'),
  PLATFORM_ERROR: t('플랫폼 문제로 연결 확인을 끝내지 못했습니다. 고객 쪽은 고칠 것이 없습니다. 잠시 뒤 다시 확인해 주세요.'),
};

/** 연결 실패 이유 한 문장. 이유가 없으면 null. */
export function connectionReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const [code = "", ...rest] = reason.split(":");
  const detail = rest.join(":").trim();
  if (code === "PERMISSION_MISSING") return detail ? t('관찰 역할에 권한이 빠졌습니다: {0}', { 0: detail }) : t('관찰 역할에 필요한 권한이 빠졌습니다.');
  if (CONNECTION[code]) return CONNECTION[code];
  if (/^[A-Z][A-Z0-9_]*$/.test(code)) return t('화면이 모르는 연결 실패 사유입니다 ({0}).', { 0: reason });
  return reason;
}

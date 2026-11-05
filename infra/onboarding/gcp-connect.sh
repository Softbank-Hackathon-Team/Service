#!/usr/bin/env bash
# 고객 GCP 프로젝트 연결 (Cloud Shell에서 고객이 실행). 키 파일은 만들지 않는다: 서비스 계정(SA) 3개를 만들고,
# 플랫폼 쪽 회사 전용 SA가 그 SA를 "빌려 쓸"(impersonate) 수 있게만 한다.
# 결정 3번 A안 (이전 전용 프로젝트): 프로젝트 둘을 쓴다
#   PROJECT_ID        고객 원래 프로젝트 → svc-observe(읽기만)만 둔다. 플랫폼 실행 권한은 0
#   TARGET_PROJECT_ID 이전 전용 프로젝트 → 도착 자원은 여기에만 만든다. svc-plan·svc-operate 와 실행 역할은 여기에만 (이름 조건 없음 — 방이 따로라서)
#   원래 프로젝트에 예전 판이 붙인 실행·plan 바인딩이 남아 있으면 걷어낸다
# 상태: AI 초안. 이 레포의 세션에서는 실행하지 않는다 (DRY_RUN=1이면 명령만 출력)
#
# 필요한 값 (환경변수):
#   PLATFORM_SA   플랫폼이 연결 화면에서 알려 준 이 회사 전용 SA 이메일 (t-<16진 28자>@<플랫폼 프로젝트>.iam.gserviceaccount.com)
#   PROJECT_ID    연결할 고객 원래 프로젝트 (기본: gcloud config의 project). 읽기만
#   TARGET_PROJECT_ID  이전 전용 프로젝트 (PROJECT_ID 와 달라야 함). 없는 프로젝트면 CREATE_TARGET_PROJECT=1 로 만든다
#   CREATE_TARGET_PROJECT=1  전용 프로젝트가 없으면 원래 프로젝트와 같은 폴더·조직 아래 만들고 결제 계정을 붙인다
#   BILLING_ACCOUNT    만들 때 붙일 결제 계정 ID (비우면 원래 프로젝트의 결제 계정)
#   ROLE_DIR      infra/permissions 폴더 (커스텀 역할 YAML·조건 JSON이 있는 곳, 기본 ./permissions)
# 다시 실행해도 된다(이미 있는 것은 건너뜀).
# 실행하는 사람에게 필요한 권한(11회차 고객 관점): 프로젝트 소유자(roles/owner), 또는 서비스 계정 관리자 + 역할 관리자 + 프로젝트 IAM 관리자
#   + Service Usage 관리자(iamcredentials API 켜기). 두 프로젝트 모두에서. 전용 프로젝트를 만들면 프로젝트 생성자 + 결제 계정 사용자도. 모자라면 그 단계에서 gcloud 오류로 멈추고, 권한을 받은 뒤 다시 실행하면 남은 것만 한다
# 실행: PLATFORM_SA=... PROJECT_ID=... TARGET_PROJECT_ID=... ROLE_DIR=./permissions bash gcp-connect.sh (infra 폴더에서)
#       레포 루트에서는 PLATFORM_SA=... PROJECT_ID=... TARGET_PROJECT_ID=... bash infra/onboarding/gcp-connect.sh (ROLE_DIR 은 스크립트 옆으로 잡힘)
set -euo pipefail

run() { if [ "${DRY_RUN:-0}" = "1" ]; then echo "+ $*"; else "$@"; fi; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
# FM-CON-03: ROLE_DIR 이 틀리거나(레포 루트에서 ./permissions) 없으면 스크립트 옆 ../permissions 로 (어느 폴더에서 쳐도 같은 파일)
SCRIPT_ROLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../permissions" 2>/dev/null && pwd || true)"
ROLE_DIR="${ROLE_DIR:-./permissions}"
if [ ! -f "${ROLE_DIR}/gcp-operate-custom-role.yaml" ] && [ -n "${SCRIPT_ROLE_DIR}" ] && [ -f "${SCRIPT_ROLE_DIR}/gcp-operate-custom-role.yaml" ]; then
  ROLE_DIR="${SCRIPT_ROLE_DIR}"
fi
: "${PLATFORM_SA:?PLATFORM_SA 필요 (연결 화면에서 복사)}"
: "${PROJECT_ID:?PROJECT_ID 필요}"
TARGET_PROJECT_ID="${TARGET_PROJECT_ID:-}"
# 결정 3번 A안: 전용 프로젝트가 없으면 아무것도 바꾸기 전에 멈춘다
if [ -z "${TARGET_PROJECT_ID}" ]; then
  echo "TARGET_PROJECT_ID 필요: 도착 자원을 만들 이전 전용 프로젝트 ID (원래 프로젝트와 다른 것). 새로 만들려면 CREATE_TARGET_PROJECT=1 도 같이" >&2
  exit 2
fi
if ! [[ "${TARGET_PROJECT_ID}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then echo "TARGET_PROJECT_ID 형식이 아님: ${TARGET_PROJECT_ID}" >&2; exit 2; fi
if [ "${TARGET_PROJECT_ID}" = "${PROJECT_ID}" ]; then
  echo "TARGET_PROJECT_ID 가 원래 프로젝트와 같음: 도착 자원은 따로 방(전용 프로젝트)에만 만든다" >&2
  exit 2
fi

# 회사 전용 SA 이름 규칙 검사: 다른 회사 SA나 사람 계정이면 거부 (혼동된 대리인 방지)
# DRAFT(ai): 이름 규칙 t-<UUID 16진 28자> (25번 H-L5)
if ! [[ "${PLATFORM_SA}" =~ ^t-[0-9a-f]{28}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]]; then
  echo "PLATFORM_SA 형식이 아님: ${PLATFORM_SA}" >&2
  exit 1
fi

# FM-CON-03: 역할 파일이 없으면 아무것도 만들기 전에 멈춘다 (예전: 관찰 권한만 넣고 중간에 멈춰 반쯤 연결된 상태가 남음)
for f in gcp-operate-custom-role.yaml gcp-operate-iam-custom-role.yaml gcp-operate-db-secret-role.yaml gcp-operate-iam-binding-condition.json gcp-operate-db-secret-condition.json; do
  if [ ! -f "${ROLE_DIR}/${f}" ]; then echo "역할 파일 없음: ${ROLE_DIR}/${f} (infra 폴더에서 치거나 ROLE_DIR=<레포>/infra/permissions)" >&2; exit 2; fi
done

OBSERVE_SA="svc-observe@${PROJECT_ID}.iam.gserviceaccount.com"
OPERATE_SA="svc-operate@${TARGET_PROJECT_ID}.iam.gserviceaccount.com"
# ID-7: plan 단계(terraform plan·precheck) 전용 SA. 실행 역할의 읽기(get·list·getIamPolicy)만 가진다 → plan 이 지우기 권한 토큰을 안 받는다
PLAN_SA="svc-plan@${TARGET_PROJECT_ID}.iam.gserviceaccount.com"
# 예전 판(한 프로젝트)이 원래 프로젝트에 만든 실행·plan SA. 바인딩만 걷어낸다 (SA 자체는 고객이 지워도 됨)
OLD_OPERATE_SA="svc-operate@${PROJECT_ID}.iam.gserviceaccount.com"
OLD_PLAN_SA="svc-plan@${PROJECT_ID}.iam.gserviceaccount.com"

# 다시 실행해도 안전하다(멱등): 만들기 전에 있는지 먼저 확인하고, 있으면 건너뛴다.
# DRY_RUN=1 이면 gcloud를 아무것도 부르지 않으므로 "없다"고 보고 명령만 모두 출력한다.
# 확인이 권한 부족 등으로 실패하면 "없다"로 보고 만들기를 시도한다 → 만들기에서 진짜 오류가 드러나 멈춘다.
dry() { [ "${DRY_RUN:-0}" = "1" ]; }
skip() { echo "= 이미 있음, 건너뜀: $*"; }
# 확인 명령이 성공하면 있음
present() { ! dry && "$@" >/dev/null 2>&1; }
# 확인 명령의 출력이 비어 있지 않으면 있음 (정책 바인딩 조회용)
listed() { local out; if dry; then return 1; fi; out="$("$@" 2>/dev/null)" || return 1; [ -n "${out}" ]; }

ensure_sa() { # 이름
  if present gcloud iam service-accounts describe "$1@${P}.iam.gserviceaccount.com" --project="${P}"; then skip "서비스 계정 $1"
  else run gcloud iam service-accounts create "$1" --project="${P}" --display-name="platform ${1#svc-}"; fi
}
# 역할: 있으면 건너뜀. 삭제 표시(deleted: true, 7~37일 보관)된 역할이면 되살린다. 내용이 달라졌는지는 비교하지 않는다(처음 만든 그대로)
ensure_role() { # 역할ID, 만들 때 추가 인자...
  local id="$1"; shift
  local desc=""
  if ! dry && desc="$(gcloud iam roles describe "${id}" --project="${P}" 2>/dev/null)"; then
    if printf '%s' "${desc}" | grep -q '^deleted: true'; then run gcloud iam roles undelete "${id}" --project="${P}"
    else skip "역할 ${id}"; fi
  else
    run gcloud iam roles create "${id}" --project="${P}" "$@"
  fi
}
# OBSROLE3: 이미 있는 역할도 권한이 모자라면 채운다. 예전 버전 스크립트로 만든 고객의 관찰 역할에는 새 권한이 없다.
#   --add-permissions 는 빠진 권한만 더하고 있는 권한은 안 지운다(고객이 따로 넣은 것도 그대로). 관찰 역할(읽기만)에만 쓴다 —
#   실행 역할은 권한이 늘면 할 수 있는 일이 늘기 때문에 여기서 자동으로 바꾸지 않는다.
#   권한 목록을 못 읽으면(iam.roles.get 없음) 바꾸지 않고 알린다. DRY_RUN 에서는 역할을 새로 만드는 명령만 나오므로 부르지 않는다.
sync_role_permissions() { # 역할ID 원하는권한(쉼표)
  local id="$1" want="$2" have missing="" p
  dry && return 0
  if ! have="$(gcloud iam roles describe "${id}" --project="${P}" --format='value(includedPermissions)' 2>/dev/null)"; then
    echo "! 역할 ${id} 의 권한 목록을 못 읽음 — 권한 갱신을 건너뜀 (iam.roles.get 권한 필요)" >&2
    return 0
  fi
  have=";${have//,/;};"   # value() 출력은 ; 로 이어진다
  local IFS=','
  for p in ${want}; do
    case "${have}" in *";${p};"*) ;; *) missing="${missing:+${missing},}${p}" ;; esac
  done
  unset IFS
  if [ -z "${missing}" ]; then echo "= 역할 ${id} 권한 최신"
  else
    echo "~ 역할 ${id} 에 빠진 읽기 권한 추가: ${missing}"
    # VOBSROLE3: 추가가 거절돼도(iam.roles.update 없음·지원 안 하는 권한) 연결의 나머지 단계는 계속한다. 예전엔 set -e 로 여기서 멈춰
    #   예전 스크립트로 반쯤 만든 고객이 다시 실행하면 바인딩·tokenCreator 를 못 만들었다(갱신 전보다 나빠짐). 빠진 권한은 플랫폼 연결 확인이 다시 알려 준다
    if ! run gcloud iam roles update "${id}" --project="${P}" --add-permissions="${missing}"; then
      echo "! 역할 ${id} 권한 추가 실패 — 연결은 계속한다. 프로젝트 소유자가 이 스크립트를 다시 실행하거나 콘솔에서 위 권한을 역할에 더할 것" >&2
    fi
  fi
}
# 프로젝트 바인딩: 같은 주체·역할(조건 바인딩이면 조건 있는 것)이 이미 있으면 건너뜀
ensure_project_binding() { # 주체SA 역할  (조건 없는 바인딩)
  local sa="$1" role="$2"
  if listed gcloud projects get-iam-policy "${P}" --flatten="bindings[].members" --filter="bindings.role=${role} AND bindings.members=serviceAccount:${sa} AND NOT bindings.condition:*" --format="value(bindings.role)"; then
    skip "프로젝트 권한 ${sa} → ${role}"
  else
    run gcloud projects add-iam-policy-binding "${P}" --member="serviceAccount:${sa}" --role="${role}" --condition=None
  fi
}
# 조건 파일의 "제목<TAB>식" 한 줄 (JSON 의 \" 를 " 로 되돌림 = gcloud value() 가 찍는 모양)
cond_line() { # 조건파일
  local t e
  t="$(sed -n 's/^ *"title": *"\([^"]*\)".*/\1/p' "$1" | head -n 1)"
  e="$(sed -n 's/^ *"expression": *"\(.*\)",\{0,1\} *$/\1/p' "$1" | head -n 1 | sed 's/\\"/"/g')"
  printf '%s\t%s\n' "${t}" "${e}"
}
# FM-GCP-10/12: 조건부 바인딩을 "조건 파일 목록과 정확히 같게" 맞춘다 (보조 역할 _iam·_db_secret). 같은 역할에 조건부 바인딩이 여럿이어도 된다
#   - 이미 같은 제목·같은 식이 전부 있고 다른 것이 없으면 → 건너뜀
#   - 아무 조건부 바인딩도 없으면 → 파일마다 추가
#   - 다른 조건(손으로 고친 식, 예전 제목, 제목은 같은데 식이 다름)이 하나라도 있으면 → 그 SA·역할 바인딩을 전부 걷어내고(--all) 파일대로 다시 넣는다
#     (실측 11/4: 손으로 좁힌 resource.service 만의 식이 남으면 이름 규칙 없이 넓은 권한이 그대로 남았다. 건너뛰면 안 됨)
ensure_cond_bindings() { # 주체SA 역할 조건파일...
  local sa="$1" role="$2" f want have
  shift 2
  want="$(for f in "$@"; do cond_line "${f}"; done | LC_ALL=C sort)"
  have=""
  if ! dry; then
    have="$(gcloud projects get-iam-policy "${P}" --flatten="bindings[].members" \
      --filter="bindings.role=${role} AND bindings.members=serviceAccount:${sa} AND bindings.condition:*" \
      --format="value(bindings.condition.title,bindings.condition.expression)" 2>/dev/null | LC_ALL=C sort)" || have=""
  fi
  if [ -n "${have}" ] && [ "${have}" = "${want}" ]; then
    for f in "$@"; do skip "프로젝트 권한 ${sa} → ${role} (조건 $(cond_line "${f}" | cut -f1))"; done
    return 0
  fi
  if [ -n "${have}" ]; then
    echo "! ${role}: 이미 있는 조건부 바인딩이 조건 파일과 다름 → 걷어내고 파일대로 다시 넣음 (있던 제목: $(printf '%s\n' "${have}" | cut -f1 | tr '\n' ' '))"
    run gcloud projects remove-iam-policy-binding "${P}" --member="serviceAccount:${sa}" --role="${role}" --all
  fi
  for f in "$@"; do
    run gcloud projects add-iam-policy-binding "${P}" --member="serviceAccount:${sa}" --role="${role}" --condition-from-file="${f}"
  done
}
# ID-4: 예전 스크립트가 만든 "조건 없는" 같은 역할 바인딩을 걷어낸다 (조건부 바인딩이 생긴 뒤에만 부른다. 남겨 두면 조건이 무의미)
drop_unconditioned_binding() { # 주체SA 역할
  local sa="$1" role="$2"
  if listed gcloud projects get-iam-policy "${P}" --flatten="bindings[].members" --filter="bindings.role=${role} AND bindings.members=serviceAccount:${sa} AND NOT bindings.condition:*" --format="value(bindings.role)"; then
    run gcloud projects remove-iam-policy-binding "${P}" --member="serviceAccount:${sa}" --role="${role}" --condition=None
  fi
}
ensure_token_creator() { # 대상 SA
  local target="$1"
  if listed gcloud iam service-accounts get-iam-policy "${target}" --project="${P}" --flatten="bindings[].members" \
      --filter="bindings.role=roles/iam.serviceAccountTokenCreator AND bindings.members=serviceAccount:${PLATFORM_SA}" --format="value(bindings.role)"; then
    skip "tokenCreator ${PLATFORM_SA} → ${target}"
  else
    run gcloud iam service-accounts add-iam-policy-binding "${target}" --project="${P}" \
      --member="serviceAccount:${PLATFORM_SA}" --role="roles/iam.serviceAccountTokenCreator"
  fi
}

# 결정 3번 A안: 주체·역할 바인딩이 조건 있든 없든 하나라도 있으면 전부 걷어낸다 (원래 프로젝트에 남은 예전 실행 권한 정리)
drop_all_bindings() { # 주체SA 역할
  local sa="$1" role="$2"
  if listed gcloud projects get-iam-policy "${P}" --flatten="bindings[].members" --filter="bindings.role=${role} AND bindings.members=serviceAccount:${sa}" --format="value(bindings.role)"; then
    echo "! ${P}: ${sa} → ${role} 바인딩 걷어냄 (원래 프로젝트엔 실행 권한 없음)"
    run gcloud projects remove-iam-policy-binding "${P}" --member="serviceAccount:${sa}" --role="${role}" --all
  fi
}
# 결정 3번 A안: 조건 없는 바인딩 하나만 남긴다. 예전 이름 조건(A/B 등) 바인딩이 있으면 걷어내고 조건 없이 다시
ensure_plain_binding_only() { # 주체SA 역할
  local sa="$1" role="$2"
  if listed gcloud projects get-iam-policy "${P}" --flatten="bindings[].members" --filter="bindings.role=${role} AND bindings.members=serviceAccount:${sa} AND bindings.condition:*" --format="value(bindings.role)"; then
    echo "! ${role}: 이름 조건 바인딩이 남아 있음 → 걷어내고 조건 없이 다시 (전용 프로젝트라 이름 조건 필요 없음)"
    run gcloud projects remove-iam-policy-binding "${P}" --member="serviceAccount:${sa}" --role="${role}" --all
  fi
  ensure_project_binding "${sa}" "${role}"
}
ensure_api() { # API 이름
  if listed gcloud services list --enabled --project="${P}" --filter="config.name=$1" --format="value(config.name)"; then skip "API ${1%%.*} (${P})"
  else run gcloud services enable "$1" --project="${P}"; fi
}

# 0) 전용 프로젝트가 있는지. 없으면 CREATE_TARGET_PROJECT=1 일 때만 만든다 (원래 프로젝트와 같은 폴더·조직, 결제 계정 붙임)
if dry && [ "${CREATE_TARGET_PROJECT:-0}" != "1" ]; then echo "+ (전용 프로젝트 ${TARGET_PROJECT_ID} 가 있다고 보고 계속)"
elif present gcloud projects describe "${TARGET_PROJECT_ID}"; then skip "전용 프로젝트 ${TARGET_PROJECT_ID}"
elif [ "${CREATE_TARGET_PROJECT:-0}" = "1" ]; then
  PARENT=""
  if ! dry; then
    PT="$(gcloud projects describe "${PROJECT_ID}" --format='value(parent.type)' 2>/dev/null || true)"
    PI="$(gcloud projects describe "${PROJECT_ID}" --format='value(parent.id)' 2>/dev/null || true)"
    case "${PT}" in folder) PARENT="--folder=${PI}" ;; organization) PARENT="--organization=${PI}" ;; esac
  fi
  run gcloud projects create "${TARGET_PROJECT_ID}" ${PARENT} --name="${TARGET_PROJECT_ID}" --labels=managed-by=platform
  BA="${BILLING_ACCOUNT:-}"
  if [ -z "${BA}" ] && ! dry; then
    BA="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingAccountName)' 2>/dev/null | sed 's#^billingAccounts/##' || true)"
  fi
  if [ -n "${BA}" ] || dry; then run gcloud billing projects link "${TARGET_PROJECT_ID}" --billing-account="${BA:-<BILLING_ACCOUNT>}"
  else echo "! 결제 계정을 못 찾음 — 전용 프로젝트에 결제 계정을 붙인 뒤 다시 실행 (BILLING_ACCOUNT=...)" >&2; exit 2; fi
else
  echo "전용 프로젝트 ${TARGET_PROJECT_ID} 가 없음 (또는 볼 권한 없음). 만들려면 CREATE_TARGET_PROJECT=1 로 다시 실행" >&2
  exit 2
fi

# DRAFT(ai): 관찰 역할 권한 = 읽기 3개(검증용) + 가져오기에 필요한 조회. 값은 첫 실측으로 보정
OBSERVE_PERMS="container.clusters.list,container.clusters.get,cloudsql.instances.list,cloudsql.instances.get,iam.serviceAccounts.get,iam.serviceAccounts.list,resourcemanager.projects.get"
# OBSROLE: 데이터 자원(Cloud Storage·Pub/Sub·Memorystore) 메타데이터 읽기. 객체 내용(storage.objects.*)·메시지는 못 읽음. 목록 원본 = packages/adapters/src/discover/data.ts
OBSERVE_PERMS="${OBSERVE_PERMS},storage.buckets.list,storage.buckets.getIamPolicy,pubsub.topics.list,pubsub.subscriptions.list,redis.instances.list"
# VMIMPORT: compute.instances.list (GCE VM 출발 읽기, 목록만 — metadata·접속 권한 없음)
# OBSROLE2: 그 밖에 플랫폼이 관찰 SA 로 부르는 모든 gcloud 읽기 명령의 권한 (표 원본 = packages/adapters/src/common/observe-permissions.ts, 시험이 소스의 모든 명령과 대조). 비밀값(secretmanager.versions.access)은 없음
OBSERVE_PERMS="${OBSERVE_PERMS},resourcemanager.projects.getIamPolicy,serviceusage.services.list,compute.networks.list,compute.forwardingRules.list,compute.globalForwardingRules.list,compute.firewalls.list,compute.regions.get,artifactregistry.repositories.list,secretmanager.secrets.list,compute.instances.list"
# CRIMPORT: Cloud Run 출발(서비스·잡·도메인 매핑·Cloud Scheduler 일정) 메타데이터 읽기. 환경변수 비밀 값은 원본에도 없음(이름·버전만)
OBSERVE_PERMS="${OBSERVE_PERMS},run.services.list,run.locations.list,run.revisions.get,run.services.getIamPolicy,run.domainmappings.list,run.jobs.list,cloudscheduler.jobs.list"
# DEPLOYNONK8S: Cloud Run 도착 배포 확인(Ready 조건 읽기)
OBSERVE_PERMS="${OBSERVE_PERMS},run.services.get"
# N8: Cloud SQL 데이터베이스 이름 목록 (내용 아님)
OBSERVE_PERMS="${OBSERVE_PERMS},cloudsql.databases.list"
# DRAFT(ai) GKE-READ: 가져오기(discover/k8s.ts)·연결 확인(can-i)이 GKE 안 앱을 kubectl 로 읽는다. GKE 는 IAM 권한으로도 쿠버네티스 읽기를 준다
#   (RBAC 를 고객이 따로 안 만들어도 됨). 목록·조회만. container.secrets.* 는 넣지 않는다 (목록에 값이 실려 옴)
OBSERVE_PERMS="${OBSERVE_PERMS},container.namespaces.list,container.deployments.list,container.deployments.get,container.statefulSets.list,container.daemonSets.list,container.replicaSets.list,container.pods.list,container.services.list,container.ingresses.list,container.horizontalPodAutoscalers.list,container.cronJobs.list,container.jobs.list,container.networkPolicies.list,container.serviceAccounts.list,container.configMaps.list,container.persistentVolumeClaims.list,container.podDisruptionBudgets.list,container.roles.list,container.roleBindings.list,container.clusterRoleBindings.list,container.thirdPartyObjects.list"
# DRAFT(ai): 가져오기 갈래 요청 — 공개 DNS 영역·레코드 읽기(입구 → IR, 트래픽 갈래), 버킷 설정 하나 읽기(storage.buckets.get, 객체 내용 아님). 읽기 전용이지만 범위가 넓어짐
OBSERVE_PERMS="${OBSERVE_PERMS},dns.managedZones.list,dns.resourceRecordSets.list,storage.buckets.get"
# E-1: 출발 나가는 IP(Cloud NAT) 읽기 (사설 DNS 영역 읽기는 위 dns 두 개)
OBSERVE_PERMS="${OBSERVE_PERMS},compute.routers.list,compute.addresses.list"
# FM-GCP-14 (실측 11/4): 연결 확인(verify)이 첫 단계 projects describe 에서 PERMISSION_MISSING:resourcemanager.projects.get 으로 막혔다.
#   큰 관찰 역할은 예전 판으로 만든 뒤 권한 추가(iam roles update)가 거절되면 빠진 채로 남는다(연결은 계속함). 맥은 roles/browser 를 손으로 붙여 넘김(우회).
#   → 확인이 부르는 권한만 담은 작은 역할을 따로 두고 svc-observe 에 붙인다. 목록 원본 = packages/adapters/src/verify/gcp.ts step("…") (시험이 대조)
VERIFY_PERMS="resourcemanager.projects.get,container.clusters.list,container.clusters.get,cloudsql.instances.list,iam.serviceAccounts.get"

# ── 원래 프로젝트: 읽기만 ──
P="${PROJECT_ID}"
# FM-CLD-14: 플랫폼이 고객 SA 를 빌릴 때(verify·plan·apply·destroy) IAM Service Account Credentials API 를 부른다 → SA 가 있는 두 프로젝트 모두에 켠다
ensure_api iamcredentials.googleapis.com
# FM-INT-26 (맥 실측 2 우회 ⑧): verify 의 projects describe·terraform 의 프로젝트 IAM 읽기가 Cloud Resource Manager API 를 부른다.
#   새 프로젝트엔 꺼져 있어 손으로 services enable 했음 → 두 프로젝트 모두에 켠다 (요금 0)
ensure_api cloudresourcemanager.googleapis.com
ensure_sa svc-observe
ensure_role platform_observe --title="platform-observe" --description="platform read-only inventory" --permissions="${OBSERVE_PERMS}" --stage=GA
sync_role_permissions platform_observe "${OBSERVE_PERMS}"
ensure_role platform_observe_verify --title="platform-observe-verify" --description="platform connection check (read-only)" --permissions="${VERIFY_PERMS}" --stage=GA
sync_role_permissions platform_observe_verify "${VERIFY_PERMS}"
ensure_project_binding "${OBSERVE_SA}" "projects/${P}/roles/platform_observe"
ensure_project_binding "${OBSERVE_SA}" "projects/${P}/roles/platform_observe_verify"
# FM-GCP-14: 맥 우회로 손으로 붙인 roles/browser(프로젝트·폴더 목록까지 넓음)가 svc-observe 에 있으면 걷어낸다. 위 작은 역할이 대신한다
if listed gcloud projects get-iam-policy "${P}" --flatten="bindings[].members" --filter="bindings.role=roles/browser AND bindings.members=serviceAccount:${OBSERVE_SA}" --format="value(bindings.role)"; then
  echo "! svc-observe 에 손으로 붙인 roles/browser 가 있음 → 걷어냄 (platform_observe_verify 가 대신함)"
  run gcloud projects remove-iam-policy-binding "${P}" --member="serviceAccount:${OBSERVE_SA}" --role="roles/browser" --all
fi
# 결정 3번 A안: 예전 판(한 프로젝트)이 원래 프로젝트에 붙인 실행·plan 권한(이름 조건 A/B 포함)을 걷어낸다. 역할 정의는 남겨도 붙은 주체가 없으면 힘이 없다
for role in platform_operate platform_operate_iam platform_operate_db_secret; do drop_all_bindings "${OLD_OPERATE_SA}" "projects/${P}/roles/${role}"; done
drop_all_bindings "${OLD_PLAN_SA}" "projects/${P}/roles/platform_plan"
ensure_token_creator "${OBSERVE_SA}"

# ── 전용 프로젝트: 도착 자원·실행 역할 ──
P="${TARGET_PROJECT_ID}"
ensure_api iamcredentials.googleapis.com
# FM-INT-26: 전용 프로젝트도 같음 + serviceusage(gcp/env 가 나머지 API 를 켜는 API, cloud-precheck gcp-apis FAIL 항목)
ensure_api cloudresourcemanager.googleapis.com
ensure_api serviceusage.googleapis.com
ensure_sa svc-plan
ensure_sa svc-operate
# 관찰 SA 도 전용 프로젝트를 읽는다 (연결 확인이 전용 프로젝트 번호·svc-operate 를 보고, 배포 확인·도착 GKE 읽기). 읽기 전용
ensure_role platform_observe --title="platform-observe" --description="platform read-only inventory" --permissions="${OBSERVE_PERMS}" --stage=GA
sync_role_permissions platform_observe "${OBSERVE_PERMS}"
ensure_role platform_observe_verify --title="platform-observe-verify" --description="platform connection check (read-only)" --permissions="${VERIFY_PERMS}" --stage=GA
sync_role_permissions platform_observe_verify "${VERIFY_PERMS}"
# ID-7 DRAFT(ai): plan 역할 = 실행 역할 파일(자동 생성)에서 읽기 동사(get·list·getIamPolicy)만 + 관찰 역할. 실행 역할이 바뀌면 다시 실행할 때 따라 바뀐다(빠진 것만 더함)
#   파일이 없으면(ROLE_DIR 틀림) 관찰 권한만 → 실행 역할 만들기에서 파일 없음으로 멈춘다. 같은 권한이 두 번 들어가지 않게 정렬·중복 제거
PLAN_READS="$( (grep -E '^- [a-zA-Z]+\.[a-zA-Z.]+\.(get|list|getIamPolicy)$' "${ROLE_DIR}/gcp-operate-custom-role.yaml" 2>/dev/null || true) | sed 's/^- //')"
PLAN_PERMS="$(printf '%s\n%s\n' "${OBSERVE_PERMS//,/$'\n'}" "${PLAN_READS}" | sed '/^$/d' | sort -u | paste -sd, -)"
ensure_role platform_plan --title="platform-plan" --description="platform plan stage (read only)" --permissions="${PLAN_PERMS}" --stage=GA
sync_role_permissions platform_plan "${PLAN_PERMS}"
ensure_role platform_operate --file="${ROLE_DIR}/gcp-operate-custom-role.yaml"
ensure_role platform_operate_iam --file="${ROLE_DIR}/gcp-operate-iam-custom-role.yaml"
# ID-2 DRAFT(ai): apply 끝에 새 도착 DB 비밀번호를 빌린 실행 SA 로 꺼낸다 (real-runner gcloud secrets versions access).
#   비밀값 읽기는 주 역할 금지 목록이라 따로 역할 + 이름 조건(app-…-db-password 버전만)으로만. plan SA(ID-7)는 이 역할을 안 받는다
ensure_role platform_operate_db_secret --file="${ROLE_DIR}/gcp-operate-db-secret-role.yaml"
ensure_project_binding "${OBSERVE_SA}" "projects/${P}/roles/platform_observe"
ensure_project_binding "${OBSERVE_SA}" "projects/${P}/roles/platform_observe_verify"
ensure_project_binding "${PLAN_SA}" "projects/${P}/roles/platform_plan"
# 결정 3번 A안: 실행 역할은 전용 프로젝트 전체에 조건 없이 (이름 조건 A/B 는 버림 — 방이 따로라 고객 자원이 없다)
ensure_plain_binding_only "${OPERATE_SA}" "projects/${P}/roles/platform_operate"
# DRAFT(ai): 보조 역할 두 개(IAM 정책 바꾸기·DB 비밀번호 꺼내기)는 같은 프로젝트 안 플랫폼 자기 SA(svc-*)·다른 비밀을 못 건드리게 조건을 그대로 둔다
ensure_cond_bindings "${OPERATE_SA}" "projects/${P}/roles/platform_operate_iam" "${ROLE_DIR}/gcp-operate-iam-binding-condition.json"
ensure_cond_bindings "${OPERATE_SA}" "projects/${P}/roles/platform_operate_db_secret" "${ROLE_DIR}/gcp-operate-db-secret-condition.json"
# 플랫폼의 회사 전용 SA가 SA를 빌려 쓰게 함. 대상은 SA 단위(프로젝트 전체 아님), 주체는 이 회사 SA 하나
ensure_token_creator "${PLAN_SA}"
ensure_token_creator "${OPERATE_SA}"
# Argo CD 허브가 이 회사 SA 로 도착 GKE 에 들어온다. GKE 는 API 접속 때 clusters.get 을 본다.
# 프로젝트 권한은 이것뿐이고, 배포 권한은 앱 구역 RoleBinding 으로만 받는다 (kinds/namespace)
ensure_role platform_hub_access --title="platform-hub-access" --description="platform argocd hub cluster access" --permissions="container.clusters.get" --stage=GA
ensure_project_binding "${PLATFORM_SA}" "projects/${P}/roles/platform_hub_access"

if [ "${DRY_RUN:-0}" = "1" ]; then
  PROJECT_NUMBER="<DRY_RUN>"
else
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null || echo '<알 수 없음: 콘솔에서 확인>')"
fi
echo "완료. 연결 화면에 입력: 원래 프로젝트 ${PROJECT_ID} (번호 ${PROJECT_NUMBER}), 전용 프로젝트 ${TARGET_PROJECT_ID}"

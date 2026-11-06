#!/usr/bin/env bash
# 고객 GCP 프로젝트 연결 (Cloud Shell에서 고객이 실행). 키 파일은 만들지 않는다: 서비스 계정(SA) 5개를 만들고,
# 플랫폼 쪽 회사 전용 SA가 그 SA를 "빌려 쓸"(impersonate) 수 있게만 한다.
# 결정 3번 A안 (이전 전용 프로젝트): 프로젝트 둘을 쓴다
#   PROJECT_ID        고객 원래 프로젝트 → svc-observe(읽기만)만 둔다. 플랫폼 실행 권한은 0
#   TARGET_PROJECT_ID 이전 전용 프로젝트 → 도착 자원은 여기에만 만든다. svc-plan·svc-operate·svc-env(B-2 환경 층)·svc-gke-node(노드)와 실행 역할은 여기에만 (이름 조건 없음 — 방이 따로라서)
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
#   ONLY_BUNDLES  (PERM-GATE) 쉼표로 이은 권한 묶음 id (예 gcp.env,gcp.plan). 주면 "그 묶음만 맞추는 모드": 묶음 표(ROLE_DIR/gcp-bundles.tsv)의
#                 역할에 빠진 권한만 더하고(있는 권한·고객이 따로 넣은 권한은 안 지움) 그 역할 바인딩·그 묶음 API 만 맞춘다. 다른 것은 손대지 않는다.
#                 실행 역할(platform_operate·_env …)도 이 모드에서만 빠진 권한을 더한다 (전체 실행은 이미 있는 실행 역할을 바꾸지 않는다).
#                 플랫폼 화면의 "권한 갱신" 링크가 이 값을 붙여 준다
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
for f in gcp-operate-custom-role.yaml gcp-operate-iam-custom-role.yaml gcp-operate-db-secret-role.yaml gcp-operate-iam-binding-condition.json gcp-operate-db-secret-condition.json gcp-env-custom-role.yaml; do
  if [ ! -f "${ROLE_DIR}/${f}" ]; then echo "역할 파일 없음: ${ROLE_DIR}/${f} (infra 폴더에서 치거나 ROLE_DIR=<레포>/infra/permissions)" >&2; exit 2; fi
done

OBSERVE_SA="svc-observe@${PROJECT_ID}.iam.gserviceaccount.com"
OPERATE_SA="svc-operate@${TARGET_PROJECT_ID}.iam.gserviceaccount.com"
# ID-7: plan 단계(terraform plan·precheck) 전용 SA. 실행 역할의 읽기(get·list·getIamPolicy)만 가진다 → plan 이 지우기 권한 토큰을 안 받는다
PLAN_SA="svc-plan@${TARGET_PROJECT_ID}.iam.gserviceaccount.com"
# B-2: 환경 층(VPC·NAT·GKE·Artifact Registry·클러스터 안 ESO 설치) 만들기 전용 SA. worker 가 환경 층 단계에서만 빌린다 (svc-plan 처럼).
#   지우기 권한은 없다 (환경 층은 사람이 지운다). svc-operate 는 그대로
ENV_SA="svc-env@${TARGET_PROJECT_ID}.iam.gserviceaccount.com"
# B-2: GKE 노드 SA. 기본 Compute SA(편집자) 대신 (CIS GKE). 로그·지표 쓰기와 Artifact Registry 읽기만. 플랫폼은 빌리지 않는다 (tokenCreator 없음)
#   svc-env 는 이 SA 하나에만 actAs (SA 단위 serviceAccountUser). 프로젝트 전체 actAs 는 주지 않는다 (permissions-lint 가 DRY_RUN 출력으로 확인)
NODE_SA="svc-gke-node@${TARGET_PROJECT_ID}.iam.gserviceaccount.com"
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
# SA 단위 바인딩: 대상 SA 자신의 정책에만 넣는다 (프로젝트 전체 아님). 같은 주체·역할이 있으면 건너뜀
ensure_sa_binding() { # 대상SA 주체SA 역할
  local target="$1" member="$2" role="$3"
  if listed gcloud iam service-accounts get-iam-policy "${target}" --project="${P}" --flatten="bindings[].members" \
      --filter="bindings.role=${role} AND bindings.members=serviceAccount:${member}" --format="value(bindings.role)"; then
    skip "${role#roles/iam.serviceAccount} ${member} → ${target}"
  else
    run gcloud iam service-accounts add-iam-policy-binding "${target}" --project="${P}" \
      --member="serviceAccount:${member}" --role="${role}"
  fi
}
ensure_token_creator() { ensure_sa_binding "$1" "${PLATFORM_SA}" roles/iam.serviceAccountTokenCreator; }

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
# PERM-GATE (실측 11/6): gcloud artifacts repositories list 는 --location 없이 부르면 먼저 지역 목록(ListLocations)을 읽는다 →
#   artifactregistry.locations.list 가 없으면 IAM_PERMISSION_DENIED (repositories.list 는 있어도). 관찰 쪽 실자원 읽기·가져오기·확인 모두 이 모양으로 부른다
OBSERVE_PERMS="${OBSERVE_PERMS},artifactregistry.locations.list"
# CRIMPORT: Cloud Run 출발(서비스·잡·도메인 매핑·Cloud Scheduler 일정) 메타데이터 읽기. 환경변수 비밀 값은 원본에도 없음(이름·버전만)
OBSERVE_PERMS="${OBSERVE_PERMS},run.services.list,run.locations.list,run.revisions.get,run.services.getIamPolicy,run.domainmappings.list,run.jobs.list,cloudscheduler.jobs.list"
# DEPLOYNONK8S: Cloud Run 도착 배포 확인(Ready 조건 읽기)
OBSERVE_PERMS="${OBSERVE_PERMS},run.services.get"
# N8: Cloud SQL 데이터베이스 이름 목록 (내용 아님)
OBSERVE_PERMS="${OBSERVE_PERMS},cloudsql.databases.list"
# DRAFT(ai) GKE-READ: 가져오기(discover/k8s.ts)·연결 확인(can-i)이 GKE 안 앱을 kubectl 로 읽는다. GKE 는 IAM 권한으로도 쿠버네티스 읽기를 준다
#   (RBAC 를 고객이 따로 안 만들어도 됨). 목록·조회만. container.secrets.* 는 넣지 않는다 (목록에 값이 실려 옴)
#   NS-1: 가져오기가 앱 네임스페이스 객체를 이름으로 읽는다(kubectl get namespace <ns>) → namespaces.get. list 만으로는 거부돼 라벨이 안 옮겨지고 검토 칸이 생겼다
OBSERVE_PERMS="${OBSERVE_PERMS},container.namespaces.list,container.namespaces.get,container.deployments.list,container.deployments.get,container.statefulSets.list,container.daemonSets.list,container.replicaSets.list,container.pods.list,container.services.list,container.ingresses.list,container.horizontalPodAutoscalers.list,container.cronJobs.list,container.jobs.list,container.networkPolicies.list,container.serviceAccounts.list,container.configMaps.list,container.persistentVolumeClaims.list,container.podDisruptionBudgets.list,container.roles.list,container.roleBindings.list,container.clusterRoleBindings.list,container.thirdPartyObjects.list"
# DRAFT(ai): 가져오기 갈래 요청 — 공개 DNS 영역·레코드 읽기(입구 → IR, 트래픽 갈래), 버킷 설정 하나 읽기(storage.buckets.get, 객체 내용 아님). 읽기 전용이지만 범위가 넓어짐
OBSERVE_PERMS="${OBSERVE_PERMS},dns.managedZones.list,dns.resourceRecordSets.list,storage.buckets.get"
# E-1: 출발 나가는 IP(Cloud NAT) 읽기 (사설 DNS 영역 읽기는 위 dns 두 개)
OBSERVE_PERMS="${OBSERVE_PERMS},compute.routers.list,compute.addresses.list"
# 리허설 이미지 복사(worker rehearsal/image-mirror.ts): 출발 Artifact Registry(gcr.io 포함)에서 다이제스트로 받기만. 올리기·지우기 없음.
#   요청 원본 = security AR_PULL_PERMISSIONS (시험이 대조). 이 줄이 없는 예전 연결은 스크립트를 다시 실행해야 리허설이 AR 이미지를 받는다
OBSERVE_PERMS="${OBSERVE_PERMS},artifactregistry.repositories.downloadArtifacts"
# FM-GCP-14 (실측 11/4): 연결 확인(verify)이 첫 단계 projects describe 에서 PERMISSION_MISSING:resourcemanager.projects.get 으로 막혔다.
#   큰 관찰 역할은 예전 판으로 만든 뒤 권한 추가(iam roles update)가 거절되면 빠진 채로 남는다(연결은 계속함). 맥은 roles/browser 를 손으로 붙여 넘김(우회).
#   → 확인이 부르는 권한만 담은 작은 역할을 따로 두고 svc-observe 에 붙인다. 목록 원본 = packages/adapters/src/verify/gcp.ts step("…") (시험이 대조)
VERIFY_PERMS="resourcemanager.projects.get,container.clusters.list,container.clusters.get,cloudsql.instances.list,iam.serviceAccounts.get"
# PERM-GATE: 관찰 SA 가 전용 프로젝트의 플랫폼 역할 정의(빠진 권한·권한 판)를 읽는 작은 역할. 전용 프로젝트에만 붙인다 (원래 프로젝트 역할은 안 읽음)
PERMCHECK_PERMS="iam.roles.get"
# 허브(Argo CD)가 이 회사 플랫폼 SA 로 도착 GKE 에 들어올 때 보는 권한
HUB_PERMS="container.clusters.get"
# PERM-GATE: 권한 판 번호 (export-permissions 가 묶음 표 첫 줄에 쓴다). 새로 만드는 역할 설명 끝에 [perms vN] 으로 박혀 관찰 SA 가 읽는다
BUNDLES_TSV="${ROLE_DIR}/gcp-bundles.tsv"
PERMS_VERSION="$(awk -F'\t' '$1 == "#version" && $2 ~ /^[0-9]+$/ { print $2; exit }' "${BUNDLES_TSV}" 2>/dev/null || true)"
PERMS_TAG="[perms v${PERMS_VERSION:-0}]"
# ID-7 DRAFT(ai): plan 역할 = 실행 역할 파일(자동 생성)에서 읽기 동사(get·list·getIamPolicy)만 + 관찰 역할. 실행 역할이 바뀌면 다시 실행할 때 따라 바뀐다(빠진 것만 더함)
#   파일이 없으면(ROLE_DIR 틀림) 관찰 권한만 → 실행 역할 만들기에서 파일 없음으로 멈춘다. 같은 권한이 두 번 들어가지 않게 정렬·중복 제거
PLAN_READS="$( (grep -E '^- [a-zA-Z]+\.[a-zA-Z.]+\.(get|list|getIamPolicy)$' "${ROLE_DIR}/gcp-operate-custom-role.yaml" 2>/dev/null || true) | sed 's/^- //')"
PLAN_PERMS="$(printf '%s\n%s\n' "${OBSERVE_PERMS//,/$'\n'}" "${PLAN_READS}" | sed '/^$/d' | sort -u | paste -sd, -)"

# ── PERM-GATE 묶음 모드: ONLY_BUNDLES 의 묶음만 맞추고 끝낸다 ──
#   묶음 = 표(gcp-bundles.tsv, export-permissions 가 권한표에서 만든다)의 한 줄: 쪽·주체 SA·역할·역할 파일·바인딩 모양·API.
#   하는 일: 그 묶음 API 켜기 → 주체 SA 확인(없으면 만듦) → 역할 확인(없으면 만듦) 뒤 빠진 권한만 더함 → 역할 설명의 권한 판 갱신 → 바인딩 → 빌리기(tokenCreator).
#   지우는 일은 없다(조건부 바인딩이 조건 파일과 다를 때 걷어내고 다시 넣는 것은 전체 실행과 같은 규칙). 다시 돌려도 같은 끝(멱등)
role_perms() { # 역할ID 역할파일 → 쉼표 목록
  case "$2" in
    -) case "$1" in
         platform_observe) printf '%s' "${OBSERVE_PERMS}" ;; platform_observe_verify) printf '%s' "${VERIFY_PERMS}" ;;
         platform_plan) printf '%s' "${PLAN_PERMS}" ;; platform_hub_access) printf '%s' "${HUB_PERMS}" ;;
         platform_observe_permcheck) printf '%s' "${PERMCHECK_PERMS}" ;; *) return 1 ;;
       esac ;;
    *) grep '^- ' "${ROLE_DIR}/$2" | sed 's/^- //' | paste -sd, - ;;
  esac
}
role_desc() { # 역할ID 역할파일 → 설명 (판 표시 포함)
  case "$2" in
    -) case "$1" in
         platform_observe) echo "platform read-only inventory ${PERMS_TAG}" ;; platform_observe_verify) echo "platform connection check (read-only) ${PERMS_TAG}" ;;
         platform_plan) echo "platform plan stage (read only) ${PERMS_TAG}" ;; platform_hub_access) echo "platform argocd hub cluster access ${PERMS_TAG}" ;;
         *) echo "platform role definition check (read-only) ${PERMS_TAG}" ;;
       esac ;;
    *) local d; d="$(sed -n 's/^description: //p' "${ROLE_DIR}/$2" | head -n 1)"; echo "${d% \[perms v*\]} ${PERMS_TAG}" ;;   # 손으로 쓴 역할 파일엔 판 표시가 없다
  esac
}
# 역할 설명의 [perms vN] 이 지금 판이 아니면 설명만 바꾼다 (권한은 안 건드림)
stamp_role() { # 역할ID 설명
  local cur=""
  if ! dry; then cur="$(gcloud iam roles describe "$1" --project="${P}" --format='value(description)' 2>/dev/null || true)"; fi
  case "${cur}" in *"${PERMS_TAG}"*) echo "= 역할 $1 권한 판 최신 ${PERMS_TAG}" ;; *) run gcloud iam roles update "$1" --project="${P}" --description="$2" ;; esac
}
sync_bundle_role() { # 역할ID 역할파일 바인딩 주체SA
  local id="$1" file="$2" binding="$3" sa="$4" perms desc
  perms="$(role_perms "${id}" "${file}")" || { echo "묶음 표의 역할 ${id} 를 모름 (스크립트와 표 판이 다름)" >&2; exit 2; }
  desc="$(role_desc "${id}" "${file}")"
  if [ "${file}" = "-" ]; then ensure_role "${id}" --title="${id//_/-}" --description="${desc}" --permissions="${perms}" --stage=GA
  else ensure_role "${id}" --file="${ROLE_DIR}/${file}"; fi
  sync_role_permissions "${id}" "${perms}"
  stamp_role "${id}" "${desc}"
  case "${binding}" in
    plain) ensure_project_binding "${sa}" "projects/${P}/roles/${id}" ;;
    plain_only) ensure_plain_binding_only "${sa}" "projects/${P}/roles/${id}" ;;
    cond:*) ensure_cond_bindings "${sa}" "projects/${P}/roles/${id}" "${ROLE_DIR}/${binding#cond:}" ;;
    *) echo "묶음 표의 바인딩 모양을 모름: ${binding}" >&2; exit 2 ;;
  esac
}
if [ -n "${ONLY_BUNDLES:-}" ]; then
  [ -f "${BUNDLES_TSV}" ] || { echo "묶음 표 없음: ${BUNDLES_TSV} (infra 폴더에서 치거나 ROLE_DIR=<레포>/infra/permissions)" >&2; exit 2; }
  if ! [[ "${ONLY_BUNDLES}" =~ ^[a-z0-9.]+(,[a-z0-9.]+)*$ ]]; then echo "ONLY_BUNDLES 형식이 아님: ${ONLY_BUNDLES}" >&2; exit 2; fi
  # 모르는 묶음이 하나라도 있으면 아무것도 바꾸기 전에 멈춘다
  for b in ${ONLY_BUNDLES//,/ }; do
    awk -F'\t' -v id="${b}" '$1 == id { f = 1 } END { exit !f }' "${BUNDLES_TSV}" || { echo "모르는 권한 묶음: ${b} (gcp-bundles.tsv 에 없음)" >&2; exit 2; }
  done
  DONE_ROLES=" "
  for b in ${ONLY_BUNDLES//,/ }; do
    IFS=$'\t' read -r _id side principal role file binding apis < <(awk -F'\t' -v id="${b}" '$1 == id' "${BUNDLES_TSV}")
    if [ "${side}" = "source" ]; then P="${PROJECT_ID}"; else P="${TARGET_PROJECT_ID}"; fi
    echo "# 묶음 ${b}: ${principal} → ${role} (${P})"
    if [ "${apis}" != "-" ]; then for a in ${apis//,/ }; do ensure_api "${a}"; done; fi
    case " ${DONE_ROLES} " in *" ${side}/${role} "*) continue ;; esac
    DONE_ROLES="${DONE_ROLES}${side}/${role} "
    case "${principal}" in
      platform) SA="${PLATFORM_SA}" ;;
      svc-observe) SA="${OBSERVE_SA}" ;;
      *) SA="${principal}@${TARGET_PROJECT_ID}.iam.gserviceaccount.com"; ensure_sa "${principal}" ;;
    esac
    sync_bundle_role "${role}" "${file}" "${binding}" "${SA}"
    # 관찰 묶음은 확인 역할(platform_observe_verify)까지 한 묶음 (권한표의 관찰 권한 = 둘의 합)
    if [ "${role}" = "platform_observe" ]; then sync_bundle_role platform_observe_verify - plain "${SA}"; fi
    # 환경 층은 노드 SA 하나에만 actAs (전체 실행과 같은 규칙)
    if [ "${role}" = "platform_env" ]; then
      ensure_sa svc-gke-node
      ensure_sa_binding "${NODE_SA}" "${ENV_SA}" roles/iam.serviceAccountUser
      for nr in roles/logging.logWriter roles/monitoring.metricWriter roles/artifactregistry.reader; do ensure_project_binding "${NODE_SA}" "${nr}"; done
    fi
    # 빌리기: 고객 SA 는 그 SA 가 있는 프로젝트의 정책에 (관찰 SA 는 원래 프로젝트)
    case "${principal}" in
      platform) ;;
      svc-observe) P="${PROJECT_ID}"; ensure_token_creator "${OBSERVE_SA}" ;;
      *) ensure_token_creator "${SA}" ;;
    esac
  done
  echo "완료 (묶음 모드 ${PERMS_TAG}): ${ONLY_BUNDLES}. 플랫폼 화면에서 [다시 확인]을 누른다"
  exit 0
fi

# ── 원래 프로젝트: 읽기만 ──
P="${PROJECT_ID}"
# FM-CLD-14: 플랫폼이 고객 SA 를 빌릴 때(verify·plan·apply·destroy) IAM Service Account Credentials API 를 부른다 → SA 가 있는 두 프로젝트 모두에 켠다
ensure_api iamcredentials.googleapis.com
# 연결 확인(projects describe)이 부르는 API. 보통 켜져 있지만 새 프로젝트면 꺼져 있다 (켜져 있으면 건너뜀)
ensure_api cloudresourcemanager.googleapis.com
# 결제 연결 확인(precheck PC-BILL, gcloud billing projects describe)은 빌린 SA 의 프로젝트로 할당량을 잡는다 → 그 API 가 꺼져 있으면 막힘
ensure_api cloudbilling.googleapis.com
ensure_sa svc-observe
ensure_role platform_observe --title="platform-observe" --description="platform read-only inventory ${PERMS_TAG}" --permissions="${OBSERVE_PERMS}" --stage=GA
sync_role_permissions platform_observe "${OBSERVE_PERMS}"
ensure_role platform_observe_verify --title="platform-observe-verify" --description="platform connection check (read-only) ${PERMS_TAG}" --permissions="${VERIFY_PERMS}" --stage=GA
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
# 새 전용 프로젝트는 API 가 거의 꺼져 있다. 연결 확인(verify: projects describe = cloudresourcemanager, svc-operate 확인 = iam)·
#   빌리기(iamcredentials·sts)와 첫 up(gcp/env: container·sqladmin·compute·secretmanager) 전에 켠다. 실측에서 cloudresourcemanager 를 손으로 켰던 것을 없앤다
# DRAFT(ai): 목록 = 연결·확인·도착 env 층이 부르는 API. 앱 층 API(redis·run·pubsub…)는 gcp/env·앱 apply 가 켬
TARGET_APIS="cloudresourcemanager serviceusage iam iamcredentials sts container sqladmin compute secretmanager cloudbilling"
for a in ${TARGET_APIS}; do ensure_api "${a}.googleapis.com"; done
ensure_sa svc-plan
ensure_sa svc-operate
ensure_sa svc-env
ensure_sa svc-gke-node
# 관찰 SA 도 전용 프로젝트를 읽는다 (연결 확인이 전용 프로젝트 번호·svc-operate 를 보고, 배포 확인·도착 GKE 읽기). 읽기 전용
ensure_role platform_observe --title="platform-observe" --description="platform read-only inventory ${PERMS_TAG}" --permissions="${OBSERVE_PERMS}" --stage=GA
sync_role_permissions platform_observe "${OBSERVE_PERMS}"
ensure_role platform_observe_verify --title="platform-observe-verify" --description="platform connection check (read-only) ${PERMS_TAG}" --permissions="${VERIFY_PERMS}" --stage=GA
sync_role_permissions platform_observe_verify "${VERIFY_PERMS}"
# ID-7: plan 역할 권한(PLAN_PERMS)은 위에서 계산 (묶음 모드와 같은 값)
ensure_role platform_plan --title="platform-plan" --description="platform plan stage (read only) ${PERMS_TAG}" --permissions="${PLAN_PERMS}" --stage=GA
sync_role_permissions platform_plan "${PLAN_PERMS}"
ensure_role platform_operate --file="${ROLE_DIR}/gcp-operate-custom-role.yaml"
ensure_role platform_operate_iam --file="${ROLE_DIR}/gcp-operate-iam-custom-role.yaml"
# ID-2 DRAFT(ai): apply 끝에 새 도착 DB 비밀번호를 빌린 실행 SA 로 꺼낸다 (real-runner gcloud secrets versions access).
#   비밀값 읽기는 주 역할 금지 목록이라 따로 역할 + 이름 조건(app-…-db-password 버전만)으로만. plan SA(ID-7)는 이 역할을 안 받는다
ensure_role platform_operate_db_secret --file="${ROLE_DIR}/gcp-operate-db-secret-role.yaml"
# B-2: 환경 층 만들기 역할 (자동 생성 파일: 읽기 + 만들기만, 지우기·IAM 정책 바꾸기·actAs 없음). 이미 있으면 실행 역할처럼 자동으로 바꾸지 않는다
ensure_role platform_env --file="${ROLE_DIR}/gcp-env-custom-role.yaml"
ensure_project_binding "${OBSERVE_SA}" "projects/${P}/roles/platform_observe"
ensure_project_binding "${OBSERVE_SA}" "projects/${P}/roles/platform_observe_verify"
# PERM-GATE: 관찰 SA 가 이 프로젝트의 플랫폼 역할 정의만 읽게 (사전 점검·환경 화면 "권한 갱신 필요"). 읽기 전용, 전용 프로젝트에만
ensure_role platform_observe_permcheck --title="platform-observe-permcheck" --description="platform role definition check (read-only) ${PERMS_TAG}" --permissions="${PERMCHECK_PERMS}" --stage=GA
sync_role_permissions platform_observe_permcheck "${PERMCHECK_PERMS}"
ensure_project_binding "${OBSERVE_SA}" "projects/${P}/roles/platform_observe_permcheck"
ensure_project_binding "${PLAN_SA}" "projects/${P}/roles/platform_plan"
# 결정 3번 A안: 실행 역할은 전용 프로젝트 전체에 조건 없이 (이름 조건 A/B 는 버림 — 방이 따로라 고객 자원이 없다)
ensure_plain_binding_only "${OPERATE_SA}" "projects/${P}/roles/platform_operate"
# DRAFT(ai): 보조 역할 두 개(IAM 정책 바꾸기·DB 비밀번호 꺼내기)는 같은 프로젝트 안 플랫폼 자기 SA(svc-*)·다른 비밀을 못 건드리게 조건을 그대로 둔다
ensure_cond_bindings "${OPERATE_SA}" "projects/${P}/roles/platform_operate_iam" "${ROLE_DIR}/gcp-operate-iam-binding-condition.json"
ensure_cond_bindings "${OPERATE_SA}" "projects/${P}/roles/platform_operate_db_secret" "${ROLE_DIR}/gcp-operate-db-secret-condition.json"
# B-2: svc-env 는 전용 프로젝트 전체에 환경 층 역할 (조건 없음, 방이 따로라서). 노드 SA 를 클러스터에 붙이는 actAs 는 svc-gke-node 하나의 정책에만
ensure_project_binding "${ENV_SA}" "projects/${P}/roles/platform_env"
ensure_sa_binding "${NODE_SA}" "${ENV_SA}" roles/iam.serviceAccountUser
# B-2: 노드 최소 권한 = 로그 쓰기·지표 쓰기·이미지 받기
for role in roles/logging.logWriter roles/monitoring.metricWriter roles/artifactregistry.reader; do ensure_project_binding "${NODE_SA}" "${role}"; done
# B-2 (나): ESO 신원은 여기서 만들지 않는다 (svc-eso 없음). ESO 는 자기 KSA 를 IAM 주체로 쓰고 앱 층(gcp/root)이 비밀마다 읽기를 준다.
#   여기서 묶으면 첫 GKE 클러스터 전에는 GKE 풀(<전용>.svc.id.goog)이 없어 "Identity Pool does not exist"(400)로 막힌다
# 플랫폼의 회사 전용 SA가 SA를 빌려 쓰게 함. 대상은 SA 단위(프로젝트 전체 아님), 주체는 이 회사 SA 하나. svc-gke-node 는 빌리지 않는다
ensure_token_creator "${PLAN_SA}"
ensure_token_creator "${OPERATE_SA}"
ensure_token_creator "${ENV_SA}"
# Argo CD 허브가 이 회사 SA 로 도착 GKE 에 들어온다. GKE 는 API 접속 때 clusters.get 을 본다.
# 프로젝트 권한은 이것뿐이고, 배포 권한은 앱 구역 RoleBinding 으로만 받는다 (kinds/namespace)
ensure_role platform_hub_access --title="platform-hub-access" --description="platform argocd hub cluster access ${PERMS_TAG}" --permissions="${HUB_PERMS}" --stage=GA
ensure_project_binding "${PLATFORM_SA}" "projects/${P}/roles/platform_hub_access"

if [ "${DRY_RUN:-0}" = "1" ]; then
  PROJECT_NUMBER="<DRY_RUN>"
else
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null || echo '<알 수 없음: 콘솔에서 확인>')"
fi
echo "완료. 연결 화면에 입력: 원래 프로젝트 ${PROJECT_ID} (번호 ${PROJECT_NUMBER}), 전용 프로젝트 ${TARGET_PROJECT_ID}"

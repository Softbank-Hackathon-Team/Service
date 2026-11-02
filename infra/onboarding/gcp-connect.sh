#!/usr/bin/env bash
# 고객 GCP 프로젝트 연결 (Cloud Shell에서 고객이 실행). 키 파일은 만들지 않는다: 서비스 계정(SA) 2개를 만들고,
# 플랫폼 쪽 회사 전용 SA가 그 SA를 "빌려 쓸"(impersonate) 수 있게만 한다.
# 상태: AI 초안. 이 레포의 세션에서는 실행하지 않는다 (DRY_RUN=1이면 명령만 출력)
#
# 필요한 값 (환경변수):
#   PLATFORM_SA   플랫폼이 연결 화면에서 알려 준 이 회사 전용 SA 이메일 (t-<16진 28자>@<플랫폼 프로젝트>.iam.gserviceaccount.com)
#   PROJECT_ID    연결할 고객 프로젝트 (기본: gcloud config의 project)
#   ROLE_DIR      infra/permissions 폴더 (커스텀 역할 YAML·조건 JSON이 있는 곳, 기본 ./permissions)
# 다시 실행해도 된다(이미 있는 것은 건너뜀).
# 실행: PLATFORM_SA=... PROJECT_ID=... ROLE_DIR=./permissions bash gcp-connect.sh
set -euo pipefail

run() { if [ "${DRY_RUN:-0}" = "1" ]; then echo "+ $*"; else "$@"; fi; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
ROLE_DIR="${ROLE_DIR:-./permissions}"
: "${PLATFORM_SA:?PLATFORM_SA 필요 (연결 화면에서 복사)}"
: "${PROJECT_ID:?PROJECT_ID 필요}"

# 회사 전용 SA 이름 규칙 검사: 다른 회사 SA나 사람 계정이면 거부 (혼동된 대리인 방지)
# DRAFT(ai): 이름 규칙 t-<UUID 16진 28자> (25번 H-L5)
if ! [[ "${PLATFORM_SA}" =~ ^t-[0-9a-f]{28}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]]; then
  echo "PLATFORM_SA 형식이 아님: ${PLATFORM_SA}" >&2
  exit 1
fi

OBSERVE_SA="svc-observe@${PROJECT_ID}.iam.gserviceaccount.com"
OPERATE_SA="svc-operate@${PROJECT_ID}.iam.gserviceaccount.com"

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
  if present gcloud iam service-accounts describe "$1@${PROJECT_ID}.iam.gserviceaccount.com" --project="${PROJECT_ID}"; then skip "서비스 계정 $1"
  else run gcloud iam service-accounts create "$1" --project="${PROJECT_ID}" --display-name="platform ${1#svc-}"; fi
}
# 역할: 있으면 건너뜀. 삭제 표시(deleted: true, 7~37일 보관)된 역할이면 되살린다. 내용이 달라졌는지는 비교하지 않는다(처음 만든 그대로)
ensure_role() { # 역할ID, 만들 때 추가 인자...
  local id="$1"; shift
  local desc=""
  if ! dry && desc="$(gcloud iam roles describe "${id}" --project="${PROJECT_ID}" 2>/dev/null)"; then
    if printf '%s' "${desc}" | grep -q '^deleted: true'; then run gcloud iam roles undelete "${id}" --project="${PROJECT_ID}"
    else skip "역할 ${id}"; fi
  else
    run gcloud iam roles create "${id}" --project="${PROJECT_ID}" "$@"
  fi
}
# OBSROLE3: 이미 있는 역할도 권한이 모자라면 채운다. 예전 버전 스크립트로 만든 고객의 관찰 역할에는 새 권한이 없다.
#   --add-permissions 는 빠진 권한만 더하고 있는 권한은 안 지운다(고객이 따로 넣은 것도 그대로). 관찰 역할(읽기만)에만 쓴다 —
#   실행 역할은 권한이 늘면 할 수 있는 일이 늘기 때문에 여기서 자동으로 바꾸지 않는다.
#   권한 목록을 못 읽으면(iam.roles.get 없음) 바꾸지 않고 알린다. DRY_RUN 에서는 역할을 새로 만드는 명령만 나오므로 부르지 않는다.
sync_role_permissions() { # 역할ID 원하는권한(쉼표)
  local id="$1" want="$2" have missing="" p
  dry && return 0
  if ! have="$(gcloud iam roles describe "${id}" --project="${PROJECT_ID}" --format='value(includedPermissions)' 2>/dev/null)"; then
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
    if ! run gcloud iam roles update "${id}" --project="${PROJECT_ID}" --add-permissions="${missing}"; then
      echo "! 역할 ${id} 권한 추가 실패 — 연결은 계속한다. 프로젝트 소유자가 이 스크립트를 다시 실행하거나 콘솔에서 위 권한을 역할에 더할 것" >&2
    fi
  fi
}
# 프로젝트 바인딩: 같은 주체·역할(조건 바인딩이면 조건 있는 것)이 이미 있으면 건너뜀
ensure_project_binding() { # 주체SA 역할 [조건파일]
  local sa="$1" role="$2" cond="${3:-}" flt
  flt="bindings.role=${role} AND bindings.members=serviceAccount:${sa}"
  [ -n "${cond}" ] && flt="${flt} AND bindings.condition.expression:*"
  if listed gcloud projects get-iam-policy "${PROJECT_ID}" --flatten="bindings[].members" --filter="${flt}" --format="value(bindings.role)"; then
    skip "프로젝트 권한 ${sa} → ${role}"
  elif [ -n "${cond}" ]; then
    run gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${sa}" --role="${role}" --condition-from-file="${cond}"
  else
    run gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${sa}" --role="${role}" --condition=None
  fi
}
ensure_token_creator() { # 대상 SA
  local target="$1"
  if listed gcloud iam service-accounts get-iam-policy "${target}" --project="${PROJECT_ID}" --flatten="bindings[].members" \
      --filter="bindings.role=roles/iam.serviceAccountTokenCreator AND bindings.members=serviceAccount:${PLATFORM_SA}" --format="value(bindings.role)"; then
    skip "tokenCreator ${PLATFORM_SA} → ${target}"
  else
    run gcloud iam service-accounts add-iam-policy-binding "${target}" --project="${PROJECT_ID}" \
      --member="serviceAccount:${PLATFORM_SA}" --role="roles/iam.serviceAccountTokenCreator"
  fi
}

# 1) 서비스 계정 2개 (관찰 / 실행)
ensure_sa svc-observe
ensure_sa svc-operate

# 2) 커스텀 역할 3개. 실행용 2개는 infra/permissions의 자동 생성 파일, 관찰용은 읽기 권한만
# DRAFT(ai): 관찰 역할 권한 = 읽기 3개(검증용) + 가져오기에 필요한 조회. 값은 첫 실측으로 보정
OBSERVE_PERMS="container.clusters.list,container.clusters.get,sql.instances.list,sql.instances.get,iam.serviceAccounts.get,iam.serviceAccounts.list,resourcemanager.projects.get"
# OBSROLE: 데이터 자원(Cloud Storage·Pub/Sub·Memorystore) 메타데이터 읽기. 객체 내용(storage.objects.*)·메시지는 못 읽음. 목록 원본 = packages/adapters/src/discover/data.ts
OBSERVE_PERMS="${OBSERVE_PERMS},storage.buckets.list,storage.buckets.getIamPolicy,pubsub.topics.list,pubsub.subscriptions.list,redis.instances.list"
# OBSROLE2: 그 밖에 플랫폼이 관찰 SA 로 부르는 모든 gcloud 읽기 명령의 권한 (표 원본 = packages/adapters/src/common/observe-permissions.ts, 시험이 소스의 모든 명령과 대조). 비밀값(secretmanager.versions.access)은 없음
OBSERVE_PERMS="${OBSERVE_PERMS},resourcemanager.projects.getIamPolicy,serviceusage.services.list,compute.networks.list,compute.forwardingRules.list,compute.globalForwardingRules.list,compute.firewalls.list,compute.regions.get,artifactregistry.repositories.list,secretmanager.secrets.list"
ensure_role platform_observe --title="platform-observe" --description="platform read-only inventory" --permissions="${OBSERVE_PERMS}" --stage=GA
sync_role_permissions platform_observe "${OBSERVE_PERMS}"
ensure_role platform_operate --file="${ROLE_DIR}/gcp-operate-custom-role.yaml"
ensure_role platform_operate_iam --file="${ROLE_DIR}/gcp-operate-iam-custom-role.yaml"

# 3) 프로젝트 권한 연결. IAM 정책을 바꾸는 역할은 app- 접두어 SA·시크릿에만 닿도록 조건을 건다
ensure_project_binding "${OBSERVE_SA}" "projects/${PROJECT_ID}/roles/platform_observe"
ensure_project_binding "${OPERATE_SA}" "projects/${PROJECT_ID}/roles/platform_operate"
ensure_project_binding "${OPERATE_SA}" "projects/${PROJECT_ID}/roles/platform_operate_iam" "${ROLE_DIR}/gcp-operate-iam-binding-condition.json"

# 4) 플랫폼의 회사 전용 SA가 두 SA를 빌려 쓰게 함. 대상은 SA 단위(프로젝트 전체 아님), 주체는 이 회사 SA 하나
for target in "${OBSERVE_SA}" "${OPERATE_SA}"; do
  ensure_token_creator "${target}"
done

if [ "${DRY_RUN:-0}" = "1" ]; then
  PROJECT_NUMBER="<DRY_RUN>"
else
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null || echo '<알 수 없음: 콘솔에서 확인>')"
fi
echo "완료. 프로젝트 번호를 연결 화면에 입력하세요: ${PROJECT_NUMBER}"

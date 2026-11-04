#!/usr/bin/env bash
# 플랫폼 쪽(우리 GCP 프로젝트) 회사 전용 SA 만들기 — GCP 연결 1단계 전에 회사마다 한 번 (플랫폼 운영자가 실행).
# 상태: AI 초안. 이 레포의 세션에서는 실행하지 않는다 (DRY_RUN=1이면 명령만 출력)
#
# 빌리는 길: 워커 gcloud 로그인(WORKER_PRINCIPAL) → 회사 전용 SA(t-<28자>, 여기서 만듦) → 고객 svc-observe|svc-plan|svc-operate
#   (packages/security/src/gcp-cli.ts --impersonate-service-account=<회사 SA>,<고객 SA>). 고객 연결 스크립트(gcp-connect.sh)는 회사 전용 SA 에 고객 SA 의 tokenCreator 를 준다.
#   이 스크립트는 그 앞 고리: 워커가 회사 전용 SA 의 tokenCreator 가 되게 한다. 키 파일은 만들지 않는다
# 회사 전용 SA 이름 = "t-" + md5(회사 UUID) 16진 앞 28자 (DB tenants.gcp_platform_sa 와 같은 규칙, 0029_gcp_platform_sa.sql)
#
# 필요한 값 (환경변수):
#   PLATFORM_PROJECT  플랫폼 GCP 프로젝트 ID (워커 GCP_PLATFORM_PROJECT 와 같은 값)
#   TENANT_ID         회사 UUID
#   WORKER_PRINCIPAL  워커가 gcloud 로 로그인한 주체 (예: serviceAccount:svc-worker@<플랫폼>.iam.gserviceaccount.com, 맥 데모는 user:<gcloud 계정>)
#   ALLOW_HUMAN_WORKER 0 이면 user: 를 거부 (기본 1)
# 다시 실행해도 된다(이미 있는 것은 건너뜀).
set -euo pipefail

run() { if [ "${DRY_RUN:-0}" = "1" ]; then echo "+ $*"; else "$@"; fi; }
dry() { [ "${DRY_RUN:-0}" = "1" ]; }

: "${PLATFORM_PROJECT:?PLATFORM_PROJECT 필요}"
: "${TENANT_ID:?TENANT_ID 필요 (회사 UUID)}"
: "${WORKER_PRINCIPAL:?WORKER_PRINCIPAL 필요 (예: serviceAccount:svc-worker@...)}"
if ! [[ "${PLATFORM_PROJECT}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then echo "PLATFORM_PROJECT 모양이 아님" >&2; exit 1; fi
TENANT_ID="$(printf '%s' "${TENANT_ID}" | tr 'A-F' 'a-f')"
if ! [[ "${TENANT_ID}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then echo "TENANT_ID 가 UUID 가 아님" >&2; exit 1; fi
# 전체 공개·그룹·도메인 주체에게는 안 연다. 워커 SA(serviceAccount:) 또는 사람 계정 하나(user:<이메일>)만
# DRAFT(ai) FM-CON-02: 맥 데모 워커는 사람 gcloud 로그인으로 돈다. 워커 gcloud 는 --impersonate-service-account=<회사 SA>,<고객 SA>
#   (쉼표 위임 체인) 라 시작 주체가 사람 계정이어도 체인이 같고 키 파일이 없다. 그래서 user: 도 받는다(경고 한 줄).
#   ALLOW_HUMAN_WORKER=0 이면 예전처럼 serviceAccount: 만 (운영: EKS 워커는 Workload Identity 로 워커 SA)
# TODO(human): 운영에서 사람 계정을 막을지(기본값을 0 으로 바꿀지) 결정
SA_RE='^serviceAccount:[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$'
USER_RE='^user:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
if [[ "${WORKER_PRINCIPAL}" =~ ${SA_RE} ]]; then :
elif [[ "${WORKER_PRINCIPAL}" =~ ${USER_RE} ]] && [ "${ALLOW_HUMAN_WORKER:-1}" != "0" ]; then
  _who="${WORKER_PRINCIPAL#user:}"
  echo "주의: 사람 계정(user:${_who:0:4}…@${_who#*@})을 워커 주체로 씀 — 데모용. 운영은 serviceAccount:<워커 SA>" >&2
elif [[ "user:${WORKER_PRINCIPAL}" =~ ${USER_RE} ]]; then
  echo "WORKER_PRINCIPAL 앞에 종류가 없음 → 사람 계정이면 user:<이메일>, 워커 SA 면 serviceAccount:<이메일>" >&2; exit 1
else
  echo "WORKER_PRINCIPAL 은 serviceAccount:<워커 SA> 또는 user:<이메일> 하나만 (allUsers·group:·domain: 안 됨, ALLOW_HUMAN_WORKER=0 이면 serviceAccount: 만)" >&2; exit 1
fi

# md5 16진: 리눅스 md5sum, 맥 md5 -q(/sbin), openssl md5 (LibreSSL·OpenSSL 둘 다), python3 순서로 시도.
#   도구마다 출력 모양이 달라("<해시>  -", "<해시>", "MD5(stdin)= <해시>") 32자 16진만 뽑고, 못 뽑으면 다음 도구로
md5_of() {
  local s="$1" c out
  # 맥은 md5·md5sum 이 /sbin 에 있다. PATH 에 /sbin 이 없어도 찾게 덧붙인다 (HASH_EXTRA_PATH= 빈 값이면 안 붙임: 시험용)
  local extra="${HASH_EXTRA_PATH-/sbin:/usr/sbin}"
  local PATH="${PATH}${extra:+:${extra}}"
  for c in "md5sum" "md5 -q" "openssl md5" "python3"; do
    command -v "${c%% *}" >/dev/null 2>&1 || continue
    if [ "${c%% *}" = "python3" ]; then out="$(printf '%s' "${s}" | python3 -c 'import hashlib,sys;print(hashlib.md5(sys.stdin.buffer.read()).hexdigest())' 2>/dev/null)" || true
    else out="$(printf '%s' "${s}" | ${c} 2>/dev/null)" || true; fi
    if [[ "${out}" =~ ([0-9a-f]{32}) ]]; then printf '%s\n' "${BASH_REMATCH[1]}"; return 0; fi
  done
  return 1
}
HASH="$(md5_of "${TENANT_ID}")" || true
# 해시가 비거나 모양이 틀리면 멈춘다 (그대로 가면 SA 이름이 "t-" 가 되어 회사끼리 섞임)
if ! [[ "${HASH}" =~ ^[0-9a-f]{32}$ ]]; then
  echo "회사 SA 이름을 못 만듦: md5 해시를 못 구함 (md5sum·md5·openssl·python3 중 하나가 필요함)" >&2
  exit 127
fi
SA_ID="t-$(printf '%s' "${HASH}" | cut -c1-28)"
SA="${SA_ID}@${PLATFORM_PROJECT}.iam.gserviceaccount.com"

if ! dry && gcloud iam service-accounts describe "${SA}" --project="${PLATFORM_PROJECT}" >/dev/null 2>&1; then echo "= 이미 있음, 건너뜀: 서비스 계정 ${SA_ID}"
else run gcloud iam service-accounts create "${SA_ID}" --project="${PLATFORM_PROJECT}" --display-name="tenant ${TENANT_ID:0:8}"; fi

# 8회차(재실행): 예전엔 --filter 에 "bindings.members=user:a@b" 를 그대로 넣었다. gcloud 거르기 문법에서 ":"·"@" 가 든 값은
#   대소문자·따옴표에 따라 안 맞을 수 있어(→ 매번 "없음"으로 보고 다시 추가) 멤버 목록을 받아 글자 그대로(대소문자 무시) 비교한다
have=""
if ! dry; then have="$(gcloud iam service-accounts get-iam-policy "${SA}" --project="${PLATFORM_PROJECT}" --flatten="bindings[].members" \
  --filter="bindings.role=roles/iam.serviceAccountTokenCreator" --format="value(bindings.members)" 2>/dev/null \
  | tr 'A-Z' 'a-z' | grep -xF -- "$(printf '%s' "${WORKER_PRINCIPAL}" | tr 'A-Z' 'a-z')" || true)"; fi
if [ -n "${have}" ]; then echo "= 이미 있음, 건너뜀: tokenCreator ${WORKER_PRINCIPAL} → ${SA_ID}"
else run gcloud iam service-accounts add-iam-policy-binding "${SA}" --project="${PLATFORM_PROJECT}" \
  --member="${WORKER_PRINCIPAL}" --role="roles/iam.serviceAccountTokenCreator"; fi

echo "완료. 고객 연결 화면의 PLATFORM_SA = ${SA}"

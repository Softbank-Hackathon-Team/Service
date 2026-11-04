#!/usr/bin/env bash
# 플랫폼 쪽(우리 GCP 프로젝트) 회사 전용 SA 만들기 — GCP 연결 1단계 전에 회사마다 한 번 (플랫폼 운영자가 실행).
# 상태: AI 초안. 이 레포의 세션에서는 실행하지 않는다 (DRY_RUN=1이면 명령만 출력)
#
# 빌리는 길: 워커 gcloud 로그인(WORKER_PRINCIPAL) → 회사 전용 SA(t-<28자>, 여기서 만듦) → 고객 svc-observe|svc-plan|svc-operate
#   (packages/security/src/gcp-cli.ts --delegates). 고객 연결 스크립트(gcp-connect.sh)는 회사 전용 SA 에 고객 SA 의 tokenCreator 를 준다.
#   이 스크립트는 그 앞 고리: 워커가 회사 전용 SA 의 tokenCreator 가 되게 한다. 키 파일은 만들지 않는다
# 회사 전용 SA 이름 = "t-" + md5(회사 UUID) 16진 앞 28자 (DB tenants.gcp_platform_sa 와 같은 규칙, 0029_gcp_platform_sa.sql)
#
# 필요한 값 (환경변수):
#   PLATFORM_PROJECT  플랫폼 GCP 프로젝트 ID (워커 GCP_PLATFORM_PROJECT 와 같은 값)
#   TENANT_ID         회사 UUID
#   WORKER_PRINCIPAL  워커가 gcloud 로 로그인한 주체 (예: serviceAccount:svc-worker@<플랫폼>.iam.gserviceaccount.com)
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
# 사람 계정·전체 공개 주체에게는 안 연다 (워커 SA 만)
if ! [[ "${WORKER_PRINCIPAL}" =~ ^serviceAccount:[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]]; then echo "WORKER_PRINCIPAL 은 serviceAccount:<워커 SA> 만" >&2; exit 1; fi

# md5 16진: 리눅스 md5sum, 맥 md5 -q, 그 밖 openssl (맥에는 md5sum 이 없다)
md5_hex() {
  if command -v md5sum >/dev/null 2>&1; then md5sum | cut -d' ' -f1
  elif command -v md5 >/dev/null 2>&1; then md5 -q
  elif command -v openssl >/dev/null 2>&1; then openssl md5 -r | cut -d' ' -f1
  else echo "md5sum·md5·openssl 중 하나가 필요함" >&2; return 127; fi
}
HASH="$(printf '%s' "${TENANT_ID}" | md5_hex)" || exit 127
SA_ID="t-$(printf '%s' "${HASH}" | cut -c1-28)"
SA="${SA_ID}@${PLATFORM_PROJECT}.iam.gserviceaccount.com"

if ! dry && gcloud iam service-accounts describe "${SA}" --project="${PLATFORM_PROJECT}" >/dev/null 2>&1; then echo "= 이미 있음, 건너뜀: 서비스 계정 ${SA_ID}"
else run gcloud iam service-accounts create "${SA_ID}" --project="${PLATFORM_PROJECT}" --display-name="tenant ${TENANT_ID:0:8}"; fi

have=""
if ! dry; then have="$(gcloud iam service-accounts get-iam-policy "${SA}" --project="${PLATFORM_PROJECT}" --flatten="bindings[].members" \
  --filter="bindings.role=roles/iam.serviceAccountTokenCreator AND bindings.members=${WORKER_PRINCIPAL}" --format="value(bindings.role)" 2>/dev/null || true)"; fi
if [ -n "${have}" ]; then echo "= 이미 있음, 건너뜀: tokenCreator ${WORKER_PRINCIPAL} → ${SA_ID}"
else run gcloud iam service-accounts add-iam-policy-binding "${SA}" --project="${PLATFORM_PROJECT}" \
  --member="${WORKER_PRINCIPAL}" --role="roles/iam.serviceAccountTokenCreator"; fi

echo "완료. 고객 연결 화면의 PLATFORM_SA = ${SA}"

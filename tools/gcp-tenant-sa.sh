#!/usr/bin/env bash
# 플랫폼 회사 전용 SA(t-<16진 28자>, infra/onboarding/gcp-platform-tenant-sa.sh 가 만듦)와 그 SA 를 주체로 한 IAM 바인딩을 세거나 지운다.
# 상태: AI 초안. cloud-zero(세기)·demo-day down(지우기)이 부른다
#
#   bash tools/gcp-tenant-sa.sh list-sa         남은 t-* SA 이메일 (한 줄에 하나)
#   bash tools/gcp-tenant-sa.sh list-bindings   t-* 를 주체로 한 바인딩 "<대상> <역할> <주체>" (지운 SA 의 deleted: 주체 포함)
#   bash tools/gcp-tenant-sa.sh purge           위 바인딩을 걷고 SA 를 지운다 (다시 돌려도 안전)
#
# 대상 = 프로젝트 IAM 정책 + 연결 SA(svc-observe·svc-plan·svc-operate)의 SA IAM 정책 (gcp-connect.sh 가 t-* 에 tokenCreator 를 준 곳).
#   워커 → t-* tokenCreator 는 t-* SA 자신의 정책이라 SA 를 지우면 같이 사라진다.
# DRAFT(ai): 연결 SA(svc-*)·커스텀 역할(platform_*)은 지우지 않는다. 고객 쪽 자원이고 요금이 없다.
#   특히 커스텀 역할은 지우면 같은 ID 를 37일 동안 다시 못 만든다(7일 안엔 undelete) → 다음 회차 gcp-connect.sh 가 깨질 수 있다.
# 주의: t-* 를 지우면 다음 회차엔 ① gcp-platform-tenant-sa.sh(플랫폼) ② gcp-connect.sh(고객) 을 다시 돌려야 빌리기 고리가 이어진다
#   (새로 만든 같은 이름 SA 는 옛 바인딩을 물려받지 않는다).
#
# 환경 변수: GCP_PROJECT(고객=도착 프로젝트, 기본 gcloud 기본값) GCP_PLATFORM_PROJECT(플랫폼 프로젝트, 기본 GCP_PROJECT)
# 끝 코드: 0 성공, 1 지우기 뒤에도 남음, 2 조회 실패
set -u
MODE=${1:-}
P=${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}
# 플랫폼 프로젝트: 환경 변수 → 레포 .env(워커와 같은 값) → 고객 프로젝트와 같다고 봄
PP=${GCP_PLATFORM_PROJECT:-$(sed -n 's/^GCP_PLATFORM_PROJECT=//p' "$(dirname "$0")/../.env" 2>/dev/null | tail -n 1 | tr -d "\"'")}
PP=${PP:-$P}
case "$P" in ''|'(unset)') echo "GCP_PROJECT 없음" >&2; exit 2 ;; esac
# 이름 규칙(0029_gcp_platform_sa.sql·gcp-connect.sh 정규식과 같음). 지운 SA 는 deleted:serviceAccount:<이메일>?uid=<숫자>
SA_RE='^t-[0-9a-f]{28}@'
MEM_RE='serviceAccount:t-[0-9a-f]{28}@[a-z0-9-]+\.iam\.gserviceaccount\.com'
CONNECT_SAS="svc-observe svc-plan svc-operate"

list_sa() {
  gcloud iam service-accounts list --project "$PP" --format='value(email)' 2>/dev/null > "$T.sa" || return 2
  grep -E "$SA_RE" "$T.sa" || true
}
# 정책 하나의 (역할, 주체) 중 주체가 t-* 인 것. $1 = 표시 이름, 나머지 = get-iam-policy 명령
pol_rows() {
  local what=$1; shift
  "$@" --flatten='bindings[].members' --format='value(bindings.role,bindings.members)' 2>"$T.err" > "$T.pol" || return 1
  # (맥 옛 awk 는 정규식 {28} 을 모른다 → 고르기는 grep -E 로)
  awk -v w="$what" 'NF >= 2 { print w, $1, $2 }' "$T.pol" | grep -E " [^ ]*$MEM_RE" || true
}
list_bindings() {
  local s
  pol_rows "project/$P" gcloud projects get-iam-policy "$P" || return 2
  [ "$PP" = "$P" ] || pol_rows "project/$PP" gcloud projects get-iam-policy "$PP" || return 2
  for s in $CONNECT_SAS; do
    # 연결 SA 가 없으면(연결 전·고객이 지움) 정책도 없다 → 건너뜀. 다른 오류는 조회 실패
    if ! pol_rows "sa/$s@$P.iam.gserviceaccount.com" gcloud iam service-accounts get-iam-policy "$s@$P.iam.gserviceaccount.com" --project "$P"; then
      grep -qiE 'NOT_FOUND|does not exist|not found' "$T.err" && continue
      return 2
    fi
  done
  return 0
}
purge() {
  local rows sas tgt role mem fail=0 left
  rows=$(list_bindings) || { echo "바인딩 조회 실패 → 지우지 않음" >&2; return 2; }
  # 바인딩 먼저 (SA 를 먼저 지우면 주체가 deleted: 로 바뀌어 같은 줄로 다시 걷어야 한다)
  printf '%s\n' "$rows" | while read -r tgt role mem; do
    [ -n "$tgt" ] || continue
    echo "바인딩 걷음: $tgt $role ${mem%%@*}@…"
    case "$tgt" in
      project/*) gcloud projects remove-iam-policy-binding "${tgt#project/}" --member="$mem" --role="$role" --all --quiet >/dev/null 2>&1 ;;
      sa/*) gcloud iam service-accounts remove-iam-policy-binding "${tgt#sa/}" --project "$P" --member="$mem" --role="$role" --quiet >/dev/null 2>&1 ;;
    esac || echo "  걷기 실패: $tgt $role"
  done
  sas=$(list_sa) || { echo "SA 목록 조회 실패" >&2; return 2; }
  for s in $sas; do
    echo "회사 전용 SA 지움: ${s%%@*}@…"
    gcloud iam service-accounts delete "$s" --project "$PP" --quiet >/dev/null 2>&1 || { echo "  지우기 실패: ${s%%@*}"; fail=1; }
  done
  # 다시 세기 (지운 SA 의 deleted: 주체가 남았으면 한 번 더 걷는다)
  rows=$(list_bindings) || return 2
  printf '%s\n' "$rows" | while read -r tgt role mem; do
    [ -n "$tgt" ] || continue
    case "$tgt" in
      project/*) gcloud projects remove-iam-policy-binding "${tgt#project/}" --member="$mem" --role="$role" --all --quiet >/dev/null 2>&1 ;;
      sa/*) gcloud iam service-accounts remove-iam-policy-binding "${tgt#sa/}" --project "$P" --member="$mem" --role="$role" --quiet >/dev/null 2>&1 ;;
    esac || true
  done
  left=$( { list_sa; list_bindings; } | grep -c . )
  if [ "${left:-0}" -eq 0 ] && [ "$fail" = 0 ]; then echo "회사 전용 SA·바인딩 0"; return 0; fi
  echo "회사 전용 SA·바인딩 ${left}개 남음"; return 1
}

T=$(mktemp "${TMPDIR:-/tmp}/gcp-tenant-sa.XXXXXX") || exit 2
trap 'rm -f "$T" "$T.sa" "$T.pol" "$T.err"' EXIT
case "$MODE" in
  list-sa) list_sa ;;
  list-bindings) list_bindings ;;
  purge) purge ;;
  *) echo "list-sa | list-bindings | purge" >&2; exit 2 ;;
esac

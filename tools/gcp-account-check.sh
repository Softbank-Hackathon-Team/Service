#!/usr/bin/env bash
# GCP 계정 대조 점검 (FM-ENV-03·FM-OPS-09·FM-CLD-09). 읽기만 한다: 만들기·바꾸기·지우기 명령 없음. 맥 RC 가 쳐도 된다.
#   bash tools/gcp-account-check.sh
# 왜: 22:14Z 맥에서 gcloud·ADC 가 권한 없는 계정으로 바뀌었는데 up-preflight 는 "로그인 있음"만 봐서 통과했다.
#   워커(verify 의 빌리기)는 gcloud 활성 계정, terraform 은 ADC 를 쓴다 → 둘이 다르면 한쪽만 실패하고 원인이 ROLE_ASSUME_DENIED 로만 보인다.
# 보는 것
#   gcp-account       gcloud 활성 계정 = GCP_EXPECTED_ACCOUNT (없으면 WARN)
#   gcp-adc-account   ADC 계정 = 활성 계정 (tokeninfo, 토큰은 0600 파일로만 넘기고 찍지 않음)
#   gcp-tenant-sa     GCP_PLATFORM_PROJECT 의 회사 전용 SA(t-*)가 있고, 활성 계정이 그 SA 의 tokenCreator 인지 (GCP 연결 앞 고리)
# 줄 모양: "OK|FAIL|WARN <항목> <설명>" (up-preflight 와 같음). 끝 코드 = FAIL 개수 (0 = 통과)
# 계정은 앞 4자 + 도메인만 찍는다
# 환경 변수: GCP_EXPECTED_ACCOUNT(기대 계정 이메일), GCP_PLATFORM_PROJECT(없으면 .env 에서 읽음),
#   GCP_TENANT_SA(연결 명령의 PLATFORM_SA. 주면 그 SA 하나만 정확히 본다)
set -u
cd "$(dirname "$0")/.." || exit 1
NF=0
ok() { echo "OK   $1 $2"; }
fail() { echo "FAIL $1 $2"; NF=$((NF + 1)); }
warn() { echo "WARN $1 $2"; }
tmo() { local s=$1; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@" < /dev/null; else perl -e 'alarm shift; exec @ARGV' "$s" "$@" < /dev/null; fi; }
# 환경 변수가 있으면(빈 값 포함) 그 값, 아예 없으면 .env 의 값
envv() { if [ -n "${!1+x}" ]; then printf '%s' "${!1}"; else sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d "\"'"; fi; }
mask() { case "$1" in *@*) printf '%s…@%s' "$(printf '%s' "${1%%@*}" | cut -c1-4)" "${1#*@}" ;; "") printf '(없음)' ;; *) printf '%s…' "$(printf '%s' "$1" | cut -c1-4)" ;; esac; }
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/gcp-acct.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT

command -v gcloud >/dev/null 2>&1 || { fail gcp-account "gcloud 없음"; exit "$NF"; }
ACTIVE=$(lc "$(tmo 20 gcloud config get-value account 2>/dev/null | tr -d '\r' | tail -n 1)")
EXPECT=$(lc "$(envv GCP_EXPECTED_ACCOUNT)")
if [ -z "$ACTIVE" ]; then fail gcp-account "gcloud 활성 계정 없음 → gcloud auth login"
elif [ -z "$EXPECT" ]; then warn gcp-account "활성 $(mask "$ACTIVE"). GCP_EXPECTED_ACCOUNT 가 없어 대조 못 함 (.env 에 기대 계정을 넣으면 FAIL 로 잡음)"
elif [ "$ACTIVE" = "$EXPECT" ]; then ok gcp-account "활성 $(mask "$ACTIVE") = 기대 계정"
else fail gcp-account "활성 $(mask "$ACTIVE") ≠ 기대 $(mask "$EXPECT") → gcloud config set account <기대 계정> (다시 로그인 말고 계정만 바꿈)"; fi

# ADC 계정: tokeninfo 에 토큰을 POST 본문(0600 파일)으로 넘긴다 (주소·로그에 안 남게)
ADC=""
if tok=$(tmo 20 gcloud auth application-default print-access-token 2>/dev/null) && [ -n "$tok" ]; then
  ( umask 077; printf 'access_token=%s' "$tok" > "$WORK/t" ); unset tok
  ADC=$(lc "$(curl -s -m 15 --data @"$WORK/t" https://oauth2.googleapis.com/tokeninfo 2>/dev/null | sed -n 's/.*"email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)")
  rm -f "$WORK/t"
  if [ -z "$ADC" ]; then warn gcp-adc-account "ADC 계정을 못 읽음 (tokeninfo 에 email 없음: 서비스 계정 키·좁은 scope 면 그럴 수 있음)"
  elif [ -n "$ACTIVE" ] && [ "$ADC" != "$ACTIVE" ]; then fail gcp-adc-account "ADC $(mask "$ADC") ≠ 활성 $(mask "$ACTIVE") → terraform 과 워커가 다른 계정으로 돎"
  else ok gcp-adc-account "ADC = 활성 계정"; fi
else fail gcp-adc-account "ADC 토큰 없음 → gcloud auth application-default login"; fi

# 회사 전용 SA 고리 (GCP 연결 앞). 플랫폼 프로젝트가 없으면 GCP 진짜 발급을 안 씀 → 건너뜀
PP=$(envv GCP_PLATFORM_PROJECT)
# 6회차(운영자 실수): TENANT_ID 를 잘못 넣어 다른 회사 SA 를 만들면 "t-* 아무거나 하나 열림"으로는 통과한다 → GCP_TENANT_SA(연결 명령의 PLATFORM_SA)를 주면 그 SA 만 본다
TSA=$(lc "${GCP_TENANT_SA-}")
# 실측 01:15Z: 워커 env 에 GCP_PLATFORM_PROJECT 가 없어 GCP verify 가 PLATFORM_SA_MISSING 으로 재시도만 돌았다.
#   진짜 발급기(REAL_STS 0 아님)면 GCP 고객 환경 발급에 꼭 필요 → 비면 FAIL (GCP 를 안 쓰는 판이면 GCP_ACCOUNT_CHECK_GCP_OFF=1 로 끔)
RS=$(envv REAL_STS)
if [ -z "$PP" ] && [ "${RS}" != "0" ] && [ "${GCP_ACCOUNT_CHECK_GCP_OFF:-0}" != "1" ]; then
  fail gcp-platform-project "GCP_PLATFORM_PROJECT 없음 + 진짜 발급기(REAL_STS≠0) → GCP verify·plan 이 PLATFORM_SA_MISSING. 워커 .env 에 GCP_PLATFORM_PROJECT=<플랫폼 프로젝트> 넣고 워커 다시 띄움"
elif [ -n "$PP" ]; then ok gcp-platform-project "GCP_PLATFORM_PROJECT 있음"; fi
if [ -n "$TSA" ] && ! [[ "$TSA" =~ ^t-[0-9a-f]{28}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]]; then fail gcp-tenant-sa "GCP_TENANT_SA 모양이 아님 (t-<28자>@<플랫폼>.iam.gserviceaccount.com)"
elif [ -n "$TSA" ]; then
  TP=${TSA#*@}; TP=${TP%%.iam.gserviceaccount.com}
  if ! mem=$(tmo 20 gcloud iam service-accounts get-iam-policy "$TSA" --project "$TP" --flatten='bindings[].members' \
      --filter='bindings.role=roles/iam.serviceAccountTokenCreator' --format='value(bindings.members)' 2>"$WORK/e"); then
    if grep -qiE 'NOT_FOUND|does not exist' "$WORK/e"; then fail gcp-tenant-sa "연결 명령의 회사 SA ${TSA%%@*} 가 없음 → 이 회사 TENANT_ID 로 gcp-platform-tenant-sa.sh (다른 회사 번호를 넣었는지 확인)"
    else fail gcp-tenant-sa "회사 SA 정책을 못 읽음: $(head -c 120 "$WORK/e" | tr '\n' ' ')"; fi
  elif printf '%s\n' "$mem" | tr 'A-Z' 'a-z' | grep -qxF -e "user:$ACTIVE" -e "serviceaccount:$ACTIVE"; then ok gcp-tenant-sa "연결 명령의 회사 SA ${TSA%%@*} → 활성 계정에 빌리기 열림"
  else fail gcp-tenant-sa "연결 명령의 회사 SA ${TSA%%@*} 에 활성 $(mask "$ACTIVE") tokenCreator 없음 → WORKER_PRINCIPAL=user:<활성 계정> 로 gcp-platform-tenant-sa.sh"; fi
elif [ -z "$PP" ]; then warn gcp-tenant-sa "GCP_PLATFORM_PROJECT 없음 → GCP 진짜 발급 안 씀 (연결 체인을 돌릴 거면 설정)"
elif ! sas=$(tmo 30 gcloud iam service-accounts list --project "$PP" --filter='email~^t-[0-9a-f]{28}@' --format='value(email)' 2>"$WORK/e"); then
  fail gcp-tenant-sa "$PP SA 목록을 못 읽음: $(head -c 120 "$WORK/e" | tr '\n' ' ')"
elif [ -z "$sas" ]; then warn gcp-tenant-sa "$PP 에 회사 전용 SA(t-*) 없음 → GCP 연결 전에 gcp-platform-tenant-sa.sh (down 뒤면 다시, 그다음 고객 gcp-connect.sh 도 다시)"
else
  # 9회차(대용량): 회사가 많으면 t-* 도 많다 → 앞 MAXSCAN 개만 보고, 못 찾았는데 더 있으면 FAIL 이 아니라 WARN(GCP_TENANT_SA 로 정확히).
  #   프로젝트당 SA 기본 한도 100 개 — 회사 하나 = t-* 하나라 80 개를 넘으면 알린다 (TODO(human): 한도 늘리기 또는 플랫폼 프로젝트 나누기)
  total=$(printf '%s\n' "$sas" | grep -c .); n=0; linked=0; MAXSCAN=10
  for sa in $sas; do
    [ "$n" -ge "$MAXSCAN" ] && break
    n=$((n + 1))
    if [ -n "$ACTIVE" ] && tmo 20 gcloud iam service-accounts get-iam-policy "$sa" --project "$PP" --flatten='bindings[].members' \
      --filter='bindings.role=roles/iam.serviceAccountTokenCreator' --format='value(bindings.members)' 2>/dev/null | tr 'A-Z' 'a-z' | grep -qxF -e "user:$ACTIVE" -e "serviceaccount:$ACTIVE"; then linked=1; break; fi
  done
  if [ "$linked" -gt 0 ]; then ok gcp-tenant-sa "회사 SA ${total}개 중 활성 계정에 빌리기 열린 것 있음"
  elif [ "$total" -gt "$n" ]; then warn gcp-tenant-sa "회사 SA ${total}개 중 앞 ${n}개에는 활성 계정 고리 없음 → GCP_TENANT_SA=<연결 명령의 PLATFORM_SA> 로 정확히 확인"
  else fail gcp-tenant-sa "회사 SA 는 있는데 활성 $(mask "$ACTIVE") 에 tokenCreator 없음 → WORKER_PRINCIPAL=user:<활성 계정> 으로 gcp-platform-tenant-sa.sh 다시"; fi
  [ "$total" -ge 80 ] && warn gcp-tenant-sa-quota "회사 SA ${total}개 (프로젝트당 SA 기본 한도 100) → 한도 늘리기 요청 필요"
fi
# 7회차(심사위원 데모): 화면의 Cloud Shell 링크는 GCP_CONNECT_REPO_URL 이 없으면 빈 터미널만 연다 → 화면 명령(bash onboarding/gcp-connect.sh)이 파일 없음으로 실패
#   맥 체인(레포에서 직접 실행)은 상관없다. 심사위원 앞에서 링크를 누를 거면 공개 레포 주소를 넣는다
if [ -n "$PP" ]; then
  RU=$(envv GCP_CONNECT_REPO_URL)
  if [ -z "$RU" ]; then warn gcp-connect-link "GCP_CONNECT_REPO_URL 없음 → 화면의 Cloud Shell 링크는 빈 터미널(연결 명령이 파일 없음). 링크를 시연하려면 공개 레포 주소를, 아니면 맥에서 레포 루트 명령으로"
  else ok gcp-connect-link "Cloud Shell 링크가 레포를 복제함 (공개 레포여야 고객이 받음)"; fi
fi
exit "$NF"

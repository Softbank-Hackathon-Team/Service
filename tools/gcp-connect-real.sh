#!/usr/bin/env bash
# CON-01: GCP 도착 환경을 진짜로 연결하는 한 줄 (맥 실세션용). 상태: AI 초안
#   예전: 도착 = 시드 환경(3333…, 흉내 발급) → 진짜 GCP 빌리기·verify 가 한 번도 안 돎. 손으로 하던 4단계를 순서대로:
#   ① 회사 번호(env:connect whoami) → ② 플랫폼 회사 전용 SA (infra/onboarding/gcp-platform-tenant-sa.sh, 워커 주체 = gcloud 로그인 계정)
#   ③ 환경 만들기 + 연결 명령 받기(env:connect create --provider gcp) → 명령의 PLATFORM_SA 가 ②에서 만든 SA 와 같은지 대조
#   ④ 고객 쪽 연결(infra/onboarding/gcp-connect.sh, 레포 루트 기준) → IAM 전파 대기 → verify → connected
#   끝 줄 "도착 환경  <env id>" = real-session 이 MI_TARGET_ENV 로 쓴다.
# 다시 쳐도 된다: SA·바인딩은 있으면 건너뜀, 같은 이름 환경은 env:connect 가 이어 씀, 이미 connected 면 ②④ 건너뜀.
# 클라우드 변경: GCP IAM (SA·커스텀 역할·바인딩)만. 요금 0. down 의 connect-gcp 단계(tools/gcp-tenant-sa.sh purge)가 회사 SA 를 지운다
# 환경: GCP_PROJECT(고객 원래 프로젝트 = 관찰만, 기본 gcloud 기본값) GCP_PLATFORM_PROJECT(기본 GCP_PROJECT) GCP_ENV_NAME(real-dst)
#   GCP_TARGET_PROJECT(결정 3번 A안: 이전 전용 프로젝트, 필수. 도착 GKE·Cloud SQL 이 여기 있어야 함) CREATE_TARGET_PROJECT(1 = 없으면 만듦)
#   CLUSTER_NAME(platform-target) GCP_ZONE(asia-northeast3-a → 리전은 끝 -a 를 뗌) GCP_IAM_WAIT_SEC(60) WORKER_PRINCIPAL(기본 user:<gcloud 계정>)
#   TARGET_PROJECT_ID(도착 전용 프로젝트, 환경 변수 → .env) VERIFY_WAIT_SEC(240, env:connect verify 가 기다리는 시간)  DRY=1: 클라우드에 쓰는 명령(②④)은 DRY_RUN=1 로 찍기만
# 종료: 0 connected  1 단계 실패(메시지에 단계 이름)  2 값 없음
set -u
say() { echo "gcp-connect: $*"; }
die() { echo "gcp-connect 실패 [$1]: $2" >&2; exit "${3:-1}"; }
P=${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}
case "$P" in ''|'(unset)') die 값 "GCP_PROJECT 없음 (gcloud config set project 또는 GCP_PROJECT=)" 2 ;; esac
PP=${GCP_PLATFORM_PROJECT:-$P}
# 결정 3번 A안: 도착 자원을 만들 이전 전용 프로젝트 (8nr2 pf22 에서 필수). 이름은 GCP_TARGET_PROJECT(8nr2) 또는 TARGET_PROJECT_ID(mac·.env) 둘 다 받음 (FM-INT-16)
TP=${GCP_TARGET_PROJECT:-${TARGET_PROJECT_ID:-$(sed -n 's/^TARGET_PROJECT_ID=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' ")}}
[ -n "$TP" ] || die 값 "GCP_TARGET_PROJECT(또는 TARGET_PROJECT_ID) 없음 (결정 3번 A안: 도착 자원을 만들 이전 전용 프로젝트, 원래 프로젝트와 달라야 함)" 2
[ "$TP" != "$P" ] || die 값 "GCP_TARGET_PROJECT 가 GCP_PROJECT 와 같음 (전용 프로젝트는 따로)" 2
NAME=${GCP_ENV_NAME:-real-dst}
CL=${CLUSTER_NAME:-platform-target}
Z=${GCP_ZONE:-asia-northeast3-a}; R=${GCP_REGION:-${Z%-[a-z]}}
DRYF=${DRY:-0}
T=$(mktemp -d "${TMPDIR:-/tmp}/gcpc.XXXXXX") || exit 1; chmod 700 "$T"; trap 'rm -rf "$T"' EXIT

# ① 회사 번호
npm run -s env:connect -- whoami > "$T/who" 2>&1 || die 회사 "env:connect whoami: $(tail -1 "$T/who")"
TID=$(sed -n 's/^회사  *\([0-9a-f-]\{36\}\).*/\1/p' "$T/who" | head -1)
[ -n "$TID" ] || die 회사 "회사 번호 줄이 없음"
# 워커 주체: 맥 데모 워커는 사람 gcloud 로그인으로 돈다(FM-CON-02 ALLOW_HUMAN_WORKER). 계정 글자는 화면에 안 찍는다
WP=${WORKER_PRINCIPAL:-}
if [ -z "$WP" ]; then
  acct=$(gcloud config get-value account 2>/dev/null)
  case "$acct" in *@*.iam.gserviceaccount.com) WP="serviceAccount:$acct" ;; *@*) WP="user:$acct" ;; *) die 주체 "gcloud 로그인 계정이 없음 (gcloud auth login)" 2 ;; esac
fi

# ③ 먼저 환경을 만들어 이미 connected 인지 본다 (링크 발급은 DB 만 씀)
npm run -s env:connect -- create --provider gcp --name "$NAME" --cluster "$CL" --region "$R" > "$T/c" 2>&1 || die 환경 "env:connect create rc≠0: $(grep -v '^$' "$T/c" | tail -1)"
ENV=$(sed -n 's/^환경 만듦  *\([0-9a-f-]\{36\}\).*/\1/p' "$T/c" | head -1)
[ -n "$ENV" ] || die 환경 "'환경 만듦' 줄이 없음"
say "환경 $ENV ($NAME)"
if grep -q '^이미 connected ' "$T/c"; then say "이미 connected → SA·연결 건너뜀"; echo "도착 환경  $ENV"; exit 0; fi
SA=$(grep -o "PLATFORM_SA='[^']*'" "$T/c" | head -1 | sed "s/^PLATFORM_SA='//; s/'$//")
already_verifying=0; grep -q '^이미 verifying ' "$T/c" && already_verifying=1
if [ "$already_verifying" = 0 ]; then
  case "$SA" in t-[0-9a-f]*@"$PP".iam.gserviceaccount.com) ;; *) die 명령 "연결 명령에 회사 SA(t-…@$PP) 가 없음 (api 의 GCP_PLATFORM_PROJECT 가 $PP 인지)" ;; esac
fi

# ② 회사 전용 SA (있으면 건너뜀) — 만든 이름이 링크의 SA 와 같아야 한다 (다른 회사 번호로 만들면 여기서 멈춤)
DRY_RUN=$([ "$DRYF" = 1 ] && echo 1 || echo 0) PLATFORM_PROJECT="$PP" TENANT_ID="$TID" WORKER_PRINCIPAL="$WP" \
  bash infra/onboarding/gcp-platform-tenant-sa.sh > "$T/sa" 2>&1 || die 회사SA "gcp-platform-tenant-sa.sh: $(tail -1 "$T/sa")"
MADE=$(grep -oE 't-[0-9a-f]{28}@[a-z0-9-]+\.iam\.gserviceaccount\.com' "$T/sa" | tail -1)
if [ "$already_verifying" = 0 ] && [ -n "$MADE" ] && [ "$MADE" != "$SA" ]; then die 회사SA "만든 SA 와 연결 명령의 SA 가 다름 (회사 번호 혼동)"; fi
say "회사 SA 준비 (${SA%%@*})"

# ④ 고객 쪽 연결 (레포 루트 기준 경로, ROLE_DIR 은 스크립트 옆 permissions — FM-CON-03)
if [ "$already_verifying" = 0 ]; then
  DRY_RUN=$([ "$DRYF" = 1 ] && echo 1 || echo 0) PLATFORM_SA="$SA" PROJECT_ID="$P" TARGET_PROJECT_ID="$TP" CREATE_TARGET_PROJECT="${CREATE_TARGET_PROJECT:-0}" bash infra/onboarding/gcp-connect.sh > "$T/gc" 2>&1 \
    || die 고객연결 "gcp-connect.sh: $(tail -1 "$T/gc")"
  say "고객 연결 스크립트 끝 → IAM 전파 ${GCP_IAM_WAIT_SEC:-60}초 기다림"
  [ "$DRYF" = 1 ] || sleep "${GCP_IAM_WAIT_SEC:-60}"
fi
[ "$DRYF" = 1 ] && { say "dry-run: verify 안 함"; echo "도착 환경  $ENV"; exit 0; }
VERIFY_WAIT_SEC=${VERIFY_WAIT_SEC:-240} npm run -s env:connect -- verify --env "$ENV" --account "$P" --target-project "$TP" > "$T/v" 2>&1; vrc=$?
# 판정: 끝 코드 0 + 고정 줄 "연결 확인 결과  connected" (grep connected 는 disconnected 에도 걸림). 이유는 마지막 상태 줄에서
last=$(grep -E 'ms  ' "$T/v" | tail -1 | sed 's/^.*ms  //')
if grep -qx '연결 확인 결과  connected' "$T/v" && [ "$vrc" = 0 ]; then say "verify → connected"; echo "도착 환경  $ENV"
else die verify "마지막 상태 ${last:-없음} rc=$vrc (env $ENV; 다시: npm run env:connect -- verify --env $ENV --account $P --target-project $TP)"; fi

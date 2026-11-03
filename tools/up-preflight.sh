#!/usr/bin/env bash
# up 사전 점검 (UPREV). apply·생성·삭제 없이 조회와 terraform validate·plan 만 한다. 맥 RC 가 쳐도 된다(만드는 명령 없음).
#   bash tools/up-preflight.sh            전부 (plan 포함, 1~3분)
#   bash tools/up-preflight.sh --quick    plan 을 빼고 (10~20초)
# demo-day.sh up 의 시작 점검(u_tools)이 이 스크립트를 부르고, PASS 가 아니면 apply 를 하나도 시작하지 않는다.
# 왜: 20:2xZ 1차 up 이 GKE 를 만든 뒤 aws 필수 변수(expected_account_id)가 없어 멈췄고, 남은 GKE 때문에 2차가 막혔다.
#   apply 전에 실패할 수 있는 것을 여기서 다 본다.
# 줄 모양: "OK|FAIL|WARN <항목> <설명>". 마지막 줄 "판정 PASS|FAIL FAIL n WARN m 초 s". 끝 코드 0 = PASS
# 비밀값·계정 번호·IP 는 찍지 않는다.
# 환경 변수: demo-day 와 같음(AWS_PROFILE AWS_REGION GCP_PROJECT GCP_ZONE DEMO_DAY_STATE TUNNEL_LOCAL_PORT) + DEMO_DAY_RESUME(1 이면 남은 state·자원 허용)
set -u
cd "$(dirname "$0")/.." || exit 1
QUICK=0
for a in "$@"; do case "$a" in --quick) QUICK=1 ;; *) echo "모르는 옵션: $a" >&2; exit 2 ;; esac; done
# UPREV: gke-gcloud-auth-plugin 은 gcloud SDK 의 bin 에 깔리는데 그 폴더가 PATH 에 없을 수 있다(Homebrew cask·설치 스크립트). kubectl 이 못 찾으면 GKE 접속 실패
#   → PATH 에 없으면 gcloud 가 알려 주는 SDK 폴더의 bin 을 PATH 앞에 더한다 (설치는 안 함)
if ! command -v gke-gcloud-auth-plugin >/dev/null 2>&1 && command -v gcloud >/dev/null 2>&1; then
  _sdk=$(gcloud info --format='value(installation.sdk_root)' 2>/dev/null)
  [ -n "$_sdk" ] && [ -x "$_sdk/bin/gke-gcloud-auth-plugin" ] && export PATH="$_sdk/bin:$PATH"
fi
export AWS_PROFILE=${AWS_PROFILE:-finals}
export AWS_REGION=${AWS_REGION:-ap-northeast-2}
GCP_PROJECT=${GCP_PROJECT:-finals-demo}
GCP_ZONE=${GCP_ZONE:-asia-northeast3-a}
STATE=${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}
LPORT=${TUNNEL_LOCAL_PORT:-55434}
RESUME=${DEMO_DAY_RESUME:-0}
TFA=infra/modules/aws/env
TFG=infra/modules/gcp/env
TFR=infra/modules/aws/demo-relay
T0=$(date +%s)
NF=0; NW=0
WORK=$(mktemp -d "${TMPDIR:-/tmp}/up-preflight.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT
ok() { echo "OK   $1 $2"; }
fail() { echo "FAIL $1 $2"; NF=$((NF + 1)); }
warn() { echo "WARN $1 $2"; NW=$((NW + 1)); }
# 명령 하나를 최대 $1 초. 맥에는 timeout 이 없을 수 있어 perl alarm 으로 (perl 은 macOS 기본)
tmo() { local s=$1; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else perl -e 'alarm shift; exec @ARGV' "$s" "$@"; fi; }

# 1. 도구·버전
miss=""
for t in terraform aws gcloud kubectl jq curl ssh npm node python3 lsof; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done
[ -z "$miss" ] && ok tools "필요한 도구 전부 있음" || fail tools "없는 도구:$miss"
if command -v terraform >/dev/null 2>&1; then
  tv=$(terraform version -json 2>/dev/null | jq -r .terraform_version 2>/dev/null)
  case "$tv" in 1.1[1-9]*|1.[2-9][0-9]*|[2-9].*) ok terraform-version "$tv (≥1.11, S3 use_lockfile·모듈 required_version)" ;; *) fail terraform-version "${tv:-못 읽음} (모듈이 ≥1.11 요구)" ;; esac
fi
if command -v gke-gcloud-auth-plugin >/dev/null 2>&1; then ok gke-auth-plugin "$(command -v gke-gcloud-auth-plugin)"
else fail gke-auth-plugin "gke-gcloud-auth-plugin 없음 → gcloud components install gke-gcloud-auth-plugin (Homebrew gcloud 면 같은 줄, 그래도 없으면 brew 의 google-cloud-sdk/bin 이 PATH 에 있는지)"; fi
[ -f "$HOME/.ssh/id_ed25519.pub" ] && ok ssh-key "~/.ssh/id_ed25519.pub 있음" || fail ssh-key "~/.ssh/id_ed25519.pub 없음 (ssh-keygen -t ed25519)"

# 2. 인증 (값은 안 찍음)
acct=$(tmo 20 aws sts get-caller-identity --query Account --output text 2>"$WORK/aws.err")
case "$acct" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ok aws-auth "프로필 $AWS_PROFILE 로 계정 확인 (expected_account_id 를 여기서 받음)" ;;
  *) fail aws-auth "sts 실패: $(head -c 120 "$WORK/aws.err" | tr '\n' ' ') (aws sso login --profile $AWS_PROFILE ?)" ;; esac
[ "$AWS_REGION" = ap-northeast-2 ] && ok aws-region "ap-northeast-2" || fail aws-region "$AWS_REGION (서울 고정)"
tmo 20 gcloud auth print-access-token >/dev/null 2>&1 && ok gcloud-auth "gcloud 로그인 있음" || fail gcloud-auth "gcloud auth login 필요"
# terraform google provider 는 gcloud 로그인이 아니라 ADC 를 쓴다
tmo 20 gcloud auth application-default print-access-token >/dev/null 2>&1 && ok gcp-adc "ADC 있음 (terraform google provider)" || fail gcp-adc "gcloud auth application-default login 필요"
tmo 20 gcloud projects describe "$GCP_PROJECT" --format='value(lifecycleState)' 2>/dev/null | grep -q ACTIVE && ok gcp-project "$GCP_PROJECT ACTIVE" || fail gcp-project "$GCP_PROJECT 를 못 읽음"
case "$GCP_ZONE" in asia-northeast3-*) ok gcp-zone "$GCP_ZONE" ;; *) fail gcp-zone "$GCP_ZONE (asia-northeast3 고정)" ;; esac

# 3. 필수 terraform 변수: 기본값 없는 변수마다 demo-day 가 넘기는지. 새 필수 변수가 생기면 여기서 FAIL (1차 rc=1 재발 막기)
#    demo-day 가 넘기는 것: aws/env expected_account_id(TF_VAR_, sts) / gcp/env project_id(-var) / relay vpc_id·public_subnet_id·ssh_public_key·ssh_cidrs_json(-var)
req_vars() { python3 - "$1" <<'PY'
import re, sys, glob
for f in sorted(glob.glob(sys.argv[1] + "/*.tf")):
    s = open(f).read()
    for m in re.finditer(r'variable\s+"([^"]+)"\s*\{', s):
        i, d = m.end(), 1
        while d and i < len(s):
            d += {"{": 1, "}": -1}.get(s[i], 0); i += 1
        body = re.sub(r'#.*', '', s[m.end():i - 1])
        if not re.search(r'^\s*default\s*=', body, re.M) and "default =" not in body: print(m.group(1))
PY
}
check_vars() { local mod=$1 given=$2 v bad=""
  for v in $(req_vars "$mod"); do case " $given " in *" $v "*) ;; *) bad="$bad $v" ;; esac; done
  [ -z "$bad" ] && ok "tfvars:${mod#infra/modules/}" "필수 변수 전부 넘김" || fail "tfvars:${mod#infra/modules/}" "demo-day 가 안 넘기는 필수 변수:$bad"; }
check_vars "$TFA" "expected_account_id"
check_vars "$TFG" "project_id"
check_vars "$TFR" "vpc_id public_subnet_id ssh_public_key ssh_cidrs_json"
# aws/env 를 apply·destroy 하는 줄은 전부 aws_account_var 를 먼저 불러야 한다 (한 줄이라도 빠지면 1차 rc=1 재발)
nw=$(grep -nE 'terraform -chdir="\$TFA" (apply|destroy)' tools/demo-day.sh | grep -v aws_account_var | cut -d: -f1 | tr '\n' ' ')
[ -z "$nw" ] && ok tfvars:wiring "aws/env apply·destroy 줄 전부 aws_account_var 먼저" || fail tfvars:wiring "demo-day.sh ${nw}줄: aws/env apply·destroy 앞에 aws_account_var 없음"

# 4. 지난 회차 흔적 (up 의 stale 단계가 치우는 것은 WARN, 못 치우는 것은 FAIL)
for f in worker api tunnel; do
  if [ -f "$STATE/$f.pid" ] && kill -0 "$(cat "$STATE/$f.pid")" 2>/dev/null; then warn "stale:$f" "지난 회차 $f 가 살아 있음 → up 이 먼저 끔"; fi
done
[ -f "$STATE/relay_ip" ] && warn stale:relay_ip "예전 중계기 IP 파일 → up 이 지움"
p3000=$(lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$p3000" ]; then
  if [ -f "$STATE/api.pid" ] && [ "$(cat "$STATE/api.pid")" = "$p3000" ]; then warn port-3000 "지난 회차 API → up 이 끔"; else fail port-3000 "다른 프로세스(pid $p3000)가 3000 을 씀 (dev:api 창을 닫기)"; fi
else ok port-3000 "비어 있음"; fi
# 다른 terraform 이 돌고 있으면 state 잠금·고아 apply (1차의 GKE 처럼)
if pgrep -fl 'terraform .*(apply|destroy)' >/dev/null 2>&1; then fail tf-running "terraform apply/destroy 가 이미 돌고 있음: 끝날 때까지 기다림"; else ok tf-running "도는 terraform 없음"; fi
for d in "$TFA" "$TFG" "$TFR"; do
  [ -f "$d/.terraform.tfstate.lock.info" ] && fail "tf-lock:${d#infra/modules/}" "state 잠금 파일이 남음 (다른 terraform 이 안 돌면 terraform force-unlock)"
done

# 5. 남은 state (로컬 tfstate). 있으면 1차처럼 자원이 남은 것
for d in "$TFA" "$TFG" "$TFR"; do
  n=0; [ -f "$d/terraform.tfstate" ] && n=$(jq '[.resources[]? | select(.mode == "managed")] | length' "$d/terraform.tfstate" 2>/dev/null || echo "?")
  if [ "$n" = 0 ]; then ok "state:${d#infra/modules/}" "남은 자원 0"
  elif [ "$RESUME" = 1 ]; then warn "state:${d#infra/modules/}" "남은 자원 $n개 (RESUME=1 → 그 위에서 이어 감)"
  else fail "state:${d#infra/modules/}" "남은 자원 $n개 → sh tools/jeong-down.sh 로 0 을 만든 뒤 up (이어 가려면 DEMO_DAY_RESUME=1)"; fi
done
tl=$(tmo 60 npm run -s tf:real -- list 2>/dev/null | awk '$3 == "state" && $5 != "0개"' | wc -l | tr -d ' ')
[ "${tl:-0}" = 0 ] && ok state:tf-real "이전별 state 남은 것 0" || { [ "$RESUME" = 1 ] && warn state:tf-real "이전별 state ${tl}개" || fail state:tf-real "이전별 state ${tl}개 남음 → jeong-down"; }

# 6. 클라우드 자원 0 (조회만)
if [ "$RESUME" = 1 ]; then warn cloud-zero "RESUME=1 이라 건너뜀"
else
  # 인증이 이미 FAIL 이면 다시 봐도 똑같으니 기다리지 않는다
  zw=${CLOUD_ZERO_WAIT_SEC:-300}; [ $NF -gt 0 ] && zw=0
  CLOUD_ZERO_WAIT_SEC=$zw tmo 420 bash tools/cloud-zero.sh > "$WORK/zero.out" 2>&1; zr=$?
  case $zr in 0) ok cloud-zero "AWS·GCP 자원 0" ;; 1) fail cloud-zero "자원이 남음: $(grep -A3 '^\[' "$WORK/zero.out" | head -6 | tr '\n' ' ' | head -c 300)" ;; *) fail cloud-zero "조회 실패(rc=$zr): $(tail -2 "$WORK/zero.out" | tr '\n' ' ')" ;; esac
fi

# 7. 한도·API·결제 (기존 사전 점검)
tmo 60 bash tools/cloud-precheck.sh > "$WORK/pre.out" 2>&1 && ok cloud-precheck "$(tail -1 "$WORK/pre.out")" || fail cloud-precheck "$(grep '^FAIL' "$WORK/pre.out" | head -3 | tr '\n' ' ')"

# 8. 데모 B 준비물: 출발 DB(k3d CNPG → 맥 포트), REPL_SOURCE_URL, 발표 화면 8080
src=${REPL_SOURCE_URL:-$(sed -n 's/^REPL_SOURCE_URL=//p' .env 2>/dev/null | tail -n 1)}
if [ -z "$src" ]; then fail repl-source ".env 에 REPL_SOURCE_URL 없음 (B3 단계 실패)"
# demo-day 는 .env 값을 글자 그대로 읽는다(sed). ${X} 꼴이 남아 있으면 비밀번호 자리에 그 글자가 들어가 복제 접속이 실패한다 (11/2 맥: compose 가 SRC_PW 경고)
elif printf '%s' "$src" | grep -q '\$'; then
  v=$(printf '%s' "$src" | grep -o '\${\{0,1\}[A-Za-z_][A-Za-z0-9_]*' | tr -d '${' | sort -u | tr '\n' ' ')

  fail repl-source "REPL_SOURCE_URL 안에 \${${v% }} 참조 → 그 자리에 실제 비밀번호를 URL 인코딩해 바로 적는다 (demo-day 는 글자 그대로 읽음. 값은 채팅 금지)"
else ok repl-source "REPL_SOURCE_URL 있음 (변수 없음)"; fi
(exec 3<>"/dev/tcp/127.0.0.1/$LPORT") 2>/dev/null && ok source-db "맥 $LPORT 열림 (터널 뒤 출발 DB)" || fail source-db "맥 $LPORT 닫힘: k3d 출발 클러스터(CNPG)가 안 떠 있음"
# .env 값 안의 ${X} 참조: compose 는 .env 와 셸에서만 푼다. 없으면 빈 글자가 된다(11/2 맥 SRC_PW 경고). 이름만 찍고 값은 안 찍는다
if [ -f .env ]; then
  refs=$(grep -v '^[[:space:]]*#' .env | sed -n 's/^[A-Za-z_][A-Za-z0-9_]*=//p' | grep -o '\${\{0,1\}[A-Za-z_][A-Za-z0-9_]*' | tr -d '${' | sort -u)
  # 다른 줄에 정의돼 있어도 안 된다: compose 만 풀고 demo-day·워커(node --env-file)는 글자 그대로 읽는다 → 참조가 있으면 전부 FAIL
  bad=""; for x in $refs; do bad="$bad $x"; done
  if [ -n "$bad" ]; then fail env-refs ".env 값 안에 풀리지 않는 참조:$bad → 그 자리에 실제 값을 바로 적는다(URL 이면 URL 인코딩). demo-day(sed)·node --env-file 은 \${…} 를 풀지 않는다. Jeong 손, 값은 채팅 금지"
  else ok env-refs ".env 안 \${…} 참조 없음"; fi
fi
# WEBUP: 발표 화면은 up 끝에 demo-day 가 web 컨테이너만 호스트 api(3000)에 붙여 다시 띄운다(--pull never).
#   그래서 지금 8080 이 떠 있을 필요는 없고, (1) web 이미지가 이 맥에 있고 (2) 컨테이너에서 호스트 127.0.0.1 에 닿아야 한다
webimg=$(docker compose -f docker-compose.prod.yml config --images web 2>/dev/null | head -n 1)
if [ -z "$webimg" ]; then fail web-image "docker compose -f docker-compose.prod.yml config 실패 (docker 켜짐?)"
elif ! docker image inspect "$webimg" >/dev/null 2>&1; then fail web-image "web 이미지 $webimg 없음 → 같은 IMAGE_PREFIX·IMAGE_TAG 로 docker compose -f docker-compose.prod.yml build web"
else
  ok web-image "$webimg 있음"
  pport=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
  python3 -m http.server "$pport" --bind 127.0.0.1 --directory "$WORK" >/dev/null 2>&1 & ppid=$!
  sleep 1
  if tmo 30 docker run --rm --add-host host.docker.internal:host-gateway --entrypoint wget "$webimg" -q -T 5 -O /dev/null "http://host.docker.internal:$pport/" >/dev/null 2>&1; then ok web-host "컨테이너 → 호스트 127.0.0.1 닿음 (8080 화면이 이 회차 api 3000 을 씀)"
  else fail web-host "컨테이너에서 host.docker.internal:127.0.0.1 포트에 못 닿음 → 8080 화면이 실회차 이전을 못 보여 줌"; fi
  kill "$ppid" 2>/dev/null; wait "$ppid" 2>/dev/null
fi
if curl -s -m 2 -o /dev/null http://localhost:3300/healthz; then warn web-prod-api "svc-prod api(3300)가 떠 있음. up 끝에 demo-day 가 멈춘다(화면은 3000 에 붙음)"; fi
curl -s -m 5 -o /dev/null https://checkip.amazonaws.com && ok checkip "공인 IP 조회 됨 (중계기 SSH 허용)" || fail checkip "checkip.amazonaws.com 안 됨"
curl -s -m 5 -o /dev/null https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem && ok rds-ca "RDS CA 받기 됨" || fail rds-ca "RDS CA 주소 안 됨"

# 9. terraform init·validate (모든 모듈) + plan (apply 와 같은 변수, 잠금 안 잡음)
for d in "$TFA" "$TFG" "$TFR"; do
  if tmo 300 terraform -chdir="$d" init -input=false > "$WORK/init.out" 2>&1 && tmo 120 terraform -chdir="$d" validate -no-color > "$WORK/val.out" 2>&1; then ok "validate:${d#infra/modules/}" "init·validate 통과"
  else fail "validate:${d#infra/modules/}" "$(grep -m2 -E 'Error|error' "$WORK/init.out" "$WORK/val.out" | tr '\n' ' ' | head -c 300)"; fi
done
if [ "$QUICK" = 1 ]; then warn plan "--quick 이라 plan 건너뜀"
else
  if [ -n "${acct:-}" ]; then
    TF_VAR_expected_account_id=$acct tmo 300 terraform -chdir="$TFA" plan -input=false -lock=false -no-color -detailed-exitcode -var create_eks=true > "$WORK/plan-a.out" 2>&1; pr=$?
    case $pr in 0|2) ok plan:aws/env "plan 통과 ($(grep -m1 -E '^Plan:|No changes' "$WORK/plan-a.out"))" ;; *) fail plan:aws/env "$(grep -m3 -E 'Error' -A2 "$WORK/plan-a.out" | tr '\n' ' ' | head -c 400)" ;; esac
  else fail plan:aws/env "aws 인증이 없어 못 함"; fi
  tmo 300 terraform -chdir="$TFG" plan -input=false -lock=false -no-color -detailed-exitcode -var "project_id=$GCP_PROJECT" -var "zone=$GCP_ZONE" -var "name=${CLUSTER_NAME:-platform-target}" > "$WORK/plan-g.out" 2>&1; pr=$?
  case $pr in 0|2) ok plan:gcp/env "plan 통과 ($(grep -m1 -E '^Plan:|No changes' "$WORK/plan-g.out"))" ;; *) fail plan:gcp/env "$(grep -m3 -E 'Error' -A2 "$WORK/plan-g.out" | tr '\n' ' ' | head -c 400)" ;; esac
  # 중계기는 aws/env 의 VPC 가 있어야 plan 이 된다(data "aws_vpc") → validate 와 변수 대조까지만
  warn plan:aws/demo-relay "VPC 가 생긴 뒤에만 plan 가능 → validate·필수 변수 대조로 대신"
fi

echo "판정 $([ $NF -eq 0 ] && echo PASS || echo FAIL) FAIL $NF WARN $NW 초 $(( $(date +%s) - T0 ))"
[ $NF -eq 0 ]

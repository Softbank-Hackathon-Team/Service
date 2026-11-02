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
export GCP_PROJECT GCP_ZONE   # GATE: cloud-zero·cloud-precheck 가 같은 프로젝트를 보게 (cloud-zero 는 없으면 gcloud 기본 프로젝트를 본다)
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
# GATE: aws CLI 는 AWS_REGION 이 아니라 AWS_DEFAULT_REGION 을 읽는다 (demo-day 와 같은 줄). 비밀·IAM 조회가 엉뚱한 리전을 보지 않게
export AWS_DEFAULT_REGION=$AWS_REGION
# GATE: 명령 출력에서 12자리 계정 번호·IP 를 가린다 (FAIL 줄은 Jeong 화면·공유 폴더로 간다)
redact() { sed -E 's/[0-9]{12}/<계정>/g; s/([0-9]{1,3}\.){3}[0-9]{1,3}/<ip>/g'; }

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
# GATE: 키 파일이 있어도 암호가 걸려 있으면 BatchMode ssh(중계기 확인·터널)가 조용히 실패해 터널을 900초 기다리다 멈춘다 → 암호 없이 읽히거나 ssh-agent 에 올라 있어야 한다
pubk=$(awk '{print $2}' "$HOME/.ssh/id_ed25519.pub" 2>/dev/null)
# shellcheck disable=SC2088  # 사람에게 보이는 안내 글자라 ~ 를 그대로 둔다 (펼칠 경로가 아님)
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then fail ssh-key-usable "~/.ssh/id_ed25519 (개인키) 없음"
elif ssh-keygen -y -P '' -f "$HOME/.ssh/id_ed25519" > "$WORK/pub" 2>/dev/null; then
  if [ -n "$pubk" ] && [ "$(awk '{print $2}' "$WORK/pub")" = "$pubk" ]; then ok ssh-key-usable "암호 없는 키, 공개키와 짝 맞음"; else fail ssh-key-usable "id_ed25519 와 id_ed25519.pub 가 짝이 아님 (중계기에 넣는 공개키로 못 들어감)"; fi
elif [ -n "$pubk" ] && ssh-add -L 2>/dev/null | grep -qF "$pubk"; then ok ssh-key-usable "암호 키지만 ssh-agent 에 올라 있음"
else fail ssh-key-usable "id_ed25519 에 암호가 있고 ssh-agent 에도 없음 → ssh-add ~/.ssh/id_ed25519 (BatchMode 터널이 못 붙음)"; fi

# 2. 인증 (값은 안 찍음)
acct=$(tmo 20 aws sts get-caller-identity --query Account --output text 2>"$WORK/aws.err")
case "$acct" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ok aws-auth "프로필 $AWS_PROFILE 로 계정 확인 (expected_account_id 를 여기서 받음)" ;;
  *) fail aws-auth "sts 실패: $(head -c 120 "$WORK/aws.err" | redact | tr '\n' ' ') (aws sso login --profile $AWS_PROFILE ?)" ;; esac
[ "$AWS_REGION" = ap-northeast-2 ] && ok aws-region "ap-northeast-2" || fail aws-region "$AWS_REGION (서울 고정)"
# GATE: SSO 토큰이 up+down(≈1시간 반) 중간에 끝나면 apply/destroy 가 ExpiredToken 으로 중간에 멈춘다 → 캐시의 만료 시각으로 남은 시간을 본다 (어느 프로필 것인지는 모름 → WARN 까지만)
if ls "$HOME"/.aws/sso/cache/*.json >/dev/null 2>&1; then
  left=$(python3 -I - "$HOME"/.aws/sso/cache/*.json <<'PY'
import json, sys, datetime
best = None
for f in sys.argv[1:]:
    try: d = json.load(open(f))
    except Exception: continue
    if "accessToken" not in d or "expiresAt" not in d: continue
    try: e = datetime.datetime.fromisoformat(d["expiresAt"].replace("Z", "+00:00"))
    except Exception: continue
    if e.tzinfo is None: e = e.replace(tzinfo=datetime.timezone.utc)
    best = e if best is None or e > best else best
print(int((best - datetime.datetime.now(datetime.timezone.utc)).total_seconds() // 60) if best else "")
PY
)
  if [ -z "$left" ]; then warn aws-sso "SSO 캐시에서 만료 시각을 못 읽음 (SSO 가 아니면 무시)"
  elif [ "$left" -lt 180 ]; then warn aws-sso "SSO 토큰 남은 시간 ${left}분 (<3시간) → up+down 중간에 끊길 수 있음: aws sso login --profile $AWS_PROFILE 다시"
  else ok aws-sso "SSO 토큰 남은 시간 ${left}분"; fi
fi
tmo 20 gcloud auth print-access-token >/dev/null 2>&1 && ok gcloud-auth "gcloud 로그인 있음" || fail gcloud-auth "gcloud auth login 필요"
# terraform google provider 는 gcloud 로그인이 아니라 ADC 를 쓴다
tmo 20 gcloud auth application-default print-access-token >/dev/null 2>&1 && ok gcp-adc "ADC 있음 (terraform google provider)" || fail gcp-adc "gcloud auth application-default login 필요"
tmo 20 gcloud projects describe "$GCP_PROJECT" --format='value(lifecycleState)' 2>/dev/null | grep -q ACTIVE && ok gcp-project "$GCP_PROJECT ACTIVE" || fail gcp-project "$GCP_PROJECT 를 못 읽음"
case "$GCP_ZONE" in asia-northeast3-*) ok gcp-zone "$GCP_ZONE" ;; *) fail gcp-zone "$GCP_ZONE (asia-northeast3 고정)" ;; esac

# 2-g. GCP 전용 (GATE-gcp). 조회·정적 검사만
# 인증 플러그인: 있기만 하고 실행이 안 되면(아키텍처 다름·깨진 설치) kubeconfig 단계에서야 멈춘다 → 한 번 실행해 본다
if command -v gke-gcloud-auth-plugin >/dev/null 2>&1; then
  tmo 20 gke-gcloud-auth-plugin --version >/dev/null 2>&1 && ok gke-auth-plugin-run "실행됨" || fail gke-auth-plugin-run "gke-gcloud-auth-plugin --version 실패 → gcloud components reinstall 또는 gcloud components install gke-gcloud-auth-plugin"
fi
# terraform google provider 는 이 환경 변수가 있으면 ADC 파일 대신 그것을 쓴다 → 아래 ADC 확인과 다른 자격으로 돌 수 있다
for v in GOOGLE_CREDENTIALS GOOGLE_OAUTH_ACCESS_TOKEN GOOGLE_APPLICATION_CREDENTIALS; do
  eval "x=\${$v:-}"
  [ -n "$x" ] || continue
  if [ "$v" = GOOGLE_APPLICATION_CREDENTIALS ] && [ ! -f "$x" ]; then fail gcp-cred-env "$v 가 없는 파일을 가리킴 → unset $v (terraform 이 인증 실패)"
  else warn gcp-cred-env "$v 가 설정됨 → terraform 은 ADC 대신 이것을 씀 (의도한 게 아니면 unset $v)"; fi
done
# ADC 로 이 프로젝트 compute 를 실제로 읽을 수 있나 (gcloud 로그인과 ADC 계정이 다를 수 있다). 토큰은 0600 파일로만 curl 에 넘기고 찍지 않는다
reg=${GCP_ZONE%-*}
if tok=$(tmo 20 gcloud auth application-default print-access-token 2>/dev/null) && [ -n "$tok" ]; then
  ( umask 077; printf 'Authorization: Bearer %s\n' "$tok" > "$WORK/adc.h" ); unset tok
  code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H @"$WORK/adc.h" "https://compute.googleapis.com/compute/v1/projects/$GCP_PROJECT/regions/$reg"); rm -f "$WORK/adc.h"
  case "$code" in 200) ok gcp-adc-access "ADC 로 $GCP_PROJECT compute 읽기 됨" ;;
    *) fail gcp-adc-access "ADC 로 $GCP_PROJECT 를 못 읽음 (HTTP $code) → gcloud auth application-default login 을 이 프로젝트 권한 있는 계정으로" ;; esac
fi
# 노드 머신 타입이 이 존에 있나 (오타·존 미지원은 GKE apply 10분 뒤에야 실패). 재고 부족(일시적)은 여기서 못 잡는다 → 실패 시 자동 down
mt=$(sed -n '/variable "node_machine_type"/,/}/s/^[[:space:]]*default[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TFG/main.tf" | head -n 1)
if [ -n "$mt" ]; then
  tmo 20 gcloud compute machine-types describe "$mt" --zone "$GCP_ZONE" --project "$GCP_PROJECT" --format='value(name)' 2>/dev/null | grep -qx "$mt" \
    && ok gcp-machine-type "$mt 가 $GCP_ZONE 에 있음" || fail gcp-machine-type "$mt 를 $GCP_ZONE 에서 못 찾음 (node_machine_type 확인)"
else fail gcp-machine-type "gcp/env main.tf 에서 node_machine_type 기본값을 못 읽음"; fi
# GKE 버전: 고정이 없으면 GKE 가 존 기본(유효) 버전을 고른다. 고정이 생기면 지금 받는 버전 목록과 대조
gv=$(sed -nE 's/^[[:space:]]*(min_master_version|node_version)[[:space:]]*=[[:space:]]*"([^"]*)".*/\2/p' "$TFG/main.tf" | head -n 1)
if [ -z "$gv" ]; then ok gke-version "버전 고정 없음 (존 기본 버전)"
elif tmo 30 gcloud container get-server-config --zone "$GCP_ZONE" --project "$GCP_PROJECT" --format='value(validMasterVersions)' 2>/dev/null | tr ';,' '\n\n' | grep -q "^$gv"; then ok gke-version "$gv 받음"
else fail gke-version "고정 버전 $gv 를 $GCP_ZONE 이 안 받음 (gcloud container get-server-config)"; fi
# PSA 지우기·다시 만들기 장치가 그대로 있나 (빠지면 down 이 code 9 로 멈추거나, 다음 up 의 연결 생성이 "Cannot modify allocated ranges" 로 멈춘다)
psa=$(sed -n '/resource "google_service_networking_connection" "psa"/,/^}/p' "$TFG/main.tf")
pbad=""
printf '%s\n' "$psa" | grep -Eq '^[[:space:]]*deletion_policy[[:space:]]*=[[:space:]]*"ABANDON"' || pbad="$pbad deletion_policy=ABANDON"
printf '%s\n' "$psa" | grep -Eq '^[[:space:]]*update_on_creation_fail[[:space:]]*=[[:space:]]*true' || pbad="$pbad update_on_creation_fail=true"
grep -q 'networks peerings delete servicenetworking-googleapis-com' tools/demo-day.sh || pbad="$pbad demo-day 피어링 삭제"
[ -z "$pbad" ] && ok gcp-psa-guard "PSA ABANDON·update_on_creation_fail·피어링 삭제 그대로" || fail gcp-psa-guard "빠짐:$pbad"

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
nw=$(grep -nE 'terraform -chdir="\$TFA" (apply|destroy)' tools/demo-day.sh | grep -v aws_account_var | cut -d: -f1 | redact | tr '\n' ' ')
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
# GATE: IAM 역할·정책은 cloud-zero 가 안 세던 것(지금은 센다). state 를 잃은 채 남으면 EKS 더하기(apply 뒤 ≈15분)가 EntityAlreadyExists 로 멈춘다
iam_left=""
for r in "${CLUSTER_NAME:-platform-target}-cluster" "${CLUSTER_NAME:-platform-target}-node"; do tmo 20 aws iam get-role --role-name "$r" >/dev/null 2>&1 && iam_left="$iam_left 역할:$r"; done
[ "$(tmo 20 aws iam list-policies --scope Local --query "length(Policies[?PolicyName=='platform-app-boundary'])" --output text 2>/dev/null)" = 1 ] && iam_left="$iam_left 정책:platform-app-boundary"
if [ -z "$iam_left" ]; then ok iam-left "지난 회차 IAM(클러스터·노드 역할, platform-app-boundary) 없음"
elif [ "$RESUME" = 1 ]; then warn iam-left "IAM 남음:$iam_left (RESUME=1 → 그 위에서 이어 감)"
else fail iam-left "IAM 남음:$iam_left → aws/env state 가 있으면 jeong-down, 없으면 콘솔·CLI 로 지운 뒤 up"; fi
# GATE-v1 (연결 스택): 실세션 connect 는 환경마다 새 스택(svc-connect-<환경 8자>)을 만들지만 역할 이름은 고정(svc-observe·svc-operate)이다.
#   지난 회차 스택이 남아 있으면 새 스택 생성이 "already exists" 로 ROLLBACK 되거나(REAL_CONNECT_RUN=1), 옛 ExternalId 역할로 verify 가 AccessDenied → connect 단계에서 실패한다.
#   down 의 connect-stack 단계가 지운다. 여기선 남았으면 FAIL(RESUME=1 이면 WARN). 같이 "권한이 레포 템플릿(observe-extra·ViewOnlyAccess)과 같은지" 도 본다
#   (DEPLOYNONK8S 처럼 표 packages/adapters/src/common/observe-permissions.ts 가 늘면 옛 템플릿으로 만든 역할은 가져오기·검증이 AccessDenied). 조회만, 계정·ARN 안 찍음
obs_lvl() { if [ "${UP_PREFLIGHT_OBSERVE:-fail}" = warn ]; then warn "$@"; else fail "$@"; fi; }
otpl=infra/onboarding/aws-connect.json
cs_roles=""; cs_err=""
for r in svc-observe svc-operate; do
  if tmo 20 aws iam get-role --role-name "$r" >/dev/null 2>"$WORK/or.err"; then cs_roles="$cs_roles $r"
  elif ! grep -q NoSuchEntity "$WORK/or.err"; then cs_err="$cs_err $r"; fi
done
[ -z "$cs_err" ] || warn connect-stack "역할 조회 실패:$cs_err ($(head -c 80 "$WORK/or.err" | redact | tr '\n' ' '))"
if [ -z "$cs_roles" ]; then [ -z "$cs_err" ] && ok connect-stack "지난 회차 연결 스택·svc-observe 없음 (연결은 실세션에서 새 템플릿으로 만든다)"
else
  set -- $cs_roles
  cs_stack=$(tmo 20 aws cloudformation describe-stack-resources --physical-resource-id "$1" --query 'StackResources[0].StackName' --output text 2>/dev/null)
  case "$cs_stack" in ''|None) cs_stack="" ;; esac
  cs_perm="권한 비교 못 함"; oprm=""
  if [ -f "$otpl" ] && tmo 20 aws iam get-role-policy --role-name svc-observe --policy-name observe-extra --output json > "$WORK/or.json" 2>/dev/null; then
    tmo 20 aws iam list-attached-role-policies --role-name svc-observe --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null | tr '\t' '\n' > "$WORK/or.att" || : > "$WORK/or.att"
    omiss=$(python3 -I - "$otpl" "$WORK/or.json" "$WORK/or.att" <<'PY'
import json, sys
def acts(doc):
    out = set()
    for st in doc.get("Statement", []):
        if st.get("Effect") != "Allow": continue
        a = st.get("Action", []); out.update([a] if isinstance(a, str) else a)
    return out
props = json.load(open(sys.argv[1]))["Resources"]["ObserveRole"]["Properties"]
want = set()
for pol in props.get("Policies", []): want |= acts(pol["PolicyDocument"])
want_m = {m for m in props.get("ManagedPolicyArns", []) if isinstance(m, str)}
try: have = acts(json.load(open(sys.argv[2]))["PolicyDocument"])
except Exception: have = set()
have_m = {l.strip() for l in open(sys.argv[3]) if l.strip() and l.strip() != "None"}
print(" ".join(sorted(want - have) + sorted("관리형:" + m.rsplit("/", 1)[-1] for m in want_m - have_m)))
PY
)
    if [ -z "$omiss" ]; then cs_perm="권한은 레포 템플릿과 같음"; else cs_perm="빠진 권한 $(echo $omiss | wc -w | tr -d ' ')개: $(echo $omiss | cut -c1-160)"; fi
    oprm=$(python3 -I -c 'import json,sys; print(" ".join("ParameterKey=%s,UsePreviousValue=true" % k for k in json.load(open(sys.argv[1])).get("Parameters", {})))' "$otpl" 2>/dev/null)
  fi
  if [ -n "$cs_stack" ]; then cs_fix="aws cloudformation delete-stack --stack-name $cs_stack && aws cloudformation wait stack-delete-complete --stack-name $cs_stack"
  else cs_fix="스택이 아니라 콘솔에서 역할$cs_roles 삭제"; fi
  if [ "$RESUME" = 1 ]; then
    case "$cs_perm" in
      빠진*) warn connect-stack "지난 회차 연결 스택 ${cs_stack:-(없음)} 역할$cs_roles 남음 (RESUME=1) — $cs_perm → 새 템플릿으로 스택 업데이트: aws cloudformation update-stack --stack-name ${cs_stack:-<스택>} --template-body file://$otpl --capabilities CAPABILITY_NAMED_IAM --parameters $oprm" ;;
      *) warn connect-stack "지난 회차 연결 스택 ${cs_stack:-(없음)} 역할$cs_roles 남음 (RESUME=1, $cs_perm)" ;;
    esac
  else fail connect-stack "지난 회차 연결 스택 ${cs_stack:-(없음)} 역할$cs_roles 남음 ($cs_perm) → 새 회차 connect 가 이름 충돌·ExternalId 불일치로 실패한다 → $cs_fix 뒤 up (down 의 connect-stack 단계도 지움)"; fi
fi
# 실세션의 "AWS 연결" 링크는 CONNECT_TEMPLATE_URL(S3)에 올린 템플릿으로 역할을 만든다 → 레포 템플릿과 내용이 다르면(옛것) 새 연결도 옛 권한. 주소는 안 찍는다
turl=${CONNECT_TEMPLATE_URL:-$(sed -n 's/^CONNECT_TEMPLATE_URL=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'")}
if [ -z "$turl" ]; then warn connect-template "CONNECT_TEMPLATE_URL 비어 있음 (실세션에서 AWS 연결 링크를 쓰면 503 CONNECT_NOT_CONFIGURED. 안 쓰면 무시)"
elif [ -f "$otpl" ]; then
  tcode=$(curl -s -m 15 -o "$WORK/tpl.json" -w '%{http_code}' "$turl" 2>/dev/null)
  if [ "$tcode" = 200 ]; then
    if python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == json.load(open(sys.argv[2])) else 1)' "$otpl" "$WORK/tpl.json" 2>/dev/null; then ok connect-template "올린 템플릿이 레포 $otpl 과 같음"
    else obs_lvl connect-template "올린 템플릿(CONNECT_TEMPLATE_URL)이 레포 $otpl 과 다름 → 새 템플릿을 같은 주소에 올린 뒤 up (옛 템플릿으로 연결하면 관찰 역할 권한이 모자람)"; fi
  else warn connect-template "올린 템플릿을 못 읽음 (HTTP ${tcode:-없음}; 공개 읽기가 아니면 정상. 레포 $otpl 과 같은지 콘솔에서 확인)"; fi
fi
# GCP: 고객 프로젝트(기본 GCP_PROJECT, 다르면 OBSERVE_GCP_PROJECT)의 커스텀 역할 platform_observe vs gcp-connect.sh 의 OBSERVE_PERMS (스크립트가 빠진 권한만 더하는 것과 같은 비교)
gsc=infra/onboarding/gcp-connect.sh
if [ -f "$gsc" ]; then
  gwant=$(sed -n 's/^OBSERVE_PERMS="\(.*\)"$/\1/p' "$gsc" | sed 's/^[$][{]OBSERVE_PERMS[}],//' | tr '\n' ',' | tr -s ',' | sed 's/,$//')
  gprj=${OBSERVE_GCP_PROJECT:-$GCP_PROJECT}
  if ghave=$(tmo 20 gcloud iam roles describe platform_observe --project "$gprj" --format='value(includedPermissions)' 2>"$WORK/gr.err"); then
    ghave=";${ghave//,/;};"; gmiss=""; oIFS=$IFS; IFS=','
    for gp in $gwant; do case "$ghave" in *";$gp;"*) ;; *) gmiss="$gmiss $gp" ;; esac; done
    IFS=$oIFS
    if [ -z "$gmiss" ]; then ok observe-role-gcp "platform_observe 권한 최신 ($gprj)"
    else obs_lvl observe-role-gcp "platform_observe 에 빠진 권한 $(echo $gmiss | wc -w | tr -d ' ')개:$gmiss → 고객 Cloud Shell 에서 gcp-connect.sh 를 같은 값으로 다시 실행 (빠진 권한만 더함)"; fi
  elif grep -qi 'NOT_FOUND\|not found' "$WORK/gr.err"; then ok observe-role-gcp "platform_observe 없음 ($gprj; 연결은 실세션에서 새 스크립트로 만든다)"
  else warn observe-role-gcp "platform_observe 조회 실패: $(head -c 100 "$WORK/gr.err" | redact | tr '\n' ' ')"; fi
else warn observe-role-gcp "$gsc 없음 (점검 생략)"; fi
# GATE: npm 길(tf:real·smoke·워커)은 node_modules 가 있어야 한다. 없으면 B4(apply 뒤 ≈15분)에서야 멈춘다
[ -d node_modules ] && [ -x node_modules/.bin/tsx ] && ok node-modules "node_modules·tsx 있음" || fail node-modules "node_modules(tsx) 없음 → npm ci"
# GATE-common c1: B4 첫 줄(tf:real check aws)은 apply 뒤 ≈12분에야 돈다. 새 자리표시(TF_FACT_*)가 생겼거나 DB 네트워크 값이 거절되면 그때 멈춘다
#   → demo-day u_envfile 이 쓰는 이름(kv TF_FACT_*·DB_*)을 그대로 읽어 자리값으로 채우고 지금 돌린다. 이름은 demo-day.sh 에서 읽으므로 거기 줄이 바뀌면 같이 따라간다
#   DRAFT(ai): 자리값 모양 = vpc-0…, ["subnet-0…"], 계정 000000000000, 클러스터 ""(B4 시점 create_eks=false 라 빈 값), 허용 /32 둘(문서용 IP 대역 TEST-NET)
if [ -x node_modules/.bin/tsx ]; then
  # 맥 BSD sed 는 \| 를 모른다 → -E
  fk=$(sed -nE 's/^[[:space:]]*kv ((TF_FACT|DB)_[A-Z0-9_]*) .*/\1/p' tools/demo-day.sh | sort -u | tr '\n' ' ')
  fe=()
  for k in $fk; do
    case "$k" in
      TF_FACT_VPC_ID) v=vpc-00000000000000000 ;;
      TF_FACT_DB_SUBNET_IDS_JSON|TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON) v='["subnet-00000000000000000","subnet-00000000000000001"]' ;;
      TF_FACT_CLUSTER_NAME) v= ;;
      TF_FACT_ACCOUNT_ID) v=000000000000 ;;
      DB_PEER_CIDRS) v=192.0.2.10/32,198.51.100.10/32 ;;
      DB_PUBLIC|DB_DISPOSABLE) v=1 ;;
      *) v=x ;;
    esac
    fe+=("$k=$v")
  done
  if [ -z "$fk" ]; then fail tfreal-facts "demo-day.sh 에서 kv TF_FACT_·DB_ 줄을 못 읽음 (u_envfile 모양이 바뀜?)"
  elif tmo 90 env "${fe[@]}" npm run -s tf:real -- check aws > "$WORK/tfc.out" 2>&1 && grep -q '^OK 자리표시 0개' "$WORK/tfc.out"; then
    ok tfreal-facts "tf:real check aws 자리값으로 통과 ($(grep -m1 '^DB 네트워크' "$WORK/tfc.out" | redact))"
  else fail tfreal-facts "tf:real check aws 실패 (B4 에서 멈출 것): $(grep -v '^[[:space:]]*$' "$WORK/tfc.out" | tail -2 | redact | tr '\n' ' ' | head -c 300)"; fi
else fail tfreal-facts "node_modules 가 없어 tf:real check 를 못 돌림 → npm ci"; fi
# GATE: 목록 줄은 "<이전 id>  <회사>  <환경>  state 자원 N개  <폴더>" → 4번째 칸이 state. 예전 $3/$5 는 안 맞아 늘 0 이었다(남은 RDS 를 못 봄). 조회 실패도 0 으로 치지 않는다
if tmo 90 npm run -s tf:real -- list > "$WORK/tfl.out" 2>"$WORK/tfl.err"; then
  tl=$(awk '$4 == "state" && $5 == "자원" && $6 != "0개"' "$WORK/tfl.out" | wc -l | tr -d ' ')
  if [ "${tl:-0}" = 0 ]; then ok state:tf-real "이전별 state 남은 것 0"
  elif [ "$RESUME" = 1 ]; then warn state:tf-real "이전별 state ${tl}개"
  else fail state:tf-real "이전별 state ${tl}개 남음 (RDS 등) → jeong-down"; fi
else fail state:tf-real "tf:real list 실패: $(head -c 160 "$WORK/tfl.err" | redact | tr '\n' ' ') (node_modules·.env 확인)"; fi
# GATE: 삭제 예약(7일 복구 창) 비밀이 있으면 같은 이름(platform/<회사>/<앱>/<키>)의 다음 apply 가 실패한다 → up 의 stale 단계와 down 이 force-delete 로 지운다. 여기선 개수만
if sc=$(tmo 30 aws secretsmanager list-secrets --include-planned-deletion --filters Key=name,Values=platform/ --query 'length(SecretList[?DeletedDate != `null`])' --output text 2>/dev/null); then :
else sc=$(for a in $(tmo 30 aws resourcegroupstaggingapi get-resources --resource-type-filters secretsmanager:secret --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null | tr '\t' '\n'); do case "$a" in *:secret:platform/*) d=$(aws secretsmanager describe-secret --secret-id "$a" --query DeletedDate --output text 2>/dev/null); [ -n "$d" ] && [ "$d" != None ] && echo x ;; esac; done | wc -l | tr -d ' '); fi
# GATE-common c2 / GATE-aws: UP_PREFLIGHT_AFTER_PURGE=1 = demo-day up 의 u_tools 가 부를 때(stale 단계의 secrets_purge 가 이미 돈 뒤).
#   그때 남은 예약 비밀(또는 못 읽음)은 FAIL(apply 전에 멈춤). 혼자 칠 때(맥 RC·사람)는 purge 전이라 WARN 그대로
# GATE-aws: demo-day up 이 부를 땐(UP_PREFLIGHT_AFTER_PURGE=1) stale 단계가 이미 지운 뒤라 남아 있으면 FAIL. 혼자 칠 땐 WARN (up 이 지울 것)
spf() { if [ "${UP_PREFLIGHT_AFTER_PURGE:-0}" = 1 ]; then fail "$@"; else warn "$@"; fi; }
case "$sc" in ''|*[!0-9]*) spf secrets-pending "삭제 예약 비밀 수를 못 읽음" ;; 0) ok secrets-pending "삭제 예약(platform/*) 비밀 0" ;;
  *) if [ "${UP_PREFLIGHT_AFTER_PURGE:-0}" = 1 ]; then fail secrets-pending "삭제 예약(platform/*) 비밀 ${sc}개가 stale 단계의 force-delete 뒤에도 남음 → smoke apply 가 'scheduled for deletion' 으로 실패할 것. aws secretsmanager list-secrets --include-planned-deletion 로 확인"
     else warn secrets-pending "삭제 예약(platform/*) 비밀 ${sc}개 → up 의 stale 단계가 바로 지운다 (안 지우면 smoke apply 가 'scheduled for deletion' 으로 실패)"; fi ;; esac

# GATE-aws: AWS 쪽 "apply 를 시작해야 알게 되는" 실패를 apply 전에 본다 (전부 조회만)
#   값은 HCL 기본값을 그대로 읽는다(demo-day 가 이 변수들을 넘기지 않음). HCL 을 바꾸면 이 점검도 같이 따라간다
hcl_default() { awk -v v="$2" '$0 ~ "variable \"" v "\"" {f=1} f && /default/ { gsub(/.*= *"|".*/, ""); print; exit }' "$1/main.tf" 2>/dev/null; }
k8sv=$(hcl_default "$TFA" k8s_version); k8sv=${k8sv:-1.33}
ntype=$(hcl_default "$TFA" node_instance_type); ntype=${ntype:-t3.medium}
rtype=$(sed -n 's/^[[:space:]]*instance_type[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TFR/main.tf" 2>/dev/null | head -n 1); rtype=${rtype:-t4g.nano}
ramip=$(sed -n 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"\(\/aws\/service\/[^"]*\)".*/\1/p' "$TFR/main.tf" 2>/dev/null | head -n 1)
# (1) EKS 버전: 목록에 없거나 UNSUPPORTED 면 클러스터 생성이 거절된다. EXTENDED_SUPPORT 면 만들어지지만 제어부 요금이 시간당 6배($0.10→$0.60) → WARN
ev=$(tmo 20 aws eks describe-cluster-versions --cluster-versions "$k8sv" --query 'clusterVersions[0].versionStatus' --output text 2>"$WORK/ev.err"); evr=$?
if [ $evr -ne 0 ]; then
  if grep -qiE 'Invalid choice|argument operation' "$WORK/ev.err"; then warn eks-version "aws CLI 가 describe-cluster-versions 를 모름(옛 CLI) → $k8sv 상태 못 봄 (brew upgrade awscli 권장)"
  else fail eks-version "EKS 버전 조회 실패: $(head -c 120 "$WORK/ev.err" | redact | tr '\n' ' ')"; fi
else case "$ev" in
  STANDARD_SUPPORT) ok eks-version "EKS $k8sv 표준 지원" ;;
  EXTENDED_SUPPORT) warn eks-version "EKS $k8sv 연장 지원 (만들기는 됨, 제어부 요금 시간당 \$0.60 = 표준의 6배. 몇 시간이면 몇 달러). 바꾸려면 aws/env k8s_version — TODO(human)" ;;
  *) fail eks-version "EKS $k8sv 상태 '${ev:-없음}' → 클러스터 생성이 거절된다 (aws/env k8s_version 을 지원 버전으로)" ;;
esac; fi
# (2) Pod Identity 애드온이 그 버전에 있는가 (aws/env aws_eks_addon.pod_identity, 없으면 EKS 더하기 끝에서 실패)
av=$(tmo 30 aws eks describe-addon-versions --addon-name eks-pod-identity-agent --kubernetes-version "$k8sv" --query 'length(addons[0].addonVersions)' --output text 2>/dev/null)
case "$av" in ''|None|0|*[!0-9]*) fail eks-addon "eks-pod-identity-agent 가 EKS $k8sv 용으로 없음 (값 '${av:-조회 실패}')" ;; *) ok eks-addon "eks-pod-identity-agent EKS $k8sv 용 ${av}개" ;; esac
# (3) 인스턴스 종류가 실제로 쓸 AZ 에 있는가. aws/env 는 data aws_availability_zones(state=available) 이름 정렬 앞 2개에 서브넷을 만든다
#   노드 그룹(사설 서브넷 2개) → 두 AZ 모두에 $ntype, 중계기(공개 서브넷 0번) → 첫 AZ 에 $rtype
azs=$(tmo 20 aws ec2 describe-availability-zones --filters Name=state,Values=available Name=zone-type,Values=availability-zone --query 'AvailabilityZones[].ZoneName' --output text 2>/dev/null | tr '\t' '\n' | grep . | sort | head -n 2 | tr '\n' ' ')
set -- $azs
if [ $# -ne 2 ]; then fail instance-types "쓸 수 있는 AZ 를 2개 못 읽음 ('$azs')"
else
  az1=$1; az2=$2
  offs=$(tmo 20 aws ec2 describe-instance-type-offerings --location-type availability-zone --filters "Name=instance-type,Values=$ntype,$rtype" "Name=location,Values=$az1,$az2" --query 'InstanceTypeOfferings[].[InstanceType,Location]' --output text 2>/dev/null)
  miss=""
  for want in "$ntype $az1" "$ntype $az2" "$rtype $az1"; do printf '%s\n' "$offs" | awk -v t="${want% *}" -v z="${want#* }" '$1 == t && $2 == z { f=1 } END { exit !f }' || miss="$miss ${want% *}@${want#* }"; done
  if [ -z "$offs" ]; then fail instance-types "인스턴스 종류 제공 조회 실패·빈 값"
  elif [ -z "$miss" ]; then ok instance-types "$ntype($az1,$az2) $rtype($az1) 제공됨"
  else fail instance-types "이 AZ 에 없음:$miss → 노드 그룹·중계기 apply 가 실패 (aws/env node_instance_type 또는 demo-relay instance_type 바꾸기 — TODO(human))"; fi
fi
# (4) 중계기 AMI(SSM 공개 파라미터). 중계기 plan 은 VPC 가 생긴 뒤에야 돌아서, 여기서 미리 읽어 본다
if [ -n "$ramip" ]; then
  amiv=$(tmo 20 aws ssm get-parameter --name "$ramip" --query Parameter.Value --output text 2>/dev/null)
  case "$amiv" in ami-*) ok relay-ami "SSM $ramip → AMI 읽힘" ;; *) fail relay-ami "SSM $ramip 를 못 읽음 (ssm:GetParameter 권한·리전) → 중계기 apply 실패" ;; esac
else warn relay-ami "demo-relay main.tf 에서 SSM AMI 이름을 못 찾음 (점검 생략)"; fi
# (5) RDS 등급·엔진: 모듈 기본 db.t4g.micro + postgres 16 (adapters aws 기본). 서울에 그 조합이 없으면 smoke 의 apply 가 9분 뒤 실패
rdsc=${CHECK_RDS_CLASS:-db.t4g.micro}; rdsv=${CHECK_RDS_MAJOR:-16}
rn=$(tmo 60 aws rds describe-orderable-db-instance-options --engine postgres --db-instance-class "$rdsc" --query "length(OrderableDBInstanceOptions[?starts_with(EngineVersion, '$rdsv.')])" --output text 2>/dev/null)
case "$rn" in ''|None|*[!0-9]*) fail rds-class "RDS 주문 가능 조회 실패 (값 '${rn:-없음}')" ;; 0) fail rds-class "$rdsc + postgres $rdsv 를 이 리전에서 못 만듦" ;; *) ok rds-class "$rdsc + postgres $rdsv 주문 가능 (${rn}개 조합)" ;; esac
# (6) 지난 회차가 남긴 RDS 가 바쁜 상태(creating·deleting 등)면 같은 이름 RDS 생성이 막히거나 cloud-zero 가 늦게 0 이 된다 → 이름만 알림
rb=$(tmo 20 aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceStatus]' --output text 2>/dev/null | awk 'NF == 2 { printf "%s%s=%s", s, $1, $2; s=" " }')
[ -z "$rb" ] && ok rds-left "RDS 0" || { [ "$RESUME" = 1 ] && warn rds-left "RDS 남음: $rb" || fail rds-left "RDS 남음: $rb → jeong-down (지우는 중이면 끝날 때까지 기다린 뒤 up)"; }

# 6. 클라우드 자원 0 (조회만)
if [ "$RESUME" = 1 ]; then warn cloud-zero "RESUME=1 이라 건너뜀"
else
  # 인증이 이미 FAIL 이면 다시 봐도 똑같으니 기다리지 않는다
  zw=${CLOUD_ZERO_WAIT_SEC:-300}; [ $NF -gt 0 ] && zw=0
  CLOUD_ZERO_WAIT_SEC=$zw tmo 420 bash tools/cloud-zero.sh > "$WORK/zero.out" 2>&1; zr=$?
  case $zr in 0) ok cloud-zero "AWS·GCP 자원 0" ;; 1) fail cloud-zero "자원이 남음: $(grep -A3 '^\[' "$WORK/zero.out" | head -6 | redact | tr '\n' ' ' | head -c 300)" ;; *) fail cloud-zero "조회 실패(rc=$zr): $(tail -2 "$WORK/zero.out" | redact | tr '\n' ' ')" ;; esac
fi

# 7. 한도·API·결제 (기존 사전 점검)
tmo 60 bash tools/cloud-precheck.sh > "$WORK/pre.out" 2>&1 && ok cloud-precheck "$(tail -1 "$WORK/pre.out")" || fail cloud-precheck "$(grep '^FAIL' "$WORK/pre.out" | head -3 | redact | tr '\n' ' ')"

# 8. 데모 B 준비물: 출발 DB(k3d CNPG → 맥 포트), REPL_SOURCE_URL, 발표 화면 8080
src=${REPL_SOURCE_URL:-$(sed -n 's/^REPL_SOURCE_URL=//p' .env 2>/dev/null | tail -n 1)}
if [ -z "$src" ]; then fail repl-source ".env 에 REPL_SOURCE_URL 없음 (B3 단계 실패)"
# demo-day 는 .env 값을 글자 그대로 읽는다(sed). ${X} 꼴이 남아 있으면 비밀번호 자리에 그 글자가 들어가 복제 접속이 실패한다 (11/2 맥: compose 가 SRC_PW 경고)
elif printf '%s' "$src" | grep -q '\$'; then
  v=$(printf '%s' "$src" | grep -o '\${\{0,1\}[A-Za-z_][A-Za-z0-9_]*' | tr -d '${' | sort -u | tr '\n' ' ')

  fail repl-source "REPL_SOURCE_URL 안에 \${${v% }} 참조 → 그 자리에 실제 비밀번호를 URL 인코딩해 바로 적는다 (demo-day 는 글자 그대로 읽음. 값은 채팅 금지)"
else ok repl-source "REPL_SOURCE_URL 있음 (변수 없음)"; fi
(exec 3<>"/dev/tcp/127.0.0.1/$LPORT") 2>/dev/null && ok source-db "맥 $LPORT 열림 (터널 뒤 출발 DB)" || fail source-db "맥 $LPORT 닫힘: k3d 출발 클러스터(CNPG)가 안 떠 있음"
# GATE: 워커·API 가 붙는 플랫폼 DB(.env DATABASE_URL). 닫혀 있으면 B4(apply 뒤 ≈15분)에서야 "API 가 안 뜸" → up 의 시작 점검이 docker compose 의 db 를 켠다
hp=$(sed -n 's/^DATABASE_URL=//p' .env 2>/dev/null | tail -n 1 | sed -E 's#^[a-z]+://([^@/]*@)?([^/:?]+)(:([0-9]+))?.*#\2 \4#')
set -- ${hp:-localhost 5432}; dbh=${1:-localhost}; dbp=${2:-5432}
(exec 3<>"/dev/tcp/$dbh/$dbp") 2>/dev/null && ok platform-db "플랫폼 DB $dbh:$dbp 열림 (워커·API 가 붙는 곳)" || warn platform-db "플랫폼 DB $dbh:$dbp 닫힘 → up 의 시작 점검이 docker compose up -d --wait db 로 켠다 (따로 치려면 그 줄)"
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
ip1=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
case "$ip1" in *[!0-9.]*|"") fail checkip "checkip.amazonaws.com 안 됨" ;; *) ok checkip "공인 IP 조회 됨 (중계기 SSH 허용)" ;; esac
# GATE: 출구 IP 가 둘이면(VPN·이중 회선) 중계기 SSH 허용(/32)이 어긋나 터널이 900초 기다리다 멈춘다 → up 은 둘 다 넣는다. 여기선 알림만
if command -v dig >/dev/null 2>&1 && [ -n "$ip1" ]; then ip2=$(dig +short +time=3 +tries=1 myip.opendns.com @resolver1.opendns.com 2>/dev/null | tail -n 1)
  case "$ip2" in ''|*[!0-9.]*) ;; "$ip1") ok egress-ip "https·dns 출구 IP 같음" ;; *) warn egress-ip "https 와 dns 의 출구 IP 가 다름 (VPN·이중 회선?) → up 이 둘 다 중계기 SSH 허용에 넣는다" ;; esac; fi
curl -s -m 5 -o /dev/null https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem && ok rds-ca "RDS CA 받기 됨" || fail rds-ca "RDS CA 주소 안 됨"

# 9. terraform init·validate (모든 모듈) + plan (apply 와 같은 변수, 잠금 안 잡음)
for d in "$TFA" "$TFG" "$TFR"; do
  if tmo 300 terraform -chdir="$d" init -input=false > "$WORK/init.out" 2>&1 && tmo 120 terraform -chdir="$d" validate -no-color > "$WORK/val.out" 2>&1; then ok "validate:${d#infra/modules/}" "init·validate 통과"
  else fail "validate:${d#infra/modules/}" "$(grep -m2 -E 'Error|error' "$WORK/init.out" "$WORK/val.out" | redact | tr '\n' ' ' | head -c 300)"; fi
done
if [ "$QUICK" = 1 ]; then warn plan "--quick 이라 plan 건너뜀"
else
  if [ -n "${acct:-}" ]; then
    TF_VAR_expected_account_id=$acct tmo 300 terraform -chdir="$TFA" plan -input=false -lock=false -no-color -detailed-exitcode -var create_eks=true > "$WORK/plan-a.out" 2>&1; pr=$?
    case $pr in 0|2) ok plan:aws/env "plan 통과 ($(grep -m1 -E '^Plan:|No changes' "$WORK/plan-a.out"))" ;; *) fail plan:aws/env "$(grep -m3 -E 'Error' -A2 "$WORK/plan-a.out" | redact | tr '\n' ' ' | head -c 400)" ;; esac
  else fail plan:aws/env "aws 인증이 없어 못 함"; fi
  tmo 300 terraform -chdir="$TFG" plan -input=false -lock=false -no-color -detailed-exitcode -var "project_id=$GCP_PROJECT" -var "zone=$GCP_ZONE" -var "name=${CLUSTER_NAME:-platform-target}" > "$WORK/plan-g.out" 2>&1; pr=$?
  case $pr in 0|2) ok plan:gcp/env "plan 통과 ($(grep -m1 -E '^Plan:|No changes' "$WORK/plan-g.out"))" ;; *) fail plan:gcp/env "$(grep -m3 -E 'Error' -A2 "$WORK/plan-g.out" | redact | tr '\n' ' ' | head -c 400)" ;; esac
  # 중계기는 aws/env 의 VPC 가 있어야 plan 이 된다(data "aws_vpc") → validate 와 변수 대조까지만
  warn plan:aws/demo-relay "VPC 가 생긴 뒤에만 plan 가능 → validate·필수 변수 대조로 대신"
fi

echo "판정 $([ $NF -eq 0 ] && echo PASS || echo FAIL) FAIL $NF WARN $NW 초 $(( $(date +%s) - T0 ))"
[ $NF -eq 0 ]

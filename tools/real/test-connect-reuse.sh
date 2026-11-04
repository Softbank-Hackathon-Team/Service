#!/usr/bin/env bash
# real-session.sh connect 단계 CONNREUSE 시험 (가짜 npm·aws·curl, 클라우드 호출 0). 상태: AI 초안
#   bash tools/real/test-connect-reuse.sh [Service 폴더, 기본 이 레포]    끝 코드 0 = 전부 통과 (apps/api/test/real-connect-reuse.test.ts 가 부름)
# 시나리오: 충돌→지우고 다시 / 이미 있음 / 이미 connected / 우리 모양 아닌 스택 충돌(안 지움) / 지운 뒤 또 충돌 / CON-01 GCP 도착 연결 → MI_TARGET_ENV
HERE="$(cd "$(dirname "$0")" && pwd)"; SVC="${1:-$(cd "$HERE/../.." && pwd)}"; PASS=0; FAILN=0
ID=11111111-2222-3333-4444-555555555555
GID=44444444-4444-4444-8444-444444444444
GSA="t-$(printf %s 11111111-1111-4111-8111-111111111111 | python3 -c 'import hashlib,sys;print(hashlib.md5(sys.stdin.buffer.read()).hexdigest()[:28])')@plat-proj.iam.gserviceaccount.com"
LINK="https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/quickcreate?stackName=svc-connect-11111111&param_ExternalId=x"
run_case() { local name="$1" scen="$2"; shift 2
  local W; W="$(mktemp -d "${TMPDIR:-/tmp}/conn-reuse.XXXXXX")"; mkdir -p "$W/bin" "$W/state" "$W/res"
  echo REAL_STS=1 > "$W/state/demo-day.env"
  cat > "$W/bin/npm" <<NPM
#!/bin/sh
echo "npm \$*" >> "$W/calls"
case "\$*" in
  *"env:connect -- whoami"*) echo "회사  11111111-1111-4111-8111-111111111111" ;;
  *"env:connect -- create --provider gcp"*) echo "환경 만듦  $GID (gcp, real-dst)"; echo "명령:"; echo "PLATFORM_SA='$GSA' PROJECT_ID='cust-proj' ROLE_DIR=./permissions bash onboarding/gcp-connect.sh" ;;
  *"env:connect -- verify --env $GID"*) f="${GVFIN:-connected}"; echo "+  40000 ms  \$f"; echo "연결 확인 결과  \$f"; [ "\$f" = connected ] || exit 1 ;;
  *"env:connect -- create"*) n=\$(grep -c 'env:connect -- create' "$W/calls")
    case "$scen:\$n" in
      conflict:1|twice:*|foreign:*) echo "환境 만듦  $ID (aws, real-src)" | sed 's/환境/환경/'; echo "$LINK"; s=svc-connect-0ld00000; [ "$scen" = foreign ] && s=someone-else; echo "연결 스택 충돌  \$s CREATE_COMPLETE" >&2; exit 3 ;;
      conflict:*) echo "환경 만듦  $ID (aws, real-src, 이어 씀: 지금 pending)"; echo "$LINK"; echo "스택이 다 만들어지면: ..." ;;
      exists:*|disc:*) echo "환경 만듦  $ID (aws, real-src)"; echo "$LINK"; echo "연결 스택 이미 있음  svc-connect-11111111 CREATE_COMPLETE 이 환경 것 → 새로 만들지 말고 verify" ;;
      connected:*) echo "환경 만듦  $ID (aws, real-src, 이어 씀: 지금 connected)"; echo "이미 connected → 링크를 다시 받지 않음. 확인만: npm run env:connect -- verify --env $ID --account <12자리>" ;;
    esac ;;
  *"env:connect -- verify"*) [ "$scen" = disc ] && { echo "+   900 ms  disconnected"; echo "연결 확인 결과  disconnected"; exit 1; }; echo "+   900 ms  connected"; echo "연결 확인 결과  connected" ;;
esac
NPM
  cat > "$W/bin/aws" <<AWS
#!/bin/sh
echo "aws \$*" >> "$W/calls"
case "\$*" in
  *"sts get-caller-identity"*) echo 000000000000 ;;
  *"cloudformation describe-stacks"*) echo svc-connect-11111111 ;;
  *"cloudtrail lookup-events"*) echo '{"sourceIdentity":"svc-test"}' ;;
esac
exit 0
AWS
  printf '#!/bin/sh\necho "gcloud $*" >> "%s/calls"\ncase "$*" in "config get-value account") echo p@example.com ;; esac\nexit 0\n' "$W" > "$W/bin/gcloud"
  chmod +x "$W/bin/npm" "$W/bin/aws" "$W/bin/gcloud"
  ( export PATH="$W/bin:$PATH" HOME="$W" DEMO_DAY_STATE="$W/state" RESULTS_DIR="$W/res" REAL_CONNECT_RUN=0 STOP_AFTER=connect CONNECT_TEMPLATE_SYNC=0 REAL_GCP_CONNECT="${GCPC:-0}" GCP_PROJECT=cust-proj GCP_TARGET_PROJECT=cust-mig GCP_PLATFORM_PROJECT=plat-proj GCP_IAM_WAIT_SEC=0
    bash "$HERE/real-session.sh" "$SVC" connect ) > "$W/out" 2>&1; local rc=$?
  TGT_FILE=$(ls "$W"/res/real-*/target-env-id.txt 2>/dev/null | head -1); TGT=$([ -n "$TGT_FILE" ] && cat "$TGT_FILE")
  local ok=1 cond
  for cond in "$@"; do
    case "$cond" in
      rc=*) [ "$rc" = "${cond#rc=}" ] || { ok=0; echo "  ✗ $name: rc=$rc (기대 ${cond#rc=})"; } ;;
      calls~*) grep -qF -- "${cond#calls~}" "$W/calls" || { ok=0; echo "  ✗ $name: 호출 없음: ${cond#calls~}"; } ;;
      calls!*) ! grep -qF -- "${cond#calls!}" "$W/calls" || { ok=0; echo "  ✗ $name: 있으면 안 되는 호출: ${cond#calls!}"; } ;;
      creates=*) [ "$(grep -c 'env:connect -- create' "$W/calls")" = "${cond#creates=}" ] || { ok=0; echo "  ✗ $name: create $(grep -c 'env:connect -- create' "$W/calls")번 (기대 ${cond#creates=})"; } ;;
      tgt=*) [ "$TGT" = "${cond#tgt=}" ] || { ok=0; echo "  ✗ $name: 도착 환경 '$TGT' (기대 ${cond#tgt=})"; } ;;
      out~*) grep -qF -- "${cond#out~}" "$W/out" || { ok=0; echo "  ✗ $name: 출력에 없음: ${cond#out~}"; } ;;
    esac
  done
  if [ $ok = 1 ]; then PASS=$((PASS+1)); echo "  ✓ $name"; else FAILN=$((FAILN+1)); sed 's/^/      | /' "$W/out" | tail -8; fi
  rm -rf "$W"; }
echo "CONNREUSE 시험 ($(bash --version | head -1 | cut -c1-40), sed $(sed --version >/dev/null 2>&1 && echo GNU || echo BSD))"
run_case "충돌 → 지난 스택 지우고 다시 create" conflict rc=0 "calls~aws cloudformation delete-stack --stack-name svc-connect-0ld00000 --region ap-northeast-2" "calls~aws cloudformation wait stack-delete-complete --stack-name svc-connect-0ld00000" creates=2 "calls~env:connect -- verify --env $ID" "out~연결: 지난 스택 정리 INFO"
run_case "이미 있음 → 스택 만들기·대기 건너뛰고 verify" exists rc=0 "calls!create-stack" "calls!describe-stacks" "calls!delete-stack" creates=1 "calls~env:connect -- verify --env $ID"
run_case "이미 connected → 링크 없음, 스택 단계 건너뛰고 verify" connected rc=0 "calls!describe-stacks" "calls!delete-stack" "calls~env:connect -- verify --env $ID" "calls~--cluster platform-target" "out~연결 스택 PASS"
run_case "거부: 우리 모양(svc-connect-*) 아닌 스택은 안 지움" foreign rc=1 "calls!delete-stack" "calls!env:connect -- verify"
run_case "거부: 지우고 다시 했는데 또 충돌 → 멈춤(지우기 1번만)" twice rc=1 creates=2 "calls!env:connect -- verify"
run_case "거부: verify 가 disconnected 면 FAIL (grep connected 거짓 PASS 막음)" disc rc=1 "calls~env:connect -- verify --env $ID" "out~verify → connected FAIL"
GCPC=1 GVFIN=disconnected run_case "FM-INT-11 거부: GCP verify 가 disconnected 면 FAIL" exists rc=1 "calls~env:connect -- verify --env $GID"
GCPC=1 run_case "CON-01 AWS 뒤 GCP 도착 연결 → 도착 환경 기록" exists rc=0 "calls~env:connect -- whoami" "calls~env:connect -- create --provider gcp --name real-dst" "calls~gcloud iam service-accounts" "calls~env:connect -- verify --env $GID --account cust-proj" "out~connect-gcp PASS" tgt=$GID
GCPC=0 run_case "REAL_GCP_CONNECT=0 → GCP 안 건드림(시드 도착)" exists rc=0 "calls!--provider gcp" "calls!gcloud iam" tgt=
echo "결과: 통과 $PASS / 실패 $FAILN"
[ "$FAILN" = 0 ]

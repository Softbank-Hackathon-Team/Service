#!/usr/bin/env bash
# 사전 점검기 자체 시험 + 실패 역시험 묶음 (방법론 v1 ⑥⑦). 클라우드·DB·kubectl 호출 없음, 파일과 가짜 사실만 쓴다.
#   bash tools/preflight-selftest.sh          레포 맨 위에서. 맥 기본 /bin/bash(3.2)·BSD 도구·터미널 없음(</dev/null)에서도 돌게 썼다
# 하는 일
#   ⑦ 지금까지 실패(Fn)마다 "고치기 전 모양" 조각을 만들어 그 탐지기가 FAIL 을 내는지, 지금 레포에서는 OK 인지 본다.
#      새 실패를 고칠 때 여기 한 줄(fixture + 기대)을 더한다. 하나라도 어긋나면 그 base 는 실측에 쓰지 않는다
#   ⑥ 같은 묶음을 터미널 없이(stdin </dev/null) 돌린다. bash 판본·sed/grep 종류를 맨 위에 찍는다
# 줄 모양: "ok|FAIL <Fn> <설명>". 마지막 줄 "selftest PASS|FAIL n/m". 끝 코드 0 = 전부 기대대로
set -u
cd "$(dirname "$0")/.." || exit 1
# 18:28Z 사고 막기: 이 시험은 jeong-up·jeong-down·demo-day up/down 을 띄우지 않는다. 혹시 그런 줄이 생기면 여기서 멈춘다
if grep -nE '(sh|bash) tools/(jeong-(up|down)|demo-day)\.sh' "$0" | grep -v '^[0-9]*:#' | grep -v 'grep -nE' >/dev/null; then echo "selftest FAIL 0/0 (시험이 jeong-up·demo-day 를 띄우는 줄을 담고 있음)"; exit 1; fi
T=$(mktemp -d "${TMPDIR:-/tmp}/pf-selftest.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
N=0; BAD=0
SELF_PID=$$
# 부작용 0 울타리 (11/3 18:28Z·18:3xZ 사고):
#   ① 진짜 demo-day up 이 이 안에서 불려도 바로 rc 5 (살아 있는 DEMO_DAY_ACTIVE 안의 up 은 시작 안 함)
#   ② 클라우드·클러스터 도구는 가짜: 불리면 기록만 하고 99. 끝에 기록이 비어 있어야 PASS
export DEMO_DAY_ACTIVE="up:$$"
mkdir -p "$T/stub"
#   (jeong-lib 가 부를 때 읽는 gcloud info 는 읽기 전용이라 기록하지 않는다)
for t in terraform aws gcloud kubectl helm k3d docker ssh; do printf '#!/bin/sh\n[ "%s $1" = "gcloud info" ] && exit 1\necho "%s $*" >> "%s/stub.log"\nexit 99\n' "$t" "$t" "$T" > "$T/stub/$t"; chmod +x "$T/stub/$t"; done
export PATH="$T/stub:$PATH"
unset JEONG_CHILD JEONG_NO_WATCH
echo "환경: bash ${BASH_VERSION:-?} · sed $(sed --version >/dev/null 2>&1 && echo GNU || echo BSD) · tty $([ -t 0 ] && echo 있음 || echo 없음)"
# expect <Fn> <want: FAIL|OK> <설명> <명령…>  — 명령 출력에 FAIL 줄이 있는지로 판정
expect() { local id=$1 want=$2 what=$3 out got; shift 3; N=$((N + 1))
  out=$("$@" < /dev/null 2>&1)
  if printf '%s\n' "$out" | grep -q '^FAIL'; then got=FAIL; else got=OK; fi
  if [ "$got" = "$want" ]; then echo "ok   $id $what ($got)"; else BAD=$((BAD + 1)); echo "FAIL $id $what: $want 이어야 하는데 $got"; printf '%s\n' "$out" | tail -n 3 | sed 's/^/       /'; fi; }
# 조각 폴더: 레포 db/ 만 빌려 쓴다(시드 id). 도구는 cwd 기준으로 파일을 읽는다
frag() { rm -rf "$T/f"; mkdir -p "$T/f/tools" "$T/f/packages/contracts/src"; cp -R db "$T/f/db"; }
LIT="python3 -I $PWD/tools/preflight-literals.py"
TFV="python3 -I $PWD/tools/preflight-tfvars.py"

# F1 필수 변수 안 넘김 (up 1차): aws/env apply 에 expected_account_id 없음
frag; cp -R infra "$T/f/infra"
printf 'TFA=infra/modules/aws/env\nu_vpc() { run terraform -chdir="$TFA" apply -input=false -auto-approve -var create_eks=false; }\n' > "$T/f/tools/demo-day.sh"
expect F1 FAIL "tfreq: 필수 변수 빠진 apply" sh -c "cd '$T/f' && $TFV tools/demo-day.sh"
expect F1 OK "tfreq: 지금 레포" $TFV tools/demo-day.sh tools/ecs-source.sh
# F6 기본 컨텍스트 k3d-onprem ↔ 맥 k3s-onprem
frag; printf 'CTX="${2:-k3d-onprem}"\nK=${ONPREM_KUBE_CONTEXT:-k3d-onprem}\n' > "$T/f/tools/m.sh"
expect F6 FAIL "literal ctx: kubeconfig 에 없는 기본값" sh -c "cd '$T/f' && ONPREM_KUBE_CONTEXT= PREFLIGHT_KUBE_CONTEXTS=k3s-onprem $LIT"
expect F6 OK "literal ctx: 지금 레포" env ONPREM_KUBE_CONTEXT=k3s-onprem PREFLIGHT_KUBE_CONTEXTS="k3s-onprem" AWS_PROFILE=finals PREFLIGHT_AWS_PROFILES=finals PREFLIGHT_ARN_KIND=user $LIT
# F7 복제 주소에 DB 이름 고정
frag; printf 'kv REPL_TARGET_URL "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/shop_api"\n' > "$T/f/tools/demo-day.sh"
expect F7 FAIL "literal dbname: /shop_api 고정" sh -c "cd '$T/f' && $LIT"
# F7 출력 계보: 읽는 출력을 모듈이 안 내보냄
frag; cp -R infra "$T/f/infra"; printf 'TFA=infra/modules/aws/env\nx=$(tfout "$TFA" db_name_missing)\n' > "$T/f/tools/demo-day.sh"
expect F7 FAIL "tfout: 선언 안 된 출력" sh -c "cd '$T/f' && $TFV tools/demo-day.sh"
expect F7 OK "tfout: 지금 레포" $TFV tools/demo-day.sh tools/ecs-source.sh
# F8 플랫폼 주체 검사가 :role/ 만 받음 ↔ IAM 사용자
frag; printf 'export const R = { PLATFORM_PRINCIPAL_ARN: { check: (v) => (/^arn:aws:iam::\\d{12}:role\\/[\\w+=,.@\\/-]+$/.test(v) ? null : "x") } };\n' > "$T/f/packages/contracts/src/config.ts"
expect F8 FAIL "literal arn: 역할만 받는 정규식 + 사용자 자격" sh -c "cd '$T/f' && PREFLIGHT_ARN_KIND=user $LIT"
expect F8 OK "literal arn: 지금 레포 + 사용자 자격" env PREFLIGHT_ARN_KIND=user AWS_PROFILE= ONPREM_KUBE_CONTEXT=k3s-onprem $LIT
# F8 띄우는 줄 설정: 실세션 connect 에 sts 세션 ARN
if [ -d node_modules ]; then
  RS="$T/rs.sh"; printf 'worker_env() { ( nohup npm run dev:worker > "$A/w" 2>&1 & ) }\n( nohup npm run dev:api > "$A/a" 2>&1 & )\n( nohup npm run dev:api > "$A/b" 2>&1 & )\n' > "$RS"
  expect F8 FAIL "config-launch: connect 줄에 sts 세션 ARN" env DATABASE_URL=postgres://u:p@localhost:5432/platform PREFLIGHT_PRINCIPAL_ARN=arn:aws:sts::123456789012:assumed-role/r/s node --import tsx tools/preflight-config.ts "$RS"
  expect F8 OK "config-launch: IAM 사용자 ARN" env DATABASE_URL=postgres://u:p@localhost:5432/platform PREFLIGHT_PRINCIPAL_ARN=arn:aws:iam::123456789012:user/demo node --import tsx tools/preflight-config.ts "$RS"
  # F16 도착 DB 표·앱 계정을 깔아 줄 곳 없음 (REPL_COPY_SCHEMA 없는 demo-day)
  frag; grep -v 'kv REPL_COPY_SCHEMA' tools/demo-day.sh > "$T/f/tools/demo-day.sh"
  expect F16 FAIL "repl-schema: REPL_COPY_SCHEMA 없는 demo-day" env PREFLIGHT_DEMO_DAY_SH="$T/f/tools/demo-day.sh" DATABASE_URL=postgres://u:p@localhost:5432/platform PREFLIGHT_PRINCIPAL_ARN=arn:aws:iam::123456789012:user/demo node --import tsx tools/preflight-config.ts "$RS"
  expect F16 OK "repl-schema: 지금 레포" env DATABASE_URL=postgres://u:p@localhost:5432/platform PREFLIGHT_PRINCIPAL_ARN=arn:aws:iam::123456789012:user/demo node --import tsx tools/preflight-config.ts "$RS"
  # F9 류: 띄우는 줄이 늘었는데 표에 없음
  printf '( nohup npm run dev:worker < /dev/null > x 2>&1 & )\n' >> "$RS"
  expect F9 FAIL "launch-count: 표에 없는 새 띄우는 줄" env DATABASE_URL=postgres://u:p@localhost:5432/platform PREFLIGHT_PRINCIPAL_ARN=arn:aws:iam::123456789012:user/demo node --import tsx tools/preflight-config.ts "$RS"
else echo "skip F8·F9 config-launch (node_modules 없음 → npm ci 뒤 다시)"; fi
# F9 셸 함수를 env 뒤에 둠
printf 'tmo() { "$@"; }\nx=$(env A=1 tmo 5 node -e 1)\n' > "$T/envfn.sh"
expect F9 FAIL "env 뒤 셸 함수" sh -c "grep -nE '(^|[^a-z_])env ([A-Z_]+=[^ ]* )*(tmo|run|step|with_env) ' '$T/envfn.sh' >/dev/null && echo 'FAIL env-fn' || echo ok"
expect F9 OK "env 뒤 셸 함수: 지금 tools/*.sh" sh -c "grep -nE '(^|[^a-z_\$])env ([A-Z_]+=[^ ]* )*(tmo|run|step|with_env) ' \$(ls tools/*.sh | grep -v preflight-selftest) | grep -v '^\s*#' >/dev/null && echo 'FAIL env-fn' || echo ok"
# F14 감시 창 없이 up — jeong-up.sh 는 절대 띄우지 않는다(진짜 up 이 된다). 게이트 함수만, 임시 STATE·JEONG_CHILD 지운 채로
mkdir -p "$T/st"; expect F14 FAIL "jeong-up 게이트: 감시 창 없음" env -u JEONG_CHILD -u JEONG_NO_WATCH DEMO_DAY_STATE="$T/st" sh -c ". tools/jeong-lib.sh; j_watch_gate >/dev/null; [ \$? = 4 ] && echo 'FAIL no-watch' || echo ok"

if [ "${SELFTEST_NO_SPAWN:-0}" = 1 ]; then echo "skip F15 (up 안: 프로세스를 띄우는 시험은 안 함)"; else
# F15 (11/3 18:28Z): 물려받은 JEONG_CHILD 로 jeong 줄이 검사를 건너뛰고 그 자리에서 돎 → 자식 표가 맞을 때만 자식. 가짜 줄로만 본다
printf 'cd "%s"\nJSELF="%s/dummy.sh"\n. tools/jeong-lib.sh\nj_bg x\necho "child-ran ${JEONG_CHILD:-unset}" > "%s/child.out"\n' "$PWD" "$T" "$T" > "$T/dummy.sh"
mkdir -p "$T/st15"
expect F15 FAIL "jeong 줄: 물려받은 JEONG_CHILD=1 은 자식 아님(터미널 검사로 멈춤)" sh -c "env -u JEONG_ALLOW_NOTTY DEMO_DAY_STATE='$T/st15' JEONG_CHILD=1 sh '$T/dummy.sh' >/dev/null 2>&1; [ \$? = 2 ] && [ ! -f '$T/child.out' ] && echo 'FAIL blocked' || echo ok"
expect F15 OK "jeong 줄: j_bg 가 띄운 자식은 자식으로 돌고 JEONG_CHILD 를 안 물려줌" sh -c "DEMO_DAY_STATE='$T/st15' JEONG_ALLOW_NOTTY=1 sh '$T/dummy.sh' >/dev/null 2>&1; i=0; while [ \$i -lt 20 ] && [ ! -f '$T/child.out' ]; do sleep 0.2; i=\$((i+1)); done; grep -qx 'child-ran unset' '$T/child.out' && echo ok || echo 'FAIL child'"
fi

# (4) 부작용 0: 이 시험 동안 이 레포의 jeong-up·demo-day up 이 새로 생기지 않았어야 한다
# 이 시험의 자손 중 jeong-up·진짜 demo-day up(--dry-run 아님)이 있으면 FAIL. 다른 시험이 동시에 띄운 것은 안 센다
desc_up() { ps -A -o pid= -o ppid= -o command= 2>/dev/null | awk -v root="$SELF_PID" '
  { pid[NR]=$1; pp[NR]=$2; $1=""; $2=""; cmd[NR]=$0 }
  END { mine[root]=1; ch=1; while (ch) { ch=0; for (i=1;i<=NR;i++) if (!(pid[i] in mine) && (pp[i] in mine)) { mine[pid[i]]=1; ch=1 } }
        for (i=1;i<=NR;i++) if (pid[i] in mine && pid[i]!=root && (cmd[i] ~ /jeong-up\.sh/ || (cmd[i] ~ /demo-day\.sh up/ && cmd[i] !~ /--dry-run/))) printf "%s ", pid[i] }'; }
NEW=$(desc_up)
N=$((N + 1)); if [ ! -s "$T/stub.log" ]; then echo "ok   side-effect 클라우드·클러스터 도구 호출 0"; else BAD=$((BAD + 1)); echo "FAIL side-effect 가짜 도구가 불림: $(cut -d' ' -f1 "$T/stub.log" | sort | uniq -c | tr '\n' ' ')"; fi
N=$((N + 1)); if [ -z "$NEW" ]; then echo "ok   side-effect jeong-up·demo-day up 새 프로세스 0"; else BAD=$((BAD + 1)); echo "FAIL side-effect 시험 중 새 up 프로세스: $NEW"; fi
echo "selftest $([ $BAD -eq 0 ] && echo PASS || echo FAIL) $((N - BAD))/$N"
[ $BAD -eq 0 ]

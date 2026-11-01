#!/usr/bin/env bash
# 발표 시각 T 역산표대로 당일 단계를 시계에 맞춰 돌린다 (z75-47, 작업 Z78). 표와 이유는 parallel/Z78/TIMELINE.md.
#   bash tools/timeline.sh <T>            T = 발표 시작 시각. "HH:MM"(오늘, 맥 현지 시각) 또는 "+50m"(지금부터)
#   bash tools/timeline.sh <T> --dry-run  단계 시각표만 찍는다
# 단계 (시작 = T 기준 분, 끝 기한 = 다음 단계 시작)
#   up         T−40  맥이 Jeong 에게 sh tools/jeong-up.sh 부탁(부탁 파일) → 진행 파일의 "JEONG up end rc=0" 까지   기한 T−15
#   preflight  T−15  npm run demo:preflight                                                                    기한 T−10
#   rehearse   T−10  bash tools/rehearse.sh --prod --runs 1 --human-delay 0 --no-sample (데모 직전 한 번, 초기화 포함)  기한 T−5
#   screen     T−5   화면 고정: 8080 응답 200 + 예열 GET + 초기화(demo-reset --prod)                                 기한 T
#   down       T+10  Jeong 에게 sh tools/jeong-down.sh 부탁 → "JEONG down end rc=0" 까지                          기한 T+25
# 각 단계를 예정 시각까지 기다렸다 시작한다(먼저 끝나도 앞당기지 않음: 시계 맞추기 연습). 늦게 시작하면 그만큼 늦은 대로 간다.
# progress.log 줄: "<시각> TL <단계> start plan=<HH:MM:SS> late=<±초>", "<시각> TL <단계> end rc= sec= deadline=<HH:MM:SS> slack=<±초>"
# 판정(마지막 줄): 기한 넘긴 단계 0, 가장 빠듯한 단계 여유 ≥ TL_MIN_SLACK_SEC(120), Jeong 줄 수(=2) 를 같이 찍는다. 끝 코드 0 = PASS
# TL_MODE=allow (ALLOW-LINES.md 를 넣은 맥): timeline 은 up/down 을 직접 부르지 않는다(z75-50, Z38b-3: 감싼 스크립트로 terraform 을 돌리면 allow 줄 심사를 비켜 감).
#   부탁 파일 mac-request-<up|down> 을 남기고 기다린다. 맥 RC 가 allow 줄 그대로 `AWS_PROFILE=finals bash tools/demo-day.sh up` 을 따로 치면
#   demo-day 끝에 진행 파일로 "DEMODAY up end rc=" 가 찍히고 timeline 이 다음으로 간다. Jeong 줄은 터널 1개(up 안에서 부탁)
# TL_MODE=jeong (기본, allow 없음): up/down 을 Jeong 줄 2개(jeong-up.sh, jeong-down.sh)로
# 시험용: TL_SCALE=60 이면 1분을 1초로 줄인다. TL_<단계>_CMD 로 단계 명령을 바꿀 수 있다
set -u
CALLER_PWD=$(pwd)
cd "$(dirname "$0")/.." || exit 1
T_ARG=${1:?"발표 시각: HH:MM 또는 +50m"}; shift
DRY=0; [ "${1:-}" = --dry-run ] && DRY=1
SCALE=${TL_SCALE:-1}
MIN_SLACK=${TL_MIN_SLACK_SEC:-120}
JSTATE=${DEMO_DAY_STATE:-$HOME/.svc-tf/demo-day}
JPROG="$JSTATE/jeong-progress.log"
case "${LOG_DIR:-}" in "") LOG_DIR=tools/measure/out/timeline-$(date -u +%Y%m%dT%H%M%SZ) ;; /*) ;; *) LOG_DIR="$CALLER_PWD/$LOG_DIR" ;; esac
mkdir -p "$LOG_DIR" || exit 1
PROGRESS="$LOG_DIR/progress.log"

now() { date +%s; }
hms() { date -r "$1" +%H:%M:%S 2>/dev/null || date -d "@$1" +%H:%M:%S; }
case "$T_ARG" in
  +*m) T=$(( $(now) + $(echo "${T_ARG#+}" | tr -d m) * 60 / SCALE )) ;;
  [0-9]*:[0-9]*) T=$(date -j -f "%H:%M:%S" "$T_ARG:00" +%s 2>/dev/null || date -d "$T_ARG" +%s) ;;
  *) echo "T 는 HH:MM 또는 +50m" >&2; exit 2 ;;
esac
at() { echo $(( T + $1 * 60 / SCALE )); }
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$PROGRESS"; }

# 부탁 하나: 부탁 파일을 남기고 진행 파일에서 끝 줄을 기다린다 (timeline 은 terraform·터널을 치지 않는다)
#   wait_line <누가> <이름> <기한>: 누가 = JEONG (Jeong 터미널 줄) | DEMODAY (맥 RC 가 allow 줄로 친 demo-day)
wait_line() {
  local who=$1 name=$2 deadline=$3 base req
  mkdir -p "$JSTATE"
  base=$(wc -l < "$JPROG" 2>/dev/null || echo 0)
  if [ "$who" = JEONG ]; then
    req="$JSTATE/jeong-request-$name"; log "TL $name Jeong 에게: sh tools/jeong-$name.sh"
  else
    req="$JSTATE/mac-request-$name"; log "TL $name 맥 RC 가 allow 줄 그대로 따로: AWS_PROFILE=finals bash tools/demo-day.sh $name"
  fi
  date +%s > "$req"
  while :; do
    if tail -n +$((base + 1)) "$JPROG" 2>/dev/null | grep -q "$who $name end"; then
      rm -f "$req"
      tail -n +$((base + 1)) "$JPROG" | grep "$who $name end" | tail -n 1 | grep -q "rc=0"; return $?
    fi
    [ "$(now)" -gt $((deadline + 600 / SCALE)) ] && { log "TL $name 기한 10분 넘게 끝 줄 없음"; return 1; }
    sleep 2
  done
}
jeong() { wait_line JEONG "$@"; }
mac() { wait_line DEMODAY "$@"; }
TL_MODE=${TL_MODE:-jeong}
if [ "$TL_MODE" = allow ]; then
  UP_CMD=${TL_UP_CMD:-mac up}
  DOWN_CMD=${TL_DOWN_CMD:-mac down}
else
  UP_CMD=${TL_UP_CMD:-jeong up}
  DOWN_CMD=${TL_DOWN_CMD:-jeong down}
fi
PREFLIGHT_CMD=${TL_PREFLIGHT_CMD:-npm run -s demo:preflight}
REHEARSE_CMD=${TL_REHEARSE_CMD:-bash tools/rehearse.sh --prod --runs 1 --no-sample}
SCREEN_CMD=${TL_SCREEN_CMD:-screen_fix}
screen_fix() {
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:8080/)" = 200 ] || { echo "8080 응답 없음"; return 1; }
  bash tools/demo-reset.sh --prod || return 1
  for i in 1 2 3; do curl -s -m 5 -o /dev/null http://localhost:8080/api/v1/environments -H "x-dev-tenant: 11111111-1111-4111-8111-111111111111"; done
  curl -s -m 5 -o /dev/null http://localhost:8080/
}
# 이름 시작(분) 기한(분) 명령
STAGES="up:-40:-15:UP_CMD preflight:-15:-10:PREFLIGHT_CMD rehearse:-10:-5:REHEARSE_CMD screen:-5:0:SCREEN_CMD down:10:25:DOWN_CMD"

log "TL start T=$(hms "$T") scale=$SCALE mode=$TL_MODE dry=$DRY"
# Z38b-5: 지난 회차가 기한 넘겨 끝나며 남긴 부탁 파일을 지운다 (남아 있으면 맥 RC·Jeong 이 옛 부탁을 보고 친다)
[ "$DRY" = 1 ] || rm -f "$JSTATE"/mac-request-* "$JSTATE"/jeong-request-*
for s in $STAGES; do IFS=: read -r n a b v <<< "$s"; log "TL plan $n start=$(hms "$(at "$a")") deadline=$(hms "$(at "$b")") cmd=${!v}"; done
[ "$DRY" = 1 ] && { log "판정 PASS(dry-run) 단계 5개, Jeong 줄 $([ "$TL_MODE" = allow ] && echo "1개(터널)" || echo 2개)"; exit 0; }

over=0; minslack=999999; tight=""; jlines=0
[ "$TL_MODE" = allow ] && jlines=1
for s in $STAGES; do
  IFS=: read -r n a b v <<< "$s"
  st=$(at "$a"); dl=$(at "$b")
  while [ "$(now)" -lt "$st" ]; do sleep 1; done
  t0=$(now)
  log "TL $n start plan=$(hms "$st") late=$((t0 - st))"
  case "${!v}" in jeong\ *) jlines=$((jlines + 1)) ;; esac
  if [ "${!v%% *}" = jeong ] || [ "${!v%% *}" = mac ]; then ${!v%% *} "${!v#* }" "$dl" >> "$LOG_DIR/$n.log" 2>&1
  else eval "${!v}" >> "$LOG_DIR/$n.log" 2>&1; fi
  rc=$?; t1=$(now); slack=$((dl - t1))
  log "TL $n end rc=$rc sec=$((t1 - t0)) deadline=$(hms "$dl") slack=$slack"
  [ $rc -eq 0 ] || over=$((over + 1))
  [ $slack -lt 0 ] && over=$((over + 1))
  # 시험 축소(TL_SCALE)일 때 여유도 실제 초로 바꿔 비교한다
  real=$((slack * SCALE))
  [ $real -lt $minslack ] && { minslack=$real; tight=$n; }
done
if [ $over -eq 0 ] && [ $minslack -ge "$MIN_SLACK" ]; then v=PASS; else v=FAIL; fi
log "판정 $v: 기한 넘김·실패 ${over}개, 가장 빠듯한 단계 $tight 여유 ${minslack}초 (기준 ≥${MIN_SLACK}), Jeong 줄 ${jlines}개"
[ $v = PASS ]

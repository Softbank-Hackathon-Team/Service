#!/bin/sh
# Jeong 직접 실행 줄 3/3 (GATE-v2, 결정 2026-11-02 "감시 창"): 결선 당일 감시 창. 실패를 보면 Jeong 대신 sh tools/jeong-down.sh 를 친다.
#   sh tools/jeong-watch.sh     ← jeong-up 을 치기 전에 다른 터미널 창에서 켜 두고 그대로 둔다 (앞에서 돈다). 끄려면 Ctrl-C (끄면 down 은 안 친다)
# 왜: 실세션(deploy·connect·import·run) 중간에 실패하면 자원이 떠 있는데 자동 down 이 없었다 (맥 RC 는 destroy 를 못 친다). 이 창이 Jeong 의 셸로 down 을 친다.
# 실패 신호 두 가지 (둘 다 이 창을 켠 뒤에 생긴 것만 본다)
#   1) $JSTATE/auto-fail 파일: real-session.sh 가 up 뒤 단계에서 실패해 멈출 때 남긴다 (일부러 멈춘 STOP_AFTER 는 안 남긴다). 사람이 `touch` 해도 된다
#      (내용 "<시각> real-session <단계> rc=<n>". 단계가 up-wait(up 끝 줄을 기다리다 멈춤)면 치우기만 하고 판단은 2)로)
#   2) 진행 파일(jeong-progress.log)의 새 줄 "JEONG up end rc≠0": 단, 그 회차 progress.log 에 "자동 down 끝 rc=0"(demo-day 가 이미 0 으로 만듦) 또는
#      "apply 를 시작하기 전에 멈춤"(자원 없음)이 있으면 건너뛴다. rc=3(이미 도는 줄이 있어 시작 안 함)도 건너뛴다
# 신호를 보면: GRACE(기본 30)초를 센다(그 사이 Ctrl-C 면 안 친다) → 도는 jeong 줄(up·down)이 있으면 끝날 때까지 기다림(destroy 겹침 방지)
#   → sh tools/jeong-down.sh → 진행 파일의 "JEONG down end rc=" 를 기다려 보여 준다 → rc≠0 이면 RETRY(60)초 뒤 한 번 더(TRIES=2) → 다시 감시
# 이 창은 하나만 켠다(둘이면 down 을 두 번 친다). 비밀값·계정 번호는 찍지 않는다. 맥 RC 는 이 창을 못 켠다(터미널 아님).
# 환경: JEONG_WATCH_POLL_SEC(10) JEONG_WATCH_GRACE_SEC(30) JEONG_WATCH_RETRY_SEC(60) JEONG_WATCH_TRIES(2) JEONG_WATCH_DOWN_WAIT_SEC(3600)
cd "$(dirname "$0")/.." || exit 1
. tools/jeong-lib.sh
# z75-50 과 같은 규칙: Jeong 터미널에서만 (맥 RC 가 부르면 멈춤). VM 시험만 JEONG_ALLOW_NOTTY=1
[ -t 1 ] || [ -n "${JEONG_ALLOW_NOTTY:-}" ] || { echo "Jeong 터미널에서만 켜는 창이다 (맥 RC 는 부르지 않는다)"; exit 2; }
mkdir -p "$JSTATE" && chmod 700 "$JSTATE" || exit 1
POLL=${JEONG_WATCH_POLL_SEC:-10}; GRACE=${JEONG_WATCH_GRACE_SEC:-30}; RETRY=${JEONG_WATCH_RETRY_SEC:-60}
TRIES=${JEONG_WATCH_TRIES:-2}; DWAIT=${JEONG_WATCH_DOWN_WAIT_SEC:-3600}
DOWN_CMD=${JEONG_DOWN_CMD:-"sh tools/jeong-down.sh"}   # 시험에서만 바꾼다
MARK="$JSTATE/auto-fail"; WLOCK="$JSTATE/watch.lock"; LASTOK="$JSTATE/watch.last-down-ok"
# 감시 창은 하나만
if [ -f "$WLOCK" ]; then
  wp=$(cat "$WLOCK" 2>/dev/null)
  if [ -n "$wp" ] && kill -0 "$wp" 2>/dev/null && ps -p "$wp" -o command= 2>/dev/null | grep -q 'jeong-watch'; then
    echo "이미 감시 창이 있다 (pid $wp). 그 창을 쓴다"; exit 3
  fi
  rm -f "$WLOCK"
fi
echo $$ > "$WLOCK"
j_awake $$   # MACAWAKE: 감시 창이 도는 동안 맥이 잠들지 않게 (창을 끄면 같이 풀림)
DOWN_RUNNING=0
bye() {
  rm -f "$WLOCK"; echo
  if [ "$DOWN_RUNNING" = 1 ]; then echo "$(j_iso) 감시 끝. 이미 띄운 jeong-down 은 뒤에서 계속 돈다: tail -f $JPROG (끝 줄 'JEONG down end rc=0' 이면 자원 0)"
  else echo "$(j_iso) 감시 끝 (down 은 안 쳤다). 자원을 지우려면: sh tools/jeong-down.sh   다시 지켜보려면: sh tools/jeong-watch.sh"; fi
  echo "$(j_iso) JEONG watch end" >> "$JPROG"; exit 0
}
trap bye INT TERM HUP
touch "$JPROG"
lines() { if [ -f "$JPROG" ]; then wc -l < "$JPROG" | tr -d ' '; else echo 0; fi; }
# 켜기 전부터 있던 신호는 지난 회차 것 → 치우기만 한다 (놀라운 destroy 없음). 자원이 남았는지는 Jeong 이 cloud-zero 로 본다
if [ -f "$MARK" ]; then
  mv "$MARK" "$MARK.stale-$(date +%s)" 2>/dev/null || rm -f "$MARK"
  echo "$(j_iso) 켜기 전부터 있던 실패 신호를 치움(지난 회차). 자원이 남았는지: bash tools/cloud-zero.sh → 남았으면 sh tools/jeong-down.sh"
fi
seen=$(lines)   # 지금까지의 줄은 지난 일 → 안 본다 (감시 창은 jeong-up 전에 켠다)
echo "$(j_iso) 감시 시작: ${POLL}초마다 $MARK 와 $JPROG 의 'JEONG up end rc≠0' 를 본다. 신호가 오면 ${GRACE}초 뒤 jeong-down. 끄려면 Ctrl-C"
echo "$(j_iso) JEONG watch start" >> "$JPROG"
# 진행 파일에 "JEONG <이름> end" 가 mark 줄 뒤에 새로 적히길 기다린다. 찍힌 rc 를 돌려준다(없으면 빈 값)
wait_end() { # <이름> <mark> <최대초>
  we_t0=$(date +%s)
  while :; do
    we_rc=$(tail -n +"$(($2 + 1))" "$JPROG" 2>/dev/null | awk -v n="$1" '$2=="JEONG" && $3==n && $4=="end" {sub(/^rc=/,"",$5); r=$5} END{print r}')
    [ -n "$we_rc" ] && { echo "$we_rc"; return 0; }
    [ $(( $(date +%s) - we_t0 )) -ge "$3" ] && { echo ""; return 1; }
    sleep "$POLL"
  done
}
run_down() { # 실패 신호 하나에 대해 down 을 최대 TRIES 번. 0 이면 성공
  rd_n=1
  while [ "$rd_n" -le "$TRIES" ]; do
    while rd_b=$(j_busy); do echo "$(j_iso) 이미 도는 jeong 줄(pid $rd_b)이 있다 → 끝날 때까지 기다림"; sleep "$POLL"; done
    rd_mark=$(lines)
    echo "$(j_iso) JEONG watch down-start try=$rd_n" >> "$JPROG"
    echo "$(j_iso) jeong-down 침 (${rd_n}번째)"
    DOWN_RUNNING=1
    # shellcheck disable=SC2086
    $DOWN_CMD
    rd_rc=$(wait_end down "$rd_mark" "$DWAIT")
    DOWN_RUNNING=0
    if [ "$rd_rc" = 0 ]; then touch "$LASTOK"; echo "$(j_iso) down 끝 rc=0 → 자원 0 (cloud-zero 는 진행 파일의 log= 경로에서 확인)"; return 0; fi
    echo "$(j_iso) down 끝 rc=${rd_rc:-없음(${DWAIT}초 안에 end 줄 없음)}"
    rd_n=$((rd_n + 1))
    [ "$rd_n" -le "$TRIES" ] && { echo "$(j_iso) ${RETRY}초 뒤 한 번 더"; sleep "$RETRY"; }
  done
  echo "$(j_iso) down 이 ${TRIES}번 다 실패 → 자원이 남았을 수 있다. 직접: sh tools/jeong-down.sh 뒤 bash tools/cloud-zero.sh"
  return 1
}
while :; do
  reason=""
  if [ -f "$MARK" ]; then
    if [ -f "$LASTOK" ] && [ "$MARK" -ot "$LASTOK" ]; then
      # 같은 실패를 두 길(진행 파일 → 실세션 파일)로 두 번 들은 것: 그 뒤에 down 이 이미 0 을 만들었다
      mv "$MARK" "$MARK.done-$(date +%s)" 2>/dev/null || rm -f "$MARK"
      echo "$(j_iso) 실패 신호(auto-fail)가 있지만 그 뒤 down 이 끝남 → 건너뜀"
    elif [ "$(awk 'NR==1{print $3}' "$MARK" 2>/dev/null)" = up-wait ]; then
      # 실세션이 "JEONG up end" 줄을 기다리다 실패(rc≠0 또는 시간 초과): up 의 결과는 2)의 진행 파일 줄로 판단한다(이미 봤거나 곧 본다). 두 번 치지 않게 파일만 치운다
      mv "$MARK" "$MARK.upwait-$(date +%s)" 2>/dev/null || rm -f "$MARK"
      echo "$(j_iso) 실세션이 up 끝 줄을 기다리다 멈춘 신호 → up 결과는 진행 파일 줄로 판단 (파일만 치움)"
    else
      reason="auto-fail: $(head -c 160 "$MARK" | tr '\n' ' ')"
      mv "$MARK" "$MARK.$(date +%s)" 2>/dev/null || rm -f "$MARK"   # 신호는 한 번만 쓴다
    fi
  else
    total=$(lines)
    [ "$total" -lt "$seen" ] && seen=0   # 진행 파일이 새로 만들어짐
    if [ "$total" -gt "$seen" ]; then
      line=$(tail -n +"$((seen + 1))" "$JPROG" | awk '$2=="JEONG" && $3=="up" && $4=="end" && $5!="rc=0" {l=$0} END{print l}')
      seen=$total
      if [ -n "$line" ]; then
        logp=$(printf '%s\n' "$line" | sed -n 's/.*log=//p')
        if [ "$(printf '%s\n' "$line" | awk '{print $5}')" = rc=3 ]; then echo "$(j_iso) up 이 시작도 안 함(이미 도는 줄) → 건너뜀"
        elif [ -n "$logp" ] && [ -f "$logp" ] && grep -q '자동 down 끝 rc=0' "$logp"; then echo "$(j_iso) up 이 실패했지만 자동 down 이 이미 0 을 만듦 → 건너뜀"
        elif [ -n "$logp" ] && [ -f "$logp" ] && grep -q 'apply 를 시작하기 전에 멈춤' "$logp"; then echo "$(j_iso) up 이 apply 전에 멈춤(자원 없음) → 건너뜀"
        else reason="up 실패: $(printf '%s' "$line" | cut -c1-120)"; fi
      fi
    fi
  fi
  if [ -n "$reason" ]; then
    echo "$(j_iso) 실패 신호: $reason"
    echo "$(j_iso) JEONG watch signal $(printf '%s' "$reason" | cut -c1-80 | tr -d '\n')" >> "$JPROG"
    echo "$(j_iso) ${GRACE}초 뒤 down 을 친다. 안 치려면 지금 Ctrl-C (감시도 끝남. 다시 켜기: sh tools/jeong-watch.sh)"
    i=$GRACE; while [ "$i" -gt 0 ]; do printf '\r  %3d초 ' "$i"; sleep 1; i=$((i - 1)); done; printf '\r          \r'
    run_down || true
    seen=$(lines)   # down 이 남긴 줄은 신호가 아니다
  fi
  sleep "$POLL"
done

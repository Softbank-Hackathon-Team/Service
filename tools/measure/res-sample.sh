#!/usr/bin/env bash
# 리허설 자원 샘플러 (z75-40, 작업 Z78). tools/rehearse.sh 가 뒤에서 띄우고 끝나면 끈다. 따로 써도 된다.
#   bash tools/measure/res-sample.sh <출력 csv>        Ctrl-C 나 kill 로 끝낸다
# 약 1초마다 한 줄: ts_ms,cpu_idle_pct,docker_mem_mb,swap_used_mb,swapouts
#   - cpu_idle_pct: 1초 동안의 CPU 쉬는 비율. 맥 iostat(-c 2 -w 1)의 둘째 줄, 리눅스 /proc/stat 차이
#   - docker_mem_mb: docker stats --no-stream 의 컨테이너 메모리 합(MB). 도커가 없으면 빈 칸
#   - swap_used_mb: 맥 sysctl vm.swapusage 의 used, 리눅스 SwapTotal−SwapFree
#   - swapouts: 부팅 뒤 스왑으로 내보낸 페이지 누계. 맥 vm_stat "Swapouts", 리눅스 /proc/vmstat pswpout. 차이가 0 이면 스왑 증가 0
# 부모(리허설)가 사라지면 스스로 끝난다. 값을 못 읽으면 그 칸만 비운다. 비밀값은 다루지 않는다.
set -u
OUT=${1:?출력 csv 경로}
PARENT=${RES_SAMPLE_PARENT:-$PPID}
OS=$(uname -s)
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000' 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))'; }

# 1초 걸린다 (이 시간이 곧 샘플 간격)
cpu_idle() {
  if [ "$OS" = Darwin ]; then
    iostat -n 0 -c 2 -w 1 2>/dev/null | tail -n 1 | awk '{ print $(NF-3) }'
  else
    local a b
    a=$(awk '/^cpu /{ print $5 + $6, $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9 }' /proc/stat); sleep 1
    b=$(awk '/^cpu /{ print $5 + $6, $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9 }' /proc/stat)
    echo "$a $b" | awk '{ d = $4 - $2; if (d > 0) printf "%.1f", 100 * ($3 - $1) / d }'
  fi
}
docker_mem() {
  command -v docker >/dev/null 2>&1 || return 0
  docker stats --no-stream --format '{{.MemUsage}}' 2>/dev/null | awk '
    { split($1, a, /[A-Za-z]+/); v = a[1]; u = $1; gsub(/[0-9.]/, "", u)
      if (u == "GiB" || u == "GB") v *= 1024; else if (u == "KiB" || u == "kB") v /= 1024; else if (u == "B") v /= 1048576
      s += v; n++ }
    END { if (n) printf "%.0f", s }'
}
swap_used() {
  if [ "$OS" = Darwin ]; then
    sysctl -n vm.swapusage 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "used") { v = $(i + 2); sub(/M$/, "", v); print v } }'
  else
    awk '/^SwapTotal:/{ t = $2 } /^SwapFree:/{ f = $2 } END { printf "%.1f", (t - f) / 1024 }' /proc/meminfo
  fi
}
swapouts() {
  if [ "$OS" = Darwin ]; then vm_stat 2>/dev/null | awk '/^Swapouts:/{ gsub(/\./, "", $2); print $2 }'
  else awk '/^pswpout /{ print $2 }' /proc/vmstat; fi
}

echo "ts_ms,cpu_idle_pct,docker_mem_mb,swap_used_mb,swapouts" > "$OUT"
TMP=$(mktemp "${TMPDIR:-/tmp}/res-sample.XXXXXX")
trap 'rm -f "$TMP"; exit 0' INT TERM EXIT
while kill -0 "$PARENT" 2>/dev/null; do
  t=$(now_ms)
  docker_mem > "$TMP" &
  dp=$!
  idle=$(cpu_idle)
  wait "$dp"
  echo "$t,${idle:-},$(cat "$TMP"),$(swap_used),$(swapouts)" >> "$OUT"
done

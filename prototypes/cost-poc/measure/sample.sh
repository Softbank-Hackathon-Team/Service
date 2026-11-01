#!/usr/bin/env bash
# DRAFT(ai): 컨테이너의 cgroup 값을 한 줄 JSON으로. CPU는 누적 사용 시간(usec)이라 앞뒤 차이가 곧 평균 사용량이다.
# 사용: sample.sh <compose 프로젝트> -> {"app":{"cpuUsec":..,"memBytes":..},...}
set -u
PROJECT=$1
printf '{'
first=1
for svc in app dbproxy db; do
  c="${PROJECT}-${svc}-1"
  read -r usage cur inactive anon < <(docker exec "$c" sh -c 'awk "/^usage_usec/{u=\$2} END{printf \"%s \",u}" /sys/fs/cgroup/cpu.stat; printf "%s " $(cat /sys/fs/cgroup/memory.current); awk "/^inactive_file/{i=\$2} /^anon /{a=\$2} END{print i, a}" /sys/fs/cgroup/memory.stat')
  [ $first = 1 ] || printf ','
  first=0
  printf '"%s":{"cpuUsec":%s,"memBytes":%s,"inactiveFile":%s,"anon":%s}' "$svc" "${usage:-0}" "${cur:-0}" "${inactive:-0}" "${anon:-0}"
done
printf '}\n'

#!/bin/sh
# nginx 는 시작할 때 proxy_pass 주소(API_URL)를 못 찾으면 바로 죽는다. 도착에서 web 이 shop-api Service 보다 먼저 뜨면
# 재시작을 거듭하며 대기 간격이 길어진다 → 주소가 잡힐 때까지 최대 120초 기다린 뒤 nginx 를 띄운다 (못 잡으면 그냥 넘긴다)
h=$(printf '%s' "$API_URL" | sed -E 's#^[a-zA-Z]+://([^/:]+).*#\1#')
i=0
until getent hosts "$h" >/dev/null 2>&1 || [ "$i" -ge 120 ]; do i=$((i + 1)); sleep 1; done
[ "$i" -gt 0 ] && echo "ironshop: API 주소 $h 를 ${i}초 기다림"
exit 0

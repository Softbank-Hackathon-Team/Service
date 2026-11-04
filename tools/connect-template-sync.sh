#!/usr/bin/env bash
# CLD-07: 콘솔 "AWS 연결" 링크가 쓰는 S3 템플릿(.env CONNECT_TEMPLATE_URL)을 레포 infra/onboarding/aws-connect.json 과 맞춘다.
#   S3 것을 aws s3 cp 로 받아(비공개 버킷이라 curl 아님) JSON 내용으로 비교 → 다르거나 없으면 같은 주소에 올리고 다시 받아 확인.
#   버킷은 만들지 않는다(없으면 실패로 알림). 주소·버킷 이름은 화면에 안 찍는다.
# 쓰는 곳: demo-day up 의 tools 단계(up-preflight 앞), tools/real/real-session.sh connect(REAL_CONNECT_RUN=0 일 때).  끄기: CONNECT_TEMPLATE_SYNC=0
# 환경: CONNECT_TEMPLATE_URL(없으면 .env 에서) AWS_PROFILE CTS_DRY=1(올리지 않고 할 일만) CTS_TEMPLATE(시험용, 기본 레포 파일)
# 종료: 0 같음·올림·건너뜀  1 못 읽음·못 올림·올린 뒤 다름
set -u
[ "${CONNECT_TEMPLATE_SYNC:-1}" = 0 ] && { echo "connect-template 건너뜀 (CONNECT_TEMPLATE_SYNC=0)"; exit 0; }
tpl=${CTS_TEMPLATE:-infra/onboarding/aws-connect.json}
[ -f "$tpl" ] || { echo "connect-template 실패: 레포 템플릿 $tpl 없음"; exit 1; }
url=${CONNECT_TEMPLATE_URL:-$(sed -n 's/^CONNECT_TEMPLATE_URL=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'")}
[ -n "$url" ] || { echo "connect-template 건너뜀 (CONNECT_TEMPLATE_URL 비어 있음; 콘솔 연결 링크를 안 쓰면 무시)"; exit 0; }
# 주소 → 버킷·키 (가상 호스트형 <b>.s3[.<r>].amazonaws.com/<k>, 경로형 s3[.<r>].amazonaws.com/<b>/<k>)
rest=${url#https://}; host=${rest%%/*}; path=${rest#*/}
[ "$path" = "$rest" ] && path=""
case "$host" in
  *.s3.amazonaws.com|*.s3.*.amazonaws.com|*.s3-*.amazonaws.com) b=${host%%.s3*}; k=$path ;;
  s3.amazonaws.com|s3.*.amazonaws.com|s3-*.amazonaws.com) b=${path%%/*}; k=${path#*/}; [ "$k" = "$path" ] && k="" ;;
  *) echo "connect-template 건너뜀 (S3 주소 모양이 아님; 손으로 올린 곳이면 CONNECT-TEMPLATE-S3.md 대로)"; exit 0 ;;
esac
k=${k%%\?*}
[ -n "$b" ] && [ -n "$k" ] || { echo "connect-template 실패: 주소에서 버킷/키를 못 읽음"; exit 1; }
d=$(mktemp -d "${TMPDIR:-/tmp}/cts.XXXXXX") || exit 1
trap 'rm -rf "$d"' EXIT
A="--only-show-errors --cli-connect-timeout 10 --cli-read-timeout 30"
same() { python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == json.load(open(sys.argv[2])) else 1)' "$tpl" "$1" 2>/dev/null; }
redact() { sed -E 's/[0-9]{12}/<계정>/g; s#s3://[^ ]*#s3://<버킷>#g' | sed "s#$b#<버킷>#g" | tr '\n' ' ' | cut -c1-160; }
if aws s3 cp $A "s3://$b/$k" "$d/cur.json" > "$d/get.err" 2>&1; then
  if same "$d/cur.json"; then echo "connect-template 같음 (레포 $tpl)"; exit 0; fi
  why="레포와 다름"
elif grep -qi 'NoSuchKey\|404\|Not Found' "$d/get.err"; then why="S3 에 없음"
else echo "connect-template 실패: S3 템플릿을 못 읽음 ($(redact < "$d/get.err"))"; exit 1; fi
if [ "${CTS_DRY:-0}" = 1 ]; then echo "dry-run: connect-template $why → 같은 주소에 올림 (aws s3 cp $tpl s3://<버킷>/$k)"; exit 0; fi
aws s3 cp $A --content-type application/json "$tpl" "s3://$b/$k" > "$d/put.err" 2>&1 \
  || { echo "connect-template 실패: 올리기 ($(redact < "$d/put.err"))"; exit 1; }
aws s3 cp $A "s3://$b/$k" "$d/new.json" > "$d/get2.err" 2>&1 && same "$d/new.json" \
  || { echo "connect-template 실패: 올린 뒤 다시 받았는데 레포와 다름"; exit 1; }
echo "connect-template 올림 ($why → 레포 $tpl 과 같아짐)"

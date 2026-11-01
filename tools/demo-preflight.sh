#!/bin/sh
# 데모 직전 점검 (z75-22). 조회만 한다. 레포 맨 위에서: sh tools/demo-preflight.sh
# 내용과 바꿀 수 있는 값은 tools/demo-preflight.ts 맨 위 설명
set -eu
cd "$(dirname "$0")/.."
exec node --env-file=.env --import tsx tools/demo-preflight.ts "$@"

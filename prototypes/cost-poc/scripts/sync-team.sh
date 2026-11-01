#!/usr/bin/env bash
# DRAFT(ai): 팀 코드 고정 사본을 origin/main으로 다시 맞춘다. 작업 트리의 코드가 아니라 origin/main에서 가져온다.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
SVC=${SVC:-"$HERE/../.."}
git -C "$SVC" fetch origin
rm -rf "$HERE/vendor/team"
mkdir -p "$HERE/vendor/team"
git -C "$SVC" archive origin/main packages/contracts packages/cost examples/shop/spec/appspec.shop.json | tar -x -C "$HERE/vendor/team"
rm -rf "$HERE/vendor/team/packages/cost/test" "$HERE/vendor/team/packages/contracts/test"
git -C "$SVC" rev-parse origin/main > "$HERE/vendor/team/COMMIT"
cat "$HERE/vendor/team/COMMIT"

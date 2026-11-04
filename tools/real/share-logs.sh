#!/bin/sh
# share-logs.sh — 로그 폴더를 가린 사본으로 옮긴다 (RV-18). 원본은 안 바꾼다. 파일 쓰기는 <새 폴더> 안에만, 네트워크 없음
# 사용: sh tools/real/share-logs.sh <원본 폴더> <새 폴더>
#   원본 폴더 아래 일반 파일 전부를 같은 상대 경로로 mask.sh 에 통과시켜 새 폴더에 쓴다 (심볼릭 링크·특수 파일은 건너뜀)
#   새 폴더는 없거나 비어 있어야 하고, 원본 폴더 안이면 안 된다 (가린 사본이 원본과 섞이지 않게)
# 끝 코드: 0 다 옮김 · 2 사용법·폴더 문제 · 1 가리기 실패 (그 파일은 새 폴더에 남기지 않음)
HERE=$(cd "$(dirname "$0")" && pwd)
[ $# -eq 2 ] || { echo "사용: sh tools/real/share-logs.sh <원본 폴더> <새 폴더>" >&2; exit 2; }
[ -d "$1" ] || { echo "원본 폴더 없음: $1" >&2; exit 2; }
SRC=$(cd "$1" && pwd -P)
if [ -e "$2" ]; then
  [ -d "$2" ] || { echo "새 폴더 자리에 파일이 있음: $2" >&2; exit 2; }
  [ -z "$(ls -A "$2")" ] || { echo "새 폴더가 비어 있지 않음: $2" >&2; exit 2; }
fi
mkdir -p "$2" || exit 2
DST=$(cd "$2" && pwd -P)
case "$DST/" in "$SRC/"*) rmdir "$2" 2>/dev/null; echo "새 폴더가 원본 폴더 안: $2" >&2; exit 2 ;; esac
n=0; bad=0
# find -print 만 쓴다 (BSD·GNU 같음). 이름의 줄바꿈은 로그 폴더에 없다고 본다
find "$SRC" -type f -print | while IFS= read -r f; do
  rel=${f#"$SRC"/}; out="$DST/$rel"
  mkdir -p "$(dirname "$out")" || exit 1
  if sh "$HERE/mask.sh" < "$f" > "$out.part"; then mv "$out.part" "$out"; else rm -f "$out.part"; echo "가리기 실패: $rel" >&2; exit 1; fi
done || bad=1
n=$(find "$DST" -type f | wc -l | tr -d ' ')
echo "가린 사본 ${n}개 → $DST"
[ "$bad" = 0 ] || exit 1

#!/bin/sh
# 잠금 파일(.terraform.lock.hcl)에 적힌 provider 판을 그대로 받아 <미러 폴더>에 펼쳐 둔다 (#373 B1, Dockerfile tf-providers 단계)
#   sh fetch-providers.sh <미러 폴더> <잠금 파일>...
# 잠금 파일만 읽어 provider 목록만 적은 빈 설정을 만들고 TF_PLUGIN_CACHE_DIR 로 init 한다.
#   플러그인 캐시 폴더 모양(<호스트>/<이름공간>/<종류>/<판>/<os_arch>/)이 filesystem_mirror 의 펼친(unpacked) 모양과 같다
#   모듈 *.tf 를 안 읽으므로 모듈을 고쳐도 이 층은 캐시에서 재사용된다 (잠금 파일이 바뀔 때만 다시 받는다)
#   받은 파일은 잠금 파일 해시로 확인된다 (안 맞으면 init 실패 → 빌드 멈춤)
set -eu
out=$1; shift
mkdir -p "$out"
for lock in "$@"; do
  d=$(mktemp -d)
  cp "$lock" "$d/.terraform.lock.hcl"
  # provider "registry.terraform.io/hashicorp/aws" { version = "6.72.0" ... } → aws = { source = "registry.terraform.io/hashicorp/aws", version = "6.72.0" }
  awk '
    BEGIN { print "terraform {"; print "  required_providers {" }
    /^provider "/ { split($0, q, "\""); src = q[2]; n = split(src, p, "/"); name = p[n] }
    /^[ \t]*version[ \t]*=/ && src != "" { split($0, v, "\""); printf "    %s = { source = \"%s\", version = \"%s\" }\n", name, src, v[2]; src = "" }
    END { print "  }"; print "}" }
  ' "$lock" > "$d/providers.tf"
  # DRAFT(ai): 내려받기가 잠깐 끊기면 3번까지 (terraform 자체도 레지스트리 요청은 다시 시도한다)
  ok=0
  for try in 1 2 3; do
    if TF_PLUGIN_CACHE_DIR="$out" terraform -chdir="$d" init -backend=false -input=false -no-color; then ok=1; break; fi
    echo "provider 받기 실패 ($lock, $try/3)"; sleep 5
  done
  rm -rf "$d"
  [ "$ok" = 1 ] || exit 1
done
# 받은 것 목록 (빌드 로그에 남긴다)
find "$out" -mindepth 5 -maxdepth 5 | sed "s|^$out/||" | sort

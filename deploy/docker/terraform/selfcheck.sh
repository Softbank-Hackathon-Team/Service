#!/bin/sh
# 이미지에 구운 provider 미러만으로(네트워크 없이) worker 가 돌리는 루트 모듈이 전부 init 되는지 본다 (#373 B1)
#   쓰는 곳: Dockerfile worker 단계 (RUN --network=none, 빌드 확인), .github/workflows/ci.yml docker 작업 (비루트·읽기 전용 뿌리·--network none)
#   작업 폴더는 실행기와 같은 모양으로 펼친다 (packages/adapters/src/terraform/real-runner.ts prepare, env-layer.ts prepare):
#     <작업>/<환경>/root/{*.tf,.terraform.lock.hcl} + <작업>/<환경>/kinds/<종류>/*.tf     → terraform -chdir=root init
#     <작업>/gcp-env/modules/gcp/env/{*.tf,.terraform.lock.hcl}                          → 환경 층
#   잠금 파일 판·해시가 미러와 다르거나, 모듈 제약이 잠금 파일과 안 맞으면 여기서 실패한다 (그대로 두면 이전마다 init 이 실패한다)
#   SELFCHECK_TFRC=/opt/terraform/terraformrc 로 주면 실제 설정(미러 + direct)으로 본다. 네트워크가 있어야 하고(판 목록만 묻는다) 전부 미러에서 깔려야 통과
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tfrc=${SELFCHECK_TFRC:-$here/offline.tfrc}
src=${TF_MODULE_ROOT:-/app/infra/modules}
work=$(mktemp -d "${TMPDIR:-/tmp}/tf-selfcheck.XXXXXX")
trap 'rm -rf "$work"' EXIT
roots=""
# DRAFT(ai): 실행기 REAL_MODULE_BASE(aws·gcp·onprem) + 환경 층(gcp/env). 새 환경 모듈이 생기면 여기도 더한다
for p in aws gcp onprem; do
  mkdir -p "$work/$p/root"
  cp "$src/$p/root/"*.tf "$src/$p/root/.terraform.lock.hcl" "$work/$p/root/"
  for k in "$src/$p/kinds/"*/; do
    n=$(basename "$k"); mkdir -p "$work/$p/kinds/$n"; cp "$k"*.tf "$work/$p/kinds/$n/"
  done
  roots="$roots $work/$p/root"
done
mkdir -p "$work/gcp-env/modules/gcp/env"
cp "$src/gcp/env/"*.tf "$src/gcp/env/.terraform.lock.hcl" "$work/gcp-env/modules/gcp/env/"
roots="$roots $work/gcp-env/modules/gcp/env"
for d in $roots; do
  if ! out=$(CHECKPOINT_DISABLE=1 TF_IN_AUTOMATION=1 TF_CLI_CONFIG_FILE="$tfrc" terraform -chdir="$d" init -input=false -no-color 2>&1); then
    echo "$out"; echo "실패: ${d#"$work"/} (미러로 init 안 됨, 설정 $tfrc)"; exit 1
  fi
  # 레지스트리에서 받은 것(signed by HashiCorp)이 있으면 미러가 그 provider·판을 못 덮은 것
  if echo "$out" | grep -q '(signed by'; then
    echo "$out" | grep -E '^- Installed '; echo "실패: ${d#"$work"/} 미러에 없는 provider 를 레지스트리에서 받았다"; exit 1
  fi
  echo "ok: ${d#"$work"/} — $(echo "$out" | grep -E '^- Installed ' | sed 's/^- Installed //' | tr '\n' ' ')"
done

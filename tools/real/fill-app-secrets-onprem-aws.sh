#!/usr/bin/env bash
# 온프레 → AWS 이전의 배포 정지(APP-20 SECRET_VALUES_MISSING)에서 도착 비밀 그릇 두 개를 채운다 (DRAFT(ai), 2026-11-07).
#   1) <prefix>/api-secrets                    ← 온프레 VM 의 k8s Secret <ns>/api-secrets 키 API_TOKEN   → {"API_TOKEN": …}
#   2) <prefix>/<출발 DB 비밀 이름>             ← 도착 RDS 앱 비밀번호 그릇 <prefix>/<인스턴스>-db-password 의 password → {"password": …}
#      (출발 CNPG 비밀번호가 아니다. 앱은 컷오버 뒤 도착 RDS 에 이 비밀번호로 붙는다. 새로 계획한 이전은 차트가 이 연결을 스스로 하므로 2) 가 필요 없다)
# 값은 화면·셸 기록·인자에 안 나온다: 읽은 값은 0600 임시 파일 → put-secret-value --secret-string file:// → 바로 지움.
# 이미 값(AWSCURRENT)이 있는 그릇은 건드리지 않는다 (FORCE=1 이면 새 버전으로 덮음).
# 쓰는 법 (레포 어디서든):
#   AWS_PROFILE=softbank bash tools/real/fill-app-secrets-onprem-aws.sh
# 환경: PREFIX(기본 platform/t-11111111/shop-api) NS(기본 app-shop-api) SRC_SECRET(api-secrets) DB_SECRET(shop-api-sample-shop-db-app) VM(ssh 호스트, 기본 onprem-vm)
set -euo pipefail
export AWS_REGION=${AWS_REGION:-ap-northeast-2}
PREFIX=${PREFIX:-platform/t-11111111/shop-api}
NS=${NS:-app-shop-api}
SRC_SECRET=${SRC_SECRET:-api-secrets}
DB_SECRET=${DB_SECRET:-shop-api-sample-shop-db-app}
VM=${VM:-onprem-vm}
FORCE=${FORCE:-0}

d=$(mktemp -d "${TMPDIR:-/tmp}/fill.XXXXXX"); chmod 700 "$d"
trap 'rm -rf "$d"' EXIT

has_value() { aws secretsmanager describe-secret --secret-id "$1" --query 'VersionIdsToStages' --output json 2>/dev/null | grep -q AWSCURRENT; }
exists() { aws secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1; }
put() {   # $1 = 그릇 이름, $2 = JSON 파일
  if ! exists "$1"; then echo "없음: $1 (apply 가 그릇을 만들었는지 확인)"; return 1; fi
  if has_value "$1" && [ "$FORCE" != 1 ]; then echo "건너뜀(이미 값 있음): $1"; return 0; fi
  aws secretsmanager put-secret-value --secret-id "$1" --secret-string "file://$2" --query VersionId --output text >/dev/null
  echo "넣음: $1"
}

# 1) API_TOKEN: VM 의 Secret 을 base64 그대로 받아 이 맥에서 JSON 으로 만든다 (값은 파이프·파일로만)
umask 077
ssh "$VM" "export KUBECONFIG=\$HOME/.kube/config; kubectl -n $NS get secret $SRC_SECRET -o jsonpath='{.data.API_TOKEN}'" > "$d/tok.b64"
[ -s "$d/tok.b64" ] || { echo "실패: VM 에서 $NS/$SRC_SECRET 키 API_TOKEN 을 못 읽음"; exit 1; }
python3 -I -c 'import base64,json,sys; v=base64.b64decode(open(sys.argv[1]).read().strip()).decode(); json.dump({"API_TOKEN": v}, open(sys.argv[2],"w"))' "$d/tok.b64" "$d/api.json"
put "$PREFIX/$SRC_SECRET" "$d/api.json"

# 2) DB 앱 비밀번호: 도착 RDS 앱 비밀번호 그릇(<인스턴스>-db-password, {username,password})에서 password 만
pw_secret=$(aws secretsmanager list-secrets --filters Key=name,Values="$PREFIX/" --query 'SecretList[].Name' --output text | tr '\t' '\n' | grep -E -- '-db-password$' | head -n 1 || true)
[ -n "$pw_secret" ] || { echo "실패: $PREFIX/ 아래 *-db-password 그릇이 없음 (apply 가 끝났는지 확인)"; exit 1; }
aws secretsmanager get-secret-value --secret-id "$pw_secret" --query SecretString --output text > "$d/pw.json"
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); json.dump({"password": d["password"]}, open(sys.argv[2],"w"))' "$d/pw.json" "$d/db.json"
put "$PREFIX/$DB_SECRET" "$d/db.json"
echo "끝. 콘솔에서 배포를 재개한다."

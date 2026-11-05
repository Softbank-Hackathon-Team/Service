#!/usr/bin/env bash
# 플랫폼 DB 마이그레이션을 EKS platform 네임스페이스의 임시 파드에서 tools/db-migrate.sh 로 넣는다 (DRAFT(ai))
#   bash tools/platform-db-migrate.sh status   넣은 것 / 남은 것 보기 (기록 표 migrate.applied 가 없으면 빈 표만 만든다)
#   bash tools/platform-db-migrate.sh apply    남은 목록이 EXPECT 와 정확히 같을 때만 넣는다 (기본 0050_replication_endpoints.sql)
# 레포 루트에서, 그 마이그레이션이 든 PR 이 main 에 머지된 뒤 main 에서 돌린다 (넣은 파일 내용이 나중에 바뀌면 db-migrate.sh 가 멈춘다).
# 표 주인 비밀번호는 RDS 관리 비밀에서 바로 k8s Secret 으로 간다 (화면·셸 기록에 안 나온다). 끝나면 파드·Secret·임시 파일을 늘 지운다.
# 새 worker 이미지 배포 전에 넣는다: 새 worker 는 모든 이전에서 replication_endpoints 를 읽는다
set -euo pipefail
MODE=${1:?usage: status|apply}
EXPECT=${EXPECT:-0050_replication_endpoints.sql}
CTX=${KUBE_CONTEXT:-softbank-platform}; NS=platform; POD=db-migrate-tmp; SEC=db-migrate-tmp
export AWS_PROFILE=${AWS_PROFILE:-softbank} AWS_REGION=${AWS_REGION:-ap-northeast-2}
k() { kubectl --context "$CTX" -n "$NS" "$@"; }

[ -f tools/db-migrate.sh ] && [ -d db/migrations ] || { echo "Service 레포 루트에서 실행한다" >&2; exit 1; }
if [ "$MODE" = apply ] && [ "$(git branch --show-current)" != main ]; then echo "apply 는 main 에서만 (머지된 최종 파일)" >&2; exit 1; fi

tmp=""
cleanup() { k delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
            k delete secret "$SEC" --ignore-not-found >/dev/null 2>&1 || true; [ -z "$tmp" ] || rm -f "$tmp"; }
trap cleanup EXIT

read -r HOST ARN < <(aws rds describe-db-instances --db-instance-identifier platform-db \
  --query 'DBInstances[0].[Endpoint.Address,MasterUserSecret.SecretArn]' --output text)
tmp=$(umask 077; mktemp)
aws secretsmanager get-secret-value --secret-id "$ARN" --query SecretString --output text | python3 -c '
import json, sys, urllib.parse as u
d = json.load(sys.stdin)
url = "postgres://%s:%s@%s:5432/platform?sslmode=require" % (u.quote(d["username"], safe=""), u.quote(d["password"], safe=""), sys.argv[1])
open(sys.argv[2], "w").write(url)' "$HOST" "$tmp"
k create secret generic "$SEC" --from-file=DB_ADMIN_URL="$tmp" >/dev/null
rm -f "$tmp"; tmp=""

k run "$POD" --image=postgres:16-alpine --restart=Never --overrides="{\"spec\":{\"containers\":[{\"name\":\"$POD\",\"image\":\"postgres:16-alpine\",\"command\":[\"sleep\",\"900\"],\"envFrom\":[{\"secretRef\":{\"name\":\"$SEC\"}}]}]}}" >/dev/null
k wait --for=condition=Ready "pod/$POD" --timeout=180s >/dev/null
k exec "$POD" -- mkdir -p /work/tools /work/db
k cp tools/db-migrate.sh "$POD:/work/tools/db-migrate.sh" >/dev/null
k cp db/migrations "$POD:/work/db/migrations" >/dev/null

case "$MODE" in
  status) k exec "$POD" -- sh /work/tools/db-migrate.sh --status ;;
  apply)
    pending=$(k exec "$POD" -- sh /work/tools/db-migrate.sh --dry-run | grep -E '^[0-9]{4}_' || true)
    echo "넣을 파일: ${pending:-(없음)}"
    if [ "$pending" != "$EXPECT" ]; then
      echo "기대(EXPECT=$EXPECT)와 다르다. 아무것도 넣지 않고 멈춘다. status 로 먼저 확인한다" >&2; exit 1
    fi
    k exec "$POD" -- sh /work/tools/db-migrate.sh
    k exec "$POD" -- sh /work/tools/db-migrate.sh --status | tail -5 ;;
  *) echo "status 또는 apply" >&2; exit 2 ;;
esac

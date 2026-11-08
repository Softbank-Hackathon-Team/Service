#!/usr/bin/env bash
# 실플랫폼 이전 한 건의 단계별 소요 시간을 플랫폼 DB 감사 기록(audit_events)에서 읽어 표로 낸다. 읽기 전용.
#
#   bash tools/demo/migration-timing.sh up                 읽기 전용 psql 파드를 띄운다 (4시간 뒤 스스로 꺼짐)
#   bash tools/demo/migration-timing.sh list               최근 이전 10건 (번호·방향·상태)
#   bash tools/demo/migration-timing.sh ready aws-onprem   시작 전 점검 (진행 중 이전·VM Agent). onprem-aws 는 인벤토리 신선도·db-tunnel·도착 네임스페이스까지
#   bash tools/demo/migration-timing.sh watch [id|latest]  전이가 생길 때마다 한 줄씩 찍고, 끝나면(completed·failed·rolled_back·cancelled) 표를 저장
#   bash tools/demo/migration-timing.sh report <id|latest> 지금까지의 표를 찍고 tools/demo/runs/ 에 저장
#   bash tools/demo/migration-timing.sh down               파드·비밀을 지운다
#
# id 는 앞 8자만 줘도 된다. latest = 가장 최근에 만든 이전.
# DB 접속 문자열은 RDS 관리 비밀 → k8s Secret 으로만 간다 (화면·셸 기록·인자에 안 나온다). 세션은 읽기 전용(default_transaction_read_only).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CTX=${KUBE_CONTEXT:-softbank-platform}; NS=platform; POD=timing-psql; SEC=timing-psql
export AWS_PROFILE=${AWS_PROFILE:-softbank} AWS_REGION=${AWS_REGION:-ap-northeast-2}
k() { kubectl --context "$CTX" -n "$NS" "$@"; }

psql_json() {   # $1 = SQL (한 JSON 값을 돌려주는 SELECT)
  k exec -i "$POD" -- sh -c 'psql "$DB_URL" -X -tA -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only=on" -f -' <<<"$1" | sed '1d'   # 첫 줄은 SET 응답, 나머지가 값(json_agg 는 여러 줄)
}

need_pod() {
  k get pod "$POD" -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running \
    || { echo "측정 파드가 없다. 먼저: bash tools/demo/migration-timing.sh up" >&2; exit 1; }
}

up() {
  if k get pod "$POD" -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running; then echo "이미 떠 있음: $POD"; return; fi
  k delete pod "$POD" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  k delete secret "$SEC" --ignore-not-found >/dev/null 2>&1 || true
  local tmp; tmp=$(umask 077; mktemp); trap 'rm -f "$tmp"' RETURN
  read -r HOST ARN < <(aws rds describe-db-instances --db-instance-identifier platform-db \
    --query 'DBInstances[0].[Endpoint.Address,MasterUserSecret.SecretArn]' --output text)
  aws secretsmanager get-secret-value --secret-id "$ARN" --query SecretString --output text | python3 -I -c '
import json, sys, urllib.parse as u
d = json.load(sys.stdin)
open(sys.argv[2], "w").write("postgres://%s:%s@%s:5432/platform?sslmode=require" % (u.quote(d["username"], safe=""), u.quote(d["password"], safe=""), sys.argv[1]))' "$HOST" "$tmp"
  k create secret generic "$SEC" --from-file=DB_URL="$tmp" >/dev/null
  k run "$POD" --image=postgres:16-alpine --restart=Never --overrides="{\"spec\":{\"containers\":[{\"name\":\"$POD\",\"image\":\"postgres:16-alpine\",\"command\":[\"sleep\",\"14400\"],\"envFrom\":[{\"secretRef\":{\"name\":\"$SEC\"}}]}]}}" >/dev/null
  k wait --for=condition=Ready "pod/$POD" --timeout=180s >/dev/null
  echo "준비됨: $POD (4시간 뒤 스스로 꺼짐, 끝나면 down)"
}

down() {
  k delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  k delete secret "$SEC" --ignore-not-found >/dev/null 2>&1 || true
  echo "지움: $POD, $SEC"
}

resolve_id() {   # $1 = 앞 8자 이상 또는 latest → 전체 uuid
  local want=${1:-latest} sql
  if [ "$want" = latest ]; then sql="SELECT id FROM migrations ORDER BY created_at DESC LIMIT 1"
  else [[ "$want" =~ ^[0-9a-f-]{8,36}$ ]] || { echo "id 모양이 아니다: $want" >&2; exit 1; }
       sql="SELECT id FROM migrations WHERE id::text LIKE '${want}%' ORDER BY created_at DESC LIMIT 1"; fi
  local id; id=$(psql_json "$sql")
  [ -n "$id" ] || { echo "이전을 못 찾음: $want" >&2; exit 1; }
  echo "$id"
}

dump() {   # $1 = uuid → 이전 한 건의 JSON (이전 줄 + 감사 기록 전부)
  psql_json "SELECT json_build_object(
    'm', (SELECT json_build_object('id', m.id, 'status', m.status, 'created', m.created_at, 'failure', m.failure_code,
           'src', (SELECT name || ' (' || provider || ')' FROM environments WHERE id = m.source_env_id),
           'tgt', (SELECT name || ' (' || provider || ')' FROM environments WHERE id = m.target_env_id))
          FROM migrations m WHERE m.id = '$1'),
    'ev', (SELECT coalesce(json_agg(json_build_object('at', at, 'action', action, 'actor', actor, 'detail', detail) ORDER BY seq), '[]')
           FROM audit_events WHERE target = '$1'))"
}

list() {
  need_pod
  psql_json "SELECT coalesce(json_agg(r), '[]') FROM (SELECT left(m.id::text, 8) AS id, to_char(m.created_at AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI') AS created,
      (SELECT name FROM environments WHERE id = m.source_env_id) AS src, (SELECT name FROM environments WHERE id = m.target_env_id) AS tgt, m.status
    FROM migrations m ORDER BY m.created_at DESC LIMIT 10) r" | python3 -I -c '
import json, sys
for r in json.load(sys.stdin): print("%s  %s  %s -> %s  %s" % (r["id"], r["created"], r["src"], r["tgt"], r["status"]))'
}

report() {
  need_pod
  local id; id=$(resolve_id "${1:-latest}")
  mkdir -p "$HERE/runs"
  dump "$id" | python3 -I "$HERE/timing_report.py" "$HERE/runs"
}

watch() {
  need_pod
  local id; id=$(resolve_id "${1:-latest}")
  echo "지켜봄: $id (15초마다, 끝나면 표 저장. 멈추려면 Ctrl-C)"
  local seen=0
  while true; do
    local j; j=$(dump "$id" || true)
    [ -n "$j" ] || { sleep 15; continue; }
    seen=$(python3 -I "$HERE/timing_report.py" --tail "$seen" <<<"$j")
    local st; st=$(python3 -I -c 'import json,sys; print(json.load(sys.stdin)["m"]["status"])' <<<"$j")
    case "$st" in completed|failed|rolled_back|cancelled)
      echo; python3 -I "$HERE/timing_report.py" "$HERE/runs" <<<"$j"; return ;;
    esac
    sleep 15
  done
}

ready() {   # $1 = aws-onprem | onprem-aws. 시작 전 점검 (읽기 전용). 막힘이 있으면 exit 1
  need_pod
  local dir=${1:-} bad=0
  [[ "$dir" = aws-onprem || "$dir" = onprem-aws ]] || { echo "사용: ready aws-onprem | onprem-aws" >&2; exit 1; }
  local j; j=$(psql_json "SELECT json_build_object(
    'inflight', (SELECT coalesce(json_agg(left(id::text,8) || ' ' || status), '[]') FROM migrations
                  WHERE status NOT IN ('completed','failed','cancelled','rolled_back','rejected','stale','draft')),
    'hb_age', (SELECT extract(epoch FROM now() - max(received_at))::int FROM agent_reports r JOIN environments e ON e.id = r.env_id
                WHERE e.name = '$VM_ENV' AND r.kind = 'heartbeat'),
    'inv_at', (SELECT max(received_at) FROM agent_reports r JOIN environments e ON e.id = r.env_id WHERE e.name = '$VM_ENV' AND r.kind = 'inventory'),
    'inv_tunnel', (SELECT jsonb_path_exists(body::jsonb, 'strict \$.** ? (@.metadata.namespace == \"$TARGET_NS\" && @.metadata.name starts with \"db-tunnel\")')
                    FROM agent_reports r JOIN environments e ON e.id = r.env_id
                    WHERE e.name = '$VM_ENV' AND r.kind = 'inventory' ORDER BY received_at DESC LIMIT 1),   -- 앱 네임스페이스 안의 것만 (VM 의 app-tunnel-test 시험 터널은 뺀다)
    'last_done', (SELECT max(a.at) FROM audit_events a JOIN migrations m ON a.target = m.id::text
                   JOIN environments t ON t.id = m.target_env_id
                  WHERE t.name = '$VM_ENV' AND a.detail->>'to' = 'completed'))")
  python3 -I - "$dir" "$j" <<'PY' || bad=1
import json, sys
from datetime import datetime
d, j = sys.argv[1], json.loads(sys.argv[2]); bad = 0
def say(ok, msg):
    global bad
    print(("통과  " if ok else "막힘  ") + msg); bad |= (not ok)
say(not j["inflight"], f"진행 중인 이전 없음 {j['inflight'] or ''}")
say(j["hb_age"] is not None and j["hb_age"] < 60, f"VM Agent heartbeat {j['hb_age']}초 전 (60초 안)")
if d == "onprem-aws":
    ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None
    inv, done = ts(j["inv_at"]), ts(j["last_done"])
    say(inv is not None and (done is None or (inv - done).total_seconds() > 0),
        f"VM 인벤토리가 직전 온프레 도착 완료 뒤에 받은 것 (남은 터널은 다음 줄이 본다) (인벤토리 {j['inv_at']}, 완료 {j['last_done']})")
    say(j["inv_tunnel"] is False, "최신 인벤토리에 db-tunnel 없음 (있으면 가져오기가 터널 파드를 고객 앱으로 잡는다)")
sys.exit(bad)
PY
  if [ "$dir" = onprem-aws ]; then
    # 도착 EKS 의 app-shop-api 네임스페이스는 직접 못 본다(권한 없음). 허브 Argo 앱이 그 안 자원을 Synced 로 보면 아직 있다
    local live; live=$(kubectl --context "$CTX" -n argocd get application "$HUB_APP" -o json 2>/dev/null | python3 -I -c '
import json, sys
try: a = json.load(sys.stdin)
except Exception: print(0); sys.exit()
print(sum(1 for r in a.get("status", {}).get("resources", []) if r.get("namespace") == "'"$TARGET_NS"'" and r.get("status") == "Synced"))' || echo 0)
    if [ "${live:-0}" -gt 0 ]; then echo "막힘  도착 EKS 에 $TARGET_NS 가 아직 있다 (허브 앱 $HUB_APP 자원 ${live}개 Synced). 클러스터 관리자가 지워야 terraform 이 네임스페이스를 만든다"; bad=1
    else echo "통과  도착 EKS 에 예전 $TARGET_NS 자원 없음 (허브 앱 기준)"; fi
  fi
  [ "$bad" = 0 ] && echo "=> 시작해도 된다: $dir" || { echo "=> 아직 시작하지 마라"; exit 1; }
}

VM_ENV=${VM_ENV:-demo2-onprem-target}; HUB_APP=${HUB_APP:-t-11111111-shop-api-aws-eks}; TARGET_NS=${TARGET_NS:-app-shop-api}

case "${1:-}" in
  up) up ;; down) down ;; list) list ;; ready) ready "${2:-}" ;;
  report) report "${2:-latest}" ;; watch) watch "${2:-latest}" ;;
  *) sed -n 2,12p "$0"; exit 1 ;;
esac

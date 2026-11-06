#!/usr/bin/env bash
# 실제 플랫폼의 한 회사(테넌트)에 팀원 로그인 계정(이메일+비밀번호)을 한 번에 만든다 (DRAFT(ai)). 가입·초대 API 가 없어서 쓰는 운영 도구
#   TENANT_ID=<회사 uuid> bash tools/platform-team-users.sh <email:이름 | 파일> ...
#   파일은 한 줄에 "email:이름" (빈 줄·# 줄 무시). 인자가 있는 파일이면 파일로, 아니면 email:이름 하나로 읽는다
# 비밀번호는 이 맥에서 만들고(24자 무작위) 앱의 hashPassword(운영과 같은 scrypt N=2^17)로 해시한다.
#   원문은 OUT_FILE(기본 ~/.config/iron/team-logins.txt, 권한 600)에 "email<TAB>password" 로만 쓰고, DB 에는 해시만 보낸다.
#   파일에 이미 있는 이메일은 같은 비밀번호를 다시 쓴다 (FORCE=1 이면 새로 만들고, 같은 회사의 기존 계정 비밀번호도 바꾼다 = reset)
# DB 단계: tools/platform-db-migrate.sh 와 같은 방식. 표 주인 연결 문자열은 RDS 관리 비밀 → k8s Secret 으로만 가고,
#   platform 네임스페이스 임시 postgres 파드에서 psql 한 트랜잭션으로 넣는다. 해시는 kubectl exec 의 표준 입력으로만 간다(프로세스 인자에 없음).
#   회사가 없으면 아무것도 안 넣고 멈춘다. 끝나면(실패해도) 파드·Secret·임시 파일을 지운다.
# 화면에는 "email → created | exists" 와 개수만 나온다. 비밀번호·해시·연결 문자열은 찍지 않는다
#   DRY_RUN=1   비밀값을 만들지 않고 AWS·kubectl 도 안 부른다. 사용자 목록과 SQL 모양(자리 표시)만 찍는다
#   KUBE_CONTEXT(기본 eks-platform)  AWS_PROFILE(기본 softbank)  AWS_REGION(기본 ap-northeast-2)  OUT_FILE  FORCE=1
set -euo pipefail
umask 077   # 이 도구가 만드는 파일(임시 연결 문자열·해시·로그인 파일)은 전부 나만 읽는다
CTX=${KUBE_CONTEXT:-eks-platform}; NS=platform
OUT_FILE=${OUT_FILE:-$HOME/.config/iron/team-logins.txt}
FORCE=${FORCE:-0}
export AWS_PROFILE=${AWS_PROFILE:-softbank} AWS_REGION=${AWS_REGION:-ap-northeast-2}

[ -f tools/platform-team-users.ts ] && [ -f apps/api/src/auth/password.ts ] || { echo "Service 레포 루트에서 실행한다" >&2; exit 1; }
TENANT_ID=$(printf '%s' "${TENANT_ID:-}" | tr 'A-F' 'a-f')
[[ $TENANT_ID =~ ^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$ ]] || { echo "TENANT_ID(회사 uuid)가 필요하다" >&2; exit 2; }
[ $# -gt 0 ] || { echo "usage: TENANT_ID=<uuid> bash tools/platform-team-users.sh <email:이름 | 파일> ..." >&2; exit 2; }
helper() { node --import tsx tools/platform-team-users.ts "$@"; }

# psql 이 표준 입력으로 읽는 스크립트. 앞부분 → (COPY 데이터 줄) → \. → 뒷부분
sql_head() { cat <<'SQL'
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- 표 주인에게도 회사 벽(FORCE RLS)이 걸린다 → tools/auth-seed.ts 처럼 회사 번호를 먼저 넣는다
SELECT set_config('app.tenant_id', :'tenant', true) AS _ \gset
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = current_setting('app.tenant_id')::uuid) THEN
    RAISE EXCEPTION 'TENANT_NOT_FOUND';
  END IF;
END $$;
CREATE TEMP TABLE incoming (email text PRIMARY KEY, display_name text, password_hash text NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE outcome (email text PRIMARY KEY, status text NOT NULL) ON COMMIT DROP;
COPY incoming (email, display_name, password_hash) FROM STDIN;
SQL
}
sql_tail() { cat <<'SQL'
WITH ins AS (
  INSERT INTO users (tenant_id, email, display_name, password_hash, password_changed_at)
  SELECT current_setting('app.tenant_id')::uuid, email, NULLIF(display_name, ''), password_hash, now() FROM incoming
  ON CONFLICT (email) DO NOTHING
  RETURNING email)
INSERT INTO outcome SELECT email, 'created' FROM ins;
SQL
  if [ "$FORCE" = 1 ]; then cat <<'SQL'
-- FORCE=1: 같은 회사에 이미 있는 계정은 비밀번호만 바꾼다 (끈 계정은 그대로 꺼 둔다)
WITH up AS (
  UPDATE users u SET password_hash = i.password_hash, password_changed_at = now()
    FROM incoming i
   WHERE u.email = i.email AND u.tenant_id = current_setting('app.tenant_id')::uuid
     AND NOT EXISTS (SELECT 1 FROM outcome o WHERE o.email = i.email)
  RETURNING u.email)
INSERT INTO outcome SELECT email, 'reset' FROM up;
SQL
  fi
  cat <<'SQL'
INSERT INTO outcome
SELECT i.email, CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.email = i.email AND u.tenant_id = current_setting('app.tenant_id')::uuid)
                     THEN 'exists' ELSE 'exists-other-tenant' END
  FROM incoming i WHERE NOT EXISTS (SELECT 1 FROM outcome o WHERE o.email = i.email);
SELECT 'RESULT' || E'\t' || email || E'\t' || status FROM outcome ORDER BY email;
COMMIT;
SQL
}

if [ "${DRY_RUN:-0}" = 1 ]; then
  echo "DRY_RUN: 회사 $TENANT_ID, kube context $CTX, 로그인 파일 $OUT_FILE (안 씀), FORCE=$FORCE"
  echo "사용자:"; helper list -- "$@" | sed 's/^/  /'
  echo "--- psql 에 표준 입력으로 보낼 SQL 모양 (데이터 줄은 자리 표시) ---"
  sql_head
  printf '<email>\t<이름>\t<scrypt$131072$8$1$소금$해시>\n\\.\n'
  sql_tail
  exit 0
fi

work=""; POD=""; SEC=""
k() { kubectl --context "$CTX" -n "$NS" "$@"; }
cleanup() {
  if [ -n "$POD" ]; then k delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; fi
  if [ -n "$SEC" ]; then k delete secret "$SEC" --ignore-not-found >/dev/null 2>&1 || true; fi
  [ -z "$work" ] || rm -rf "$work"
}
trap cleanup EXIT
work=$(mktemp -d)

# 1) 로컬: 비밀번호 정하기·해시·로그인 파일 쓰기 (DB 보다 먼저: 중간에 실패해도 다음 실행이 같은 비밀번호를 다시 쓴다)
args=(--out "$OUT_FILE" --hashes "$work/hashes.tsv" --plan "$work/plan.tsv")
[ "$FORCE" = 1 ] && args+=(--force)
helper prepare "${args[@]}" -- "$@"

# 2) 표 주인 연결 문자열 → k8s Secret (platform-db-migrate.sh 와 같은 길. 화면·셸 기록에 안 나온다)
id="team-users-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
read -r HOST ARN < <(aws rds describe-db-instances --db-instance-identifier platform-db \
  --query 'DBInstances[0].[Endpoint.Address,MasterUserSecret.SecretArn]' --output text)
aws secretsmanager get-secret-value --secret-id "$ARN" --query SecretString --output text | python3 -c '
import json, sys, urllib.parse as u
d = json.load(sys.stdin)
url = "postgres://%s:%s@%s:5432/platform?sslmode=require" % (u.quote(d["username"], safe=""), u.quote(d["password"], safe=""), sys.argv[1])
open(sys.argv[2], "w").write(url)' "$HOST" "$work/db-url"
SEC=$id; k create secret generic "$SEC" --from-file=DB_ADMIN_URL="$work/db-url" >/dev/null
rm -f "$work/db-url"

POD=$id
k run "$POD" --image=postgres:16-alpine --restart=Never --overrides="{\"spec\":{\"containers\":[{\"name\":\"$POD\",\"image\":\"postgres:16-alpine\",\"command\":[\"sleep\",\"600\"],\"envFrom\":[{\"secretRef\":{\"name\":\"$SEC\"}}]}]}}" >/dev/null
k wait --for=condition=Ready "pod/$POD" --timeout=180s >/dev/null

# 3) 한 트랜잭션. 해시는 표준 입력(COPY FROM STDIN)으로만. 실패하면 오류 글의 해시를 가려서 보여 준다
if ! { sql_head; cat "$work/hashes.tsv"; printf '\\.\n'; sql_tail; } \
    | k exec -i "$POD" -- sh -c 'exec psql "$DB_ADMIN_URL" -X -q -At -v ON_ERROR_STOP=1 -v tenant="$1" -f -' _ "$TENANT_ID" \
      >"$work/result.txt" 2>"$work/psql.err"; then
  if grep -q TENANT_NOT_FOUND "$work/psql.err"; then
    echo "회사 없음: $TENANT_ID — 아무 계정도 넣지 않았다" >&2
  else
    echo "DB 단계 실패 — 트랜잭션 전체가 되돌려졌다. 로그인 파일의 비밀번호는 다시 돌리면 그대로 쓴다" >&2
    sed -E 's/scrypt\$[^[:space:]",)]*/scrypt$<숨김>/g' "$work/psql.err" >&2
  fi
  exit 1
fi

# 4) 결과 찍기 + DB 에 안 들어간 새 비밀번호를 로그인 파일에서 빼기
helper finalize --out "$OUT_FILE" --plan "$work/plan.tsv" <"$work/result.txt"
echo "로그인 파일: $OUT_FILE (권한 600, 각자에게 따로 전한다)"

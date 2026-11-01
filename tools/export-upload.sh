#!/bin/bash
# tools/export-upload.sh — GitHub 업로드용 "깨끗한 폴더"를 만든다 (Z106-02)
# 쓰는 법: bash tools/export-upload.sh [출력폴더]
#   기본 출력: ~/Softbank_final/upload-YYYYMMDD  (Service 폴더 바깥)
#   UPLOAD_FORCE=1 이면 출력 폴더가 이미 있어도 지우고 다시 만든다
# 하는 일
#   1) rsync 로 Service → 출력 폴더 복사. .env·.claude·로그·node_modules·terraform 상태·키 파일은 뺀다
#   2) 출력 폴더에 금지 파일 이름이 남았는지 다시 본다
#   3) 비밀값 모양 grep 규칙을 돌린다. 시험용 가짜값(허용 목록)은 뺀다. 원문은 찍지 않는다(앞 4자 + 길이만)
#   4) 파일 수·용량을 찍는다. 1건이라도 걸리면 exit 1 (그 폴더는 올리지 말 것)
# 맥 기본 도구만 쓴다: bash 3.2, BSD grep -E (grep -P 없음), rsync(openrsync 포함)
set -u
LC_ALL=C; export LC_ALL
SRC=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$HOME/Softbank_final/upload-$(date +%Y%m%d)}
case "$OUT" in "$SRC"|"$SRC"/*) echo "FAIL 출력 폴더가 Service 안쪽이다: $OUT"; exit 2 ;; esac
if [ -e "$OUT" ]; then
  if [ "${UPLOAD_FORCE:-0}" = 1 ]; then rm -rf "$OUT"; else echo "FAIL 이미 있다: $OUT (UPLOAD_FORCE=1 로 다시 만들기)"; exit 2; fi
fi
mkdir -p "$OUT" || exit 2
command -v rsync >/dev/null || { echo "FAIL rsync 없음"; exit 2; }

EXCLUDES='
.git/
.env
.env.*
.agent-key*.env
.secrets/
.claude/
.omc/
.int-logs/
.dev-logs/
.DS_Store
node_modules/
dist/
coverage/
test-results/
e2e-results/
e2e-fail/
playwright-report/
measurements/
tmp-flood/
tmp-kill/
tools/measure/out/
apps/agent-worker/scripts/bench-out/
apps/agent-worker/test/eval/out/
apps/agent-worker/scripts/remediate-out/
.terraform/
*.tfstate
*.tfstate.*
*.tfvars
terraform.tfstate.d/
crash.log
outputs.json
db-secret.json
.svc-tf/
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*
*-sa-key.json
*service-account*.json
credentials*.json
kubeconfig*
*.kubeconfig
*.tgz
*.tar.gz
*.b64
*.zip
*.log
*.tsbuildinfo
.skeleton-import.zip
.merge-*.tgz
'
EXF=$(mktemp); trap 'rm -f "$EXF"' EXIT
printf '%s\n' "$EXCLUDES" | grep -v '^$' > "$EXF"
# .env.example 은 남긴다 (값 없는 견본)
rsync -a --include='.env.example' --exclude-from="$EXF" "$SRC"/ "$OUT"/ || { echo "FAIL rsync"; exit 2; }

BAD=0
echo "== 1. 금지 파일 이름"
LEFT=$(cd "$OUT" && find . \( -name '.env' -o -name '.env.*' ! -name '.env.example' -o -name '*.tfstate*' -o -name '*.tfvars' -o -name '*.pem' -o -name '*.key' -o -name 'kubeconfig*' -o -name 'db-secret.json' -o -name 'outputs.json' -o -name 'node_modules' -o -name '.claude' -o -name '.int-logs' -o -name '.git' -o -name '.svc-tf' -o -name '*.log' \) -print)
if [ -n "$LEFT" ]; then echo "$LEFT" | sed 's/^/  BAD /'; BAD=$((BAD + $(echo "$LEFT" | wc -l))); else echo "  0건"; fi

echo "== 2. 비밀값 모양 (가짜값 허용 목록 제외)"
# 허용 목록: 레포 시험 코드가 일부러 쓰는 가짜값 (Z106 SECRET-SCAN.md §2)
ALLOW='AKIAZ3EXAMPLEKEY0000|AKIAABCDEFGHIJKLMNOP|AKIAIOSFODNN7EXAMPLE|ghp_abcdefghijklmnopqrstuvwxyz0123|:(123456789012|111122223333|000000000000|999999999999|999988887777|725000000000):'
rule() {
  name=$1; re=$2
  grep -rnoE --binary-files=without-match --exclude=package-lock.json "$re" "$OUT" 2>/dev/null | grep -vE "$ALLOW" | while IFS= read -r l; do
    f=${l%%:*}; rest=${l#*:}; n=${rest%%:*}; m=${rest#*:}
    printf '  BAD %s %s:%s %s…(%s자)\n' "$name" "${f#$OUT/}" "$n" "$(printf '%s' "$m" | cut -c1-4)" "${#m}"
  done
}
HITS=$( {
  rule AWS_AKID '(AKIA|ASIA)[0-9A-Z]{16}'
  rule AWS_ARN_ACCT 'arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:'
  rule PRIVATE_KEY '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  rule GCP_API_KEY 'AIza[0-9A-Za-z_-]{35}'
  rule ANTHROPIC 'sk-ant-[A-Za-z0-9_-]{20,}'
  rule OPENAI 'sk-(proj-)?[A-Za-z0-9]{32,}'
  rule CF_TUNNEL_TOKEN 'eyJhIjoi[A-Za-z0-9_=-]{50,}'
  rule JWT 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  rule GH_TOKEN '(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,}'
  rule SLACK 'xox[abprs]-[A-Za-z0-9-]{10,}'
  rule EMAIL '[A-Za-z0-9._%+-]+@(gmail|naver|daum|kakao|hanmail|outlook|hotmail|yahoo|icloud)\.[a-z.]+'
} )
if [ -n "$HITS" ]; then echo "$HITS"; BAD=$((BAD + $(echo "$HITS" | wc -l))); else echo "  0건"; fi

echo "== 3. 크기"
FILES=$(find "$OUT" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$OUT" | cut -f1)
BIG=$(find "$OUT" -type f -size +50M)
[ -n "$BIG" ] && { echo "$BIG" | sed 's/^/  BAD 50MB 넘음 /'; BAD=$((BAD + 1)); }
echo "  출력 $OUT"
echo "  파일 $FILES 개, 용량 $SIZE"
if [ "$BAD" -eq 0 ]; then echo "EXPORT-UPLOAD PASS 0건"; exit 0; else echo "EXPORT-UPLOAD FAIL ${BAD}건 (이 폴더는 올리지 말 것)"; exit 1; fi

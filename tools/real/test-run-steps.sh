#!/usr/bin/env bash
# real-session.sh 의 run 앞 LB 등록(TRF-21 cf:check --register)과 DB 마이그레이션 pending 확인(ORC-26) 시험. 가짜 npm·npx·마이그레이터, 클라우드·DB 호출 0. 상태: AI 초안
#   bash tools/real/test-run-steps.sh [Service 폴더, 기본 이 레포]    끝 코드 0 = 전부 통과 (apps/api/test/real-run-steps.test.ts 가 부름)
HERE="$(cd "$(dirname "$0")" && pwd)"; SVC="${1:-$(cd "$HERE/../.." && pwd)}"; PASS=0; FAILN=0
MID=99999999-9999-4999-8999-999999999999; TID=11111111-1111-4111-8111-111111111111
run_case() { local name="$1" start="$2"; shift 2
  local W; W="$(mktemp -d "${TMPDIR:-/tmp}/run-steps.XXXXXX")"; mkdir -p "$W/bin" "$W/state" "$W/res/real-old"
  echo "CF_CHECK_SOURCE_ORIGIN='192.0.2.10'" > "$W/state/demo-day.env"; echo "$MID" > "$W/res/real-old/migration-id.txt"
  cat > "$W/bin/npm" <<NPM
#!/bin/sh
echo "npm \$*" >> "$W/calls"
case "\$*" in
  *"env:connect -- whoami"*) echo "회사  $TID" ;;
  *"cf:check"*) echo "cf-origin=\${CF_CHECK_SOURCE_ORIGIN:-없음}" >> "$W/calls"; [ "\${CF_FAIL:-0}" = 1 ] && { echo "FAIL zone" >&2; exit 1; }; echo "등록 끝" ;;
esac
exit 0
NPM
  printf '#!/bin/sh\necho "npx $*" >> "%s/calls"\necho "STATUS +1s approved"\nexit 0\n' "$W" > "$W/bin/npx"
  printf '#!/bin/sh\necho "migrate $*" >> "%s/calls"\nprintf "%%b" "$MIG_OUT"\nexit "${MIG_RC:-0}"\n' "$W" > "$W/bin/fake-migrate"
  chmod +x "$W/bin/npm" "$W/bin/npx" "$W/bin/fake-migrate"
  ( export PATH="$W/bin:$PATH" HOME="$W" DEMO_DAY_STATE="$W/state" RESULTS_DIR="$W/res" REAL_PLAN_ACKS=0 STOP_AFTER="$start" REAL_DB_MIGRATE=fake-migrate
    bash "$HERE/real-session.sh" "$SVC" "$start" ) > "$W/out" 2>&1; local rc=$?
  local ok=1 cond
  for cond in "$@"; do
    case "$cond" in
      rc=*) [ "$rc" = "${cond#rc=}" ] || { ok=0; echo "  ✗ $name: rc=$rc (기대 ${cond#rc=})"; } ;;
      calls~*) grep -qF -- "${cond#calls~}" "$W/calls" 2>/dev/null || { ok=0; echo "  ✗ $name: 호출 없음: ${cond#calls~}"; } ;;
      calls!*) ! grep -qF -- "${cond#calls!}" "$W/calls" 2>/dev/null || { ok=0; echo "  ✗ $name: 있으면 안 되는 호출: ${cond#calls!}"; } ;;
      order) a=$(grep -n 'cf:check' "$W/calls" | head -1 | cut -d: -f1); b=$(grep -n 'real-flow' "$W/calls" | head -1 | cut -d: -f1)
             [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || { ok=0; echo "  ✗ $name: cf:check 가 real-flow 보다 먼저가 아님"; } ;;
      out~*) grep -qF -- "${cond#out~}" "$W/out" || { ok=0; echo "  ✗ $name: 출력에 없음: ${cond#out~}"; } ;;
    esac
  done
  if [ $ok = 1 ]; then PASS=$((PASS+1)); echo "  ✓ $name"; else FAILN=$((FAILN+1)); sed 's/^/      | /' "$W/out" | tail -8; fi
  rm -rf "$W"; }
echo "RUNSTEPS 시험 ($(bash --version | head -1 | cut -c1-40))"
run_case "TRF-21 이전 번호·회사 번호로 cf:check 등록 → 그 뒤 real-flow" run rc=0 order \
  "calls~cf:check -- --register=$MID --tenant=$TID --apply --keep --probe=20 --probe-target=gcp-app-demo" "calls~cf-origin=192.0.2.10" "out~LB 등록(cf:check) PASS"
CF_FAIL=1 run_case "거부: cf:check 실패면 real-flow 안 감" run rc=1 "calls~cf:check" "calls!real-flow" "out~LB 등록(cf:check) FAIL"
REAL_CF_REGISTER=0 run_case "REAL_CF_REGISTER=0 → 등록 안 함" run rc=0 "calls!cf:check" "calls~real-flow"
MIG_OUT='applied  0001_init.sql\napplied  0040_traffic_lease.sql\n' run_case "ORC-26 pending 0 → 통과" import "calls~migrate --status" "out~DB 마이그레이션(import) PASS"
MIG_OUT='applied  0001_init.sql\npending  0041_lease_fix.sql\n' run_case "거부: pending 있으면 가져오기 전에 멈춤" import rc=1 "out~pending 1개 (첫 0041_lease_fix.sql)" "calls!api-flow"
echo "결과: 통과 $PASS / 실패 $FAILN"
[ "$FAILN" = 0 ]

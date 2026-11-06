#!/usr/bin/env bash
# 팀 환경 등록부(docs/team-env/registry.yaml)에서 칸 하나를 읽어 GCP 연결 명령을 값까지 채워 찍는다. 상태: AI 초안
#   bash tools/team-env.sh <slot-N>           명령만 찍는다 (아무것도 실행하지 않음). 줄마다 명령 하나, 자리 값(<…>) 없음
#   bash tools/team-env.sh <slot-N> --check   읽기 전용 gcloud(projects describe, services list)로 빠진 프로젝트·API 만 알려 준다
#   bash tools/team-env.sh <slot-N> source    출발 샘플(3티어 shop, 네임스페이스 real-app, orders 100행)을 칸의 환경마다 올리는 명령만 찍는다
#                                             gcp → tools/gcp-source.sh (원래 프로젝트), aws → tools/aws-source-app.sh (이미 있는 EKS·RDS 에 앱만)
#                                             aws 의 DB 는 등록부 db_instance(RDS 식별자)로만 찾는다. 없으면 DB·app·seed 줄 대신 채우라는 주석
# 환경 변수
#   TEAM_ENV_REGISTRY      등록부 파일 (기본 docs/team-env/registry.yaml)
#   PLATFORM_GCP_PROJECT   플랫폼 GCP 프로젝트 (기본 sb-iron-platform). 회사 전용 SA = t-<md5(회사 번호) 앞 28자>@<이 프로젝트>
#   PLATFORM_SA            회사 전용 SA 를 직접 줄 때 (연결 화면에 보이는 값과 같아야 한다)
# 끝 코드: 0 정상  1 --check 에서 빠진 것 있음  2 인자·등록부 잘못 (무엇이 틀렸는지 한 줄씩)
# 등록부 규칙(전용 프로젝트는 한 칸에만, 환경 이름은 회사 안에서 하나)을 어기면 명령을 찍지 않고 멈춘다.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REG="${TEAM_ENV_REGISTRY:-$ROOT/docs/team-env/registry.yaml}"
CONNECT="$ROOT/infra/onboarding/gcp-connect.sh"
die() { echo "team-env: $*" >&2; exit 2; }

SLOT="${1:-}"; MODE="${2:-print}"
case "$SLOT" in -h|--help|"") sed -n '2,13p' "$0"; [ -n "$SLOT" ]; exit $? ;; esac
[[ "$SLOT" =~ ^slot-[1-9][0-9]*$ ]] || die "칸 이름은 slot-<번호>: $SLOT"
case "$MODE" in print|--check|source) ;; *) die "모르는 옵션: $MODE (--check·source 만 있음)" ;; esac
[ -f "$REG" ] || die "등록부 없음: $REG"

# 등록부 → "경로=값" 줄 (예: slots.0.environments.1.gcp.dedicated_project=iron-target-gcp).
# 이 등록부가 쓰는 YAML 만 읽는다: 블록 맵, "- " 목록, 한 줄 흐름 맵·목록({ } [ ]), 따옴표 값, # 주석. 그 밖의 모양은 끝 코드 2
flatten() {
  awk -v SQ="'" '
  function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
  function bad(m) { if (!ERR) printf "team-env: 등록부 %d번째 줄: %s\n", NR, m > "/dev/stderr"; ERR = 1 }
  function emit(p, v) { print p "=" v }
  function nocomment(s,    i, c, q, out) {
    q = ""; out = ""
    for (i = 1; i <= length(s); i++) {
      c = substr(s, i, 1)
      if (q != "") { if (c == q) q = ""; out = out c; continue }
      if (c == "\"" || c == SQ) { q = c; out = out c; continue }
      if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[ \t]/)) break
      out = out c
    }
    if (q != "") bad("따옴표가 닫히지 않음")
    return out
  }
  function ws() { while (FP <= length(FL) && substr(FL, FP, 1) ~ /[ \t]/) FP++ }
  # 흐름 안 값 하나: 따옴표면 그 안, 아니면 , } ] 또는 ": " 앞까지
  function scalar(    c, q, out) {
    ws(); c = substr(FL, FP, 1); out = ""
    if (c == "\"" || c == SQ) {
      q = c; FP++
      while (FP <= length(FL) && substr(FL, FP, 1) != q) { out = out substr(FL, FP, 1); FP++ }
      if (FP > length(FL)) bad("따옴표가 닫히지 않음")
      FP++; return out
    }
    while (FP <= length(FL)) {
      c = substr(FL, FP, 1)
      if (c != "" && index(",}]", c) > 0) break
      if (c == ":" && (FP == length(FL) || substr(FL, FP + 1, 1) ~ /[ \t]/)) break
      out = out c; FP++
    }
    return trim(out)
  }
  function node(p,    c, k, i) {
    ws(); c = substr(FL, FP, 1)
    if (c == "{") {
      FP++
      for (;;) {
        ws(); if (substr(FL, FP, 1) == "}") { FP++; return }
        k = scalar(); ws()
        if (k == "" || substr(FL, FP, 1) != ":") { bad("흐름 맵 키 뒤에 : 없음"); FP = length(FL) + 1; return }
        FP++; node(p "." k); ws(); c = substr(FL, FP, 1)
        if (c == ",") { FP++; continue }
        if (c == "}") { FP++; return }
        bad("흐름 맵이 닫히지 않음"); FP = length(FL) + 1; return
      }
    }
    if (c == "[") {
      FP++; i = 0
      for (;;) {
        ws(); if (substr(FL, FP, 1) == "]") { FP++; return }
        node(p "." i); i++; ws(); c = substr(FL, FP, 1)
        if (c == ",") { FP++; continue }
        if (c == "]") { FP++; return }
        bad("흐름 목록이 닫히지 않음"); FP = length(FL) + 1; return
      }
    }
    emit(p, scalar())
  }
  # 블록 값 (줄 끝까지). 흐름이면 펼치고, 따옴표면 벗기고, 아니면 그대로
  function value(p, v,    c) {
    v = trim(v); c = substr(v, 1, 1)
    if (c == "{" || c == "[") { FL = v; FP = 1; node(p); ws(); if (FP <= length(FL)) bad("흐름 값 뒤에 남은 글자"); return }
    if ((c == "\"" || c == SQ) && length(v) >= 2 && substr(v, length(v), 1) == c) v = substr(v, 2, length(v) - 2)
    emit(p, v)
  }
  # "키: 값" 또는 "키:" (아래 줄에 자식). ind = 그 키의 칸 위치
  function entry(parent, s, ind,    k, v, p) {
    if (!match(s, /^[A-Za-z0-9_.-]+:([ \t]|$)/)) { bad("키: 값 모양이 아님"); return }
    k = s; sub(/:.*/, "", k); v = substr(s, length(k) + 2)
    p = (parent == "" ? k : parent "." k)
    if (trim(v) == "") { N++; SI[N] = ind; SP[N] = p; SK[N] = "key"; SC[N] = 0 }
    else value(p, v)
  }
  {
    line = nocomment($0); sub(/[ \t]+$/, "", line)
    if (line ~ /^[ \t]*$/) next
    if (line ~ /^\t/ || line ~ /^ *\t/) { bad("들여쓰기에 탭"); next }
    match(line, /^ */); ind = RLENGTH; s = substr(line, ind + 1)
    if (s ~ /^- / || s == "-") {
      while (N > 0 && (SI[N] > ind || (SI[N] == ind && SK[N] == "item"))) N--
      if (N == 0 || SK[N] != "key") { bad("목록 항목의 부모 키가 없음"); next }
      p = SP[N] "." SC[N]; SC[N]++
      rest = trim(substr(s, 2))
      N++; SI[N] = ind; SP[N] = p; SK[N] = "item"; SC[N] = 0
      if (rest == "") next
      if (rest ~ /^[{\[]/ || rest !~ /^[A-Za-z0-9_.-]+:([ \t]|$)/) { value(p, rest); next }
      entry(p, rest, ind + 2)
      next
    }
    while (N > 0 && SI[N] >= ind) N--
    entry((N > 0 ? SP[N] : ""), s, ind)
  }
  END { exit ERR ? 2 : 0 }
  ' "$1"
}

FLAT="$(flatten "$REG")" || die "등록부를 읽지 못함: $REG"
get() { printf '%s\n' "$FLAT" | awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }'; }
has() { printf '%s\n' "$FLAT" | awk -v k="$1" 'index($0, k "=") == 1 { f = 1 } END { exit !f }'; }

[ "$(get version)" = 1 ] || die "등록부 version 이 1 이 아님"
TENANT="$(get tenant)"
[[ "$TENANT" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "등록부 tenant 가 회사 번호(UUID) 모양이 아님: $TENANT"

# 칸 번호 찾기
SI_=""
for i in $(printf '%s\n' "$FLAT" | sed -n 's/^slots\.\([0-9][0-9]*\)\.id=.*/\1/p'); do
  [ "$(get "slots.$i.id")" = "$SLOT" ] && { [ -z "$SI_" ] || die "칸 $SLOT 이 두 번 있음"; SI_="$i"; }
done
[ -n "$SI_" ] || die "등록부에 $SLOT 칸이 없음"
# 칸마다 회사를 나눈 명부: 칸의 tenant 가 있으면 그 회사 (회사 전용 SA 도 그 회사 것)
ST_="$(get "slots.$SI_.tenant")"
if [ -n "$ST_" ]; then
  [[ "$ST_" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "$SLOT 칸 tenant 가 회사 번호(UUID) 모양이 아님: $ST_"
  TENANT="$ST_"
fi

# 회사 전용 SA: 연결 화면이 보여 주는 값과 같은 규칙 (apps/api 의 tenant SA 이름 = t-<md5(회사 번호) 앞 28자>)
md5hex() { if command -v md5sum >/dev/null 2>&1; then printf %s "$1" | md5sum | awk '{print $1}'; else printf %s "$1" | md5 | awk '{print $NF}'; fi; }
if [ -z "${PLATFORM_SA:-}" ]; then
  h="$(md5hex "$TENANT")"; [ ${#h} -eq 32 ] || die "md5 를 계산하지 못함 (md5sum 또는 md5 필요)"
  PLATFORM_SA="t-${h:0:28}@${PLATFORM_GCP_PROJECT:-sb-iron-platform}.iam.gserviceaccount.com"
fi
[[ "$PLATFORM_SA" =~ ^t-[0-9a-f]{28}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] || die "PLATFORM_SA 모양이 아님: $PLATFORM_SA"

# 규칙 검사 (등록부 전체): 환경 이름은 회사 안에서 하나, 전용 프로젝트는 다른 어떤 환경의 원래·전용 프로젝트와도 겹치지 않음
dup="$(printf '%s\n' "$FLAT" | sed -n 's/^slots\.[0-9][0-9]*\.environments\.[0-9][0-9]*\.name=//p' | sort | uniq -d | head -1)"
[ -z "$dup" ] || die "환경 이름 $dup 이 두 칸 이상에 있음 (공유 환경은 한 칸에만 적고 notes 에 공유라고 쓴다)"
PROJ_RE='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
# 칸의 환경 번호 (등록부 순서). 빈 목록도 bash 3.2 + set -u 에서 안 깨지게 배열 대신 빈칸으로 나눈 글자
GCP_ENVS=""; AWS_ENVS=""; SRC_ENVS=""
# db_instance (AWS 출발 샘플의 RDS 식별자): aws 환경에만, RDS 식별자 모양 (packages/contracts TeamEnvironment 와 같은 규칙)
RDS_ID_RE='^[a-z](-?[a-z0-9])*$'
for j in $(printf '%s\n' "$FLAT" | sed -n "s/^slots\.$SI_\.environments\.\([0-9][0-9]*\)\.name=.*/\1/p"); do
  e="slots.$SI_.environments.$j"
  if has "$e.db_instance"; then
    di="$(get "$e.db_instance")"
    [ "$(get "$e.provider")" = aws ] || die "$SLOT/$(get "$e.name"): db_instance 는 provider: aws 환경에만 쓴다"
    [[ "$di" =~ $RDS_ID_RE ]] && [ ${#di} -le 63 ] || die "$SLOT/$(get "$e.name"): db_instance 가 RDS 식별자 모양이 아님 (소문자·숫자·-, 63자까지): $di"
  fi
  case "$(get "$e.provider")" in
    gcp) GCP_ENVS="$GCP_ENVS $j"; SRC_ENVS="$SRC_ENVS $j" ;;
    aws) AWS_ENVS="$AWS_ENVS $j"; SRC_ENVS="$SRC_ENVS $j" ;;
  esac
done
if [ "$MODE" = source ]; then
  [ -n "$SRC_ENVS" ] || die "$SLOT 에 provider: aws·gcp 환경이 없음 (등록부 environments 에 출발 환경을 적는다: docs/team-env/README.md)"
else
  [ -n "$GCP_ENVS" ] || die "$SLOT 에 provider: gcp 환경이 없음 (등록부 environments 에 gcp 환경과 두 프로젝트를 적는다. AWS 는 콘솔의 \"AWS 연결\" 링크로 연결: docs/team-env/README.md)"
fi
for j in $GCP_ENVS; do
  e="slots.$SI_.environments.$j"; n="$(get "$e.name")"
  o="$(get "$e.gcp.original_project")"; d="$(get "$e.gcp.dedicated_project")"
  [ -n "$o" ] && [ -n "$d" ] || die "$SLOT/$n: gcp.original_project·gcp.dedicated_project 를 둘 다 채운다"
  [[ "$o" =~ $PROJ_RE ]] || die "$SLOT/$n: original_project 가 GCP 프로젝트 ID 모양이 아님: $o"
  [[ "$d" =~ $PROJ_RE ]] || die "$SLOT/$n: dedicated_project 가 GCP 프로젝트 ID 모양이 아님: $d"
  [ "$o" != "$d" ] || die "$SLOT/$n: 원래 프로젝트와 전용 프로젝트가 같음 ($d)"
  uses="$(printf '%s\n' "$FLAT" | grep -E "^slots\.[0-9]+\.environments\.[0-9]+\.gcp\.(original|dedicated)_project=${d}\$" | grep -vc "^$e\.gcp\.dedicated_project=")"
  [ "$uses" -eq 0 ] || die "$SLOT/$n: 전용 프로젝트 $d 를 다른 환경도 쓴다 (규칙 3: 전용 프로젝트는 한 칸에만)"
done

# 고객 쪽 명령 (값이 모두 검사를 통과한 뒤에만 찍는다)
print_cmds() {
  local n="$1" o="$2" d="$3"
  echo "# === $SLOT / $n: 원래 $o → 전용 $d (Cloud Shell 또는 두 프로젝트 소유자로 gcloud 로그인한 맥, 레포 루트에서) ==="
  echo "# 1) 연결: SA·커스텀 역할·빌리기 허용·API 켜기 (다시 실행해도 됨, 있는 것은 건너뜀)"
  echo "PLATFORM_SA=$PLATFORM_SA PROJECT_ID=$o TARGET_PROJECT_ID=$d bash infra/onboarding/gcp-connect.sh"
  echo "# 2) Cloud Billing API (#313, 예전 스크립트로 연결한 프로젝트용. 켜져 있으면 바뀌는 것 없음)"
  echo "gcloud services enable cloudbilling.googleapis.com --project=$o"
  echo "gcloud services enable cloudbilling.googleapis.com --project=$d"
  echo "# 3) 이미 있던 역할 맞추기 (#316 실측 403 권한·허브 RoleBinding·이미지 복사. gcp-connect.sh 는 있는 platform_env·platform_operate 를 건너뜀. 없는 권한만 더함)"
  echo "gcloud iam roles update platform_env --project=$d --add-permissions=compute.addresses.setLabels,compute.globalAddresses.setLabels,compute.instanceGroupManagers.get,serviceusage.operations.get"
  echo "gcloud iam roles update platform_operate --project=$d --add-permissions=compute.instanceGroupManagers.get,resourcemanager.projects.get,secretmanager.versions.enable,serviceusage.operations.get"
  echo "gcloud iam roles update platform_plan --project=$d --add-permissions=compute.instanceGroupManagers.get,serviceusage.operations.get"
  echo "gcloud iam roles update platform_operate --project=$d --add-permissions=container.roleBindings.create,container.roleBindings.delete,container.roleBindings.get,container.roleBindings.update,container.roles.bind,container.roles.create,container.roles.delete,container.roles.escalate,container.roles.get,container.roles.update"
  echo "gcloud iam roles update platform_operate --project=$d --add-permissions=artifactregistry.repositories.downloadArtifacts,artifactregistry.repositories.uploadArtifacts"
  echo "# 4) 첫 앱 층 apply 가 TF_APPLY_FAILED(iam.serviceAccounts.setIamPolicy 403)로 멈춘 뒤: app- SA 마다 실행 SA 에 SA IAM 권한 (#317 14번, 조건식 버그 우회). 그 뒤 다시 시도"
  echo "for sa in \$(gcloud iam service-accounts list --project=$d --filter='email~^app-' --format='value(email)'); do gcloud iam service-accounts add-iam-policy-binding \"\$sa\" --project=$d --member=serviceAccount:svc-operate@$d.iam.gserviceaccount.com --role=projects/$d/roles/platform_operate_iam; done"
}

# --check: 읽기 전용 두 가지만 부른다 (projects describe, services list --enabled). 쓰기 0
need_apis_target() {
  local l; l="$(sed -n 's/^TARGET_APIS="\(.*\)"$/\1/p' "$CONNECT" | head -1)"
  [ -n "$l" ] || die "gcp-connect.sh 에서 TARGET_APIS 줄을 못 찾음 ($CONNECT)"
  echo "$l"
}
check_project() { # 프로젝트, 켜져 있어야 할 API(짧은 이름)…
  local p="$1"; shift; local on a miss=0
  if ! gcloud projects describe "$p" --format='value(projectId)' >/dev/null 2>&1; then
    echo "MISSING project $p (없거나 볼 권한 없음 — 만들고 결제 계정을 붙인다)"; return 1
  fi
  echo "OK project $p"
  if ! on="$(gcloud services list --enabled --project="$p" --format='value(config.name)' 2>/dev/null)"; then
    echo "MISSING services $p (API 목록을 못 읽음 — serviceusage 권한 또는 API 꺼짐)"; return 1
  fi
  for a in "$@"; do
    if printf '%s\n' "$on" | grep -qx "$a.googleapis.com"; then :; else echo "MISSING api $p $a.googleapis.com"; miss=1; fi
  done
  [ "$miss" = 0 ] && echo "OK apis $p ($# 개)"
  return "$miss"
}

# source: 출발 샘플(3티어 shop: shop-web·shop-api·Postgres orders 100행, 네임스페이스 real-app)을 올리는 명령. 실행은 안 함
#   gcp 는 원래 프로젝트에 tools/gcp-source.sh (VPC·GKE·Cloud SQL 까지 만든다), aws 는 이미 있는 EKS·RDS 에 tools/aws-source-app.sh (앱만)
shared() { case "$(get "$1.notes")" in *공유*) return 0 ;; esac; return 1; }
# 기본 이미지는 태그라 app·seed 가 docker buildx 로 digest 에 고정한다. repo@sha256 로 주면 두 스크립트 모두 Docker 없이 그대로 쓴다
img_note() { # 덧붙일 말
  echo "#    app·seed 의 기본 이미지는 태그라 docker buildx 로 digest 에 고정한다$1. Docker 가 없으면 WEB_IMAGE·API_IMAGE·SEED_IMAGE 를 repo@sha256:<digest> 로 export 하면 Docker 없이 그대로 쓴다"
}
source_gcp() { # 환경 경로
  local e="$1" n o d r v
  n="$(get "$e.name")"; o="$(get "$e.gcp.original_project")"; d="$(get "$e.gcp.dedicated_project")"; r="$(get "$e.region")"
  v="GCP_PROJECT=$o TF_STATE_BUCKET=$o-tfstate REGION=$r"
  echo "# === $SLOT / $n: GCP 출발 샘플 → 원래 프로젝트 $o ($r). GKE platform-target·Cloud SQL sample-shop-db, 네임스페이스 real-app, orders 100행 ==="
  echo "# 원래 프로젝트에만 올린다 (전용 $d 에 올리면 도착 환경 층과 이름이 부딪힌다). 약 \$0.30/시간. 원래 프로젝트 소유자로 gcloud 로그인 (Cloud Shell), 레포 루트에서"
  [ "$r" = asia-northeast3 ] || echo "# 샘플 모듈(infra/samples/gcp-source)은 asia-northeast3 고정이다. REGION 은 state 버킷 위치만 바꾼다"
  if shared "$e"; then echo "# 공유 환경: 팀 채널에 알리고 쓴다. 이미 올라가 있으면 up·app·seed 는 건너뛰고, down 은 치지 않는다 (남도 쓴다)"; fi
  echo "# 0) 이미 있는지 (읽기만. platform-target 이 보이면 up 은 끝난 것)"
  echo "gcloud container clusters list --project=$o --format='value(name)'"
  echo "# 1) VPC·GKE·Cloud SQL (25~35분) → shop-web·shop-api → orders 100행. 줄 끝에 --dry-run 을 붙이면 명령 순서만 찍는다"
  img_note " (Cloud Shell 에는 있음)"
  echo "$v bash tools/gcp-source.sh up"
  echo "$v bash tools/gcp-source.sh app"
  echo "$v bash tools/gcp-source.sh seed"
  echo "# 다 쓴 뒤 (GKE·Cloud SQL 을 지운다. state 버킷은 남김): $v bash tools/gcp-source.sh down"
}
source_aws() { # 환경 경로
  local e="$1" n c r di
  n="$(get "$e.name")"; c="$(get "$e.cluster")"; r="$(get "$e.region")"; di="$(get "$e.db_instance")"
  echo "# === $SLOT / $n: AWS 출발 샘플 → EKS $c ($r), 네임스페이스 real-app (shop-web·shop-api), RDS ${di:-(등록부 db_instance 없음)} 의 DB shop 에 orders 100행 ==="
  echo "# 먼저 있어야 하는 것 (이 도구는 만들지 않는다): EKS 클러스터 $c, 같은 VPC 의 RDS PostgreSQL(초기 DB 이름 shop). RDS 보안 그룹은 EKS 클러스터 보안 그룹에서 5432 를 받는다"
  echo "#   만드는 법: 콘솔(EKS → 클러스터 생성 / RDS → 데이터베이스 생성 → PostgreSQL, 초기 데이터베이스 이름 shop, 마스터 비밀번호 \"Secrets Manager 에서 관리\") 또는 aws CLI(aws eks create-cluster …, aws rds create-db-instance --engine postgres --db-name shop --manage-master-user-password …)"
  if shared "$e"; then echo "# 공유 환경: 팀 채널에 알리고 쓴다. 이미 올라가 있으면 app·seed 는 건너뛰고, down 은 치지 않는다 (남도 쓴다)"; fi
  echo "# 1) kubeconfig (자기 AWS 계정으로 aws 로그인한 맥, 레포 루트에서). 컨텍스트 이름 = 환경 이름"
  echo "aws eks update-kubeconfig --name $c --region $r --alias $n"
  echo "# 2) 이미 있는지 (읽기만. shop-web·shop-api 가 보이면 4) 는 건너뛴다)"
  echo "kubectl --context $n -n real-app get deployment shop-web shop-api"
  if [ -z "$di" ]; then
    # 리전의 "첫 PostgreSQL" 을 고르지 않는다: 같은 AWS 계정에 플랫폼 자기 DB(platform-db)가 있어 시드가 거기로 갈 수 있다
    echo "# 3) DB: 등록부의 $n 에 db_instance(RDS 식별자)가 없어 DB·app·seed 줄을 찍지 않는다 (리전의 아무 PostgreSQL 이나 고르지 않는다. 같은 계정에 플랫폼 DB platform-db 가 있다)"
    echo "#    docs/team-env/registry.yaml 의 $n 줄에 db_instance: <자기 샘플 RDS 식별자> 를 더하고 다시: bash tools/team-env.sh $SLOT source"
    return 0
  fi
  echo "# 3) DB = 등록부 db_instance $di (이 이름으로만 찾는다). 마스터 비밀은 seed 만 쓴다 (앱 계정 shop_app 을 만들 때, 임시 Secret 은 seed 뒤 지움)"
  echo "#    마스터 비밀번호를 직접 정한 RDS 면 DB_PASSWORD_SECRET_ID 대신 DB_PASSWORD_FILE=<한 줄 파일(600)>"
  echo "export KUBE_CONTEXT=$n NS=real-app AWS_REGION=$r DB_INSTANCE=$di DB_NAME=shop"
  echo "export DB_HOST=\"\$(aws rds describe-db-instances --region $r --db-instance-identifier $di --query 'DBInstances[0].Endpoint.Address' --output text)\""
  echo "export DB_PASSWORD_SECRET_ID=\"\$(aws rds describe-db-instances --region $r --db-instance-identifier $di --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)\""
  echo "# 4) app: shop-web·shop-api (앱 계정 shop_app, 비밀번호 = Secret shop-db-app 랜덤) → seed: 마스터로 붙어 shop_app 을 맞추고 orders 100행. 줄 끝에 --dry-run 을 붙이면 명령 순서만 찍는다"
  img_note ""
  echo "bash tools/aws-source-app.sh app"
  echo "bash tools/aws-source-app.sh seed"
  echo "# 다 쓴 뒤 (네임스페이스만 지운다. EKS·RDS·orders 표·shop_app 은 그대로): bash tools/aws-source-app.sh down"
}
if [ "$MODE" = source ]; then
  # 값 검사를 다 통과한 뒤에만 찍는다 (찍힌 줄이 그대로 명령이 되므로 셸에 안전한 모양만)
  NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'; EKS_RE='^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'
  AWS_REGION_RE='^[a-z]{2}(-[a-z]+)+-[0-9]+$'; GCP_REGION_RE='^[a-z]+-[a-z]+[0-9]+$'
  for j in $AWS_ENVS; do
    e="slots.$SI_.environments.$j"; n="$(get "$e.name")"; c="$(get "$e.cluster")"; r="$(get "$e.region")"
    [[ "$n" =~ $NAME_RE ]] || die "$SLOT/$n: 환경 이름을 kubectl 컨텍스트 이름으로 못 씀 (영문·숫자·. _ - 만)"
    [ -n "$c" ] || die "$SLOT/$n: aws 환경에 cluster(EKS 이름)를 채운다"
    [[ "$c" =~ $EKS_RE ]] || die "$SLOT/$n: cluster 가 EKS 이름 모양이 아님: $c"
    [[ "$r" =~ $AWS_REGION_RE ]] || die "$SLOT/$n: region 이 AWS 리전 모양이 아님: $r"
    case "$(get "$e.db_instance")" in
      *platform-db*) die "$SLOT/$n: db_instance 에 platform-db 가 들어 있음 (플랫폼 자기 DB 라 출발 샘플로 쓰지 않는다. 자기 샘플 RDS 식별자를 적는다)" ;;
    esac
  done
  for j in $GCP_ENVS; do
    e="slots.$SI_.environments.$j"; n="$(get "$e.name")"; r="$(get "$e.region")"
    [[ "$r" =~ $GCP_REGION_RE ]] || die "$SLOT/$n: region 이 GCP 리전 모양이 아님: $r"
  done
  echo "# 출발 샘플 (3티어 shop: shop-web·shop-api·Postgres orders 100행, 네임스페이스 real-app). 줄마다 명령 하나, 위에서부터 차례로"
  for j in $SRC_ENVS; do
    e="slots.$SI_.environments.$j"
    case "$(get "$e.provider")" in gcp) source_gcp "$e" ;; aws) source_aws "$e" ;; esac
  done
  exit 0
fi

rc=0
for j in $GCP_ENVS; do
  e="slots.$SI_.environments.$j"; n="$(get "$e.name")"
  o="$(get "$e.gcp.original_project")"; d="$(get "$e.gcp.dedicated_project")"
  if [ "$MODE" = print ]; then print_cmds "$n" "$o" "$d"; continue; fi
  command -v gcloud >/dev/null 2>&1 || die "gcloud 가 없음"
  echo "# $SLOT / $n"
  # 원래 프로젝트에 켜야 하는 API 는 gcp-connect.sh 의 ensure_api 줄(iamcredentials·cloudresourcemanager·cloudbilling)과 같다
  check_project "$o" iamcredentials cloudresourcemanager cloudbilling || rc=1
  # shellcheck disable=SC2046
  check_project "$d" $(need_apis_target) || rc=1
done
if [ "$MODE" = --check ]; then
  [ "$rc" = 0 ] && echo "다 있음" || echo "빠진 것이 있음 → bash tools/team-env.sh $SLOT 의 1)·2) 명령을 실행한 뒤 다시 --check"
fi
exit "$rc"

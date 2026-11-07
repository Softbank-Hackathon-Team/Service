#!/usr/bin/env bash
# GCP 출발 샘플(src-gcp-sample) 올리기·채우기·내리기 (상태 DRAFT(ai)). infra/samples/gcp-source 를 부르기만 한다.
# 비용이 드는 도구다. 사람이 Cloud Shell 에서 진짜로 돌린다. 다른 곳에서는 --dry-run 으로 명령 순서만 본다.
#   bash tools/gcp-source.sh up   [--dry-run]   API 켜기 → state 버킷 → terraform apply(VPC·GKE·Cloud SQL) → kubeconfig 연결
#   bash tools/gcp-source.sh app  [--dry-run]   tools/real/flow/sample-3tier-eks.yaml.tpl 를 real-app 에 적용 (이미지 digest 고정)
#   bash tools/gcp-source.sh seed [--dry-run]   GKE 안 일회용 Job 으로 orders 표 + 100행 (다시 돌려도 100행 그대로)
#   bash tools/gcp-source.sh entry [--dry-run]  출발 앱을 Cloudflare 존 호스트 뒤에 둔다: 원격 관리 터널 + DNS CNAME + GKE 안 cloudflared + 명세용 Ingress
#     (이전마다 트래픽 입구 자동 생성 TRAFFIC_AUTO_LB 의 전제). ENTRY_HOST·CLOUDFLARE_ACCOUNT_ID·CLOUDFLARE_ZONE_ID·CLOUDFLARE_API_TOKEN 필요
#   bash tools/gcp-source.sh down [--dry-run]   real-app 삭제 → terraform destroy → GKE·Cloud SQL 0 확인 (state 버킷은 남김)
# 환경 변수: GCP_PROJECT(iron-source-gcp) REGION(asia-northeast3) TF_STATE_BUCKET(<프로젝트>-tfstate) NS(real-app)
#   WEB_IMAGE·API_IMAGE·SEED_IMAGE(태그면 digest 로 바꿈, @sha256 로 주면 그대로) GCP_SOURCE_STATE(~/.svc-tf/gcp-source: 로그·.terraform)
# 비밀값·계정 정보를 찍지 않는다. 명령 출력은 로그 파일에만, 화면에는 단계와 끝 코드만.
set -u
cd "$(dirname "$0")/.." || exit 1
CMD=${1:-}; shift || true
DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) echo "모르는 옵션: $a" >&2; exit 2 ;; esac; done
case "$CMD" in up|app|seed|entry|down) ;; -h|--help|"") sed -n '2,13p' "$0"; [ -n "$CMD" ]; exit $? ;; *) echo "up·app·seed·entry·down 중 하나" >&2; exit 2 ;; esac

GCP_PROJECT=${GCP_PROJECT:-iron-source-gcp}
REGION=${REGION:-asia-northeast3}
ZONE=${ZONE:-asia-northeast3-a}   # infra/samples/gcp-source/main.tf 의 zone 과 같아야 한다
CLUSTER=platform-target           # 같은 파일의 module.env name
DB_INSTANCE=sample-shop-db        # 같은 파일의 cfg.name
TF_STATE_BUCKET=${TF_STATE_BUCKET:-${GCP_PROJECT}-tfstate}
TF_PREFIX=sample/gcp-source
NS=${NS:-real-app}
WEB_IMAGE=${WEB_IMAGE:-docker.io/library/nginx:1.27-alpine}   # real-session.sh 기본값과 같음
API_IMAGE=${API_IMAGE:-docker.io/hashicorp/http-echo:1.0}
SEED_IMAGE=${SEED_IMAGE:-docker.io/library/postgres:16-alpine}
# DRAFT(ai): 플랫폼 차트(deploy/helm/platform values cloudflared.image)와 같은 판
CLOUDFLARED_IMAGE=${CLOUDFLARED_IMAGE:-docker.io/cloudflare/cloudflared:2026.10.7}
CF_API=${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}
STATE=${GCP_SOURCE_STATE:-$HOME/.svc-tf/gcp-source}
MOD=infra/samples/gcp-source
TPL=tools/real/flow/sample-3tier-eks.yaml.tpl
KCTX="gke_${GCP_PROJECT}_${ZONE}_${CLUSTER}"   # get-credentials 가 만드는 컨텍스트 이름
LOGF=$STATE/$CMD-$(date -u +%Y%m%dT%H%M%SZ).log
say() { echo "$(date -u +%H:%M:%SZ) gcp-source $*"; }
# run: dry-run 이면 명령만 찍고, 아니면 로그 파일에 출력을 남기며 실행 (인자 그대로, 셸 합치기 없음)
run() {
  if [ "$DRY" = 1 ]; then say "DRY: $*"; return 0; fi
  "$@" >> "$LOGF" 2>&1; local rc=$?; [ $rc -eq 0 ] || say "실패 rc=$rc: $* (로그 $LOGF)"; return $rc
}
tf() { run terraform -chdir="$MOD" "$@"; }
K() { kubectl --context "$KCTX" "$@"; }
export TF_DATA_DIR="$STATE/tfdata" TF_IN_AUTOMATION=1   # .terraform 은 레포 밖. state 는 GCS (backend.tf)
[ "$DRY" = 1 ] || { mkdir -p "$STATE" && chmod 700 "$STATE" || exit 1; }
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/gcp-source.XXXXXX")" || exit 1; chmod 700 "$TMPD"
trap 'rm -rf "$TMPD"' EXIT

tf_init() { tf init -input=false -reconfigure -backend-config="bucket=$TF_STATE_BUCKET" -backend-config="prefix=$TF_PREFIX"; }
# tfo: terraform 출력 하나 (비밀 아닌 값만 부른다). dry-run 이면 자리 값
tfo() {
  [ "$DRY" = 1 ] && { echo "<dry-$1>"; return 0; }
  terraform -chdir="$MOD" output -raw "$1" 2>> "$LOGF"
}
# 이미지 태그 → repo@sha256:… (real-session.sh 의 dig_of 와 같은 방식)
digest_ref() {
  case "$1" in *@sha256:*) echo "$1"; return 0 ;; esac
  [ "$DRY" = 1 ] && { echo "${1%:*}@sha256:<dry-digest>"; return 0; }
  local d
  d=$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest 2>/dev/null)
  case "$d" in sha256:*) echo "${1%:*}@$d" ;; *) return 1 ;; esac
}
# 클러스터 연결 확인: 이 스크립트가 만든 이름의 컨텍스트에만 쓴다
need_ctx() {
  [ "$DRY" = 1 ] && { say "DRY: kubectl 컨텍스트 $KCTX 확인"; return 0; }
  kubectl config get-contexts -o name 2>/dev/null | grep -qx "$KCTX" && return 0
  say "kubectl 컨텍스트 $KCTX 없음 → get-credentials 로 연결"
  run gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$GCP_PROJECT" || { say "클러스터 연결 실패 (up 이 끝났는지)"; return 1; }
}
# k8s Secret 을 파일에서 만들거나 갈아 끼운다 (값은 파이프로만, 화면·로그에 안 남음)
put_secret() { # 이름 키 파일
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS create secret generic $1 --from-file=$2=<임시 파일> | kubectl apply -f -"; return 0; fi
  K -n "$NS" create secret generic "$1" --from-file="$2=$3" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 \
    || { say "Secret $1 만들기 실패 (로그 $LOGF)"; return 1; }
}
zero_check() { # GKE 클러스터·Cloud SQL 인스턴스가 0 인지 (조회만)
  [ "$DRY" = 1 ] && { say "DRY: gcloud container clusters list · gcloud sql instances list 가 0"; return 0; }
  local g s
  g=$(gcloud container clusters list --project "$GCP_PROJECT" --format='value(name)' 2>>"$LOGF" | grep -c .)
  s=$(gcloud sql instances list --project "$GCP_PROJECT" --format='value(name)' 2>>"$LOGF" | grep -c .)
  say "남은 것: GKE $g, Cloud SQL $s"; [ "$g" -eq 0 ] && [ "$s" -eq 0 ]
}

# Cloud Shell 의 terraform 은 "설치하세요" 안내만 찍고 0 으로 끝나는 가짜다 (2026-11-07 실측: apply 가 2초 만에 "성공" → get-credentials 404).
#   진짜인지 버전 줄로 본다. dry-run 은 부르지 않으니 안 본다 (entry 는 terraform 을 안 쓴다)
if [ "$DRY" != 1 ] && [ "$CMD" != entry ]; then
  terraform version 2>/dev/null | head -1 | grep -q '^Terraform v' || {
    say "terraform 이 없다 (Cloud Shell 기본은 안내만 찍는 가짜). 홈에 설치: curl -sLo tf.zip https://releases.hashicorp.com/terraform/1.16.4/terraform_1.16.4_linux_amd64.zip && unzip -o tf.zip terraform -d ~/bin && export PATH=~/bin:\$PATH"
    exit 1; }
fi

case "$CMD" in
up)
  say "up 시작 dry=$DRY project=$GCP_PROJECT region=$REGION"
  run gcloud services enable compute.googleapis.com container.googleapis.com sqladmin.googleapis.com \
    servicenetworking.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
    cloudresourcemanager.googleapis.com iam.googleapis.com --project "$GCP_PROJECT" || exit 1
  if [ "$DRY" != 1 ] && gcloud storage buckets describe "gs://$TF_STATE_BUCKET" --project "$GCP_PROJECT" >> "$LOGF" 2>&1; then
    say "state 버킷 있음 → 그대로 씀"
  else
    [ "$DRY" = 1 ] && say "DRY: (state 버킷이 없으면) 만든다"
    run gcloud storage buckets create "gs://$TF_STATE_BUCKET" --project "$GCP_PROJECT" --location "$REGION" \
      --uniform-bucket-level-access --public-access-prevention || exit 1
    run gcloud storage buckets update "gs://$TF_STATE_BUCKET" --project "$GCP_PROJECT" --versioning || exit 1
  fi
  tf_init || exit 1
  say "terraform apply (GKE·Cloud SQL 이 차례로 생겨 25~35분)"
  tf apply -input=false -auto-approve -var "project_id=$GCP_PROJECT" || exit 1
  run gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --project "$GCP_PROJECT" || exit 1
  say "up 끝 (다음: app → seed)"
  ;;
app)
  say "app 시작 dry=$DRY ns=$NS"
  need_ctx || exit 1
  DB_HOST=$(tfo db_private_ip) && [ -n "$DB_HOST" ] || { say "db_private_ip 출력 없음 (up 이 끝났는지, init 은 up 이 함)"; exit 1; }
  WEB_REF=$(digest_ref "$WEB_IMAGE") && API_REF=$(digest_ref "$API_IMAGE") \
    || { say "이미지 digest 를 못 구함: WEB_IMAGE·API_IMAGE 에 repo@sha256:… 로 주면 됨"; exit 1; }
  # 템플릿은 그대로 쓴다. EKS 전용 값이 없어서 자리표시 네 개만 채운다 (RDS 주소 자리 = Cloud SQL 사설 IP)
  sed -e "s#__NS__#${NS}#g" -e "s#__WEB_IMAGE__#${WEB_REF}#g" -e "s#__API_IMAGE__#${API_REF}#g" -e "s#__DB_HOST__#${DB_HOST}#g" "$TPL" > "$TMPD/sample.yaml" || exit 1
  if grep -q '__[A-Z_]*__' "$TMPD/sample.yaml"; then say "템플릿에 못 채운 자리표시가 남음: $(grep -o '__[A-Z_]*__' "$TMPD/sample.yaml" | sort -u | tr '\n' ' ')"; exit 1; fi
  say "매니페스트 렌더 OK ($(grep -c '^kind:' "$TMPD/sample.yaml")개 객체)"
  if [ "$DRY" = 1 ]; then say "DRY: kubectl create namespace $NS --dry-run=client -o yaml | kubectl apply -f -"
  else K create namespace "$NS" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 || { say "네임스페이스 실패"; exit 1; }; fi
  # 시험용 Secret 은 실행 때 랜덤 (real-session.sh 와 같음. shop-db-app 은 진짜 DB 비밀번호가 아님)
  if [ "$DRY" != 1 ]; then ( umask 077; openssl rand -hex 24 | tr -d '\n' > "$TMPD/s1"; openssl rand -hex 24 | tr -d '\n' > "$TMPD/s2" ) || exit 1; fi
  put_secret api-secrets API_TOKEN "$TMPD/s1" || exit 1
  put_secret shop-db-app password "$TMPD/s2" || exit 1
  run kubectl --context "$KCTX" apply -f "$TMPD/sample.yaml" || exit 1
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS wait --for=condition=Available deployment --all --timeout=300s"
  elif K -n "$NS" wait --for=condition=Available deployment --all --timeout=300s >> "$LOGF" 2>&1; then say "Deployment Available"
  else say "300초 안에 Available 아님 (kubectl -n $NS get pods 로 확인)"; exit 1; fi
  say "app 끝"
  ;;
seed)
  say "seed 시작 dry=$DRY ns=$NS"
  need_ctx || exit 1
  DB_HOST=$(tfo db_private_ip) && DB_NAME=$(tfo db_name) && DB_USER=$(tfo db_user) && PW_SECRET=$(tfo db_password_secret) \
    && [ -n "$DB_HOST" ] && [ -n "$PW_SECRET" ] || { say "terraform 출력 없음 (up 이 끝났는지)"; exit 1; }
  SEED_REF=$(digest_ref "$SEED_IMAGE") || { say "seed 이미지 digest 를 못 구함: SEED_IMAGE 에 repo@sha256:… 로 주면 됨"; exit 1; }
  if [ "$DRY" = 1 ]; then say "DRY: gcloud secrets versions access latest --secret=$PW_SECRET --project=$GCP_PROJECT > <임시 파일(600)>"
  else ( umask 077; gcloud secrets versions access latest --secret="$PW_SECRET" --project="$GCP_PROJECT" > "$TMPD/pw" ) 2>> "$LOGF" && [ -s "$TMPD/pw" ] \
    || { say "DB 비밀번호를 못 읽음 (Secret Manager 권한)"; exit 1; }; fi
  # 끝나면(실패해도) Job·Secret 을 지운다
  cleanup_seed() { run kubectl --context "$KCTX" -n "$NS" delete job shop-seed secret shop-seed-db --ignore-not-found --wait=true; rm -f "$TMPD/pw"; }
  if [ "$DRY" = 1 ]; then say "DRY: kubectl create namespace $NS --dry-run=client -o yaml | kubectl apply -f -"
  else K create namespace "$NS" --dry-run=client -o yaml | K apply -f - >> "$LOGF" 2>&1 || { say "네임스페이스 실패"; exit 1; }; fi
  run kubectl --context "$KCTX" -n "$NS" delete job shop-seed --ignore-not-found --wait=true || exit 1
  put_secret shop-seed-db PGPASSWORD "$TMPD/pw" || { cleanup_seed; exit 1; }
  rm -f "$TMPD/pw"
  # 표 모양 = AWS 샘플. 다시 돌려도 100행을 넘지 않게: 모자란 만큼만 넣는다 (100 이상이면 0행)
  cat > "$TMPD/seed-job.yaml" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: shop-seed
  namespace: ${NS}
  labels: { app: shop-seed }
spec:
  backoffLimit: 2
  activeDeadlineSeconds: 300
  template:
    metadata:
      labels: { app: shop-seed }
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 70 }
      containers:
        - name: psql
          image: ${SEED_REF}
          command: ["psql", "-v", "ON_ERROR_STOP=1", "-At",
            "-c", "create table if not exists orders (id bigserial primary key, item text, qty int, created_at timestamptz default now())",
            "-c", "insert into orders (item, qty) select 'item-' || g, (g % 5) + 1 from generate_series(1, greatest(0, 100 - (select count(*) from orders))) g",
            "-c", "select 'orders=' || count(*) from orders"]
          env:
            - { name: PGHOST, value: "${DB_HOST}" }
            - { name: PGPORT, value: "5432" }
            - { name: PGDATABASE, value: "${DB_NAME}" }
            - { name: PGUSER, value: "${DB_USER}" }
            - { name: PGSSLMODE, value: require }
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef: { name: shop-seed-db, key: PGPASSWORD }
          resources:
            requests: { cpu: 50m, memory: 32Mi }
EOF
  run kubectl --context "$KCTX" apply -f "$TMPD/seed-job.yaml" || { cleanup_seed; exit 1; }
  if [ "$DRY" = 1 ]; then say "DRY: kubectl -n $NS wait --for=condition=complete job/shop-seed --timeout=300s → logs 의 orders=N"; rc=0
  elif K -n "$NS" wait --for=condition=complete job/shop-seed --timeout=300s >> "$LOGF" 2>&1; then
    N=$(K -n "$NS" logs job/shop-seed 2>> "$LOGF" | grep -o 'orders=[0-9]*' | tail -1)
    say "seed 끝 ${N:-orders=?}"; rc=0
  else
    K -n "$NS" logs job/shop-seed >> "$LOGF" 2>&1
    say "seed Job 이 300초 안에 안 끝남 (로그 $LOGF)"; rc=1
  fi
  cleanup_seed
  exit $rc
  ;;
entry)
  say "entry 시작 dry=$DRY ns=$NS host=${ENTRY_HOST:-}"
  miss=""; for v in ENTRY_HOST CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN; do [ -n "${!v:-}" ] || miss="$miss $v"; done
  [ -z "$miss" ] || { say "환경 변수 없음:$miss (토큰 권한: Account Cloudflare Tunnel Edit, Zone DNS Edit)"; exit 1; }
  need_ctx || exit 1
  TUN_NAME="gcp-source-$NS"   # 이전마다 만드는 svc-<8자> 터널과 이름이 겹치지 않는다
  if [ "$DRY" = 1 ]; then
    say "DRY: Cloudflare 터널 $TUN_NAME 찾기·만들기 → ingress $ENTRY_HOST → http://shop-web.$NS:80 → DNS CNAME $ENTRY_HOST → <터널>.cfargotunnel.com (proxied)"
    say "DRY: Secret source-cloudflared(token) + Deployment source-cloudflared(라벨 svc.platform/metrics=cloudflared) + Ingress shop-web(host $ENTRY_HOST)"
    say "entry 끝"; exit 0
  fi
  # 토큰은 파일 헤더로만 (명령줄·로그에 안 남음)
  ( umask 077; printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$TMPD/h" ) || exit 1
  cf() { # 방법 경로 [본문]. 결과 JSON 의 .result 를 찍고, success 가 아니면 1
    local out; out=$(curl -sS -X "$1" -H @"$TMPD/h" -H 'Content-Type: application/json' ${3:+--data "$3"} "$CF_API$2" 2>> "$LOGF") || return 1
    jq -e '.success' >/dev/null <<<"$out" || { jq -c '.errors' <<<"$out" >> "$LOGF" 2>&1; return 1; }
    jq -c '.result' <<<"$out"
  }
  A="/accounts/$CLOUDFLARE_ACCOUNT_ID" Z="/zones/$CLOUDFLARE_ZONE_ID"
  # 파이프 앞쪽(cf) 실패를 놓치지 않게 (없으면 인증 실패도 "터널 만듦" 으로 찍혔다, 2026-11-07 실측). 이 단계에서만 켠다
  set -o pipefail
  cf GET "/user/tokens/verify" > /dev/null || { say "Cloudflare 토큰 인증 실패 (값이 토큰이 아니거나 만료. 로그 $LOGF)"; exit 1; }
  TID=$(cf GET "$A/cfd_tunnel?name=$TUN_NAME&is_deleted=false" | jq -r '.[0].id // empty') || { say "터널 조회 실패 (로그 $LOGF)"; exit 1; }
  if [ -z "$TID" ]; then
    TID=$(cf POST "$A/cfd_tunnel" "$(jq -nc --arg n "$TUN_NAME" '{name:$n, config_src:"cloudflare"}')" | jq -r '.id // empty') && [ -n "$TID" ] || { say "터널 만들기 실패 (로그 $LOGF)"; exit 1; }
    say "터널 $TUN_NAME 만듦"
  else say "터널 $TUN_NAME 다시 씀"; fi
  cf PUT "$A/cfd_tunnel/$TID/configurations" "$(jq -nc --arg h "$ENTRY_HOST" --arg s "http://shop-web.$NS:80" \
    '{config:{ingress:[{hostname:$h, service:$s}, {service:"http_status:404"}]}}')" > /dev/null || { say "터널 규칙 실패 (로그 $LOGF)"; exit 1; }
  REC=$(jq -nc --arg h "$ENTRY_HOST" --arg c "$TID.cfargotunnel.com" '{type:"CNAME", name:$h, content:$c, proxied:true, comment:"gcp-source entry"}')
  RID=$(cf GET "$Z/dns_records?name=$ENTRY_HOST" | jq -r '.[0].id // empty') || { say "DNS 조회 실패"; exit 1; }
  if [ -z "$RID" ]; then cf POST "$Z/dns_records" "$REC" > /dev/null || { say "DNS 줄 만들기 실패"; exit 1; }
  else cf PUT "$Z/dns_records/$RID" "$REC" > /dev/null || { say "DNS 줄 고치기 실패 (이전 LB 가 같은 호스트를 쓰는 중이면 그대로 둔다)"; exit 1; }; fi
  ( umask 077; cf GET "$A/cfd_tunnel/$TID/token" | jq -j '.' > "$TMPD/tok" ) && [ -s "$TMPD/tok" ] || { say "터널 토큰 실패"; exit 1; }
  put_secret source-cloudflared token "$TMPD/tok" || exit 1
  # 파드 라벨 svc.platform/metrics=cloudflared: 가져오기가 이 연결기를 고객 앱 부품으로 읽지 않게 (packages/adapters discover/k8s.ts isPlatformEntry)
  # DRAFT(ai): Ingress 는 명세 입구 호스트를 남기는 표시용. 클래스 public 은 GKE 컨트롤러가 안 집어 외부 LB 가 생기지 않는다 (실제 입구는 터널)
  cat > "$TMPD/entry.yaml" <<YAML || exit 1
apiVersion: apps/v1
kind: Deployment
metadata: { name: source-cloudflared, namespace: $NS }
spec:
  replicas: 1
  selector: { matchLabels: { app.kubernetes.io/name: source-cloudflared } }
  template:
    metadata: { labels: { app.kubernetes.io/name: source-cloudflared, svc.platform/metrics: cloudflared } }
    spec:
      containers:
        - name: cloudflared
          image: $CLOUDFLARED_IMAGE
          args: [tunnel, --no-autoupdate, run]
          env: [{ name: TUNNEL_TOKEN, valueFrom: { secretKeyRef: { name: source-cloudflared, key: token } } }]
          resources: { requests: { cpu: 20m, memory: 64Mi }, limits: { memory: 128Mi } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: shop-web, namespace: $NS }
spec:
  ingressClassName: public
  rules:
    - host: $ENTRY_HOST
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: shop-web, port: { number: 80 } } } }] }
YAML
  K apply -f "$TMPD/entry.yaml" >> "$LOGF" 2>&1 || { say "연결기·Ingress 적용 실패 (로그 $LOGF)"; exit 1; }
  K -n "$NS" rollout status deployment/source-cloudflared --timeout=120s >> "$LOGF" 2>&1 || { say "cloudflared 가 120초 안에 안 뜸"; exit 1; }
  say "entry 끝: https://$ENTRY_HOST → 터널 → shop-web (콘솔에서 출발 다시 가져오기 하면 명세 입구에 이 호스트가 잡힌다)"
  ;;
down)
  say "down 시작 dry=$DRY project=$GCP_PROJECT"
  tf_init || exit 1
  if [ "$DRY" = 1 ] || gcloud container clusters describe "$CLUSTER" --zone "$ZONE" --project "$GCP_PROJECT" >> "$LOGF" 2>&1; then
    need_ctx && run kubectl --context "$KCTX" delete namespace "$NS" --ignore-not-found --wait=true --timeout=300s \
      || say "알림: 네임스페이스 삭제 실패 → 클러스터와 같이 지워진다"
  else say "GKE 없음 → 네임스페이스 삭제 건너뜀"; fi
  # Cloud SQL 을 먼저 지운다: 사설 IP DB 가 남아 있으면 PSA 피어링이 안 지워진다
  tf destroy -input=false -auto-approve -var "project_id=$GCP_PROJECT" -target=module.db || exit 1
  # env 모듈의 PSA 연결은 deletion_policy=ABANDON → 피어링은 gcloud 로 지우고 state 에서만 뺀다 (tools/demo-day.sh d_gke 와 같은 순서)
  peer_rm() { run gcloud compute networks peerings delete servicenetworking-googleapis-com --network "$CLUSTER" --project "$GCP_PROJECT" --quiet || true; }
  peer_rm
  if [ "$DRY" = 1 ] || terraform -chdir="$MOD" state list 2>> "$LOGF" | grep -qx 'module.env.google_service_networking_connection.psa'; then
    tf state rm module.env.google_service_networking_connection.psa || true
  fi
  ok=0
  for i in 1 2 3; do
    if tf destroy -input=false -auto-approve -var "project_id=$GCP_PROJECT"; then ok=1; break; fi
    say "destroy ${i}번째 실패 → 피어링 다시 지우고 30초 뒤 재시도"
    peer_rm; [ "$DRY" = 1 ] || sleep 30
  done
  [ "$ok" = 1 ] || { say "판정 FAIL down (destroy 실패, 로그 $LOGF)"; exit 1; }
  zero_check || { say "판정 FAIL down (GKE·Cloud SQL 이 남음)"; exit 1; }
  say "판정 PASS down (state 버킷 gs://$TF_STATE_BUCKET 은 남김. 지우려면 사람이 직접)"
  ;;
esac

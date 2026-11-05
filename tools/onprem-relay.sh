#!/usr/bin/env bash
# 온프레 CNPG 로의 DB 이전 한 건에 쓸 중계기(infra/modules/aws/demo-relay)를 사람이 세우고, 끝점 줄을 넣는 도구. 사람이 돌린다
# DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역). 이 도구는 그 줄을 채우는 쪽이다
#
# 이 도구는 terraform 을 apply·destroy 하지 않는다. 할 명령을 화면에 찍고, 사람이 실행한다 (CLAUDE.md 7절)
#
# 사용 (Service 폴더에서)
#   1) bash tools/onprem-relay.sh prepare --tenant <uuid> --migration <uuid> --vpc vpc-… --subnet subnet-… \
#        --rds-endpoint <RDS 엔드포인트 이름> --region ap-northeast-2 --ssh-cidr <VM 나가는 IP>/32 --worker-cidr <플랫폼 NAT IP>/32 \
#        [--source-db-sg sg-…] [--admin-pubkey-file ~/.ssh/id_ed25519.pub] [--work-dir <레포 밖 폴더>]
#      → 터널 공개 키를 파생해 찍고, 작업 폴더(레포 밖)에 relay.tfvars 를 쓰고, terraform 명령을 찍는다
#   2) (사람) 찍힌 terraform 명령으로 중계기를 세운다
#   3) bash tools/onprem-relay.sh register --tenant <uuid> --migration <uuid> --rds-endpoint <이름> --dbname <DB> --source-user <출발 복제 계정> \
#        [--work-dir <1 과 같은 폴더>] [--source-password-ref env:REPL_SECRET_SRC_<id8>] [--known-hosts-file <파일>] \
#        [--relay-public-ip <IP> --relay-private-ip <IP>] [--app-role <앱 계정>] [--target-user svc_migrate]
#      → 중계기 호스트 키(ssh-keyscan)를 받고, tools/repl-endpoint.ts set 으로 출발·도착 두 줄을 넣는다
#   그 뒤: 워커 deploy 가 CNPG 서버 인증서·봉인 비밀·터널을 gitops 로 보내고, 도착 줄 ca_pem·verify-full, 출발 줄 peer(db-tunnel) 를 채운다
#
# 무엇이 비밀인가
#   - 터널 개인 키·이전 역할 비밀번호: REPL_SECRET_MASTER_KEY 로 파생한다. 이 도구는 공개 키만 찍는다 (개인 키는 워커가 봉인해서만 내보낸다)
#   - 출발 복제 계정 비밀번호: 줄에는 참조(env:REPL_SECRET_SRC_<id8>)만. 값은 워커 환경 변수로 운영자가 넣는다
#   - relay.tfvars 는 공개 값만 들지만 *.tfvars 는 레포에 두지 않는다 (CLAUDE.md 7절). 그래서 작업 폴더는 레포 밖이어야 한다
# 필요한 것: bash, node(npm run repl:endpoint), terraform(사람이 돌릴 때), ssh-keyscan(register), .env 의 DATABASE_URL·REPL_SECRET_MASTER_KEY
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODULE="$ROOT/infra/modules/aws/demo-relay"
die() { echo "onprem-relay: $*" >&2; exit 2; }
usage() { sed -n '6,14p' "$0" >&2; exit 2; }

CMD=${1:-}; [ -n "$CMD" ] || usage; shift
TENANT="" MIGRATION="" VPC="" SUBNET="" RDS="" REGION="ap-northeast-2" SSH_CIDR="" WORKER_CIDR="" SOURCE_SG="" ADMIN_PUB="$HOME/.ssh/id_ed25519.pub"
WORK="" DBNAME="" SRC_USER="" SRC_REF="" KNOWN="" PUB_IP="" PRIV_IP="" APP_ROLE="" TARGET_USER="svc_migrate"
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 에 값이 없다"
  case "$1" in
    --tenant) TENANT=$2 ;; --migration) MIGRATION=$2 ;; --vpc) VPC=$2 ;; --subnet) SUBNET=$2 ;;
    --rds-endpoint) RDS=$2 ;; --region) REGION=$2 ;; --ssh-cidr) SSH_CIDR=$2 ;; --worker-cidr) WORKER_CIDR=$2 ;;
    --source-db-sg) SOURCE_SG=$2 ;; --admin-pubkey-file) ADMIN_PUB=$2 ;; --work-dir) WORK=$2 ;;
    --dbname) DBNAME=$2 ;; --source-user) SRC_USER=$2 ;; --source-password-ref) SRC_REF=$2 ;; --known-hosts-file) KNOWN=$2 ;;
    --relay-public-ip) PUB_IP=$2 ;; --relay-private-ip) PRIV_IP=$2 ;; --app-role) APP_ROLE=$2 ;; --target-user) TARGET_USER=$2 ;;
    *) die "모르는 옵션 $1" ;;
  esac
  shift 2
done

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ $TENANT =~ $UUID_RE ]] || die "--tenant 는 소문자 uuid"
[[ $MIGRATION =~ $UUID_RE ]] || die "--migration 은 소문자 uuid"
ID8=$(printf '%s' "$MIGRATION" | tr -d '-' | cut -c1-8)
ID8_UP=$(printf '%s' "$ID8" | tr 'a-f' 'A-F')
[ -n "$WORK" ] || WORK="$HOME/.svc-relay/$ID8"
# 작업 폴더는 레포 밖 (tfvars·terraform 상태 파일이 레포에 들어가지 않게)
mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
case "$WORK/" in "$ROOT/"*) die "--work-dir 가 레포 안이다 ($WORK). 레포 밖 폴더를 준다" ;; esac
# 주소 칸은 tfvars·sshd PermitOpen 에 그대로 들어간다 → 이름·IPv4 글자만
NAME_RE='^[A-Za-z0-9.-]+$'
cidr32() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]]; }

case "$CMD" in
prepare)
  [[ $VPC =~ ^vpc-[0-9a-f]+$ ]] || die "--vpc vpc-…"
  [[ $SUBNET =~ ^subnet-[0-9a-f]+$ ]] || die "--subnet subnet-… (공개 서브넷)"
  [[ $RDS =~ $NAME_RE ]] || die "--rds-endpoint 는 RDS 엔드포인트 이름 (포트 없이)"
  [[ $REGION =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]] || die "--region 예 ap-northeast-2"
  cidr32 "$SSH_CIDR" || die "--ssh-cidr 는 VM 나가는 IP/32 (터널 파드가 22 로 붙는 곳)"
  cidr32 "$WORKER_CIDR" || die "--worker-cidr 는 플랫폼 워커 나가는 IP/32 (워커가 중계 5432 로 도착 CNPG 에 붙는다)"
  [ -z "$SOURCE_SG" ] || [[ $SOURCE_SG =~ ^sg-[0-9a-f]{8,17}$ ]] || die "--source-db-sg sg-…"
  [ -r "$ADMIN_PUB" ] || die "--admin-pubkey-file 을 못 읽는다 ($ADMIN_PUB). 중계기 ec2-user 용 내 공개 키"
  ADMIN_KEY=$(head -n1 "$ADMIN_PUB")
  case "$ADMIN_KEY" in *PRIVATE*) die "--admin-pubkey-file 에 개인 키가 있다. .pub 파일을 준다" ;; ssh-*|ecdsa-*) ;; *) die "--admin-pubkey-file 이 공개 키 한 줄이 아니다" ;; esac
  TUNNEL_PUB=$(cd "$ROOT" && npm run -s repl:endpoint -- pubkey --tenant "$TENANT" --migration "$MIGRATION")
  case "$TUNNEL_PUB" in "ssh-ed25519 "*) ;; *) die "터널 공개 키 파생 실패 (REPL_SECRET_MASTER_KEY 확인)" ;; esac
  TFVARS="$WORK/relay.tfvars"
  umask 077
  cat > "$TFVARS" <<EOF
# tools/onprem-relay.sh prepare 가 만들었다 ($(date -u +%Y-%m-%dT%H:%M:%SZ)). 이전 $MIGRATION
# 공개 값만 든다. 레포에 넣지 않는다
region                  = "$REGION"
name                    = "svc-relay-$ID8"
vpc_id                  = "$VPC"
public_subnet_id        = "$SUBNET"
ssh_public_key          = "$ADMIN_KEY"
ssh_cidrs_json          = "[\"$SSH_CIDR\"]"
extra_pg_cidrs_json     = "[\"$WORKER_CIDR\"]"
tunnel_public_key       = "$TUNNEL_PUB"
forward_pg_targets_json = "[\"$RDS:5432\"]"
tunnel_reverse          = true
source_db_sg_id         = "$SOURCE_SG"
EOF
  echo "터널 공개 키 (중계기 tunnel 계정, 개인 키는 워커가 봉인해 gitops 로만 보낸다):"
  echo "  $TUNNEL_PUB"
  echo "tfvars: $TFVARS"
  echo
  echo "사람이 실행 (이 도구는 실행하지 않는다). 고객 계정 실행 역할 권한 = infra/permissions/aws-relay-statements.json"
  echo "  terraform -chdir=\"$WORK\" init -from-module=\"$MODULE\""
  echo "  terraform -chdir=\"$WORK\" plan -var-file=relay.tfvars -out=relay.plan"
  echo "  terraform -chdir=\"$WORK\" apply relay.plan"
  [ -n "$SOURCE_SG" ] || echo "  주의: --source-db-sg 없음. 출발 RDS 보안 그룹 나가기가 막혀 있으면 롤백 창 역복제(RDS → 중계 5432)가 못 붙는다"
  echo "그다음: bash tools/onprem-relay.sh register --tenant $TENANT --migration $MIGRATION --work-dir \"$WORK\" --rds-endpoint $RDS --dbname <DB> --source-user <출발 복제 계정>"
  echo "이전이 끝나면: terraform -chdir=\"$WORK\" destroy -var-file=relay.tfvars (사람)"
  ;;
register)
  [[ $RDS =~ $NAME_RE ]] || die "--rds-endpoint 는 prepare 때와 같은 이름"
  [ -n "$DBNAME" ] || die "--dbname 필요"
  [ -n "$SRC_USER" ] || die "--source-user 필요 (출발 RDS 복제 계정)"
  [ -n "$SRC_REF" ] || SRC_REF="env:REPL_SECRET_SRC_$ID8_UP"
  if [ -z "$PUB_IP" ] || [ -z "$PRIV_IP" ]; then
    # 상태 파일을 읽기만 한다 (apply 아님)
    command -v terraform >/dev/null || die "terraform 이 없다. --relay-public-ip·--relay-private-ip 로 준다"
    [ -n "$PUB_IP" ] || PUB_IP=$(terraform -chdir="$WORK" output -raw public_ip)
    [ -n "$PRIV_IP" ] || PRIV_IP=$(terraform -chdir="$WORK" output -raw private_ip)
  fi
  [[ $PUB_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "중계기 공개 IP 가 이상하다: $PUB_IP"
  [[ $PRIV_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "중계기 사설 IP 가 이상하다: $PRIV_IP"
  if [ -z "$KNOWN" ]; then
    # 22 는 --ssh-cidr 에만 열려 있다. 이 기계가 그 대역 밖이면 실패한다 → VM 에서 받아 --known-hosts-file 로 준다
    KNOWN="$WORK/relay_known_hosts"
    ssh-keyscan -t ed25519 -T 10 "$PUB_IP" 2>/dev/null > "$KNOWN" || true
    grep -q "^$PUB_IP ssh-ed25519 " "$KNOWN" || die "ssh-keyscan 실패 (22 가 이 기계에 안 열렸을 수 있다). VM 에서 'ssh-keyscan -t ed25519 $PUB_IP' 를 받아 --known-hosts-file 로 준다"
    echo "중계기 호스트 키 지문 (EC2 콘솔 출력의 지문과 대조한다):"
    ssh-keygen -lf "$KNOWN" || true
  fi
  [ -r "$KNOWN" ] || die "--known-hosts-file 을 못 읽는다"
  grep -q "PRIVATE KEY" "$KNOWN" && die "--known-hosts-file 에 개인 키가 있다"
  cd "$ROOT"
  # 출발: 워커가 RDS 에 직접(VPC 안 또는 허용된 경로). peer 는 deploy 가 db-tunnel.<ns>.svc:5432 로 채운다
  npm run -s repl:endpoint -- set --tenant "$TENANT" --migration "$MIGRATION" --side source --label "rds-src-$ID8" --provider rds \
    --host "$RDS" --port 5432 --dbname "$DBNAME" --user "$SRC_USER" --password-ref "$SRC_REF" --sslmode require \
    ${APP_ROLE:+--app-role "$APP_ROLE"}
  # 도착: 워커 → 중계 공개 IP:5432 (역방향 터널) → 온프레 CNPG. RDS(롤백 창 역복제)는 중계 사설 IP:5432 로 붙는다
  #   계정 = 차트 이전 역할(svc_migrate), 비밀번호 = derive:migrate (워커가 봉인한 <cnpg>-migrate 와 같은 값)
  #   sslmode 는 우선 require. deploy 가 플랫폼 CA 를 발급하면 ca_pem·tls_servername·verify-full 로 바꾼다
  npm run -s repl:endpoint -- set --tenant "$TENANT" --migration "$MIGRATION" --side target --label "onprem-cnpg-$ID8" --provider cnpg \
    --host "$PUB_IP" --port 5432 --peer-host "$PRIV_IP" --peer-port 5432 --dbname "$DBNAME" --user "$TARGET_USER" \
    --password-ref derive:migrate --sslmode require ${APP_ROLE:+--app-role "$APP_ROLE"} \
    --relay-host "$PUB_IP" --relay-known-hosts-file "$KNOWN" --relay-port 22
  echo "넣었다. 출발 비밀번호 참조 = $SRC_REF (워커 환경 변수에 값을 넣는다)"
  ;;
*) usage ;;
esac

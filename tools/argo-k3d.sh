#!/usr/bin/env bash
# Z103: 맥 k3d 에 Argo CD(core) 를 올려 Z94 반영 확인 코드를 진짜 Application 에 대고 시험한다. 클라우드 자원 0.
#
# 무엇을 확인하나 (워커와 같은 argoWatcherFromEnv, k8s 길 = ARGO_KUBE_CONTEXT, 토큰 불필요)
#   A ok          : 첫 커밋이 Synced+Healthy 가 되면 ok            → "argoHealthy 도달 초"
#   B new-commit  : 새 커밋을 올리고 refresh 표시 → 새 리비전으로 ok  → "커밋 → 반영 초"
#   C degraded    : 없는 이미지 + progressDeadline 15초 커밋        → ARGO_DEGRADED
#   D wrong-rev   : 아무도 안 올린 리비전                           → ARGO_TIMEOUT (6초)
#   E missing     : 없는 Application 이름                          → ARGO_APP_MISSING (4초)
#   F recover     : 좋은 커밋으로 되돌림                            → ok
#   G release     : 새 릴리스(probe-rev 3) 올림                      → ok, pod 주석 3
#   H rollback    : git revert 로 이전 릴리스 되돌림 → Argo 반영       → ok, pod 주석 2 (이전 리비전으로 돌아간 pod 확인)
#
# 사용 (Service 폴더에서)
#   bash tools/argo-k3d.sh all      up → probe → down (기본)
#   bash tools/argo-k3d.sh up       Argo core + 시험용 git 서버 + Application
#   bash tools/argo-k3d.sh probe    A~F
#   bash tools/argo-k3d.sh down     전부 지우고 남은 것 0 확인
# 환경 변수
#   ARGO_KUBE_CONTEXT   없으면 이름에 onprem 이 든 컨텍스트 1개 자동 (맥 = k3s-onprem)
#   ARGO_INSTALL_YAML   기본 tools/argocd-core-install-v2.13.3.yaml (인터넷에서 직접 apply 하지 않는다. sha 확인 뒤 씀)
#   ARGO_K3D_REUSE=1    argocd 네임스페이스가 이미 있어도 진행
#   ARGO_K3D_NOREFRESH=1  B 에서 refresh 표시를 안 함 → Argo 기본 git 주기(약 3분)까지 걸리는지 측정 (ARGO_WAIT_SEC 240)
# 출력: .int-logs/argo-k3d/<시각>/progress.log, probe.jsonl, summary.txt. 끝 줄 "ARGO-K3D PASS n/8" 또는 "ARGO-K3D FAIL ..."
# 하지 않는 것: 포트 열기·터널·DNS·인증서·클라우드·.env 읽기. 쓰는 곳은 k3d 클러스터 안(argocd, argo-probe 네임스페이스)뿐
set -u

# 컨텍스트: ARGO_KUBE_CONTEXT 가 있으면 그것. 없으면 kubectl 컨텍스트 중 이름에 onprem 이 든 것이 정확히 1개일 때 그것
#   (맥은 k3s-onprem, 문서 기본은 k3d-onprem). 0개·2개 이상이면 멈추고 ARGO_KUBE_CONTEXT 를 달라고 한다
if [ -n "${ARGO_KUBE_CONTEXT:-}" ]; then CTX=$ARGO_KUBE_CONTEXT
else
  _c=$(kubectl config get-contexts -o name 2>/dev/null | grep onprem || true)
  if [ "$(printf '%s\n' "$_c" | grep -c .)" = 1 ]; then CTX=$_c
  else echo "ARGO-K3D FAIL 컨텍스트 자동 감지 실패 (onprem 후보: $(echo $_c)). ARGO_KUBE_CONTEXT=<이름> 을 앞에 붙여 다시"; exit 1; fi
fi
NS=argocd
APPNS=argo-probe
TENANT=t-11111111
APPNAME=shop
APP="${TENANT}-${APPNAME}-aws-eks"
YAML=${ARGO_INSTALL_YAML:-tools/argocd-core-install-v2.13.3.yaml}
YAML_SHA=cfe23fcb976c00c96e5add2f8fd9f70db4390b06c66ec4f391634e49e3ef45e3
IMG=quay.io/argoproj/argocd:v2.13.3
WHAT=${1:-all}
RUN=${ARGO_K3D_RUN:-.int-logs/argo-k3d/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$RUN"
echo "$(date -u +%H:%M:%S) 컨텍스트 $CTX" >>"$RUN/progress.log"
LOG="$RUN/progress.log"
K() { kubectl --context "$CTX" "$@"; }
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }
die() { log "중단: $*"; echo "ARGO-K3D FAIL $*" | tee -a "$RUN/summary.txt"; exit 1; }
now_ms() { node -e 'console.log(Date.now())'; }
# k3d 노드 컨테이너 메모리 (Docker 한도 안에서 Argo 가 얼마나 먹나). docker 가 없거나 막히면 건너뜀
mem() { command -v docker >/dev/null && docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' 2>/dev/null | grep k3d- | sed "s/^/   메모리($1) /" | tee -a "$LOG" || true; }

pre() {
  command -v kubectl >/dev/null || die "kubectl 없음"
  command -v node >/dev/null || die "node 없음"
  K get nodes >/dev/null 2>&1 || die "컨텍스트 $CTX 에 못 붙음 (k3d cluster list 로 onprem 이 떠 있는지)"
  [ -f "$YAML" ] || die "$YAML 없음 (parallel/Z103/vendor 에서 복사)"
  got=$(shasum -a 256 "$YAML" 2>/dev/null | cut -d' ' -f1 || sha256sum "$YAML" | cut -d' ' -f1)
  [ "$got" = "$YAML_SHA" ] || die "설치 yaml sha 불일치 $got"
  [ -f tools/argo-probe.ts ] || die "tools/argo-probe.ts 없음"
}

up() {
  pre
  if K get ns "$NS" >/dev/null 2>&1 && [ "${ARGO_K3D_REUSE:-0}" != 1 ]; then
    die "네임스페이스 $NS 가 이미 있다 (다른 Argo 일 수 있음). 지우려면 down, 그대로 쓰려면 ARGO_K3D_REUSE=1"
  fi
  mem 설치전
  t0=$(now_ms)
  log "1/4 Argo CD core v2.13.3 설치 (server·dex·UI 없음 = 토큰·포트 불필요)"
  K create ns "$NS" >/dev/null 2>&1 || true
  # CRD 가 커서(applicationsets) client-side apply 의 annotation 한도를 넘는다 → server-side
  K apply -n "$NS" --server-side --force-conflicts -f "$YAML" >>"$LOG" 2>&1 || die "Argo 설치 apply 실패"
  for d in argocd-repo-server argocd-redis argocd-applicationset-controller; do
    K -n "$NS" rollout status deploy/$d --timeout=300s >>"$LOG" 2>&1 || die "$d 안 뜸"
  done
  K -n "$NS" rollout status statefulset/argocd-application-controller --timeout=300s >>"$LOG" 2>&1 || die "application-controller 안 뜸"
  t1=$(now_ms); log "   설치 $(( (t1 - t0) / 1000 ))초"

  log "2/4 시험용 git 서버 (클러스터 안 git daemon, Argo 이미지 재사용 → 새 이미지 받기 없음, 바깥 레포 안 씀)"
  cat <<EOF | K apply -f - >>"$LOG" 2>&1 || die "git 서버 apply 실패"
apiVersion: v1
kind: ConfigMap
metadata: { name: argo-probe-src, namespace: $NS }
data:
  app.yaml: |
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: probe
    spec:
      replicas: 1
      progressDeadlineSeconds: 600
      selector: { matchLabels: { app: probe } }
      template:
        metadata:
          labels: { app: probe }
          annotations: { probe-rev: "1" }
        spec:
          terminationGracePeriodSeconds: 1
          containers:
          - name: c
            image: $IMG
            command: ["sleep", "infinity"]
            resources: { requests: { cpu: 10m, memory: 16Mi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: argo-gitd, namespace: $NS }
spec:
  replicas: 1
  selector: { matchLabels: { app: argo-gitd } }
  template:
    metadata: { labels: { app: argo-gitd } }
    spec:
      containers:
      - name: gitd
        image: $IMG
        imagePullPolicy: IfNotPresent
        command: ["sh", "-c"]
        args:
        - |
          set -e
          export HOME=/tmp
          git config --global user.email probe@platform.invalid
          git config --global user.name probe
          git config --global init.defaultBranch main
          mkdir -p /srv/work && cd /srv/work && git init -q && cp /src/app.yaml . && git add . && git commit -qm c1
          git clone -q --bare /srv/work /srv/probe.git && touch /srv/probe.git/git-daemon-export-ok
          cd /srv/work && git remote add origin /srv/probe.git
          exec git daemon --reuseaddr --export-all --base-path=/srv --listen=0.0.0.0 --port=9418 /srv
        ports: [{ containerPort: 9418 }]
        readinessProbe: { tcpSocket: { port: 9418 }, periodSeconds: 2 }
        volumeMounts: [{ name: src, mountPath: /src }, { name: srv, mountPath: /srv }]
      volumes:
      - { name: src, configMap: { name: argo-probe-src } }
      - { name: srv, emptyDir: {} }
---
apiVersion: v1
kind: Service
metadata: { name: argo-gitd, namespace: $NS }
spec: { selector: { app: argo-gitd }, ports: [{ port: 9418, targetPort: 9418 }] }
EOF
  K -n "$NS" rollout status deploy/argo-gitd --timeout=120s >>"$LOG" 2>&1 || die "git 서버 안 뜸"

  # default AppProject 는 보통 argocd-server 가 뜰 때 만든다. core 설치엔 server 가 없어 직접 둔다 (이미 있으면 그대로)
  K -n "$NS" get appproject default >/dev/null 2>&1 || cat <<EOF | K apply -f - >>"$LOG" 2>&1 || die "AppProject default apply 실패"
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata: { name: default, namespace: $NS }
spec:
  sourceRepos: ["*"]
  destinations: [{ server: "*", namespace: "*" }]
  clusterResourceWhitelist: [{ group: "*", kind: "*" }]
EOF

  log "3/4 Application $APP (이름 = 워커 argoAppName 규칙 <tenant>-<app>-aws-eks, 도착 = 같은 k3d 의 $APPNS)"
  date -u +%s > "$RUN/app-created.epoch"
  cat <<EOF | K apply -f - >>"$LOG" 2>&1 || die "Application apply 실패"
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: $APP, namespace: $NS }
spec:
  project: default
  source: { repoURL: "git://argo-gitd.$NS.svc.cluster.local/probe.git", targetRevision: main, path: . }
  destination: { server: "https://kubernetes.default.svc", namespace: $APPNS }
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true]
EOF
  mem 설치후
  log "4/4 준비 끝"
}

head_rev() { K -n "$NS" exec deploy/argo-gitd -- sh -c 'cd /srv/work && git rev-parse HEAD'; }
# 시험 레포에 커밋 1개. $1 = sed 식
commit() {
  K -n "$NS" exec deploy/argo-gitd -- sh -c "export HOME=/tmp; cd /srv/work && sed -i '$1' app.yaml && git commit -qam step && git push -q origin HEAD:main && git rev-parse HEAD"
}
refresh() {
  [ "${ARGO_K3D_NOREFRESH:-0}" = 1 ] && return 0
  K -n "$NS" annotate application "$APP" argocd.argoproj.io/refresh=normal --overwrite >>"$LOG" 2>&1
}
PASSN=0
probe1() {  # case expect commit wait [app]
  out=$(node --import tsx tools/argo-probe.ts --case "$1" --expect "$2" --commit "$3" --wait "$4" \
        --tenant "$TENANT" --app "${5:-$APPNAME}" --context "$CTX" 2>>"$LOG")
  rc=$?
  echo "$out" >>"$RUN/probe.jsonl"
  log "   $1: $out"
  [ $rc -eq 0 ] && PASSN=$((PASSN + 1))
}

# pod 가 기대 릴리스 주석을 달고 떠 있나 (Synced+Healthy 와 별도로 진짜 pod 를 본다). 맞으면 PASSN 하나 더 (G·H 는 probe1 과 합쳐 1칸)
podrev() {
  K -n "$APPNS" rollout status deploy/probe --timeout=90s >>"$LOG" 2>&1
  # 옛 pod 가 Terminating 동안은 Running 으로 보인다 → 하나로 모일 때까지 최대 30초
  for _ in $(seq 1 30); do
    revs=$(K -n "$APPNS" get pods -l app=probe -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.deletionTimestamp}{"|"}{.metadata.annotations.probe-rev}{" "}{end}' 2>>"$LOG" | tr ' ' '\n' | grep '^|' | cut -c2- | sort -u | tr '\n' ' ')
    [ "$revs" = "$2 " ] && break
    sleep 1
  done
  rsrev=$(K -n "$APPNS" get deploy probe -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>>"$LOG")
  log "   $1 pod: 주석 [${revs% }] (기대 $2), Deployment revision $rsrev"
  echo "{\"case\":\"$1-pod\",\"podRev\":\"${revs% }\",\"expect\":\"$2\",\"deployRevision\":\"$rsrev\"}" >>"$RUN/probe.jsonl"
  [ "$revs" = "$2 " ] || { PASSN=$((PASSN - 1)); log "   $1 pod 리비전 틀림 또는 섞임"; }
}

probe() {
  pre
  K -n "$NS" get application "$APP" >/dev/null 2>&1 || die "Application 없음 (먼저 up)"
  R1=$(head_rev) || die "git 서버 읽기 실패"
  log "A ok: 첫 커밋 ${R1:0:12} → Synced+Healthy 기다림"
  probe1 A-ok ok "$R1" 180
  c0=$(cat "$RUN/app-created.epoch" 2>/dev/null || echo 0)
  [ "$c0" != 0 ] && log "   Application 만든 뒤 ok 까지 $(( $(date -u +%s) - c0 ))초"

  log "B new-commit: 주석 하나 바꿔 새 커밋"
  R2=$(commit 's/probe-rev: "1"/probe-rev: "2"/') || die "커밋 실패"
  refresh
  W=120; [ "${ARGO_K3D_NOREFRESH:-0}" = 1 ] && W=240
  probe1 B-new-commit ok "$R2" $W

  log "C degraded: 없는 이미지 태그 + progressDeadline 15초"
  R3=$(commit 's/progressDeadlineSeconds: 600/progressDeadlineSeconds: 15/; s#\(image: quay.io/argoproj/argocd:\).*#\1v0.0.0-z103-missing#') || die "커밋 실패"
  refresh
  probe1 C-degraded ARGO_DEGRADED "$R3" 120

  log "D wrong-rev: 아무도 안 올린 리비전"
  probe1 D-wrong-rev ARGO_TIMEOUT 0000000000000000000000000000000000000000 6

  log "E missing: 없는 Application"
  probe1 E-missing ARGO_APP_MISSING "$R1" 4 nope

  log "F recover: 좋은 이미지로 되돌림"
  R4=$(commit "s#\(image: quay.io/argoproj/argocd:\).*#\1v2.13.3#; s/progressDeadlineSeconds: 15/progressDeadlineSeconds: 600/") || die "커밋 실패"
  refresh
  probe1 F-recover ok "$R4" 180

  log "G release: 새 릴리스 probe-rev 3"
  R5=$(commit 's/probe-rev: "2"/probe-rev: "3"/') || die "커밋 실패"
  refresh
  probe1 G-release ok "$R5" 120
  podrev G 3

  log "H rollback: git revert 로 이전 릴리스(probe-rev 2) 되돌림"
  tr0=$(now_ms)
  R6=$(K -n "$NS" exec deploy/argo-gitd -- sh -c 'export HOME=/tmp; cd /srv/work && git revert --no-edit HEAD >/dev/null && git push -q origin HEAD:main && git rev-parse HEAD') || die "revert 실패"
  refresh
  probe1 H-rollback ok "$R6" 120
  podrev H 2
  tr1=$(now_ms)
  log "   롤백(revert 커밋 → Synced+Healthy → pod 이전 리비전) $(( tr1 - tr0 ))ms"
  echo "{\"case\":\"H-rollback-total\",\"ms\":$(( tr1 - tr0 )),\"from\":\"${R5:0:12}\",\"to\":\"${R6:0:12}\"}" >>"$RUN/probe.jsonl"

  if [ $PASSN -eq 8 ]; then echo "ARGO-K3D PASS 8/8" | tee -a "$RUN/summary.txt" "$LOG"
  else echo "ARGO-K3D FAIL $PASSN/8 (probe.jsonl 참고)" | tee -a "$RUN/summary.txt" "$LOG"; return 1; fi
}

down() {
  mem 정리전
  log "정리: Application → 시험 네임스페이스 → Argo 설치물 → argocd 네임스페이스"
  K -n "$NS" delete application --all --wait --timeout=60s >>"$LOG" 2>&1 || true
  K delete ns "$APPNS" --wait --timeout=120s --ignore-not-found >>"$LOG" 2>&1 || true
  [ -f "$YAML" ] && K delete -n "$NS" -f "$YAML" --ignore-not-found --wait --timeout=120s >>"$LOG" 2>&1 || true
  K delete ns "$NS" --wait --timeout=120s --ignore-not-found >>"$LOG" 2>&1 || true
  left=$( (K get crd -o name 2>/dev/null | grep -c argoproj.io) || true)
  nsl=$( (K get ns "$NS" "$APPNS" -o name 2>/dev/null | wc -l | tr -d ' ') || true)
  crl=$( (K get clusterrole,clusterrolebinding -o name 2>/dev/null | grep -c argocd) || true)
  log "남은 것: argoproj CRD ${left:-0}, 네임스페이스 ${nsl:-0}, argocd ClusterRole/Binding ${crl:-0}"
  if [ "${left:-0}" = 0 ] && [ "${nsl:-0}" = 0 ] && [ "${crl:-0}" = 0 ]; then echo "ARGO-K3D DOWN zero" | tee -a "$LOG"
  else echo "ARGO-K3D DOWN 남음" | tee -a "$LOG"; return 1; fi
}

case "$WHAT" in
  up) up ;;
  probe) probe ;;
  down) down ;;
  # die 는 exit 라 subshell 로 감싼다 → up·probe 가 어디서 멈춰도 down 은 꼭 돈다 (단, 이미 있던 argocd 때문에 멈춘 경우는 남의 것이라 안 지움)
  all) pre; if K get ns "$NS" >/dev/null 2>&1 && [ "${ARGO_K3D_REUSE:-0}" != 1 ]; then die "네임스페이스 $NS 가 이미 있다 (지우지 않음)"; fi
       ( up ) && ( probe ); p=$?; down; d=$?; log "결과 폴더 $RUN"; [ $p -eq 0 ] && [ $d -eq 0 ] ;;
  *) echo "사용: bash tools/argo-k3d.sh [all|up|probe|down]"; exit 2 ;;
esac

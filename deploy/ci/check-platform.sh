#!/usr/bin/env bash
# 플랫폼 차트(deploy/helm/platform)를 세 벌로 렌더해서 쿠버네티스 스키마 검사 + 샌드박스 자원 개수 확인.
#   기본(sandbox 끔) / sandbox 켬(gVisor 끔) / gVisor 켬
#   CRD(SecretStore, ExternalSecret)는 datreeio CRDs-catalog 스키마로 검사
#   sandbox 켬이면 sandbox.imageRegistry 가 꼭 있어야 한다. 없거나 모양이 틀리면 렌더가 실패하는지도 본다
# 필요: helm, kubeconform. 사용: bash deploy/ci/check-platform.sh
set -euo pipefail

CHART=deploy/helm/platform
K8S_VERSION="${K8S_VERSION:-1.35.0}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# 가짜 계정 (렌더·검사 전용)
ON=(--set sandbox.enabled=true --set sandbox.imageRegistry=000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox)

helm lint "$CHART"
helm lint "$CHART" "${ON[@]}"

helm template platform "$CHART" -n platform > "$OUT/default.yaml"
helm template platform "$CHART" -n platform "${ON[@]}" > "$OUT/sandbox-on.yaml"
helm template platform "$CHART" -n platform "${ON[@]}" --set sandbox.gvisor.enabled=true > "$OUT/gvisor-on.yaml"

fail=0
for bad in "" "https://000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox" "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox/" "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com" "ghcr.io/sandbox"; do
  if helm template platform "$CHART" -n platform --set sandbox.enabled=true --set "sandbox.imageRegistry=$bad" >/dev/null 2>&1; then
    echo "FAIL sandbox.imageRegistry='$bad' 인데 렌더가 됐다"; fail=1
  fi
done
[ $fail -eq 0 ] && echo "ok   sandbox.imageRegistry 없음·틀린 모양은 렌더 실패"

kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT"/*.yaml

# 자원 개수: 렌더 이름 뒤에 KINDS 순서대로
KINDS=(ClusterRole ClusterRoleBinding ValidatingAdmissionPolicy ValidatingAdmissionPolicyBinding StorageClass RuntimeClass ServiceAccount)
expect() {
  local f=$1; shift
  local want=("$@")
  for i in "${!KINDS[@]}"; do
    local got; got=$(grep -c "^kind: ${KINDS[$i]}\$" "$OUT/$f.yaml" || true)
    if [ "$got" != "${want[$i]}" ]; then echo "FAIL $f: ${KINDS[$i]} ${got}개, 기대 ${want[$i]}개"; fail=1; fi
  done
}
expect default     0 0 0 0 0 0 3
expect sandbox-on  2 1 6 6 1 0 3
expect gvisor-on   2 1 6 6 1 1 3
[ $fail -eq 0 ] && echo "ok   샌드박스 자원 개수 (기본 끔·켬·gVisor)"

# 런타임 가드 대상: gVisor 끔 = 수정 고리만, 켬 = 리허설도 (ADR-006 Q7)
purpose() { awk '/^kind: ValidatingAdmissionPolicyBinding$/{b=1} b&&/name: sbx-runtimeclass-guard$/{f=1} f&&/values:/{print; exit}' "$OUT/$1.yaml" | tr -d ' '; }
if [ "$(purpose sandbox-on)" != "values:[remediation]" ]; then echo "FAIL sandbox-on: 런타임 가드 대상 $(purpose sandbox-on)"; fail=1; fi
if [ "$(purpose gvisor-on)" != "values:[remediation,rehearsal]" ]; then echo "FAIL gvisor-on: 런타임 가드 대상 $(purpose gvisor-on)"; fail=1; fi
[ $fail -eq 0 ] && echo "ok   런타임 가드 대상 (gVisor 끔 = 수정 고리, 켬 = 리허설도)"

# worker GCP 로그인: 값이 없으면 아무것도 안 그린다, 값이 있으면 worker 만 설정 파일·토큰을 받는다, 틀린 모양은 렌더 실패
AUD=//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/platform-hub/providers/platform-eks
IMG=(--set apps.image.registry=x --set apps.image.tag=y)
# 출력을 먼저 담고 고른다. `… | grep -q` 는 일치하자마자 끝나 앞 명령이 SIGPIPE(141)로 끝나고, pipefail 아래서는 "있음"이 "없음"으로 뒤집힌다
contains() { grep -qF -- "$2" <<<"$1"; }
NOGCP=$(helm template platform "$CHART" -n platform "${IMG[@]}")
if grep -qE 'GCP_PLATFORM_PROJECT|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|worker-gcp-cred' <<<"$NOGCP"; then
  echo "FAIL gcpPlatform 값 없이 GCP 설정이 그려졌다"; fail=1
fi
# --reuse-values: 이 칸이 생기기 전 릴리스 값으로 올려도 렌더가 돈다
if ! helm template platform "$CHART" -n platform "${IMG[@]}" --set gcpPlatform=null >/dev/null 2>&1; then
  echo "FAIL gcpPlatform 칸이 없는 릴리스 값으로 렌더가 안 된다"; fail=1
fi
GCP=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set gcpPlatform.project=platform-proj --set "gcpPlatform.wifAudience=$AUD")
printf '%s\n' "$GCP" > "$OUT/gcp-on.yaml"
kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT/gcp-on.yaml"
# 앱 Deployment 하나만 잘라 낸다
app() { printf '%s\n' "$GCP" | awk -v n="# Source: platform/templates/app.yaml" -v d="$1" 'BEGIN{RS="\n---\n"} index($0,n) && /kind: Deployment/ && index($0,"  name: " d "\n")'; }
want() { if ! contains "$(app "$1")" "$2"; then echo "FAIL $1 에 $2 없음"; fail=1; fi; }
deny() { if contains "$(app "$1")" "$2"; then echo "FAIL $1 에 $2 있음"; fail=1; fi; }
want api GCP_PLATFORM_PROJECT
want worker GCP_PLATFORM_PROJECT
want worker CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE
want worker "audience: $AUD"
want worker worker-gcp-cred
for a in api agent-worker web; do deny "$a" CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE; deny "$a" gcp-token; done
deny agent-worker GCP_PLATFORM_PROJECT
deny web GCP_PLATFORM_PROJECT
if ! contains "$GCP" 'svc-worker@platform-proj.iam.gserviceaccount.com:generateAccessToken'; then echo "FAIL 설정 파일에 svc-worker 없음"; fail=1; fi
for bad in "--set gcpPlatform.project=platform-proj" "--set gcpPlatform.project=platform-proj --set gcpPlatform.wifAudience=https://example.com/aud" "--set gcpPlatform.project=Bad_Project --set gcpPlatform.wifAudience=$AUD"; do
  # shellcheck disable=SC2086
  if helm template platform "$CHART" -n platform $bad >/dev/null 2>&1; then echo "FAIL '$bad' 인데 렌더가 됐다"; fail=1; fi
done
[ $fail -eq 0 ] && echo "ok   worker GCP 로그인 (값 없음·worker 만·틀린 모양 거부)"

# 리허설·샌드박스 런타임·AI 점검 GitOps 읽기 (values sandbox.rehearsal · sandbox.gvisor · agentRemediation.gitopsRead)
#   값 없으면 아무것도 안 그린다 / 켜면 worker·agent-worker 에만 / sandbox 끔 + 리허설 켬은 렌더 실패 / 칸이 없는 릴리스 값(--reuse-values)으로도 렌더
REG=000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox
part() { printf '%s\n' "$DOC" | awk -v n="# Source: platform/templates/$1" -v k="kind: $2" -v d="  name: $3" 'BEGIN{RS="\n---\n"} index($0,n) && index($0,k "\n") && index($0,d "\n")'; }
has() { if ! contains "$(part "$1" "$2" "$3")" "$4"; then echo "FAIL $5: $3 에 $4 없음"; fail=1; fi; }
hasnt() { if contains "$(part "$1" "$2" "$3")" "$4"; then echo "FAIL $5: $3 에 $4 있음"; fail=1; fi; }
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" "${ON[@]}")
for a in api worker agent-worker web; do
  for e in SANDBOX_REHEARSAL SANDBOX_IMAGE_REGISTRY SANDBOX_RUNTIME_CLASS; do hasnt app.yaml Deployment "$a" "$e" "기본"; done
done
hasnt secrets.yaml ExternalSecret agent-worker-env GITOPS_ "기본"
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" "${ON[@]}" --set sandbox.rehearsal.enabled=true --set sandbox.gvisor.enabled=true --set agentRemediation.gitopsRead=true)
printf '%s\n' "$DOC" > "$OUT/sandbox-env-on.yaml"
kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT/sandbox-env-on.yaml"
has app.yaml Deployment worker '{ name: SANDBOX_REHEARSAL, value: "on" }' "켬"
has app.yaml Deployment worker "{ name: SANDBOX_IMAGE_REGISTRY, value: \"$REG\" }" "켬"
has app.yaml Deployment agent-worker '{ name: SANDBOX_RUNTIME_CLASS, value: "gvisor" }' "켬"
hasnt app.yaml Deployment worker SANDBOX_RUNTIME_CLASS "켬"
for a in api agent-worker web; do hasnt app.yaml Deployment "$a" SANDBOX_REHEARSAL "켬"; done
for a in api web; do hasnt app.yaml Deployment "$a" SANDBOX_RUNTIME_CLASS "켬"; done
has secrets.yaml ExternalSecret agent-worker-env "property: GITOPS_REPO_URL" "켬"
has secrets.yaml ExternalSecret agent-worker-env "property: GITOPS_READ_TOKEN" "켬"
hasnt secrets.yaml ExternalSecret agent-worker-env GITOPS_WRITE_TOKEN "켬 (쓰기 토큰은 안 준다)"
hasnt secrets.yaml ExternalSecret worker-env GITOPS_READ_TOKEN "켬 (worker 비밀은 그대로)"
if helm template platform "$CHART" -n platform "${IMG[@]}" --set sandbox.rehearsal.enabled=true >/dev/null 2>&1; then
  echo "FAIL sandbox 끔인데 sandbox.rehearsal.enabled=true 로 렌더가 됐다"; fail=1
fi
# AI 점검 샌드박스 (values agentRemediation.sandboxMode): 비우면 env 없음 / vcluster 는 agent-worker 에만 / sandbox·gVisor 없이 vcluster, 모르는 값은 렌더 실패
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" "${ON[@]}")
hasnt app.yaml Deployment agent-worker SANDBOX_MODE "기본"
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" "${ON[@]}" --set sandbox.gvisor.enabled=true --set agentRemediation.sandboxMode=vcluster)
has app.yaml Deployment agent-worker '{ name: SANDBOX_MODE, value: "vcluster" }' "vcluster"
for a in api worker web; do hasnt app.yaml Deployment "$a" SANDBOX_MODE "vcluster"; done
for bad in "--set agentRemediation.sandboxMode=vcluster" "${ON[*]} --set agentRemediation.sandboxMode=vcluster" "--set agentRemediation.sandboxMode=k3d"; do
  # shellcheck disable=SC2086
  if helm template platform "$CHART" -n platform "${IMG[@]}" $bad >/dev/null 2>&1; then echo "FAIL '$bad' 인데 렌더가 됐다"; fail=1; fi
done
if ! helm template platform "$CHART" -n platform "${IMG[@]}" "${ON[@]}" --set sandbox.rehearsal=null --set agentRemediation=null >/dev/null 2>&1; then
  echo "FAIL sandbox.rehearsal·agentRemediation 칸이 없는 릴리스 값으로 렌더가 안 된다"; fail=1
fi
[ $fail -eq 0 ] && echo "ok   리허설·런타임·AI 점검 GitOps 읽기·AI 점검 샌드박스 (값 없음·켬·sandbox·gVisor 없이 거부·예전 릴리스 값)"
# 흉내 트래픽 (values traffic.mock): 기본은 아무 데도 MOCK_TRAFFIC 없음, 켜면 worker 에만, traffic 칸이 없는 릴리스 값으로도 렌더
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}")
for a in api worker agent-worker web; do hasnt app.yaml Deployment "$a" MOCK_TRAFFIC "traffic.mock 기본"; done
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set traffic.mock=true)
has app.yaml Deployment worker '{ name: MOCK_TRAFFIC, value: "1" }' "traffic.mock 켬"
for a in api agent-worker web; do hasnt app.yaml Deployment "$a" MOCK_TRAFFIC "traffic.mock 켬"; done
if ! helm template platform "$CHART" -n platform "${IMG[@]}" --set traffic=null >/dev/null 2>&1; then echo "FAIL traffic 칸이 없는 릴리스 값으로 렌더가 안 된다"; fail=1; fi
# 환경 층 자동 (values envLayer.auto): 같은 규칙
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}")
for a in api worker agent-worker web; do hasnt app.yaml Deployment "$a" ENV_LAYER_AUTO "envLayer.auto 기본"; done
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set envLayer.auto=true)
has app.yaml Deployment worker '{ name: ENV_LAYER_AUTO, value: "1" }' "envLayer.auto 켬"
for a in api agent-worker web; do hasnt app.yaml Deployment "$a" ENV_LAYER_AUTO "envLayer.auto 켬"; done
if ! helm template platform "$CHART" -n platform "${IMG[@]}" --set envLayer=null >/dev/null 2>&1; then echo "FAIL envLayer 칸이 없는 릴리스 값으로 렌더가 안 된다"; fail=1; fi
[ $fail -eq 0 ] && echo "ok   흉내 트래픽·환경 층 자동 (값 없음·켬·예전 릴리스 값)"
# worker Terraform 디스크: 값이 없으면 아무것도 안 그린다, 켜면 worker 에만 붙는다, worker 가 2개면 렌더 실패
if grep -qE 'worker-tf-work|TF_WORK_DIR|type: Recreate' <<<"$(helm template platform "$CHART" -n platform "${IMG[@]}")"; then
  echo "FAIL tfWorkDir 값 없이 디스크가 그려졌다"; fail=1
fi
TFD=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set apps.worker.replicas=1 --set apps.worker.tfWorkDir.size=20Gi)
[ "$(printf '%s\n' "$TFD" | grep -c 'claimName: worker-tf-work')" = 1 ] || { echo "FAIL 디스크는 worker 하나에만 붙어야 한다"; fail=1; }
contains "$TFD" 'name: TF_WORK_DIR, value: /var/lib/svc-tf' || { echo "FAIL TF_WORK_DIR 이 디스크를 가리키지 않는다"; fail=1; }
contains "$TFD" 'type: Recreate' || { echo "FAIL 디스크를 켰는데 Recreate 가 아니다"; fail=1; }
if helm template platform "$CHART" -n platform "${IMG[@]}" --set apps.worker.tfWorkDir.size=20Gi >/dev/null 2>&1; then
  echo "FAIL worker 2개에 디스크를 켰는데 렌더가 됐다"; fail=1
fi
[ $fail -eq 0 ] && echo "ok   worker Terraform 디스크 (값 없음·worker 만·2개 거부)"
# Argo CD 허브 역할 (values argocd.hubRoleArn): 값 없으면 안 그린다, 있으면 api·worker 에만, 역할 ARN 이 아니면 렌더 실패, 칸 없는 릴리스 값으로도 렌더
HUB=arn:aws:iam::000000000000:role/platform-argocd-hub
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}")
for a in api worker agent-worker web; do hasnt app.yaml Deployment "$a" ARGO_HUB_ROLE_ARN "허브 기본"; done
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set "argocd.hubRoleArn=$HUB")
for a in api worker; do has app.yaml Deployment "$a" "{ name: ARGO_HUB_ROLE_ARN, value: \"$HUB\" }" "허브 켬"; done
for a in agent-worker web; do hasnt app.yaml Deployment "$a" ARGO_HUB_ROLE_ARN "허브 켬"; done
for bad in "arn:aws:iam::000000000000:user/x" "platform-argocd-hub"; do
  if helm template platform "$CHART" -n platform "${IMG[@]}" --set "argocd.hubRoleArn=$bad" >/dev/null 2>&1; then echo "FAIL argocd.hubRoleArn='$bad' 인데 렌더가 됐다"; fail=1; fi
done
if ! helm template platform "$CHART" -n platform "${IMG[@]}" --set argocd.hubRoleArn=null >/dev/null 2>&1; then
  echo "FAIL argocd.hubRoleArn 칸이 없는 릴리스 값으로 렌더가 안 된다"; fail=1
fi
[ $fail -eq 0 ] && echo "ok   Argo CD 허브 역할 (값 없음·api·worker 만·틀린 모양 거부·예전 릴리스 값)"
# 비밀 아닌 설정 (values apps.<이름>.env): 값 없으면 아무 데도 없다 / 준 앱에만, 차트 env 뒤에 / 차트가 넣는 이름·그 앱 비밀 이름·비밀처럼 보이는 이름은 렌더 실패 / 칸 없는 릴리스 값으로도 렌더
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}")
for a in api worker agent-worker web; do hasnt app.yaml Deployment "$a" "values apps.$a.env" "env 기본"; done
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set traffic.mock=true \
  --set apps.worker.env.INVENTORY_TIMEOUT_MS=30000 --set apps.worker.env.STEP_CONCURRENCY=5 --set apps.web.env.WEB_ONLY=1)
printf '%s\n' "$DOC" > "$OUT/app-env-on.yaml"
kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT/app-env-on.yaml"
has app.yaml Deployment worker '{ name: INVENTORY_TIMEOUT_MS, value: "30000" }' "env"
has app.yaml Deployment worker '{ name: STEP_CONCURRENCY, value: "5" }' "env"
has app.yaml Deployment web '{ name: WEB_ONLY, value: "1" }' "env"
for a in api agent-worker web; do hasnt app.yaml Deployment "$a" STEP_CONCURRENCY "env (worker 만)"; done
for a in api worker agent-worker; do hasnt app.yaml Deployment "$a" WEB_ONLY "env (web 만)"; done
order=$(part app.yaml Deployment worker | grep -oE 'name: (WORKER_METRICS_PORT|MOCK_TRAFFIC|INVENTORY_TIMEOUT_MS|STEP_CONCURRENCY),' | tr -d ',' | awk '{printf "%s ", $2}')
[ "$order" = "WORKER_METRICS_PORT MOCK_TRAFFIC INVENTORY_TIMEOUT_MS STEP_CONCURRENCY " ] || { echo "FAIL env 순서 (차트 env 뒤에 와야 한다): $order"; fail=1; }
# 값 파일의 큰 정수는 float64 로 들어온다. "1e+06" 이 아니라 "1000000". 앞서 준 이름은 null 로 뺀다 (릴리스 값 + --set X=null 과 같은 모양)
printf 'apps:\n  worker:\n    env:\n      INVENTORY_TIMEOUT_MS: 1000000\n      STEP_CONCURRENCY: 5\n' > "$OUT/env-values.yaml"
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" -f "$OUT/env-values.yaml" --set apps.worker.env.STEP_CONCURRENCY=null)
has app.yaml Deployment worker '{ name: INVENTORY_TIMEOUT_MS, value: "1000000" }' "env 값 파일 정수"
hasnt app.yaml Deployment worker STEP_CONCURRENCY "env null 로 빼기"
# 차트가 넣는 이름은 템플릿에서 뽑는다: env 블록에 이름을 더하고 금지 목록에 안 더하면 여기서 걸린다
chartEnv=$(grep -oE '^ +- \{ name: [A-Z_]+,' "$CHART/templates/app.yaml" | awk '{print $4}' | tr -d ',' | sort -u)
grep -qx HOME <<<"$chartEnv" && grep -qx ENV_LAYER_AUTO <<<"$chartEnv" || { echo "FAIL 템플릿에서 차트 env 이름을 못 뽑았다"; fail=1; }
bad=()
for k in $chartEnv; do bad+=("apps.worker.env.$k=x"); done
# 그 앱 비밀 이름 / 비밀처럼 보이는 이름 / 소문자 / 맵·목록 값
bad+=(apps.worker.env.GITOPS_PUSH=1 apps.api.env.PUBLIC_API_URL=x apps.agent-worker.env.DATABASE_URL=x
  apps.worker.env.GITHUB_TOKEN=x apps.web.env.CLIENT_SECRET=x apps.worker.env.DB_PASSWORD=x apps.api.env.SIGNING_KEY=x
  apps.web.env.DATABASE_URL=x apps.worker.env.OWNER_DATABASE_URL=x apps.worker.env.step_concurrency=5 'apps.worker.env.STEP_CONCURRENCY[0]=5')
for b in "${bad[@]}"; do
  if helm template platform "$CHART" -n platform "${IMG[@]}" --set "$b" >/dev/null 2>&1; then echo "FAIL --set $b 인데 렌더가 됐다"; fail=1; fi
done
if helm template platform "$CHART" -n platform "${IMG[@]}" --set agentRemediation.gitopsRead=true --set apps.agent-worker.env.GITOPS_REPO_URL=x >/dev/null 2>&1; then
  echo "FAIL agentRemediation.gitopsRead 로 비밀이 된 GITOPS_REPO_URL 을 agent-worker env 로 받았다"; fail=1
fi
if ! helm template platform "$CHART" -n platform "${IMG[@]}" --set apps.api.env=null --set apps.worker.env=null --set apps.agent-worker.env=null --set apps.web.env=null >/dev/null 2>&1; then
  echo "FAIL apps.<이름>.env 칸이 없는 릴리스 값으로 렌더가 안 된다"; fail=1
fi
[ $fail -eq 0 ] && echo "ok   앱 비밀 아닌 env (값 없음·준 앱만·차트 env 뒤·금지 이름 ${#bad[@]}개 거부·예전 릴리스 값)"
# worker 크기: 기본 requests 500m·512Mi, 상한 2Gi. 값으로 바꿀 수 있다
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}")
res=$(part app.yaml Deployment worker | awk '/^          resources:/{f=1;next} f&&/^          [a-z]/{exit} f' | tr -d ' \n')
[ "$res" = "limits:memory:2Girequests:cpu:500mmemory:512Mi" ] || { echo "FAIL worker 기본 resources: $res"; fail=1; }
DOC=$(helm template platform "$CHART" -n platform "${IMG[@]}" --set apps.worker.resources.requests.cpu=250m)
has app.yaml Deployment worker 'cpu: 250m' "worker resources 값"
[ $fail -eq 0 ] && echo "ok   worker 크기 (기본 500m·512Mi·상한 2Gi, 값으로 바꿈)"
exit $fail

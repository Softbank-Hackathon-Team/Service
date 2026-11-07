# syntax=docker/dockerfile:1.7
# 서버 앱 3개(api · worker · agent-worker) 운영 이미지와 온프레 Agent 이미지를 한 파일로 만든다 (Z75-17, W1). 빌드 문맥 = Service 루트
#   docker build -f deploy/docker/Dockerfile --target api          -t svc-api:dev .
#   docker build -f deploy/docker/Dockerfile --target worker       -t svc-worker:dev .
#   docker build -f deploy/docker/Dockerfile --target agent-worker -t svc-agent-worker:dev .
#   docker build -f deploy/docker/Dockerfile --target onprem-agent -t svc-onprem-agent:dev .   (고객 온프레 클러스터에서 도는 Agent)
# 단계: manifests(package.json만) → deps(npm ci, 셋이 같이 씀) → src → build-<앱>(esbuild 묶음) → <앱>(묶음 파일만)
# 이미지는 여전히 3개다. 앱마다 필요한 것만 담는다(api: 권한 파일·차트, worker: git·권한 파일, agent-worker: 묶음만)
# 예전엔 apps/<앱>/Dockerfile 3개에 같은 앞 단계 35줄이 세 번 있었다. 앞 단계를 고치면 세 곳을 같이 고쳐야 했다
# DRAFT(ai): 런타임에 node_modules 없음. 외부 패키지까지 main.mjs 하나에 묶는다(deploy/docker/bundle.mjs)
ARG NODE_IMAGE=node:22.23.4-alpine3.24
# worker 의 git. 바탕(alpine 3.24)과 같은 alpine 판으로 만든 공식 git 이미지에서 꺼내 온다 (apk 저장소에 안 닿아도 빌드된다)
ARG GIT_IMAGE=alpine/git:v2.54.0
# worker 의 crane (리허설 이미지 복사, apps/worker/src/rehearsal/image-mirror.ts). 공식 이미지의 정적 바이너리 하나만 꺼내 온다
#   판 v0.22.1, 다이제스트 = 여러 아키텍처 index (amd64·arm64 둘 다 같은 고정값으로 받는다)
ARG CRANE_IMAGE=gcr.io/go-containerregistry/crane:v0.22.1@sha256:1f968817b95790bed063f71175aa6b8ff879fa17064020415f3e18bb6e6a36e1
# W1: 온프레 Agent 의 kubectl. 공식 이미지(registry.k8s.io/kubectl)의 정적 바이너리 /bin/kubectl 하나만 꺼내 온다
#   판 v1.36.5 = 시연 온프레 k3s(v1.36.5+k3s1)와 같은 판. kubectl 은 서버와 위아래 1 minor 까지 지원한다
#   다이제스트 = 여러 아키텍처 index (amd64·arm64 둘 다 같은 고정값으로 받는다)
# DRAFT(ai): 고객 k3s 판이 1.35 미만·1.37 초과면 이 판을 같이 올려야 한다
#   agent-worker 의 KUBECTL_IMAGE(플랫폼 EKS 판)와 따로 둔다. 고객 클러스터 판에 맞추기 때문이다
ARG ONPREM_KUBECTL_IMAGE=registry.k8s.io/kubectl:v1.36.5@sha256:0667e3f3e6ef435d7cd4c16684244703ebd67314c17511c2a9f87ea44f6cdf6b
# agent-worker 의 helm (vCluster 차트를 sbx-* 네임스페이스에 올린다). git 과 같은 방식으로 이미지에서 꺼낸다. 다이제스트 고정
ARG HELM_IMAGE=alpine/helm:3.22.1@sha256:8191701ad1f82ee3695c87211fcbfe6d7b1bb7df92ac1c8de9ccdb0995a6a2c1
# agent-worker 의 kubectl (플랫폼 클러스터 밖에서 돌 때 가상 API 로 port-forward). helm 과 같은 방식, 다이제스트 고정. 플랫폼 EKS 1.35 와 같은 마이너
ARG KUBECTL_IMAGE=registry.k8s.io/kubectl:v1.35.10@sha256:4e1d541a3d62f74637974e4c71f3cea91b9a36ffd059ab45e355648898783837
# worker 의 gcloud (GCP 출발 가져오기: projects describe·container clusters list·get-credentials). 진짜 플랫폼 worker 에 클라우드 CLI 가 없어
#   출발이 무엇이든 가져오기가 IMPORT_SOURCE_UNAVAILABLE 로 멈췄다 (2026-11-05 실측). 공식 alpine 판은 musl 용 python 을 SDK 안에 담고 있어 바탕에 python 을 따로 안 넣는다
#   판 592.0.0, 다이제스트 = 여러 아키텍처 index (amd64·arm64)
ARG GCLOUD_IMAGE=gcr.io/google.com/cloudsdktool/google-cloud-cli:592.0.0-alpine@sha256:9040d28a6512f32c495322a3af6ea000f803a0ae001cec055937154efe5a2230
# worker 의 terraform (도착 자원 만들기·지우기: packages/adapters/src/terraform/real-runner.ts). 없으면 aws·gcp·onprem apply 가 TF_BIN_MISSING 으로 멈춘다
#   (2026-11-05 플랫폼 worker 시작 로그 "terraform 실행 파일 없음"). helm 과 같은 방식으로 공식 이미지에서 정적 바이너리만 꺼낸다
#   판 1.16.4 = 모듈 required_version ">= 1.11" 을 만족하고 개발에서 쓰는 판. 다이제스트 = 여러 아키텍처 index (amd64·arm64)
ARG TERRAFORM_IMAGE=hashicorp/terraform:1.16.4@sha256:985cdc6c1d9b0a65b83377f666efd2f740b47f02ac55be1ced3d18f7d3b0e829
# worker 의 aws CLI (AWS 출발 가져오기·STS). 공식 설치본은 glibc 전용이라 musl 바탕에서 못 돈다 → alpine community 패키지
# DRAFT(ai): 2.34 계열로 고정. alpine 저장소는 같은 가지의 최신 판만 남겨서 정확한 판(-rN)으로 묶으면 나중에 빌드가 깨진다
ARG AWS_CLI_APK=aws-cli~2.34

FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
# 워크스페이스 package.json 만 남긴다 → 소스가 바뀌어도 npm ci 층은 캐시에서 재사용
# hadolint ignore=SC2016
RUN mkdir -p /out && cp package.json package-lock.json /out/ \
 && find . -name package.json -not -path "*/node_modules/*" -not -path "./package.json" \
      -exec sh -c 'for f; do mkdir -p "/out/${f%/*}" && cp "$f" "/out/$f"; done' _ {} +

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY --from=manifests /out/ ./
# 회사망처럼 TLS 를 가로채는 프록시 뒤라면 CA 를 비밀 마운트로 준다(없으면 건너뜀)
#   docker build --secret id=extra_ca,src=/경로/ca.crt ...
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
 && npm ci --no-audit --no-fund --ignore-scripts

# 묶음에 들어가는 원본. 앱별 build 단계는 자기 앱 폴더만 복사해서, 다른 앱 원본이 바뀌어도 이 앱 묶음은 캐시를 쓴다
FROM deps AS src
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY deploy/docker ./deploy/docker

FROM src AS build-api
COPY apps/api ./apps/api
# 문서 화면(/api/v1/docs/ui)용 명세. 이 층에서 코드로 만들고 bundle.mjs 가 dist/api/docs/ 로 복사한다 (Z51, Z75-02)
COPY tools/openapi ./tools/openapi
RUN npx tsx tools/openapi/gen-openapi.ts \
 && node deploy/docker/bundle.mjs api

FROM src AS build-worker
COPY apps/worker ./apps/worker
RUN node deploy/docker/bundle.mjs worker

FROM src AS build-agent-worker
COPY apps/agent-worker ./apps/agent-worker
RUN node deploy/docker/bundle.mjs agent-worker

# W1: 온프레 Agent 는 tools/onprem-agent.ts 하나가 진입점 (@svc/agent 의 kubectl 모으기 + 서명 보내기)
FROM src AS build-onprem-agent
COPY tools/onprem-agent.ts ./tools/onprem-agent.ts
RUN node deploy/docker/bundle.mjs onprem-agent

# git 과 git 이 쓰는 공유 라이브러리만 /out 에 모은다 (ldd 로 찾은 것 + 심볼릭 링크의 실제 파일)
FROM ${GIT_IMAGE} AS git
# SC2046: $(cat /tmp/libs) 는 파일 목록이라 일부러 쪼갠다 (따옴표로 묶으면 한 파일 이름이 된다)
# hadolint ignore=SC2016,SC2046,DL4006
RUN set -e; mkdir -p /out; \
    files="/usr/bin/git $(find /usr/libexec/git-core -type f)"; \
    libs=$(for f in $files; do ldd "$f" 2>/dev/null || true; done | awk '/=>/ {print $3}' | sort -u); \
    for l in $libs; do echo "$l"; readlink -f "$l"; done | sort -u > /tmp/libs; \
    tar -cf - /usr/bin/git /usr/libexec/git-core /usr/share/git-core $(cat /tmp/libs) 2>/dev/null | tar -xf - -C /out

FROM ${CRANE_IMAGE} AS crane
FROM ${HELM_IMAGE} AS helm
FROM ${TERRAFORM_IMAGE} AS terraform
# #373 B1: worker 가 이전마다 돌리는 terraform init 의 provider 를 빌드 때 한 번만 받아 둔다
#   (진짜 플랫폼 실측 onprem→AWS: init 10.6초. 이전마다 aws provider(풀면 약 800MB)를 받아 풀고, 작업 폴더마다 그 복사본이 남았다)
#   루트 모듈 잠금 파일(infra/modules/*/root, gcp/env 의 .terraform.lock.hcl)에 적힌 판·해시 그대로 받는다. 잠금 파일만 복사 → 모듈 *.tf 를 고쳐도 이 층은 캐시
#   DRAFT(ai): 미러 자리 /opt/terraform/providers, 잠금 파일 해시는 linux_amd64(이미지)·linux_arm64(arm 노드·로컬 도커)·darwin_arm64(개발 맥) 몫
#   잠금 파일 다시 만들기: 실행기 모양으로 펼친 폴더에서 terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
#     (packages/adapters/test/b1-provider-mirror.test.ts 가 모듈 제약과 잠금 파일이 어긋나면 알려 준다)
FROM ${TERRAFORM_IMAGE} AS tf-providers
COPY deploy/docker/terraform/fetch-providers.sh /tf/fetch-providers.sh
COPY infra/modules/aws/root/.terraform.lock.hcl /tf/locks/aws-root.lock.hcl
COPY infra/modules/gcp/root/.terraform.lock.hcl /tf/locks/gcp-root.lock.hcl
COPY infra/modules/onprem/root/.terraform.lock.hcl /tf/locks/onprem-root.lock.hcl
COPY infra/modules/gcp/env/.terraform.lock.hcl /tf/locks/gcp-env.lock.hcl
RUN sh /tf/fetch-providers.sh /out/providers /tf/locks/*.lock.hcl
FROM ${KUBECTL_IMAGE} AS kubectl
FROM ${ONPREM_KUBECTL_IMAGE} AS onprem-kubectl
# GKE 클러스터 kubeconfig(get-credentials)는 gke-gcloud-auth-plugin 을 부른다. 기본 묶음에 없어 여기서 더한다.
#   bq·gsutil 은 가져오기가 안 쓴다 → 뺀다 (약 80MB). __pycache__ 는 남긴다 (worker 뿌리 파일 시스템이 읽기 전용이라 실행 때 못 만든다)
FROM ${GCLOUD_IMAGE} AS gcloud
RUN gcloud components install gke-gcloud-auth-plugin --quiet \
 && gcloud components remove bq gsutil --quiet \
 && rm -rf /google-cloud-sdk/.install/.backup \
 && gke-gcloud-auth-plugin --version

# 세 이미지 공통 바탕
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "main.mjs"]

FROM runtime AS api
ENV API_PORT=3000
# Z47: 컨테이너 안에서는 모든 주소에 붙어야 web·healthcheck 가 닿는다 (코드 기본값은 localhost)
ENV API_HOST=0.0.0.0
# Z66(3차): 보안 표가 읽는 최소 권한 파일·앱 차트. 묶음 파일 하나에는 안 들어가서 따로 복사.
#   없으면 apps/api/src/security/load.ts 가 못 읽어 "정적" 근거·LP-AWS-BOUNDARY 가 비고 prod e2e 2건 실패
COPY infra/permissions /app/infra/permissions
COPY gitops/charts /app/gitops/charts
# 온프레 설치 한 줄이 받는 파일 (routes/onprem-install.ts, GET /api/v1/install/onprem*). 레포와 같은 상대 경로로 둔다
COPY tools/onprem-bootstrap.sh tools/onprem-install.sh tools/argocd-core-install-v2.13.3.yaml tools/sealed-secrets-controller-v0.40.0.yaml tools/onprem-argocd-health.yaml tools/cnpg-1.30.1.yaml tools/external-secrets-2.14.0.tgz /app/onprem-bundle/tools/
COPY deploy/helm/onprem-agent /app/onprem-bundle/deploy/helm/onprem-agent
ENV PERMISSIONS_DIR=/app/infra/permissions
ENV CHART_DIR=/app/gitops/charts/app
# 팀 가입 명부 (routes/signup.ts, apps/api/src/auth/team-registry.ts). 없거나 틀리면 가입만 꺼진다. 자리를 열면 이미지를 다시 빌드한다
COPY docs/team-env/registry.yaml /app/team-env/registry.yaml
ENV TEAM_REGISTRY_PATH=/app/team-env/registry.yaml
# 파일 주인은 root(읽기만 가능) → 앱이 자기 코드를 못 바꾼다
COPY --from=build-api /src/dist/api/ ./
# 이미지에 들어 있는 node 사용자(uid 1000). 루트로 돌지 않는다
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.mjs", "http://127.0.0.1:3000/healthz"]

FROM runtime AS runtime-git
# git 을 쓰는 두 앱의 바탕: worker = gitops 배포(N2), agent-worker = AI 점검이 gitops 레포를 읽기 토큰으로 clone
# Z75: apk add 대신 git 단계에서 복사(패키지 서버가 막힌 곳에서도 빌드됨). 바탕에 이미 있는 라이브러리(libz·libssl 등)는 덮어쓰지 않는다.
#      층에 임시 파일이 안 남게 bind 로 붙인다. WITH_GIT=0 은 git 없이 만드는 검증용(4차 apps/worker/Dockerfile 과 같은 뜻, 기본 1)
ARG WITH_GIT=1
# DL3003: /g 는 이 RUN 동안만 붙는 마운트라 WORKDIR 로 못 간다. DL4006: 마지막 줄은 grep 결과만 본다(! 로 뒤집음, pipefail 이면 ldd 실패에 뒤집혀 통과해 버린다)
# hadolint ignore=SC2044,DL3003,DL4006
RUN --mount=type=bind,from=git,source=/out,target=/g set -e; [ "$WITH_GIT" = "1" ] || exit 0; cd /g; \
    for f in $(find . -type f -o -type l); do \
      [ -e "/$f" ] || [ -L "/$f" ] || { mkdir -p "/${f%/*}"; cp -a "$f" "/$f"; }; \
    done; git --version; \
    # R7-3: https(push·clone)는 git-remote-https 가 libcurl 사슬을 따로 읽는다. 빠진 라이브러리가 있으면 빌드에서 멈춘다
    ! ldd /usr/libexec/git-core/git-remote-https 2>&1 | grep -q "not found"

FROM runtime-git AS worker
# gitops 배포(N2)는 git 명령을 부른다. 묶음 렌더(gitops 레포 tools/render.mjs)는 helm template 을 부른다 → helm 은 아래 crane 다음에 넣는다
# 리허설 이미지 복사 도구. 정적 Go 바이너리라 라이브러리가 필요 없다 (TLS 루트는 바탕의 /etc/ssl/certs)
COPY --from=crane /ko-app/crane /usr/local/bin/crane
# 묶음 렌더 도구. gitops 레포 tools/lib.mjs 가 helm template 을 부른다 (apps/worker/src/gitops/repo.ts tool("render.mjs")).
#   배포 커밋과 리허설이 같은 렌더를 쓴다. agent-worker 와 같은 helm 단계(다이제스트 고정), 정적 Go 바이너리
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
RUN helm version --short
COPY --from=terraform /bin/terraform /usr/local/bin/terraform
RUN terraform version
# 가져오기(discover)·사전 점검·역할 빌리기가 부르는 클라우드 CLI (packages/adapters/src/discover/index.ts, precheck/cloud-precheck.ts)
#   kubectl = EKS·GKE 안의 Deployment·Service 읽기 (플랫폼 EKS 와 같은 판 단계를 같이 쓴다)
#   설정·캐시는 HOME(/tmp, 차트가 emptyDir 로 준다) 아래에 쓴다. 사용 통계·업데이트 확인은 끈다 (바깥으로 나가는 호출을 줄인다)
COPY --from=gcloud /google-cloud-sdk /opt/google-cloud-sdk
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
ENV PATH=/opt/google-cloud-sdk/bin:$PATH \
    CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true \
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true \
    AWS_CLI_AUTO_PROMPT=off
ARG AWS_CLI_APK
# openssl = 이전별 CNPG 서버 인증서 발급 (apps/worker/src/gitops/migration-secrets.ts issueServerCert). Node 에 X.509 만드는 API 가 없다
# hadolint ignore=DL3018
RUN apk add --no-cache "$AWS_CLI_APK" openssl \
 && aws --version && gcloud --version >/dev/null && kubectl version --client >/dev/null && gke-gcloud-auth-plugin --version >/dev/null \
 && openssl version
# 최소 권한 파일(J2): 묶음 파일 하나에는 안 들어가서 따로 복사. 없으면 실행 역할 발급이 전부 거부된다
COPY infra/permissions /app/infra/permissions
ENV PERMISSIONS_DIR=/app/infra/permissions
# #373 B1: 구운 provider 미러 + CLI 설정 (잘 안 바뀌는 gcloud·aws CLI 층 뒤에 둔다). 미러에 있으면 작업 폴더에 링크만 걸고(복사 0), 없는 provider·판만 레지스트리에서 받는다 (terraformrc 주석)
#   실행기 childEnv 가 TF_CLI_CONFIG_FILE 을 terraform 에 넘긴다 (packages/adapters/src/terraform/real-runner.ts PASS_ENV)
COPY deploy/docker/terraform/terraformrc deploy/docker/terraform/offline.tfrc deploy/docker/terraform/selfcheck.sh /opt/terraform/
COPY --from=tf-providers /out/providers /opt/terraform/providers
ENV TF_CLI_CONFIG_FILE=/opt/terraform/terraformrc
# terraform 모듈 (infra/modules/<환경>/{root,kinds,app}). 실행기가 이전마다 TF_WORK_DIR 로 복사해서 돈다.
#   묶음(dist/worker)은 레포 뿌리를 import.meta.url 로 못 찾으므로 경로를 env 로 준다. state·tfvars·.terraform 은 .dockerignore 가 뺀다
COPY infra/modules /app/infra/modules
# #373 B1: 네트워크 없이 미러만으로 루트 모듈 전부 init 되는지 빌드에서 확인 (잠금 파일 판·해시나 모듈 제약이 미러와 어긋나면 여기서 멈춘다)
#   임시 폴더는 tmpfs 라 층에 아무것도 안 남는다
RUN --network=none --mount=type=tmpfs,target=/tmp sh /opt/terraform/selfcheck.sh
# 환경 층(gcp/env)이 ${path.module}/../../../charts/cluster-secret-store 를 쓴다 → 모듈과 같은 깊이에 차트도 (worker env-layer.ts 가 작업 폴더로 복사)
COPY infra/charts /app/infra/charts
ENV TF_MODULE_ROOT=/app/infra/modules
COPY --from=build-worker /src/dist/worker/ ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.mjs", "db"]

FROM runtime-git AS agent-worker
# git: AI 점검(remediate)이 gitops 레포를 clone 해 작업 복사본을 만든다 (values agentRemediation.gitopsRead)
# vCluster 리허설: helm·kubectl(정적 바이너리) + 차트 묶음·CRD (apps/agent-worker/vendor). 체크섬이 다르면 빌드가 멈춘다
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY apps/agent-worker/vendor /app/vendor
WORKDIR /app/vendor
RUN sha256sum -c SHA256SUMS && helm version --short && kubectl version --client
WORKDIR /app
COPY --from=build-agent-worker /src/dist/agent-worker/ ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.mjs", "db"]

# W1: 고객 온프레 클러스터에서 도는 Agent. 클러스터를 읽고(kubectl) 서명한 보고를 플랫폼 API 로 보낸다 (밖으로 443 만)
#   클러스터 안에서는 kubectl 이 파드의 ServiceAccount 토큰으로 자동 인증한다 (kubeconfig 를 넣지 않는다)
#   필요한 환경변수: AGENT_REPORT_URL, AGENT_KEY_ID, AGENT_KEY_SECRET (키 두 개는 Secret 에서. 설치 차트 W2)
#   읽기 전용 루트 파일시스템으로 돌려도 된다: 쓰는 곳이 없다 (--enroll 은 --out 을 쓰기 가능한 마운트로 준다)
#   docker run --rm svc-onprem-agent:dev --help
FROM runtime AS onprem-agent
COPY --from=onprem-kubectl /bin/kubectl /usr/local/bin/kubectl
# 고객이 받는 공개 이미지(GHCR)다 → 소스맵(main.mjs.map, 원본 소스·주석 전체)은 넣지 않는다. 오류 줄 번호는 main.mjs 기준
COPY --from=build-onprem-agent /src/dist/onprem-agent/main.mjs ./
COPY --from=build-onprem-agent /src/dist/onprem-agent/data ./data
USER node
ENTRYPOINT ["node", "main.mjs"]
# 10초마다 heartbeat·deploy 보고, security·facts·inventory 는 약 300초마다 (tools/onprem-agent.ts loop, #373 A3). 설치 차트는 agent.every 로 덮는다
CMD ["loop", "--every", "10"]

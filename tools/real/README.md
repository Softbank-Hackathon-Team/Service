# tools/real — 실클라우드 한 회차 실측 흐름 (레포 안 판)

상태: AI 초안

| 항목 | 내용 |
|---|---|
| 목적 | 진짜 클라우드(AWS 출발 EKS·ECS → GCP 도착)로 연결·가져오기·계획·이전 한 회차를 돌리고 단계마다 시각·결과를 표로 남긴다 |
| 받는 것 | 레포 루트 `.env`, `$HOME/.svc-tf/demo-day/demo-day.env`(demo-day up 이 씀), AWS·gcloud 로그인 |
| 넘기는 것 | `$RESULTS_DIR`(기본 `$HOME/.svc-tf/real-results`, 레포 밖)/real-<시각>.md 와 같은 이름 폴더(가린 로그·명세·계획서) |
| 부작용 | API·워커 재시작, AWS 연결 스택(CloudFormation), GCP IAM(회사 SA·연결 SA·바인딩), 샘플 앱 배포. **terraform apply/destroy 는 안 친다**(올리기·내리기는 `sh tools/jeong-up.sh`·`sh tools/jeong-down.sh`) |
| 실패 | 단계 이름과 rc 를 표에 적고 멈춤. up 뒤 실패면 감시 창이 읽는 `$STATE/auto-fail` 신호를 남김 |

## 사용

```sh
bash tools/real/real-session.sh              # 이 레포로 처음부터
bash tools/real/real-session.sh "" import    # 이어서 (단계: pre up deploy connect import ecs-up ecs-import ecs-down run down zero)
```

예전 `mac/real-session.sh`(레포 밖 사본)와 흐름이 같다. 차이는 대조·흐름 스크립트를 `.m-import`·`.real` 로 복사하지 않고 이 폴더 것을 바로 쓰는 것, 결과 폴더가 레포 밖 `$HOME/.svc-tf/real-results` 인 것.

## 파일

| 파일 | 하는 일 |
|---|---|
| real-session.sh | 한 회차 순서. connect 단계는 AWS 출발(연결 스택 이어 쓰기·충돌 정리) 다음 GCP 도착(CON-01, `tools/gcp-connect-real.sh`) |
| m-import/api-flow.ts | 이전 만들기(출발 범위 `sourceScope` 포함, IR-04) → spec_review → 계획 → awaiting_approval. 승인은 안 함 |
| m-import/check-import.ts | 가져온 IR v2 를 샘플 3티어 규칙과 대조 (표) |
| m-import/render-v2.ts | IR v2 → 도착별 Builder 산출물 |
| m-import/scope.ts | 환경변수(MI_NAMESPACES 등) → sourceScope |
| flow/real-flow.ts | 승인 → 이전 → 컨트롤 끝까지 |
| flow/ecs-check.ts | ECS 출발 IR 대조 |
| mask.sh · mask-test.sh | 결과에 쓰기 전 계정·키·토큰 가림과 그 시험 |
| test-connect-reuse.sh | connect 단계 시나리오 시험(가짜 npm·aws·gcloud) |

시험은 `npm test` 에 들어 있다: `apps/api/test/real-*.test.ts`.

## 끄기·바꾸기 (환경변수)

- `REAL_GCP_CONNECT=0` GCP 도착을 진짜로 연결하지 않고 시드 환경(흉내 발급)을 씀
- `REAL_CONNECT_RUN=0` AWS 연결 스택을 CLI 로 만들지 않고 링크만 찍음(이때 S3 템플릿을 `tools/connect-template-sync.sh` 로 맞춤)
- `REAL_RUN_PREFIX=dev` 워커·API 를 watch 모드로(코드를 고치며 돌릴 때만). 기본은 `start:*`, 없는 판이면 `dev:*`
- `MI_TARGET_ENV` 도착 환경 번호를 직접 줌

## 앱 비밀 값 (APP-20)

플랫폼은 비밀 값을 복사하지 않는다(ADR-072). 도착 terraform 이 비밀 저장소 항목(빈 껍데기)을 만든 뒤, 고객 자격으로:

```sh
python3 tools/secret-copy.py --to gcp --app <앱> --project <도착 프로젝트> --context <출발 kube 컨텍스트> --namespace <ns>
```

값은 kubectl → 이 프로세스 → gcloud/aws stdin 으로만 흐른다(화면·파일·명령줄 0). 같은 값이면 새 버전을 안 만든다.

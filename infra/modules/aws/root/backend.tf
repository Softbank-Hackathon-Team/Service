# backend 만 이 파일에 둔다. 실행기(real-runner)가 TF_STATE_BACKEND=s3 일 때 작업 폴더 안의 이 파일 하나만 s3 블록으로 덮어쓴다
# (backend 블록이 두 개면 init 실패). 원격 키·자격은 packages/adapters/src/terraform/state-backend.ts
terraform {
  # state 는 작업 폴더 바로 아래 (findWorkDir·destroy·list 가 지금 위치 그대로 찾게). 상대 경로는 -chdir=root 기준
  backend "local" {
    path = "../terraform.tfstate"
  }
}

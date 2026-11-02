# 원격 state: aws/bootstrap 의 장부 버킷. 첫 apply 전에 aws/bootstrap 이 apply 되어 있어야 한다
# - bucket·assume_role 은 init 때 준다: terraform init -backend-config=$HOME/.svc-tf/backend.hcl (값은 aws/bootstrap 출력)
# - use_lockfile = true: S3 파일로 잠금 (Terraform 1.10+). DynamoDB 잠금은 폐기 예정이라 안 쓴다
# - 모의 테스트는 terraform init -backend=false 로 돌아 이 설정을 쓰지 않는다
terraform {
  backend "s3" {
    key          = "service/aws-platform/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

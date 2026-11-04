# 원격 state: aws/bootstrap 의 장부 버킷. 첫 init 전에 aws/bootstrap 이 apply 되어 있어야 한다
# - 버킷 이름은 aws/bootstrap 의 var.bucket_name 기본값과 같아야 한다
# - use_lockfile = true: S3 파일로 잠금 (Terraform 1.10+). DynamoDB 잠금은 폐기 예정이라 안 쓴다
# - 모의 테스트는 terraform init -backend=false 로 돌아 이 설정을 쓰지 않는다
terraform {
  backend "s3" {
    bucket       = "sb-iron-platform-tfstate"
    key          = "service/aws-platform/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

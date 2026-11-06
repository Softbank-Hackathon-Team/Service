# bucket·prefix 는 init 때 받는다: terraform init -backend-config=bucket=<버킷> -backend-config=prefix=sample/gcp-source
terraform {
  backend "gcs" {}
}

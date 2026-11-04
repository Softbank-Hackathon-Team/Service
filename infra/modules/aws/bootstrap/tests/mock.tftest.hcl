# 진짜 AWS 없이 plan만: 장부 버킷 이름·보호 설정(퍼블릭 차단·버전 관리·암호화·수명 주기)
mock_provider "aws" {}
variables {
  expected_account_id = "123456789012"
}

run "bucket_protection" {
  command = plan
  assert {
    condition     = aws_s3_bucket.state.bucket == "sb-iron-platform-tfstate"
    error_message = "버킷 이름은 var.bucket_name 그대로여야 함"
  }
  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "장부 버킷은 퍼블릭 접근 차단 4개가 전부 켜져야 함"
  }
  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "장부 버킷은 버전 관리가 켜져야 함"
  }
  assert {
    condition     = aws_s3_bucket.state.force_destroy == false
    error_message = "장부 버킷은 안의 파일째 지울 수 없어야 함 (force_destroy=false)"
  }
  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : r.apply_server_side_encryption_by_default[0].sse_algorithm]) == "AES256"
    error_message = "장부 버킷은 SSE-S3 암호화를 명시해야 함"
  }
  assert {
    condition     = one([for r in aws_s3_bucket_lifecycle_configuration.state.rule : r.noncurrent_version_expiration[0].noncurrent_days]) == 30
    error_message = "비현재 버전은 30일 뒤 만료여야 함"
  }
}


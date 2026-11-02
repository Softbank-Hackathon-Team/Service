# 진짜 AWS 없이 plan만: 버킷 보호 설정 / 주체 목록 있음 / 주체 목록 비었음 세 갈래
mock_provider "aws" {}
variables {
  expected_account_id = "123456789012"
}

run "bucket_protection" {
  command = plan
  assert {
    condition     = aws_s3_bucket.state.bucket == "tfstate-123456789012"
    error_message = "버킷 이름은 <name>-<계정 번호>여야 함"
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

run "role_scoped_to_bucket" {
  command = plan
  assert {
    condition = jsonencode([for s in jsondecode(aws_iam_role_policy.tf_state.policy).Statement : s.Resource]) == jsonencode([
      "arn:aws:s3:::tfstate-123456789012",
      "arn:aws:s3:::tfstate-123456789012/*",
    ])
    error_message = "tf-state 역할은 장부 버킷과 그 안의 파일에만 권한이 있어야 함"
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.tf_state.policy).Statement : alltrue([for a in flatten([s.Action]) : startswith(a, "s3:")])])
    error_message = "tf-state 역할은 S3 밖 권한이 없어야 함"
  }
}

run "explicit_admins" {
  command = plan
  variables {
    state_admin_principal_arns = ["arn:aws:iam::123456789012:user/state-admin", "arn:aws:iam::123456789012:role/ops"]
  }
  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.tf_state.assume_role_policy).Statement[0].Principal.AWS) == jsonencode(["arn:aws:iam::123456789012:user/state-admin", "arn:aws:iam::123456789012:role/ops"])
    error_message = "주체 목록을 주면 신뢰 정책 주체가 그 목록과 같아야 함"
  }
}

run "empty_admins_fall_back_to_root" {
  command = plan
  assert {
    condition     = jsonencode(jsondecode(aws_iam_role.tf_state.assume_role_policy).Statement[0].Principal.AWS) == jsonencode(["arn:aws:iam::123456789012:root"])
    error_message = "주체 목록이 비면 신뢰 정책 주체는 계정 루트여야 함"
  }
}

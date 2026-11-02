# 진짜 AWS 없이 plan만: 클러스터 없음 / 있음 / 데모 파기 세 갈래
mock_provider "aws" {
  mock_data "aws_eks_cluster" {
    defaults = { vpc_config = [{ cluster_security_group_id = "sg-0cluster" }] }
  }
}
variables {
  expected_account_id = "123456789012"
  vpc_id              = "vpc-0abc"
  db_subnet_ids       = ["subnet-0a", "subnet-0c"]
}

run "no_cluster_defaults" {
  command = plan
  assert {
    condition     = length(aws_ecr_repository.app) == 4 && alltrue([for r in aws_ecr_repository.app : r.image_tag_mutability == "IMMUTABLE" && r.image_scanning_configuration[0].scan_on_push])
    error_message = "ECR 4개 모두 태그 변경 금지 + 올릴 때 스캔이어야 함"
  }
  assert {
    condition     = aws_db_instance.db.publicly_accessible == false && aws_db_instance.db.storage_encrypted == true && aws_db_instance.db.manage_master_user_password == true
    error_message = "플랫폼 DB는 사설·암호화·RDS 관리 비밀번호여야 함"
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.db_from_cluster) == 0
    error_message = "클러스터가 없으면 DB로 들어오는 길이 없어야 함"
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.evidence.block_public_policy == true && aws_s3_bucket_public_access_block.evidence.restrict_public_buckets == true
    error_message = "증거 버킷은 퍼블릭 접근을 전부 막아야 함"
  }
  assert {
    condition     = aws_s3_bucket_versioning.evidence.versioning_configuration[0].status == "Enabled"
    error_message = "증거 버킷은 버전 관리가 켜져야 함"
  }
  assert {
    condition     = aws_s3_bucket.evidence.force_destroy == false && aws_db_instance.db.skip_final_snapshot == false && alltrue([for r in aws_ecr_repository.app : r.force_delete == false])
    error_message = "기본값(deletion_protection=true)이면 버킷·DB·ECR 을 그냥 지울 수 없어야 함"
  }
}

run "with_cluster" {
  command = plan
  variables {
    cluster_name = "platform"
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_cluster[0].from_port == 5432 && aws_vpc_security_group_ingress_rule.db_from_cluster[0].referenced_security_group_id == "sg-0cluster"
    error_message = "클러스터가 있으면 클러스터 SG에서 5432만 열려야 함"
  }
}

run "demo_teardown" {
  command = plan
  variables {
    deletion_protection = false
  }
  assert {
    condition     = aws_s3_bucket.evidence.force_destroy == true && aws_db_instance.db.skip_final_snapshot == true && aws_db_instance.db.deletion_protection == false && alltrue([for r in aws_ecr_repository.app : r.force_delete == true])
    error_message = "deletion_protection=false 면 그날 지울 수 있어야 함"
  }
}

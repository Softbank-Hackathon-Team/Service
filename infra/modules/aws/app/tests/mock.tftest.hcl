# 진짜 AWS 없이 plan만: 어댑터가 만든 변수(-var-file)로 자원 모양 확인
mock_provider "aws" {
  mock_data "aws_eks_cluster" {
    defaults = {
      endpoint              = "https://ABC.gr7.ap-northeast-2.eks.amazonaws.com"
      certificate_authority = [{ data = "bW9jaw==" }]
      vpc_config            = [{ cluster_security_group_id = "sg-0123456789abcdef0" }]
    }
  }
  mock_data "aws_eks_cluster_auth" {
    defaults = { token = "mock-token" }
  }
}
mock_provider "kubernetes" {}
run "plan_with_db" {
  command = plan
  assert {
    condition     = aws_db_instance.db[0].engine_version == var.db_engine_version && aws_db_instance.db[0].publicly_accessible == false
    error_message = "DB 버전·비공개 설정이 다름"
  }
  assert {
    condition     = kubernetes_namespace_v1.app[0].metadata[0].name == var.k8s_namespace
    error_message = "앱 네임스페이스를 만들어야 함"
  }
  assert {
    condition     = length(aws_secretsmanager_secret.s) == length(jsondecode(var.secret_names_json))
    error_message = "시크릿 그릇 수가 명세와 다름"
  }
}
run "plan_without_db" {
  command = plan
  variables {
    db_enabled = false
  }
  assert {
    condition     = length(aws_db_instance.db) == 0
    error_message = "DB가 없어야 함"
  }
}
# Z77: 데모 공개 DB. 허용 목록·TLS 강제·공개 서브넷·구독용 나가는 규칙이 들어가는지
run "plan_public_demo_z77" {
  command = plan
  variables {
    db_public                 = true
    db_peer_cidrs_json        = "[\"203.0.113.7/32\",\"10.40.0.21/32\"]"
    db_public_subnet_ids_json = "[\"subnet-pub-a\",\"subnet-pub-b\"]"
    db_deletion_protection    = false
  }
  assert {
    condition     = aws_db_instance.db[0].publicly_accessible == true && aws_db_instance.db[0].deletion_protection == false && aws_db_instance.db[0].skip_final_snapshot == true
    error_message = "데모 DB 는 공개 + 파기 쉬움이어야 함"
  }
  assert {
    condition     = toset(aws_db_subnet_group.db[0].subnet_ids) == toset(["subnet-pub-a", "subnet-pub-b"])
    error_message = "공개 DB 는 공개 서브넷 묶음이어야 함"
  }
  assert {
    condition     = length([for r in aws_security_group.db[0].ingress : r if contains(r.cidr_blocks == null ? [] : r.cidr_blocks, "203.0.113.7/32")]) == 1
    error_message = "허용 목록 CIDR 만 5432 로 들어와야 함"
  }
  assert {
    condition     = length(aws_security_group.db[0].egress) == 2
    error_message = "구독용 나가는 규칙은 허용 목록 수만큼(5432)"
  }
  assert {
    condition     = length([for p in aws_db_parameter_group.db[0].parameter : p if p.name == "rds.force_ssl" && p.value == "1"]) == 1
    error_message = "rds.force_ssl=1 이어야 함"
  }
}
run "plan_private_default_z77" {
  command = plan
  assert {
    condition     = aws_db_instance.db[0].publicly_accessible == false && aws_db_instance.db[0].deletion_protection == true && aws_db_instance.db[0].skip_final_snapshot == false
    error_message = "기본(사설)은 예전 그대로: 비공개, 삭제 보호, 마지막 스냅샷"
  }
}
run "plan_public_rejects_wide_cidr_z77" {
  command = plan
  variables {
    db_public                 = true
    db_peer_cidrs_json        = "[\"0.0.0.0/0\"]"
    db_public_subnet_ids_json = "[\"subnet-pub-a\",\"subnet-pub-b\"]"
  }
  expect_failures = [var.db_peer_cidrs_json]
}
run "plan_public_needs_subnets_z77" {
  command = plan
  variables {
    db_public          = true
    db_peer_cidrs_json = "[\"203.0.113.7/32\"]"
  }
  expect_failures = [aws_db_subnet_group.db]
}
# Z77: B 회차 (env 모듈 create_eks=false). 클러스터 없이 RDS·보안 그룹·시크릿·IAM 만, 네임스페이스·Pod Identity 없음
run "plan_no_cluster_z77" {
  command = plan
  variables {
    cluster_name              = ""
    db_public                 = true
    db_peer_cidrs_json        = "[\"203.0.113.7/32\"]"
    db_public_subnet_ids_json = "[\"subnet-pub-a\",\"subnet-pub-b\"]"
    db_deletion_protection    = false
  }
  assert {
    condition     = length(kubernetes_namespace_v1.app) == 0 && length(aws_eks_pod_identity_association.app) == 0 && length(data.aws_eks_cluster.this) == 0 && length(aws_iam_role.app) == 0 && length(aws_iam_role_policy.app) == 0
    error_message = "클러스터가 없으면 네임스페이스·Pod Identity·클러스터 조회·앱 IAM 역할이 없어야 함 (Z77 B')"
  }
  assert {
    condition     = length(aws_db_instance.db) == 1 && aws_db_instance.db[0].publicly_accessible == true
    error_message = "RDS 는 그대로 만들어야 함"
  }
  assert {
    condition     = length(aws_security_group.db[0].ingress) == 1 && output.namespace == ""
    error_message = "들어오기는 허용 목록 1개만, namespace 출력은 빈 문자열"
  }
}

# 진짜 AWS 없이 plan만: kubectl admin 접근 두 갈래 확인 (admin_principal_arn 비움 / 줌)
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-northeast-2a", "ap-northeast-2c"] }
  }
}
variables {
  expected_account_id = "123456789012"
}
run "no_admin_principal_bootstrap" {
  command = plan
  assert {
    condition     = aws_eks_cluster.this[0].access_config[0].bootstrap_cluster_creator_admin_permissions == true
    error_message = "비우면 만든 사람 admin(bootstrap)이 켜져야 함"
  }
  assert {
    condition     = length(aws_eks_access_entry.admin) == 0 && length(aws_eks_access_policy_association.admin) == 0
    error_message = "비우면 admin access entry를 만들지 않아야 함"
  }
}
run "with_admin_principal" {
  command = plan
  variables {
    admin_principal_arn = "arn:aws:iam::123456789012:role/PlatformAdmin"
  }
  assert {
    condition     = aws_eks_cluster.this[0].access_config[0].bootstrap_cluster_creator_admin_permissions == false
    error_message = "주면 bootstrap admin은 꺼야 함"
  }
  assert {
    condition     = aws_eks_access_policy_association.admin[0].policy_arn == "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" && aws_eks_access_policy_association.admin[0].access_scope[0].type == "cluster"
    error_message = "ClusterAdminPolicy를 클러스터 범위로 연결해야 함"
  }
}
run "reject_assumed_role_arn" {
  command = plan
  variables {
    admin_principal_arn = "arn:aws:sts::123456789012:assumed-role/PlatformAdmin/me"
  }
  expect_failures = [var.admin_principal_arn]
}

# Z77: B 회차용. EKS·노드·애드온·access entry·NAT 없이 VPC·서브넷만, cluster_* 출력은 빈 문자열
run "no_eks_z77" {
  command = plan
  variables {
    create_eks          = false
    admin_principal_arn = "arn:aws:iam::123456789012:role/PlatformAdmin"
    operate_role_arn    = "arn:aws:iam::123456789012:role/PlatformOperate"
  }
  assert {
    condition     = length(aws_eks_cluster.this) == 0 && length(aws_eks_node_group.default) == 0 && length(aws_eks_addon.pod_identity) == 0
    error_message = "create_eks=false 면 EKS·노드 그룹·애드온이 없어야 함"
  }
  assert {
    condition     = length(aws_eks_access_entry.admin) == 0 && length(aws_eks_access_entry.operate) == 0 && length(aws_eks_access_policy_association.admin) == 0
    error_message = "create_eks=false 면 access entry 도 없어야 함"
  }
  assert {
    condition     = length(aws_nat_gateway.this) == 0 && length(aws_eip.nat) == 0 && length(aws_iam_role.node) == 0 && length(aws_iam_role_policy_attachment.node) == 0 && length(aws_iam_policy.app_boundary) == 0
    error_message = "create_eks=false 면 NAT·노드 역할도 없어야 함"
  }
  assert {
    condition     = output.cluster_name == "" && length(aws_subnet.public) == 2 && length(aws_subnet.private) == 2
    error_message = "VPC·서브넷은 그대로, cluster_name 은 빈 문자열"
  }
}
run "default_keeps_eks_z77" {
  command = plan
  assert {
    condition     = length(aws_eks_cluster.this) == 1 && length(aws_eks_node_group.default) == 1 && length(aws_nat_gateway.this) == 1
    error_message = "기본(create_eks=true)은 예전 그대로 EKS·노드·NAT"
  }
}

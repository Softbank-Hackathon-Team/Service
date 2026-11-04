# Z77: 진짜 AWS 없이 plan 만. SSH 는 허용 목록만, 5432 는 VPC 안 + 추가 허용만
mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = { cidr_block = "10.40.0.0/16" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
}
variables {
  vpc_id           = "vpc-0abc"
  public_subnet_id = "subnet-pub-a"
  ssh_public_key   = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForPlanOnly z77"
  ssh_cidrs_json   = "[\"203.0.113.7/32\"]"
}
run "plan_relay" {
  command = plan
  assert {
    condition     = aws_instance.relay.instance_type == "t4g.nano" && aws_instance.relay.associate_public_ip_address == true
    error_message = "공개 서브넷의 t4g.nano 1대"
  }
  assert {
    condition     = length([for r in aws_security_group.relay.ingress : r if r.from_port == 22 && r.cidr_blocks == tolist(["203.0.113.7/32"])]) == 1
    error_message = "SSH 는 맥 공인 IP 만"
  }
  assert {
    condition     = length([for r in aws_security_group.relay.ingress : r if r.from_port == 5432]) == 1
    error_message = "5432 는 VPC 안만"
  }
}
run "plan_relay_rejects_open_ssh" {
  command = plan
  variables {
    ssh_cidrs_json = "[\"0.0.0.0/0\"]"
  }
  expect_failures = [var.ssh_cidrs_json]
}
# 기본값의 나가는 규칙 0개는 plan 에서 값이 정해지지 않아(빈 egress 는 계산 값) 여기서 못 본다. 정방향 run 이 "1개뿐"을 본다
run "plan_relay_default_no_tunnel_user" {
  command = plan
  assert {
    condition     = !strcontains(aws_instance.relay.user_data, "Match User tunnel") && output.tunnel_user == null
    error_message = "tunnel_public_key 가 없으면 tunnel 계정을 만들지 않는다"
  }
}
run "plan_relay_forward_tunnel" {
  command = plan
  variables {
    tunnel_public_key       = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeTunnelKeyPlanOnly onprem-db-tunnel"
    forward_pg_targets_json = "[\"shop.abc123.ap-northeast-2.rds.amazonaws.com:5432\"]"
  }
  assert {
    condition     = length([for r in aws_security_group.relay.egress : r if r.from_port == 5432 && r.to_port == 5432 && r.cidr_blocks == tolist(["10.40.0.0/16"])]) == 1 && length(aws_security_group.relay.egress) == 1
    error_message = "정방향이면 나가는 규칙은 VPC 안 5432 하나뿐"
  }
  assert {
    condition     = strcontains(aws_instance.relay.user_data, "PermitOpen shop.abc123.ap-northeast-2.rds.amazonaws.com:5432") && strcontains(aws_instance.relay.user_data, "ForceCommand /bin/false") && strcontains(aws_instance.relay.user_data, "PermitTTY no")
    error_message = "tunnel 계정은 RDS 목적지 전달만 (셸·tty 없음)"
  }
  assert {
    condition     = output.tunnel_user == "tunnel"
    error_message = "tunnel 계정 이름을 출력한다"
  }
}
run "plan_relay_rejects_non_pg_forward_target" {
  command = plan
  variables {
    tunnel_public_key       = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeTunnelKeyPlanOnly onprem-db-tunnel"
    forward_pg_targets_json = "[\"10.40.0.10:22\"]"
  }
  expect_failures = [var.forward_pg_targets_json]
}

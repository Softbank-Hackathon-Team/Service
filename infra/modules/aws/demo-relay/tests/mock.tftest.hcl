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

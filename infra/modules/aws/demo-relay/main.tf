# Z77 DRAFT(ai): 데모 전용 "역방향 SSH 중계기" EC2 1대. 결정 문서 parallel/Z77/DB-NETWORK-DECISION.md
# 왜 필요한가: 논리 복제 정방향 구독은 "도착 DB 가 출발 DB 에 붙는" 방향이다. 출발이 맥(공유기 뒤)이면
#   클라우드 DB 는 맥에 직접 못 붙는다. 맥이 먼저 이 EC2 로 SSH 를 열고(ssh -R 0.0.0.0:5432:<맥 DB>),
#   클라우드 DB 의 구독은 "이 EC2 의 IP:5432" 로 붙는다 → 그 연결이 SSH 를 타고 맥의 Postgres 로 간다.
# worker 가 아니라 사람이 맥에서 직접 apply/destroy 한다 (env 모듈과 같은 급의 데모 바닥).
#   그래서 앱 모듈·권한표·계획 지문은 안 바뀐다. 결선 실환경(AWS↔GCP)에는 쓰지 않는다
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}
variable "name" {
  type    = string
  default = "z77-demo-relay"
}
variable "vpc_id" { type = string }           # env 모듈 출력 vpc_id
variable "public_subnet_id" { type = string } # env 모듈 출력 public_subnet_ids 의 첫 번째
variable "ssh_public_key" { type = string }   # 맥의 ~/.ssh/id_ed25519.pub 내용 (공개키, 비밀 아님)
variable "ssh_cidrs_json" {                   # SSH(22)를 열 곳 = 맥 공인 IP/32
  type = string
  validation {
    condition     = length(jsondecode(var.ssh_cidrs_json)) > 0 && alltrue([for c in jsondecode(var.ssh_cidrs_json) : can(cidrhost(c, 0)) && tonumber(split("/", c)[1]) >= 24])
    error_message = "ssh_cidrs_json: 1개 이상, IPv4 CIDR /24 보다 좁게 (맥 공인 IP/32)."
  }
}
variable "extra_pg_cidrs_json" { # 5432 에 더 붙어도 되는 곳 (예: Cloud SQL 나가는 IP/32). VPC 안(RDS)은 기본 허용
  type    = string
  default = "[]"
  validation {
    condition     = alltrue([for c in jsondecode(var.extra_pg_cidrs_json) : can(cidrhost(c, 0)) && tonumber(split("/", c)[1]) >= 24])
    error_message = "extra_pg_cidrs_json: IPv4 CIDR /24 보다 좁게."
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { managed-by = "platform", purpose = "z77-demo-relay" }
  }
}

data "aws_vpc" "this" { id = var.vpc_id }

data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_key_pair" "relay" {
  key_name   = var.name
  public_key = var.ssh_public_key
}

resource "aws_security_group" "relay" {
  name        = "${var.name}-sg"
  description = "Reverse SSH relay for demo logical replication"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = jsondecode(var.ssh_cidrs_json)
    content {
      description = "SSH from demo peer ${ingress.value}"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }
  ingress {
    description = "Postgres (tunneled to the Mac) from inside the VPC (RDS)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.this.cidr_block]
  }
  dynamic "ingress" {
    for_each = jsondecode(var.extra_pg_cidrs_json)
    content {
      description = "Postgres (tunneled) from ${ingress.value}"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }
  # 나가는 규칙 없음: 받은 연결은 SSH 터널 안으로만 간다 (응답은 상태 추적으로 허용)
}

resource "aws_instance" "relay" {
  ami                         = data.aws_ssm_parameter.ami.value
  instance_type               = "t4g.nano"
  subnet_id                   = var.public_subnet_id
  vpc_security_group_ids      = [aws_security_group.relay.id]
  key_name                    = aws_key_pair.relay.key_name
  associate_public_ip_address = true
  # ssh -R 0.0.0.0:5432 가 사설 IP 에도 열리게 GatewayPorts 를 켠다 (기본은 127.0.0.1 에만 열린다)
  user_data = <<-EOT
    #!/bin/bash
    echo "GatewayPorts clientspecified" > /etc/ssh/sshd_config.d/90-relay.conf
    echo "ClientAliveInterval 15" >> /etc/ssh/sshd_config.d/90-relay.conf
    systemctl restart sshd
  EOT
  metadata_options {
    http_tokens = "required"
  }
  root_block_device {
    encrypted = true
  }
  tags = { Name = var.name }
}

output "public_ip" { value = aws_instance.relay.public_ip }
output "private_ip" { value = aws_instance.relay.private_ip }
output "ssh_user" { value = "ec2-user" }

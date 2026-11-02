# kind: vm (AWS EC2). VM 출발(EC2·GCE·온프레 VM)을 VM 으로 옮길 때 (재현성 기본: 출발과 같은 종류, RUNTIMEMAP v2).
# 변수 모양 = packages/contracts/src/tf-kinds.ts VmTfVars. 루트(aws/root) vm_json 으로 붙음. env_json 은 루트가 조각을 합친 [{name, value}]
# 앱 설치 = user-data 가 docker 를 깔고 digest 로 고정한 이미지를 systemd 유닛으로 돌림. 비밀 값은 모듈이 모른다 (Secrets Manager 이름 → 시작 때 VM 이 읽음)
# DRAFT(ai): 출발 VM 의 설치 방식(패키지·스크립트·systemd)은 가져오기가 안 읽음 → 컨테이너 이미지(BuildPlan 으로 만든 것)를 VM 위에서 돌리는 방식으로 정함
# TODO(human): 자동 확장(ASG)·로드밸런서(ALB)·입구(entry) 연결은 없음. 대수 = instances 고정, 앞단 연결은 사람이 정함
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id           = string
    name         = string
    role_name    = string
    image        = string
    command_json = optional(string)
    args_json    = optional(string)
    cpu_milli    = optional(number)
    mem_mib      = optional(number)
    port         = optional(number)
    instances    = number
    health_path  = optional(string)
    env_json     = optional(string, "[]")
    secrets_json = optional(string, "[]")
    identity     = string
    public       = optional(bool, false)
  })
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.cfg.image))
    error_message = "이미지는 digest 로 고정 (재현성)."
  }
  validation {
    condition     = var.cfg.instances >= 1 && var.cfg.instances <= 20
    error_message = "VM 대수는 1~20."
  }
  validation {
    condition     = length(var.cfg.name) >= 1 && length(var.cfg.name) <= 63
    error_message = "VM 이름은 1~63자."
  }
  validation {
    condition     = startswith(var.cfg.role_name, "app-") && length(var.cfg.role_name) <= 61
    error_message = "역할 이름은 app- 로 시작, 61자 이하."
  }
}
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "region" { type = string }
variable "boundary_arn" { type = string }
# 비밀 이름 → Secrets Manager ARN (루트가 만든 그릇)
variable "secret_arns" {
  type    = map(string)
  default = {}
}
# null 이면 AL2023 최신 (SSM 공개 매개변수). 재현성을 원하면 AMI id 를 고정해 넘김
variable "ami_id" {
  type    = string
  default = null
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  env     = jsondecode(coalesce(var.cfg.env_json, "[]"))
  secrets = jsondecode(coalesce(var.cfg.secrets_json, "[]"))
  # DRAFT(ai): IR 의 CPU·메모리 이상인 가장 작은 인스턴스 종류. 모르면 t3.small. (cpu, mem) 순서 = 작은 것부터
  shapes = [
    ["t3.micro", 2000, 1024], ["t3.small", 2000, 2048], ["t3.medium", 2000, 4096], ["t3.large", 2000, 8192],
    ["m6i.xlarge", 4000, 16384], ["m6i.2xlarge", 8000, 32768], ["m6i.4xlarge", 16000, 65536],
  ]
  want_cpu = coalesce(var.cfg.cpu_milli, 0)
  want_mem = coalesce(var.cfg.mem_mib, 0)
  fits     = [for s in local.shapes : s[0] if s[1] >= local.want_cpu && s[2] >= local.want_mem]
  machine  = var.cfg.cpu_milli == null && var.cfg.mem_mib == null ? "t3.small" : (length(local.fits) > 0 ? local.fits[0] : local.shapes[length(local.shapes) - 1][0])
  # 대수가 서브넷보다 많으면 돌려 가며 놓음
  names     = [for i in range(var.cfg.instances) : "${var.cfg.name}-${i + 1}"]
  read_arns = distinct([for s in local.secrets : var.secret_arns[s.secret]])
  registry  = try(regex("^([0-9]+\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com)/", var.cfg.image)[0], "")
  env_file  = join("\n", [for e in local.env : "${e.name}=${replace(e.value, "\n", " ")}"])
  # 시작 때마다: 비밀을 읽어 환경 파일에 덧붙이고(권한 600), 이미지를 받아 돌림
  secret_lines = join("\n", [for s in local.secrets :
    "echo \"${s.name}=$(aws secretsmanager get-secret-value --region ${var.region} --secret-id ${var.secret_arns[s.secret]} --query SecretString --output text | jq -r '.\"${s.key}\"')\" >> /etc/platform/${var.cfg.id}.env"
  ])
  exec_args = join(" ", concat(
    var.cfg.command_json == null ? [] : ["--entrypoint", "'${jsondecode(var.cfg.command_json)[0]}'"],
    ["${var.cfg.image}"],
    var.cfg.command_json == null ? [] : [for a in slice(jsondecode(var.cfg.command_json), 1, length(jsondecode(var.cfg.command_json))) : "'${a}'"],
    var.cfg.args_json == null ? [] : [for a in jsondecode(var.cfg.args_json) : "'${a}'"],
  ))
  user_data = <<EOT
#!/bin/bash
set -euo pipefail
dnf install -y docker jq
systemctl enable --now docker
install -d -m 700 /etc/platform
cat > /etc/platform/${var.cfg.id}.env.base <<'ENVEOF'
${local.env_file}
ENVEOF
cat > /usr/local/bin/platform-${var.cfg.id}-start <<'STARTEOF'
#!/bin/bash
set -euo pipefail
umask 077
cp /etc/platform/${var.cfg.id}.env.base /etc/platform/${var.cfg.id}.env
${local.secret_lines}
${local.registry == "" ? "true" : "aws ecr get-login-password --region ${var.region} | docker login --username AWS --password-stdin ${local.registry}"}
docker rm -f ${var.cfg.id} 2>/dev/null || true
exec docker run --rm --name ${var.cfg.id} --env-file /etc/platform/${var.cfg.id}.env ${var.cfg.port == null ? "" : "-p ${var.cfg.port}:${var.cfg.port}"} ${local.exec_args}
STARTEOF
chmod 700 /usr/local/bin/platform-${var.cfg.id}-start
cat > /etc/systemd/system/platform-${var.cfg.id}.service <<'UNITEOF'
[Unit]
Description=platform app ${var.cfg.id}
After=docker.service network-online.target
Requires=docker.service
[Service]
ExecStart=/usr/local/bin/platform-${var.cfg.id}-start
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable --now platform-${var.cfg.id}.service
EOT
  trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_caller_identity" "me" {}

data "aws_ssm_parameter" "ami" {
  count = var.ami_id == null ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_iam_role" "app" {
  name                 = var.cfg.role_name
  permissions_boundary = var.boundary_arn
  assume_role_policy   = local.trust
  tags                 = var.tags
}

# 관리형 정책을 붙이지 않고 인라인으로 (permissions-lint). ECR 이미지 받기 + 이 앱의 비밀만 읽기
resource "aws_iam_role_policy" "app" {
  name = "pull-secrets"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = "arn:aws:ecr:${var.region}:${data.aws_caller_identity.me.account_id}:repository/*" },
      ], length(local.read_arns) == 0 ? [] : [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = local.read_arns },
    ])
  })
}

resource "aws_iam_instance_profile" "app" {
  name = var.cfg.role_name
  role = aws_iam_role.app.name
  tags = var.tags
}

resource "aws_instance" "app" {
  count                       = var.cfg.instances
  ami                         = var.ami_id == null ? data.aws_ssm_parameter.ami[0].value : var.ami_id
  instance_type               = local.machine
  subnet_id                   = var.subnet_ids[count.index % length(var.subnet_ids)]
  vpc_security_group_ids      = var.security_group_ids
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = false
  user_data                   = local.user_data
  user_data_replace_on_change = true
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }
  root_block_device {
    encrypted = true
  }
  tags = merge(var.tags, { Name = local.names[count.index] })
}

output "instance_ids" { value = aws_instance.app[*].id }
output "private_ips" { value = aws_instance.app[*].private_ip }
output "machine_type" { value = local.machine }
output "role_arn" { value = aws_iam_role.app.arn }
output "user_data" { value = local.user_data }

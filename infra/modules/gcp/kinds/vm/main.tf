# kind: vm (GCP GCE). VM 출발(EC2·GCE·온프레 VM)을 VM 으로 옮길 때 (재현성 기본: 출발과 같은 종류, RUNTIMEMAP v2).
# 변수 모양 = packages/contracts/src/tf-kinds.ts VmTfVars. 루트(gcp/root) vm_json 으로 붙음. env_json 은 루트가 조각을 합친 [{name, value}]
# 앱 설치 = startup-script 가 docker 를 깔고 digest 로 고정한 이미지를 systemd 유닛으로 돌림. 비밀 값은 모듈이 모른다 (Secret Manager 이름 → 시작 때 VM 이 읽음)
# DRAFT(ai): 출발 VM 의 설치 방식은 가져오기가 안 읽음 → 컨테이너 이미지(BuildPlan 으로 만든 것)를 VM 위에서 돌리는 방식으로 정함
# DRAFT(ai): 외부 IP 없음 (env 층 Cloud NAT 로 패키지·이미지를 받음)
# TODO(human): 자동 확장(MIG)·로드밸런서·입구(entry) 연결은 없음. 대수 = instances 고정. Artifact Registry 읽기 권한(roles/artifactregistry.reader)은 프로젝트 IAM 이라 보안 승인 몫
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
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
    condition     = can(regex("^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$", var.cfg.name))
    error_message = "GCE 인스턴스 이름은 소문자로 시작, 49자 이하 (뒤에 -번호가 붙음)."
  }
  validation {
    condition     = length(var.cfg.role_name) >= 6 && length(var.cfg.role_name) <= 30 && startswith(var.cfg.role_name, "app-")
    error_message = "SA account_id 는 6~30자, app- 로 시작."
  }
}
variable "project_id" { type = string }
variable "region" { type = string }
variable "subnetwork" { type = string }
# 비밀 이름 → Secret Manager secret id (루트가 만든 그릇). 접근 권한도 이 SA 에 붙인다
variable "secret_ids" {
  type    = map(string)
  default = {}
}
# null 이면 debian-12 최신 이미지 계열. 재현성을 원하면 이미지 이름을 고정해 넘김
variable "boot_image" {
  type    = string
  default = null
}
# null 이면 <리전>-a
variable "zone" {
  type    = string
  default = null
}
variable "labels" {
  type    = map(string)
  default = {}
}

locals {
  env     = jsondecode(coalesce(var.cfg.env_json, "[]"))
  secrets = jsondecode(coalesce(var.cfg.secrets_json, "[]"))
  # DRAFT(ai): IR 의 CPU·메모리 이상인 가장 작은 머신. 모르면 e2-small
  shapes = [
    ["e2-small", 2000, 2048], ["e2-medium", 2000, 4096], ["e2-standard-2", 2000, 8192],
    ["e2-standard-4", 4000, 16384], ["e2-standard-8", 8000, 32768], ["e2-standard-16", 16000, 65536],
  ]
  want_cpu = coalesce(var.cfg.cpu_milli, 0)
  want_mem = coalesce(var.cfg.mem_mib, 0)
  fits     = [for s in local.shapes : s[0] if s[1] >= local.want_cpu && s[2] >= local.want_mem]
  machine  = var.cfg.cpu_milli == null && var.cfg.mem_mib == null ? "e2-small" : (length(local.fits) > 0 ? local.fits[0] : local.shapes[length(local.shapes) - 1][0])
  zone     = coalesce(var.zone, "${var.region}-a")
  names    = [for i in range(var.cfg.instances) : "${var.cfg.name}-${i + 1}"]
  read_ids = toset([for s in local.secrets : var.secret_ids[s.secret]])
  registry = try(regex("^([a-z0-9-]+-docker\\.pkg\\.dev|gcr\\.io|[a-z]+\\.gcr\\.io)/", var.cfg.image)[0], "")
  env_file = join("\n", [for e in local.env : "${e.name}=${replace(e.value, "\n", " ")}"])
  # 시작 때마다: 비밀을 읽어 환경 파일에 덧붙이고(권한 600), 이미지를 받아 돌림
  secret_lines = join("\n", [for s in local.secrets :
    "echo \"${s.name}=$(gcloud secrets versions access latest --project ${var.project_id} --secret ${var.secret_ids[s.secret]})\" >> /etc/platform/${var.cfg.id}.env"
  ])
  exec_args = join(" ", concat(
    var.cfg.command_json == null ? [] : ["--entrypoint", "'${jsondecode(var.cfg.command_json)[0]}'"],
    ["${var.cfg.image}"],
    var.cfg.command_json == null ? [] : [for a in slice(jsondecode(var.cfg.command_json), 1, length(jsondecode(var.cfg.command_json))) : "'${a}'"],
    var.cfg.args_json == null ? [] : [for a in jsondecode(var.cfg.args_json) : "'${a}'"],
  ))
  startup = <<EOT
#!/bin/bash
set -euo pipefail
apt-get update -y
apt-get install -y docker.io jq
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
${local.registry == "" ? "true" : "gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin https://${local.registry}"}
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
}

resource "google_service_account" "app" {
  project      = var.project_id
  account_id   = var.cfg.role_name
  display_name = "platform ${var.cfg.id}"
}

resource "google_secret_manager_secret_iam_member" "read" {
  for_each  = local.read_ids
  project   = var.project_id
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

resource "google_compute_instance" "app" {
  count        = var.cfg.instances
  project      = var.project_id
  name         = local.names[count.index]
  zone         = local.zone
  machine_type = local.machine
  labels       = var.labels
  boot_disk {
    initialize_params {
      image = coalesce(var.boot_image, "debian-cloud/debian-12")
    }
  }
  network_interface {
    subnetwork = var.subnetwork
  }
  service_account {
    email  = google_service_account.app.email
    scopes = ["cloud-platform"]
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "true"
  }
  metadata_startup_script = local.startup
  depends_on              = [google_secret_manager_secret_iam_member.read]
}

output "instance_names" { value = google_compute_instance.app[*].name }
output "private_ips" { value = [for i in google_compute_instance.app : i.network_interface[0].network_ip] }
output "machine_type" { value = local.machine }
output "service_account_email" { value = google_service_account.app.email }
output "startup_script" { value = local.startup }

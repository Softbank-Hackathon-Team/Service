# GCP 출발 샘플 (src-gcp-sample): "고객이 이미 운영 중인 서비스" 자리. GCP→온프레·GCP→AWS 이전 시험용 (상태: AI 초안)
# 기존 모듈 두 개를 부르기만 한다 (새 자원 정의 없음). AWS 출발 샘플(aws/env + aws/kinds/postgres)과 같은 모양.
# apply·destroy 는 사람이 Cloud Shell 에서 tools/gcp-source.sh 로 돌린다.
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

locals {
  region = "asia-northeast3"
  zone   = "asia-northeast3-a"
}

# kinds/postgres 는 provider 블록이 없어 이 루트의 기본 google provider 를 쓴다 (env 모듈은 자기 provider 를 가짐)
provider "google" {
  project = var.project_id
  region  = local.region
}

module "env" {
  source     = "../../modules/gcp/env"
  project_id = var.project_id
  region     = local.region
  zone       = local.zone
  name       = "platform-target"
  create_gke = true
  create_eso = false
}

module "db" {
  source     = "../../modules/gcp/kinds/postgres"
  network_id = module.env.network_id
  region     = local.region
  app_name   = "shop"
  labels     = { managed-by = "sample", app = "shop" }
  cfg = {
    id                    = "sample-shop-db"
    name                  = "sample-shop-db"
    major_version         = "16"
    storage_gb            = 20
    db_name               = "shop"
    app_user              = "app"
    backup_retention_days = 1
    public                = false
    deletion_protection   = false # DRAFT(ai): 시험용 샘플이라 down 으로 바로 지운다
  }
  # 사설 IP Cloud SQL 은 PSA 피어링(env 의 google_service_networking_connection.psa)이 먼저 있어야 만들어진다.
  #   env 모듈은 그 연결을 출력하지 않고, network_id 참조만으로는 VPC 만 기다린다 → 모듈 전체를 기다린다.
  #   (env 는 안에 provider 블록이 있어 module "env" 쪽에는 depends_on 을 못 단다. 여기 db 쪽에 단다)
  #   대가: Cloud SQL 이 GKE 노드 풀까지 끝난 뒤에 시작해 up 이 직렬로 길어진다
  depends_on = [module.env]
}

# kind: queue (GCP Pub/Sub). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts QueueTfVars (TA5fix: 계약이 기준)
#   model queue = 토픽 1개 + 받는 구독 1개(같은 이름), model topic = 토픽 + subscriptions_json 의 구독들(PS-1, 없으면 토픽만)
#   dead_letter_to 는 루트가 대상 큐의 토픽 id 로 바꿔 dead_letter_topic 으로 넘긴다
# DRAFT(ai): link url = 구독 전체 이름(받는 쪽, topic 이면 토픽 id), name = 토픽 이름(보내는 쪽)
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

# PS-1·DM-6·B-1: 받는 쪽(구독) 설정. 없으면 null: 만료 = 안 함, 나머지 = 상품 기본
# 계약은 모든 칸을 보낸다. optional 은 옛 호출·시험 입력(id·name 만)을 받으려고
variable "cfg" {
  type = object({
    id                      = string
    name                    = string
    model                   = optional(string, "queue")
    ordered                 = optional(bool) # 순서 보장(메시지 정렬)
    retention_sec           = optional(number)
    ack_timeout_sec         = optional(number)
    dead_letter_to          = optional(string)
    dead_letter_max_receive = optional(number)
    allow_from_json         = optional(string, "[]")
    idle_expiry_sec         = optional(number)
    retain_acked            = optional(bool)
    filter                  = optional(string)
    push_endpoint           = optional(string)
    subscriptions_json      = optional(string, "[]")
  })
  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9._~%+-]{2,254}$", var.cfg.name))
    error_message = "Pub/Sub 이름 규칙(영문 시작, 3~255자)."
  }
  validation {
    condition     = contains(["queue", "topic"], var.cfg.model)
    error_message = "queue model 은 queue·topic."
  }
  validation {
    # DRAFT(ai): allow_from_json(보내고 받는 신원)은 IAM(identity grants) 몫. 여기선 모양만 본다
    condition     = can(tolist(jsondecode(var.cfg.allow_from_json)))
    error_message = "queue allow_from_json 은 JSON 배열."
  }
  validation {
    condition     = can(tolist(jsondecode(var.cfg.subscriptions_json))) && alltrue([for s in try(jsondecode(var.cfg.subscriptions_json), []) : can(regex("^[A-Za-z][A-Za-z0-9._~%+-]{2,254}$", s.name))])
    error_message = "queue subscriptions_json 은 JSON 배열이고 구독마다 Pub/Sub 이름 규칙."
  }
}
variable "labels" { type = map(string) }
variable "dead_letter_topic" {
  type    = string
  default = ""
}

locals {
  sub = var.cfg.model == "queue"
}

# DM-6: retention_sec 은 구독 보관(안 받은 메시지)이다. 토픽 보관(되감기용)은 IR 에 없어 안 정함
resource "google_pubsub_topic" "this" {
  name   = var.cfg.name
  labels = var.labels
}

# TODO(human): 죽은 편지를 쓰려면 Pub/Sub 서비스 에이전트에 대상 토픽 publisher·이 구독 subscriber 권한이 필요(IAM 은 이 묶음 밖)
resource "google_pubsub_subscription" "this" {
  count                      = local.sub ? 1 : 0
  name                       = var.cfg.name
  topic                      = google_pubsub_topic.this.id
  labels                     = var.labels
  enable_message_ordering    = var.cfg.ordered == true
  ack_deadline_seconds       = var.cfg.ack_timeout_sec # null 이면 상품 기본(10초)
  message_retention_duration = var.cfg.retention_sec == null ? null : "${var.cfg.retention_sec}s"
  retain_acked_messages      = var.cfg.retain_acked
  filter                     = var.cfg.filter
  # DM-6: 출발 만료 그대로. 없으면 만료 안 함(ttl "") — 상품 기본(31일 안 쓰면 지움)으로 두지 않음
  expiration_policy {
    ttl = var.cfg.idle_expiry_sec == null ? "" : "${var.cfg.idle_expiry_sec}s"
  }
  # B-1: push 구독은 같은 주소로 (주소가 이 앱 입구가 아니면 계획 전에 사람에게 — v2Blockers)
  dynamic "push_config" {
    for_each = var.cfg.push_endpoint == null ? [] : [var.cfg.push_endpoint]
    content { push_endpoint = push_config.value }
  }
  dynamic "dead_letter_policy" {
    for_each = var.dead_letter_topic == "" ? [] : [var.dead_letter_topic]
    content {
      dead_letter_topic = dead_letter_policy.value
      # DRAFT(ai): 모르면 5. QR-1: 범위(5~100) 밖은 자르지 않음 — 계획 전에 사람에게 (queueRangeProblems)
      max_delivery_attempts = coalesce(var.cfg.dead_letter_max_receive, 5)
    }
  }
}

# PS-1: topic 모델의 구독 목록 (구독마다 받는 쪽 설정 그대로). 구독 목록 안 DLQ 는 계획 전에 막힘
resource "google_pubsub_subscription" "extra" {
  for_each                   = local.sub ? {} : { for s in jsondecode(var.cfg.subscriptions_json) : s.name => s }
  name                       = each.key
  topic                      = google_pubsub_topic.this.id
  labels                     = var.labels
  enable_message_ordering    = try(each.value.ordered, null) == true
  ack_deadline_seconds       = try(each.value.ack_timeout_sec, null)
  message_retention_duration = try(each.value.retention_sec, null) == null ? null : "${each.value.retention_sec}s"
  retain_acked_messages      = try(each.value.retain_acked, null)
  filter                     = try(each.value.filter, null)
  expiration_policy {
    ttl = try(each.value.idle_expiry_sec, null) == null ? "" : "${each.value.idle_expiry_sec}s"
  }
  dynamic "push_config" {
    for_each = try(each.value.push_endpoint, null) == null ? [] : [each.value.push_endpoint]
    content { push_endpoint = push_config.value }
  }
}

locals {
  url = local.sub ? google_pubsub_subscription.this[0].id : google_pubsub_topic.this.id
}

output "url" { value = local.url }
output "name" { value = google_pubsub_topic.this.name }
output "topic_id" { value = google_pubsub_topic.this.id }
# LINK_OUTPUTS.queue = url·name. SUB-1: topic 모델 구독 목록이면 "sub.<출발 구독 이름>" = 도착 구독 이름 (env fromLink.subscription 이 읽음)
output "link" {
  value = merge({
    url  = local.url
    name = google_pubsub_topic.this.name
    }, { for s in jsondecode(var.cfg.subscriptions_json) : "sub.${s.source}" => google_pubsub_subscription.extra[s.name].name if try(s.source, null) != null && !local.sub
  })
}

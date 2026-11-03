# kind: queue (AWS). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts QueueTfVars (TA5fix: 계약이 기준)
#   model queue = SQS, model topic = SNS. ordered=true 면 FIFO(이름에 .fifo). 서버 측 암호화는 항상 켬
#   dead_letter_to 는 루트가 대상 큐의 ARN 으로 바꿔 dead_letter_arn 으로 넘긴다 (같은 for_each 안 참조는 순환이라)
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

# 계약은 모든 칸을 보낸다. optional 은 옛 호출·시험 입력(id·name 만)을 받으려고
variable "cfg" {
  type = object({
    id                      = string
    name                    = string # ".fifo" 는 ordered=true 일 때 여기서 붙임
    model                   = optional(string, "queue")
    ordered                 = optional(bool)
    retention_sec           = optional(number)
    ack_timeout_sec         = optional(number)
    dead_letter_to          = optional(string)
    dead_letter_max_receive = optional(number)
    allow_from_json         = optional(string, "[]")
  })
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,75}$", var.cfg.name))
    error_message = "SQS·SNS 이름은 영문·숫자·_·- 75자 이하 (.fifo 는 자동)."
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
}
variable "dead_letter_arn" {
  type    = string
  default = ""
}

locals {
  fifo = var.cfg.ordered == true
  name = local.fifo ? "${var.cfg.name}.fifo" : var.cfg.name
  sqs  = var.cfg.model == "queue"
}

resource "aws_sqs_queue" "this" {
  count                      = local.sqs ? 1 : 0
  name                       = local.name
  fifo_queue                 = local.fifo ? true : null
  visibility_timeout_seconds = var.cfg.ack_timeout_sec # null 이면 상품 기본
  message_retention_seconds  = var.cfg.retention_sec
  sqs_managed_sse_enabled    = true
  # DRAFT(ai): maxReceive 를 모르면 5
  redrive_policy = var.dead_letter_arn == "" ? null : jsonencode({
    deadLetterTargetArn = var.dead_letter_arn
    maxReceiveCount     = coalesce(var.cfg.dead_letter_max_receive, 5)
  })
}

# SNS 는 보관 기간·확인 시간 칸이 없다 (retention_sec·ack_timeout_sec 은 구독 쪽 값이라 여기선 안 씀)
resource "aws_sns_topic" "this" {
  count             = local.sqs ? 0 : 1
  name              = local.name
  fifo_topic        = local.fifo ? true : null
  kms_master_key_id = "alias/aws/sns"
}

locals {
  url = local.sqs ? aws_sqs_queue.this[0].url : aws_sns_topic.this[0].arn
  arn = local.sqs ? aws_sqs_queue.this[0].arn : aws_sns_topic.this[0].arn
}

output "url" { value = local.url }
output "name" { value = local.name }
output "arn" { value = local.arn }
# LINK_OUTPUTS.queue = url·name (SNS 는 url 자리에 ARN — 보내는 쪽 SDK 가 쓰는 주소)
output "link" {
  value = {
    url  = local.url
    name = local.name
  }
}

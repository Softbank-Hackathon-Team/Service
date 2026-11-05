# 고객 "AWS 연결" 링크의 CloudFormation 템플릿 버킷 (infra/onboarding/aws-connect.json 을 올려 둔 곳)
# 버킷은 이미 있고 Terraform 이 만들지 않는다 (import 도 안 함). 주소가 바뀌면 api 를 다시 띄워야 해서 기존 버킷을 그대로 쓴다
# 여기서는 공개 차단 설정과 버킷 정책만 관리한다. 템플릿 객체 올리기는 사람이 한다 (aws s3 cp)
# 주의: aws_s3_bucket_policy 는 버킷 정책 전체를 덮어쓴다. destroy 하면 공개 차단 설정도 지워진다
variable "connect_template_bucket" {
  type    = string
  default = "svc-connect-template-5f2cb764"
}
variable "connect_template_key" {
  type    = string
  default = "aws-connect.json"
  validation {
    # 공개할 객체 하나만 가리켜야 한다. 와일드카드·앞 슬래시·빈 값이면 다른 객체까지 열리거나 주소가 틀어진다
    condition     = length(var.connect_template_key) > 0 && !can(regex("[*?]", var.connect_template_key)) && !startswith(var.connect_template_key, "/")
    error_message = "connect_template_key 는 객체 키 하나 (와일드카드 *?·앞 / 없이)"
  }
}

data "aws_s3_bucket" "connect_template" {
  bucket = var.connect_template_bucket
}

# ACL 로 공개하는 길은 막고, 버킷 정책으로 객체 하나만 연다
resource "aws_s3_bucket_public_access_block" "connect_template" {
  bucket                  = data.aws_s3_bucket.connect_template.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false # true 면 아래 공개 정책을 S3 가 거부한다
  restrict_public_buckets = false # true 면 공개 정책이 붙어도 익명 요청이 막힌다
}

# DRAFT(ai): 고객 계정 CloudFormation 이 templateURL 로 읽어야 해서 객체 하나만 공개. 템플릿에 비밀값 없음, ExternalId·플랫폼 ARN 은 링크 파라미터(apps/api/src/connect/link.ts)로만 넘어감
resource "aws_s3_bucket_policy" "connect_template" {
  bucket = data.aws_s3_bucket.connect_template.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadConnectTemplateOnly"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${data.aws_s3_bucket.connect_template.arn}/${var.connect_template_key}"
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [data.aws_s3_bucket.connect_template.arn, "${data.aws_s3_bucket.connect_template.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.connect_template]
}

output "connect_template_url" {
  value = "https://${var.connect_template_bucket}.s3.${data.aws_s3_bucket.connect_template.region}.amazonaws.com/${var.connect_template_key}"
}

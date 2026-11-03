# A8 DRAFT(ai): 출발 IAM 권한(I4 grants · posture.permissions)을 도착 앱 역할의 인라인 정책 하나로 붙인다.
#   identity_json[*].grants_json = packages/adapters/src/target/grants.ts awsGrantPlan 의 문장 목록.
#   자원은 IR id 로만 온다 → 여기서 그 id 의 종류 모듈 ARN (+ 출발 경로, 예: 버킷 "/*") 으로 바꾼다. 출발 계정 번호·ARN 은 안 들어옴.
#   star = true 인 문장은 Resource "*" (계정 단위 동작 거울, 또는 Deny *).
# TODO(human): 앱 역할 권한 경계(infra/permissions/aws-app-role-boundary.json)가 시크릿 읽기만 허용 → 경계를 넓히기 전엔 이 정책이 실제로 안 먹힘

locals {
  grant_arn = merge(
    { for k, m in module.postgres : "postgres/${k}" => m.arn },
    { for k, m in module.cache : "cache/${k}" => m.arn },
    { for k, m in module.object_store : "objectStore/${k}" => m.arn },
    { for k, m in module.queue_dl : "queue/${k}" => m.arn },
    { for k, m in module.queue : "queue/${k}" => m.arn },
  )
  grant_statements = {
    for id, i in local.identity : id => [
      for s in jsondecode(coalesce(try(i.grants_json, null), "[]")) : {
        Effect   = s.effect
        Action   = s.actions
        Resource = s.star ? ["*"] : flatten([for t in s.targets : [for p in t.paths : "${local.grant_arn["${t.kind}/${t.id}"]}${p}"]])
      }
    ]
  }
}

resource "aws_iam_role_policy" "grants" {
  for_each = { for id, st in local.grant_statements : id => st if length(st) > 0 }
  name     = "migrated-grants"
  role     = module.identity[each.key].role_name
  policy   = jsonencode({ Version = "2012-10-17", Statement = each.value })
}

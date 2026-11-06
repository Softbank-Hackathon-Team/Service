# A8 DRAFT(ai): 출발 IAM 권한(I4 grants)을 도착 신원의 자원 단위 역할 바인딩으로 붙인다 (버킷·토픽·구독).
#   주체 = kinds/identity 출력 principal (KSA 직접 주체 principal://…/subject/ns/<구역>/sa/<KSA>, #317 가: GSA 없음).
#   버킷은 균일 접근(kinds/object-store uniform_bucket_level_access)이라 KSA 주체를 받는다
#   identity_json[*].grants_json = packages/adapters/src/target/grants.ts gcpGrantPlan 의 바인딩 목록 (kind·target·role·scope).
#   자원은 IR id 로만 온다 → 그 id 의 종류 모듈 출력(버킷 이름·토픽 id·구독 id)으로 바꾼다. 프로젝트 단위 역할은 안 줌 (대응표 밖 → precheck block)

locals {
  grant_rows = flatten([
    for id, i in local.identity : [
      for b in jsondecode(coalesce(try(i.grants_json, null), "[]")) : merge(b, { identity = id })
    ]
  ])
  grant_by_scope = {
    for sc in ["bucket", "topic", "subscription"] : sc => {
      for b in local.grant_rows : "${b.identity}/${b.target}/${b.role}" => b if b.scope == sc
    }
  }
}

resource "google_storage_bucket_iam_member" "grant" {
  for_each = local.grant_by_scope["bucket"]
  bucket   = module.object_store[each.value.target].name
  role     = each.value.role
  member   = module.identity[each.value.identity].principal
}

resource "google_pubsub_topic_iam_member" "grant" {
  for_each = local.grant_by_scope["topic"]
  topic    = try(module.queue[each.value.target].topic_id, module.queue_dl[each.value.target].topic_id)
  role     = each.value.role
  member   = module.identity[each.value.identity].principal
}

# 큐 모양(model=queue)이면 kinds/queue 의 url = 구독 id. 토픽 모양(구독 없음)이면 url 이 토픽 id 라 구독 바인딩이 실패 → 그때는 사람이 구독을 정함
resource "google_pubsub_subscription_iam_member" "grant" {
  for_each     = local.grant_by_scope["subscription"]
  subscription = try(module.queue[each.value.target].url, module.queue_dl[each.value.target].url)
  role         = each.value.role
  member       = module.identity[each.value.identity].principal
}

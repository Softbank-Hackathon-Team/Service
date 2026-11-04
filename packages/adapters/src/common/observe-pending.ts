// DRAFT(ai) 관찰 권한 넓힘: 가져오기 갈래가 쓸 읽기 권한을 연결 템플릿·스크립트에 미리 넣는다 (고객이 연결을 다시 하지 않게).
//   이 판의 가져오기 코드는 아직 이 권한을 부르지 않는다. 가져오기 갈래가 합쳐져 명령표(observe-permissions.ts)에 같은 이름이 생기면 여기서 지운다
//   - DNS: 공개 DNS 영역·레코드 목록 → IR (트래픽 갈래 가져오기)
//   - 데이터: 버킷 이벤트 알림·SNS 토픽·구독 목록 (비밀 IR 갈래 AWS_DATA_READ_PENDING·GCP_DATA_READ_PENDING)
//   전부 목록·설정 읽기. 객체·메시지·비밀값은 못 읽는다 (DNS 레코드 값은 원래 공개 정보)
export const AWS_OBSERVE_PENDING = [
  "route53:ListHostedZones", "route53:ListResourceRecordSets",
  "s3:GetBucketNotification", "sns:ListTopics", "sns:ListSubscriptionsByTopic",
];
// GCP 쪽(dns.managedZones.list·dns.resourceRecordSets.list·storage.buckets.get)은 gcp-connect.sh 담당 갈래가 넣는다

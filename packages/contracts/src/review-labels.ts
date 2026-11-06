// 검토 키(fieldMeta 의 needs_review 키) → 사람이 읽는 이름표.
// 화면은 키를 PATCH confirm 에 그대로 보내고, 보여 줄 때만 이 이름표를 쓴다. 키 모양은 contracts spec.ts 의 "확인 경로" 주석과 같다.
// DRAFT(ai): 문구·표는 AI 임시안. 모르는 키는 키 그대로 돌려준다 (지어낸 설명을 붙이지 않음)

// discover 가 남기는 what (packages/adapters common/unread.ts keyOf 뒤 모양) → 이름
const WHAT: Record<string, string> = {
  "namespace": "k8s 네임스페이스", "cluster": "클러스터", "ecs-cluster": "ECS 클러스터",
  "ecs": "ECS 서비스", "ec2": "EC2 인스턴스", "gce": "GCE 인스턴스", "cloudrun": "Cloud Run 서비스", "cloudrun.jobs": "Cloud Run 작업",
  "s3": "S3 버킷", "s3.truncated": "S3 버킷 (일부만 읽음)", "gcs": "GCS 버킷", "gcs.truncated": "GCS 버킷 (일부만 읽음)",
  "sqs": "SQS 큐", "elasticache": "ElastiCache", "memorystore": "Memorystore", "pubsub": "Pub/Sub 토픽", "pubsub.subscriptions": "Pub/Sub 구독",
  "rds.wanted": "지정한 RDS", "cloudsql.wanted": "지정한 Cloud SQL", "cnpg.wanted": "지정한 CNPG",
};
// what 앞부분(s3.<버킷>.<설정>, sqs.<큐>, ecs.<서비스> …) → 종류 이름
const WHAT_PREFIX: Record<string, string> = { s3: "S3 버킷", sqs: "SQS 큐", elasticache: "ElastiCache", ecs: "ECS 서비스" };

function whatLabel(what: string): string {
  if (WHAT[what]) return WHAT[what]!;
  const dot = what.indexOf(".");
  const head = dot > 0 ? what.slice(0, dot) : what;
  return WHAT_PREFIX[head] && dot > 0 ? `${WHAT_PREFIX[head]} ${what.slice(dot + 1)}` : what;
}

/** 검토 키 하나의 이름표. 같은 what 이 여러 번이면 키 끝 #n 을 "(n번째)"로 */
export function reviewLabel(key: string): string {
  const m = /^(.*)#(\d+)$/.exec(key);
  const base = m ? m[1]! : key, nth = m ? ` (${m[2]}번째)` : "";
  if (base === "app.name") return "앱 이름" + nth;
  if (base.startsWith("check.unread.")) return `못 읽음: ${whatLabel(base.slice("check.unread.".length))} — 출발에 있는지 확인${nth}`;
  if (base === "check.pick.platform-namespace") return `플랫폼이 만든 네임스페이스를 고름 — 옮길 고객 앱이 맞는지 확인${nth}`;   // PF-A14
  if (base.startsWith("check.pick.")) return `자동으로 고름: ${whatLabel(base.slice("check.pick.".length))} — 맞는지 확인${nth}`;
  const rv = /^check\.reviews\[(\d+)\]$/.exec(base);
  if (rv) return `검토 항목 ${Number(rv[1]) + 1}${nth}`;
  const comp = /^components\.([^.]+)\.(.+)$/.exec(base);
  if (comp) return `구성요소 ${comp[1]} 의 ${comp[2]}${nth}`;
  const link = /^links\.(.+)->(.+)$/.exec(base);
  if (link) return `연결 ${link[1]} → ${link[2]}${nth}`;
  if (base.startsWith("entry.")) return `입구 ${base.slice("entry.".length)}${nth}`;
  if (base.startsWith("namespaces.")) return `네임스페이스 ${base.slice("namespaces.".length)}${nth}`;
  // PF-A10 DRAFT(ai): 처음 보는 고객 화면에 키 원문(점·해시)이 그대로 나가던 것들. 자세한 이유는 fieldMeta rationale 에 그대로 있다
  if (base.startsWith("unread.")) return `못 읽음: k8s ${base.slice("unread.".length)} — 출발에 있는지 확인${nth}`;
  const pair = /^secrets\.([^.]+)\.keys\.(.+)\.pairedWith$/.exec(base);
  if (pair) return `비밀 ${pair[1]} 의 ${pair[2]} — 도착 DB 비밀번호와 짝 확인${nth}`;
  const val = /^check\.(.+)\.(vendor|privateIp)\.[0-9a-f]+$/.exec(base);
  if (val) return `${val[1]} 에 출발 ${val[2] === "vendor" ? "벤더 주소" : "사설 IP"}가 값으로 남음${nth}`;
  if (base.startsWith("check.boundary.")) return `경계 밖: ${base.slice("check.boundary.".length)} — 같이 옮길지 확인${nth}`;
  if (base.startsWith("check.")) return `점검 항목: ${base.slice("check.".length)}${nth}`;
  return key;
}

/** 키 목록 → {키: 이름표} */
export const reviewLabels = (keys: readonly string[]): Record<string, string> => Object.fromEntries(keys.map((k) => [k, reviewLabel(k)]));

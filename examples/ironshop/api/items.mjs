// 아이언 철물점 상품 목록과 이름 바꾸기 (순수 함수, DB 없음)
// DRAFT(ai): 출발 시드가 넣은 옛 행(item-1 … item-100)은 DB 값을 바꾸지 않고 화면에서만 철물 이름으로 보여 준다

export const ITEMS = ["망치", "못 한 상자", "육각 볼트", "너트", "몽키 스패너", "드라이버", "줄자", "철사"];

/** DB 의 item 값 → 화면 이름. item-N 은 상품 목록에서 돌아가며 고른다 */
export function displayName(item) {
  const m = /^item-(\d+)$/.exec(String(item));
  return m ? ITEMS[(Number(m[1]) - 1 + ITEMS.length) % ITEMS.length] : String(item);
}

/** 주문 입력 검사. 맞으면 { item, qty }, 아니면 null */
export function parseOrder(body) {
  const item = body?.item;
  const qty = Number(body?.qty ?? 1);
  if (!ITEMS.includes(item) || !Number.isInteger(qty) || qty < 1 || qty > 99) return null;
  return { item, qty };
}

/** DB 서버 설정 → 화면에 보일 위치 이름. 주소 모양이 아니라 서버가 가진 설정으로 고른다
 *  (도착 앱이 컷오버 전에 출발 DB 를 IP 로 가리켜도 틀리지 않게)
 *  DRAFT(ai) 【추정】 rds.force_ssl 은 RDS 에만, cloudsql.logical_decoding 은 Cloud SQL 에만 있는 설정. 실계정에서 아직 확인 전 */
export function placeOf(s) {
  if (s?.rds != null) return "AWS RDS";
  if (s?.cloudsql != null) return "GCP Cloud SQL";
  return "Postgres (CNPG·자체 운영)";
}

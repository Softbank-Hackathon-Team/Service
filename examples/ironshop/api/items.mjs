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
 *  관리형 서비스가 만들어 두는 관리 역할이 있는지로 고른다: rdsadmin 은 RDS 에만, cloudsqlsuperuser 는 Cloud SQL 에만 있다.
 *  pg_roles 는 아무 계정이나 읽을 수 있어서 앱 계정(shop_app)으로도 보인다.
 *  예전 규칙(current_setting('rds.force_ssl', true))은 2026-11-08 실제 RDS 에서 앱 계정으로 null 이 나와 RDS 를 CNPG 로 잘못 보였다.
 *  cloudsqlsuperuser 규칙은 2026-11-08 실제 Cloud SQL(iron-target-gcp)에서 앱 계정으로 "GCP Cloud SQL" 이 나오는 것을 확인했다 */
export function placeOf(s) {
  if (s?.rds === true) return "AWS RDS";
  if (s?.cloudsql === true) return "GCP Cloud SQL";
  return "Postgres (CNPG·자체 운영)";
}

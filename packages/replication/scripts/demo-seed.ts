// REPL을 켠 smoke 전에 한 번: 출발·도착 DB를 빈 상태로 되돌리고 출발에만 데모 데이터(주문 2000행)를 넣는다.
// 먼저 npm run db:up. 접속 주소는 test/harness.ts 기본값(55432/55433) 또는 IT_SOURCE_URL 등
import { resetAndSeed } from "../test/harness.js";
await resetAndSeed(Number(process.env.ROWS ?? 2000));
console.log("seeded: source orders/customers, target empty schema");

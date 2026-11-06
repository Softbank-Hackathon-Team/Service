import { AppSpecV2 } from "@svc/contracts";
import { ONE } from "./demo-one.js";

// 대체 상품 시험용 명세: 데모 한 벌(shop-api + shop-db)에 관리형 캐시·큐·버킷을 붙이고 shop-api 가 셋에 connect.
//   공유 데모 인벤토리(DEMO_INVENTORY)는 건드리지 않는다
export const SUBSTITUTE_SPEC: AppSpecV2 = AppSpecV2.parse({
  ...ONE,
  components: [...ONE.components,
    { id: "shop-cache", kind: "cache", props: { engine: "redis", version: "7.0", memoryMiB: 1024, tls: true, auth: true } },
    { id: "shop-orders", kind: "queue", props: { model: "queue", ordered: true, retentionSec: 86400, ackTimeoutSec: 30 } },
    { id: "shop-assets", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 5, lifecycle: [{ prefix: "old/", toColdAfterDays: 30 }] } }],
  links: [...ONE.links, ...["shop-cache", "shop-orders", "shop-assets"].map((to) => ({ from: "shop-api", to, intent: "connect" }))],
});

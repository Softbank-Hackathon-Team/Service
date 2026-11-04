// pf-d APP-20 (ADR-072): 계획 precheck 에 "도착 비밀 그릇에 고객이 값을 넣어야 함" 줄. 경고(warn)이지 막는 줄이 아님 — 막는 건 deploy 직전 버전 검사
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { v2PrecheckItems } from "../src/index.js";

// target-v2.test.ts 의 BASE 와 같은 명세 (k8s 서비스 1개 + DATABASE_PASSWORD 비밀 + postgres)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"registry/shop-api","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":2,"max":2},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[{"name":"LOG_LEVEL","value":"info"},{"name":"DATABASE_PASSWORD","fromSecret":{"secret":"DATABASE_PASSWORD","key":"password"}}]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["shop.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const secval = (p: "aws" | "gcp" | "onprem", s: AppSpecV2) => v2PrecheckItems(p, { specV2: s }).filter((i) => i.id.startsWith("PC-V2-SECVAL-"));

test("APP-20: 비밀을 읽는 k8s 서비스 → gcp·aws 계획에 PC-V2-SECVAL warn 줄 (그릇 이름·키, 값은 없음)", () => {
  for (const p of ["gcp", "aws"] as const) {
    const sec = secval(p, BASE);
    assert.ok(sec.length > 0, p);
    assert.ok(sec.every((i) => i.level === "warn" && /ADR-072/.test(i.fix ?? "")), p);
    assert.ok(sec.some((i) => /키 password/.test(i.message)), JSON.stringify(sec));
  }
});

test("APP-20 거부: 온프레 계획엔 SECVAL 줄이 없고, 비밀을 안 읽는 명세는 비밀 줄이 없음 (막는 줄도 안 생김)", () => {
  assert.equal(secval("onprem", BASE).length, 0);
  const bare = AppSpecV2.parse(JSON.parse(JSON.stringify(BASE).replace(/,\{"name":"DATABASE_PASSWORD","fromSecret":\{[^}]*\}\}/, "")));
  assert.ok(!JSON.stringify(bare).includes("fromSecret"), "비밀 참조가 빠져야 함");
  assert.ok(secval("gcp", bare).every((i) => !/password/.test(i.message)), JSON.stringify(secval("gcp", bare)));
  assert.ok(!v2PrecheckItems("gcp", { specV2: bare }).some((i) => i.id.startsWith("PC-V2-SECVAL") && i.level === "block"));
});

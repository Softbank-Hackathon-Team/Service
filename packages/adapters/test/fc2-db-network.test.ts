// fc2 TF4-2: 출발 DB 허용 주소가 /24 보다 넓어도 그대로 옮긴다 (2026-11-03 결정). 모듈은 CIDR 모양만 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AppSpecV2, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, v2Blockers } from "../src/index.js";
import { v2PrecheckItems } from "../src/target/plan-v2.js";

type Raw = Record<string, any>;
const BASE: Raw = {"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"posture":{"permissions":[],"network":[]}};
const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;
const withFw = (ingress: Raw[], pub: boolean) => { const s = structuredClone(BASE); s.posture.network.push({ scope: "component", subject: "db", mode: "mirror", public: pub, ingress }); return AppSpecV2.parse(s); };
const root = fileURLToPath(new URL("../../../", import.meta.url));

for (const p of ["aws", "gcp"] as const) {
  test(`TF4-2 ${p}: /22·0.0.0.0/0 허용 주소가 그대로 peer_cidrs_json 으로, 사전 점검도 안 막음`, () => {
    const spec = withFw([{ from: "10.0.0.0/22" }, { from: "0.0.0.0/0" }], true);
    const pg = JSON.parse(String(targetBuilderFor(p).toTerraformV2(spec, T(p)).vars.postgres_json))[0];
    assert.deepEqual(JSON.parse(pg.peer_cidrs_json), ["0.0.0.0/0", "10.0.0.0/22"]);
    assert.equal(pg.public, true);
    assert.ok(!v2PrecheckItems(p, { specV2: spec }).some((i) => i.level === "block"), "넓다고 막지 않음");
    const tf = readFileSync(`${root}infra/modules/${p}/kinds/postgres/main.tf`, "utf8");
    assert.ok(!/split\("\/", c\)\[1\]\) >= 24/.test(tf), "모듈의 /24 거부가 없어야 함");
    assert.match(tf, /can\(cidrhost\(c, 0\)\)/);   // 모양 검사는 남음
  });
}

test("TF4-2 거부: CIDR 이 아닌 허용 원본(보안 그룹 id)은 그대로 못 옮겨 사람 확인", () => {
  const b = v2Blockers(withFw([{ from: "sg-0abc" }, { from: "10.0.0.0/8" }], true), targetBuilderFor("aws").capabilities());
  assert.ok(b.needsHuman.some((m) => /sg-0abc/.test(m)), JSON.stringify(b));
});

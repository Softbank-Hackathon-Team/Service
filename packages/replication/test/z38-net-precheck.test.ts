// Z38 REVIEW-5 04 조각: Z77-2 (출발 쪽 공개 경로 평문) · Z77-3 (관리형 DB 에 워커 TLS 없음) — 연결 전에 잡는다. DB 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointFromEnv, isPrivateHost, peerPathProblem, precheck, workerTlsProblem, type Endpoint } from "../src/index.js";

const RDS = "postgres://app:pw@shop.abc.ap-northeast-2.rds.amazonaws.com:5432/shop";
const ep = (o: Partial<Endpoint> & { adminUrl: string }): Endpoint => ({ label: "x", provider: "postgres", appRole: "app_user", ...o });

test("isPrivateHost: 사설·루프백·점 없는 이름·.internal 은 사설, 공인 IP·공개 이름은 공개", () => {
  for (const h of ["10.0.1.5", "172.20.0.3", "192.168.0.10", "127.0.0.1", "localhost", "db", "host.docker.internal", "pg.svc", "[::1]"])
    assert.equal(isPrivateHost(h), true, h);
  for (const h of ["3.38.1.2", "172.32.0.1", "relay.example.com", "34.64.1.1"]) assert.equal(isPrivateHost(h), false, h);
});

test("Z77-3: RDS·Cloud SQL 에 워커 TLS 설정이 없으면 이유를 돌려준다 (URL sslmode=require 나 REPL_CA_FILE 이 있으면 통과)", () => {
  assert.match(workerTlsProblem(ep({ provider: "rds", adminUrl: RDS }))!, /평문 접속을 거절/);
  assert.match(workerTlsProblem(ep({ provider: "cloudsql", adminUrl: "postgres://a@34.64.1.1/x" }))!, /cloudsql/);
  assert.equal(workerTlsProblem(ep({ provider: "rds", adminUrl: `${RDS}?sslmode=require` })), null);
  assert.equal(workerTlsProblem(endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: RDS, REPL_TARGET_PROVIDER: "rds", REPL_CA_FILE: "/ca.pem" })), null);
  assert.equal(workerTlsProblem(ep({ provider: "postgres", adminUrl: "postgres://a@localhost/x" })), null);
});

test("Z77-2: TLS 를 안 켠 맥 출발이라도 관리형 DB 가 공개 주소로 붙으면 PEER_URL sslmode 를 요구 (사설 중계기 IP 는 통과)", () => {
  const cloud = ep({ provider: "cloudsql", adminUrl: "postgres://a@34.64.1.1/x?sslmode=require" });
  const mac = (peer: string) => ep({ label: "mac", adminUrl: "postgres://a@localhost:55432/shop", peerUrl: peer });
  assert.match(peerPathProblem(mac("postgres://rep@3.38.1.2:5432/shop"), cloud)!, /공개 경로 평문/);
  assert.equal(peerPathProblem(mac("postgres://rep@3.38.1.2:5432/shop?sslmode=require"), cloud), null);
  assert.equal(peerPathProblem(mac("postgres://rep@10.0.1.5:5432/shop"), cloud), null);
  assert.equal(peerPathProblem(mac("postgres://rep@3.38.1.2:5432/shop"), ep({ provider: "cnpg", adminUrl: "postgres://a@localhost/x" })), null);
});

test("precheck: 연결 전 TLS 문제가 있으면 붙어 보지 않고 NET-TLS0·NET-TLS1 로 이유를 남긴다", async () => {
  // 닿지 않는 주소(포트 1). 예전엔 pg 접속 오류가 그대로 던져졌다
  const src = ep({ label: "mac", adminUrl: "postgres://a@127.0.0.1:1/shop", peerUrl: "postgres://rep@3.38.1.2:5432/shop" });
  const tgt = ep({ label: "rds", provider: "rds", adminUrl: "postgres://a@127.0.0.1:1/shop" });
  const r = await precheck(src, tgt);
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.map((c) => `${c.id}/${c.side}`).sort(), ["NET-TLS0/target", "NET-TLS1/source"]);
});

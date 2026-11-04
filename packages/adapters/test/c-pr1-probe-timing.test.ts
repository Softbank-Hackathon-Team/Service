// PR-1: IR 프로브 제한 시간·성공 횟수·종료 유예 → k8s 프로브 칸 (pb1 toK8sProbe 가 버리던 것). 계약(K8sProbe strict)도 받음
import { test } from "node:test";
import assert from "node:assert/strict";
import { K8sProbe } from "@svc/contracts";
import { toK8sProbe } from "../src/target/k8s-probe.js";

test("PR-1: timeoutSec·successThreshold·terminationGracePeriodSec 가 k8s …Seconds 칸으로 그대로 가고 계약을 통과", () => {
  const k = toK8sProbe({ type: "http", path: "/healthz", port: 8080, periodSec: 10, timeoutSec: 5, successThreshold: 2, failureThreshold: 3, terminationGracePeriodSec: 30 } as never);
  assert.deepEqual(k, { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 10, timeoutSeconds: 5, successThreshold: 2, failureThreshold: 3, terminationGracePeriodSeconds: 30 });
  assert.deepEqual(K8sProbe.parse(k), k);
});

test("PR-1 거부: 출발에 없던 칸은 지어내지 않음(키 없음 = k8s 기본), 계약은 모르는 칸 거부", () => {
  const k = toK8sProbe({ type: "tcp", port: 5432 } as never);
  assert.deepEqual(k, { tcpSocket: { port: 5432 } });
  assert.throws(() => K8sProbe.parse({ tcpSocket: { port: 1 }, timeoutSec: 5 }));
});

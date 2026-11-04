import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubeClient, type VirtualAdminKube, type VirtualAgentKube } from "../src/index.js";

test("kube 클라이언트: 토큰 파일은 요청마다 다시 읽고, Warning 머리는 한 줄씩 돌려준다", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization));
    res.setHeader("warning", ['299 - "would violate PodSecurity \\"restricted:latest\\": runAsNonRoot != true"', '299 - "autoscaling/v2beta2, deprecated"']);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "kube-token-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "first\n");
  const kube = kubeClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile });
  const a = await kube.call("GET", "/api");
  writeFileSync(tokenFile, "rotated\n");
  await kube.call("GET", "/api");
  server.close();
  assert.deepEqual(seen, ["Bearer first", "Bearer rotated"]);
  assert.deepEqual(a.warnings, ['would violate PodSecurity "restricted:latest": runAsNonRoot != true', "autoscaling/v2beta2, deprecated"]);
});

test("가상 관리자 클라이언트는 조회 전용 자리(LLM 도구)에 넘길 수 없다 (타입 검사)", () => {
  const forTools = (k: VirtualAgentKube) => k;
  const admin = {} as VirtualAdminKube;
  // @ts-expect-error 관리자 kubeconfig 가 LLM 도구로 가면 컴파일이 깨져야 한다
  forTools(admin);
  assert.ok(true);
});

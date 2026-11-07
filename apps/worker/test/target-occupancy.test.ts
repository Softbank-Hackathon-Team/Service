// 사전 점검: 도착에 같은 앱을 옮겨 놓은 끝난 이전이 있으면 승인 줄(warn)로 알린다.
//   2026-11-07 실플랫폼: GCP→온프레 1adfeb6c 가 같은 앱(shop-api)·같은 도착(onprem-vm)으로 AWS→온프레 f6c08ef2 결과를 덮고, 롤백 때 지웠다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { targetOccupancyItems, type CompletedMove } from "../src/jobs/target-occupancy.js";

const VM = "37653b15-f150-4cb3-a34b-9dde8ea30b5d", AWS = "783df2ef-8dbf-4a20-904d-bb02aeb96332", GCP = "ef114bd9-32a1-4fc6-9ae0-76bd491e6e2e";
const mv = (id: string, from: string, to: string, at: string): CompletedMove => ({ id, sourceEnvId: from, targetEnvId: to, completedAt: at });
const run = (moves: CompletedMove[]) => targetOccupancyItems({ appName: "shop-api", targetEnvId: VM, targetName: "onprem-vm", moves });

test("앞선 이전이 같은 앱을 이 도착에 옮겨 놓았으면 warn 한 줄 (이전 번호·네임스페이스 포함)", () => {
  const items = run([mv("f6c08ef2-9bdc-4bf2-86ab-0329bc3bde19", AWS, VM, "2026-11-06T17:51:00.000000")]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "PC-TARGET-APP-OCCUPIED");
  assert.equal(items[0]!.level, "warn");
  assert.match(items[0]!.message, /f6c08ef2/);
  assert.match(items[0]!.message, /app-shop-api/);
});

test("거부(줄 없음): 완료 이전이 없으면 빈 목록", () => {
  assert.deepEqual(run([]), []);
});

test("거부(줄 없음): 그 뒤에 이 환경에서 앱을 다른 곳으로 옮겨 끝냈으면 비었다", () => {
  assert.deepEqual(run([
    mv("aaaaaaaa-0000-4000-8000-000000000001", AWS, VM, "2026-11-06T17:51:00.000000"),
    mv("bbbbbbbb-0000-4000-8000-000000000002", VM, AWS, "2026-11-07T03:00:00.000000"),
  ]), []);
});

test("나갔다가 다시 들어왔으면 다시 차 있다 (순서는 완료 시각으로)", () => {
  const items = run([
    mv("cccccccc-0000-4000-8000-000000000003", GCP, VM, "2026-11-07T05:00:00.000000"),
    mv("aaaaaaaa-0000-4000-8000-000000000001", AWS, VM, "2026-11-06T17:51:00.000000"),
    mv("bbbbbbbb-0000-4000-8000-000000000002", VM, AWS, "2026-11-07T03:00:00.000000"),
  ]);
  assert.equal(items.length, 1);
  assert.match(items[0]!.message, /cccccccc/);
});

test("거부(줄 없음): 이 환경과 상관없는 완료 이전은 보지 않는다", () => {
  assert.deepEqual(run([mv("dddddddd-0000-4000-8000-000000000004", AWS, GCP, "2026-11-07T05:00:00.000000")]), []);
});

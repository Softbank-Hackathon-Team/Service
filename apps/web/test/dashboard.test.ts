import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketSignature, envHeadline, fromInventory, groupMigrations, humanAction, listNote, realEnvs,
} from "../src/features/dashboard/model";
import type { EnvironmentView, MigrationStatus, MigrationView } from "../src/lib/types";

const env = (id: string, connectionStatus: EnvironmentView["connectionStatus"] = "connected", name = id): EnvironmentView =>
  ({ id, provider: "aws", name, connectionStatus, accountId: null, lastVerifiedAt: null, failureReason: null });
const mig = (id: string, status: MigrationStatus, updatedAt = "2026-11-01T00:00:00Z"): MigrationView =>
  ({ id, status, version: 1, sourceEnvId: "a", targetEnvId: "b", updatedAt });
const ok = { health: "healthy" as const, mock: false, resources: 1, region: null, problem: null };

test("환경 머리말: 모두 정상, 확인이 필요한 환경, 환경 없음", () => {
  assert.equal(envHeadline([env("a")], { a: ok }), "환경 1개가\n정상입니다");
  assert.equal(envHeadline([env("a"), env("b", "failed")], { a: ok }), "환경 2개 중\n1개를 확인해 주세요");
  assert.equal(envHeadline([env("a")], {}), "환경 1개 중\n1개를 확인해 주세요");
  assert.equal(envHeadline([], {}), "연결된 환경이\n없습니다");
});

test("시험용 환경은 대시보드에서 뺀다", () => {
  assert.deepEqual(realEnvs([env("a"), env("b", "connected", "load-1")]).map((e) => e.id), ["a"]);
});

test("인벤토리: 못 읽으면 확인 불가와 이유, 나쁜 자원이 있으면 불안정", () => {
  const down = fromInventory({ status: "unavailable", reason: "권한 없음", source: "none", region: null, groups: [] });
  assert.equal(down.health, "unknown");
  assert.equal(down.problem, "권한 없음");
  const bad = fromInventory({ status: "ok", reason: null, source: "aws-cli", region: "r", groups: [{
    items: [{ name: "db", status: "failed" }, { name: "app", status: "running" }, { name: "x", status: "stopped" }] }] });
  assert.equal(bad.health, "degraded");
  assert.equal(bad.resources, 3);
  assert.equal(bad.problem, "db failed 외 1개");
});

test("이전 묶음: 사람 차례, 진행 중, 끝남은 최근 5건까지", () => {
  const done = Array.from({ length: 7 }, (_, i) => mig(`d${i}`, "completed", `2026-11-0${i + 1}T00:00:00Z`));
  const g = groupMigrations([mig("h", "awaiting_approval"), mig("p", "paused"), mig("r", "shifting"), ...done]);
  assert.deepEqual(g.human.map((m) => m.id).sort(), ["h", "p"]);
  assert.deepEqual(g.running.map((m) => m.id), ["r"]);
  assert.equal(g.done.length, 5);
  assert.equal(g.done[0]!.id, "d6");
});

test("목록 안내 한 줄은 상황에 맞게 바뀌고, 사람 차례가 있으면 없다", () => {
  assert.equal(listNote(groupMigrations([mig("h", "approved")])), null);
  assert.equal(listNote(groupMigrations([mig("r", "deploying")])), "지금 사람이 할 일은 없습니다.");
  assert.equal(listNote(groupMigrations([mig("d", "completed")])), "진행 중인 이전이 없습니다.");
  assert.match(listNote(groupMigrations([])) ?? "", /새 이전을 시작/);
});

test("줄 이동 비교: 묶음이 바뀔 때만 값이 달라진다", () => {
  const before = bucketSignature([mig("a", "deploying")]);
  assert.equal(bucketSignature([mig("a", "syncing")]), before);
  assert.notEqual(bucketSignature([mig("a", "paused")]), before);
});

test("사람 버튼 이름은 합의한 세 단계를 쓴다", () => {
  assert.equal(humanAction("spec_review"), "명세 확정");
  assert.equal(humanAction("awaiting_approval"), "계획 승인");
  assert.equal(humanAction("approved"), "실행 시작");
  assert.equal(humanAction("shifting"), null);
});

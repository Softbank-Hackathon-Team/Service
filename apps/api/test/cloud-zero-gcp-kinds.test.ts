// tools/cloud-zero.sh gcp FM-CLD-10: GCP 도착 종류(Memorystore·Pub/Sub·GCS·Cloud Run 서비스/잡·Scheduler)도 센다. 가짜 gcloud 로만 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../tools/cloud-zero.sh", import.meta.url));
// FAKE_LEFT 에 든 종류만 이름 하나를 낸다. FAKE_API_OFF 에 든 종류는 "API 꺼짐" 오류. 거르기(--filter)가 managed-by=platform 인지도 본다
const FAKE = `#!/bin/sh
k=""
case "$*" in
  *"redis instances list"*) k=redis ;; *"pubsub topics list"*) k=topic ;; *"pubsub subscriptions list"*) k=sub ;;
  *"storage buckets list"*) k=bucket ;; *"run services list"*) k=runsvc ;; *"run jobs list"*) k=runjob ;; *"scheduler jobs list"*) k=sched ;;
  *) exit 0 ;;
esac
case " \${FAKE_API_OFF:-} " in *" $k "*) echo "API [x.googleapis.com] not enabled on project" >&2; exit 1 ;; esac
case "$k" in sched) ;; *) case "$*" in *managed-by=platform*) ;; *) echo "no-label-filter-$k" ; exit 0 ;; esac ;; esac
case " \${FAKE_LEFT:-} " in *" $k "*) echo "app-shop-$k" ;; esac
exit 0
`;
function run(env: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "czg-"));
  writeFileSync(join(bin, "gcloud"), FAKE); chmodSync(join(bin, "gcloud"), 0o755);
  const r = spawnSync("bash", [SCRIPT, "gcp"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, GCP_PROJECT: "demo-prj", CLOUD_ZERO_WAIT_SEC: "0", ...env } });
  return { code: r.status, out: r.stdout };
}

test("FM-CLD-10: 아무것도 안 남음 → OK zero (라벨 거르기를 씀, 남의 자원은 안 셈)", () => {
  const r = run({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK zero/);
  assert.doesNotMatch(r.out, /no-label-filter/);
});

test("FM-CLD-10 거부: Memorystore·Pub/Sub·GCS·Cloud Run·Scheduler 가 하나씩 남으면 끝 코드 1, 이름이 남은 것 목록에", () => {
  for (const k of ["redis", "topic", "sub", "bucket", "runsvc", "runjob", "sched"]) {
    const r = run({ FAKE_LEFT: k });
    assert.equal(r.code, 1, `${k}: ${r.out}`);
    assert.match(r.out, new RegExp(`app-shop-${k}`), k);
    assert.doesNotMatch(r.out, /OK zero/, k);
  }
});

test("FM-CLD-10: API 가 꺼진 프로젝트(새 프로젝트)는 조회 실패가 아니라 0", () => {
  const r = run({ FAKE_API_OFF: "redis topic sub bucket runsvc runjob sched" });
  assert.equal(r.code, 0, r.out);
});

// Z57: gitops 자식 환경 허용 목록이 GIT_CONFIG_KEY_0·GIT_CONFIG_VALUE_0 을 빼먹어 git 이 전부 실패하던 것 (GIT_CONFIG_COUNT 만 넘어감)
import { test } from "node:test";
import assert from "node:assert/strict";
import { childEnv } from "../src/gitops/repo.js";

test("childEnv: GIT_CONFIG_COUNT 를 넘기면 GIT_CONFIG_KEY_n·VALUE_n 도 같이 넘긴다", () => {
  const out = childEnv({ PATH: "/usr/bin", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1",
    GIT_CONFIG_KEY_1: "c.d", GIT_CONFIG_VALUE_1: "2", GITOPS_WRITE_TOKEN: "t" });
  assert.deepEqual(Object.keys(out).sort(),
    ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_1", "PATH"]);
});

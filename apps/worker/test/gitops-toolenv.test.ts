// Z47: gitops 레포 도구(render·validate·npm install)에는 워커 비밀값을 넘기지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolEnv } from "../src/gitops/repo.js";

test("toolEnv: 비밀값 이름은 빼고 도구 실행에 필요한 것은 남긴다", () => {
  const out = toolEnv({
    PATH: "/usr/bin", HOME: "/home/x", NODE_OPTIONS: "--max-old-space-size=256", HELM_CACHE_HOME: "/tmp/h", LANG: "C",
    DATABASE_URL: "postgres://u:p@h/db", OWNER_DATABASE_URL: "postgres://o:p@h/db", PGPASSWORD: "p",
    GITOPS_WRITE_TOKEN: "t", GITOPS_REPO_URL: "https://x", CLOUDFLARE_API_TOKEN: "c", CF_API_TOKEN: "c",
    ANTHROPIC_API_KEY: "a", AWS_PROFILE: "finals", AWS_SECRET_ACCESS_KEY: "s", GOOGLE_APPLICATION_CREDENTIALS: "/k.json",
    GCP_BILLING_API_KEY: "g", REPL_SOURCE_URL: "postgres://r:p@h/db", AGENT_HMAC_SECRET: "h", AZURE_MOCK: "1",
  });
  assert.deepEqual(Object.keys(out).sort(), ["HELM_CACHE_HOME", "HOME", "LANG", "NODE_OPTIONS", "PATH"]);
});

// GCP 도착 Terraform 은 빌린 토큰만 쓰고, 재발급된 토큰을 창구에서 다시 받는다 (네트워크는 127.0.0.1 만, 클라우드 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, createRealTerraformRunner, gcpTerraformEnv, type Exec } from "@svc/adapters";
import { startGcpTokenServer, withGcpCred } from "../src/gcp-token-server.js";
import { runnerOpts } from "../src/jobs/apply-real.js";

const PATH = "/computeMetadata/v1/instance/service-accounts/default/token";
const get = (host: string, path = PATH, headers: Record<string, string> = { "Metadata-Flavor": "Google" }) => fetch(`http://${host}${path}`, { headers });

test("창구는 지금 토큰과 남은 초를 주고, 재발급되면 새 토큰을 준다", async () => {
  let t = { token: "tok-1", expiresAt: "2026-11-06T00:15:00Z" };
  const s = await startGcpTokenServer(() => t, () => Date.parse("2026-11-06T00:00:00Z"));
  try {
    assert.match(s.host, /^127\.0\.0\.1:\d+$/);
    const first = await (await get(s.host, `${PATH}?scopes=a`)).json() as Record<string, unknown>;
    assert.deepEqual(first, { access_token: "tok-1", expires_in: 900, token_type: "Bearer" });
    t = { token: "tok-2", expiresAt: "2026-11-06T00:20:00Z" };
    assert.equal(((await (await get(s.host)).json()) as { access_token: string }).access_token, "tok-2");
  } finally { await s.close(); }
});

test("거부: 메타데이터 머리글이 없으면 403, 토큰 말고 다른 경로는 404 (토큰이 안 실린다)", async () => {
  const s = await startGcpTokenServer(() => ({ token: "secret-tok", expiresAt: "2099-01-01T00:00:00Z" }));
  try {
    const noHeader = await get(s.host, PATH, {});
    assert.equal(noHeader.status, 403);
    assert.ok(!(await noHeader.text()).includes("secret-tok"));
    assert.equal((await get(s.host, "/computeMetadata/v1/project/project-id")).status, 404);
  } finally { await s.close(); }
});

test("withGcpCred: 도착 토큰이 없으면 cred 없이 부르고, 있으면 창구를 열었다가 실패해도 닫는다", async () => {
  assert.equal(await withGcpCred({}, "p", async (c) => c), undefined);
  assert.equal(await withGcpCred({ gcpToken: { source: "x" } }, "p", async (c) => c), undefined, "출발 토큰으로 도착 자원을 만들지 않는다");
  let host = "";
  const roles = { gcpToken: { target: "tok-a" }, gcpExpiresAt: { target: "2099-01-01T00:00:00Z" } };
  await assert.rejects(withGcpCred(roles, "proj", async (c) => {
    host = c!.metadataHost;
    assert.equal(c!.projectId, "proj");
    assert.equal(((await (await get(host)).json()) as { access_token: string }).access_token, "tok-a");
    roles.gcpToken.target = "tok-b";
    assert.equal(c!.token(), "tok-b", "재발급된 토큰을 읽는다");
    throw new Error("apply 실패");
  }), /apply 실패/);
  await assert.rejects(get(host), "실패해도 창구가 닫혀야 한다");
});

test("Terraform 환경: 창구를 가리키고 워커 자기 구글 자격은 빠진다. 환경 필터도 창구 주소를 넘긴다", () => {
  const base = { PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/f", GOOGLE_OAUTH_ACCESS_TOKEN: "old", GOOGLE_CREDENTIALS: "k",
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/var/run/gcp-cred/worker.json", CLOUDFLARE_API_TOKEN: "cf" };
  const cred = { metadataHost: "127.0.0.1:9", token: () => "tok", projectId: "proj" };
  const { env, secretEnv } = runnerOpts({ gcpCred: cred }, base) as { env: NodeJS.ProcessEnv; secretEnv: () => NodeJS.ProcessEnv };
  for (const k of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_CREDENTIALS", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"]) assert.equal(env[k], undefined, k);
  assert.equal(env.GCE_METADATA_HOST, "127.0.0.1:9");
  assert.equal(env.CLOUDSDK_AUTH_ACCESS_TOKEN, "tok");
  assert.equal(env.CLOUDSDK_CORE_PROJECT, "proj");
  assert.equal(childEnv(env).GCE_METADATA_HOST, "127.0.0.1:9");
  assert.equal(childEnv(env).CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(secretEnv().CLOUDSDK_AUTH_ACCESS_TOKEN, "tok");
  assert.equal(gcpTerraformEnv({ metadataHost: "h", token: () => "t" }, base).CLOUDSDK_CORE_PROJECT, undefined);
});

test("AWS·자격 없음 길은 그대로다", () => {
  const base = { PATH: "/bin", AWS_PROFILE: "me" };
  const aws = runnerOpts({ credEnv: { AWS_CONFIG_FILE: "/c" } }, base);
  assert.equal(aws.env.AWS_PROFILE, undefined);
  assert.equal(aws.env.GCE_METADATA_HOST, undefined);
  assert.equal(runnerOpts({}, base).env, base);
});

test("apply 뒤 DB 비밀은 재발급된 토큰으로 꺼낸다", async () => {
  let token = "tok-start";
  const seen: { cmd: string; token?: string }[] = [];
  const exec: Exec = async (cmd, args, o) => {
    seen.push({ cmd, token: o.env?.CLOUDSDK_AUTH_ACCESS_TOKEN });
    if (cmd === "terraform" && args.includes("apply")) token = "tok-renewed";
    const stdout = args.includes("output") ? JSON.stringify({ db_password_secret_id: { value: "sec" } }) : cmd === "gcloud" ? "pw" : "";
    return { code: 0, stdout, stderr: "", ms: 1 };
  };
  const cred = { metadataHost: "127.0.0.1:9", token: () => token, projectId: "proj" };
  const r = createRealTerraformRunner({ ...runnerOpts({ gcpCred: cred }, { PATH: "/bin" }), exec, workRoot: mkdtempSync(join(tmpdir(), "gcp-token-")) });
  const out = await r.apply("gcp", "4a8c0000-0000-4000-8000-0000000000a1", {} as never);
  assert.equal(out.ok, true, JSON.stringify(out.log));
  assert.equal(seen.find((s) => s.cmd === "gcloud")?.token, "tok-renewed");
  assert.equal(seen.find((s) => s.cmd === "terraform")?.token, "tok-start");
});

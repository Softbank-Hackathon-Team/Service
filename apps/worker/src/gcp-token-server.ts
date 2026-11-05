import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { GcpTerraformCred } from "@svc/adapters";

// GCP 도착 Terraform 에 빌린 토큰을 넘기는 길.
// 실행 역할은 15분까지, 긴 단계는 상한을 늘리지 않고 10분마다 다시 빌린다 (security broker.ts OPERATE_MAX_TTL_SEC).
//   Google 프로바이더의 GOOGLE_OAUTH_ACCESS_TOKEN 은 시작 때 한 번만 읽어 긴 생성 중에 만료된다. 그래서 메타데이터 서버와 같은 모양의 창구를
//   이 파드의 127.0.0.1 에 열고 GCE_METADATA_HOST 로 가리킨다. 프로바이더는 만료되면 여기서 지금 토큰을 다시 받는다 (키 파일 없음, 값은 메모리에만)
// DRAFT(ai): 창구는 단계 동안만 연다. 같은 파드의 프로세스는 읽을 수 있다 (그 프로세스들은 이미 같은 worker 메모리·환경 안에 있다)
const TOKEN_PATH = "/computeMetadata/v1/instance/service-accounts/default/token";

export interface GcpTokenSource { token: string; expiresAt: string }

export async function startGcpTokenServer(current: () => GcpTokenSource | undefined, now: () => number = Date.now) {
  const server = createServer((q, r) => {
    // 메타데이터 서버처럼 이 머리글이 없으면 거부한다 (다른 도구가 잘못 부른 요청)
    if (q.headers["metadata-flavor"] !== "Google" || q.method !== "GET") { r.writeHead(403); r.end(); return; }
    const t = current();
    if (q.url?.split("?")[0] !== TOKEN_PATH || !t) { r.writeHead(404); r.end(); return; }
    const left = Math.floor((Date.parse(t.expiresAt) - now()) / 1000);
    r.writeHead(200, { "content-type": "application/json", "metadata-flavor": "Google" });
    r.end(JSON.stringify({ access_token: t.token, expires_in: Math.max(1, left), token_type: "Bearer" }));
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", res); });
  const { address, port } = server.address() as AddressInfo;
  return {
    host: `${address}:${port}`,
    close: () => new Promise<void>((res) => { server.close(() => res()); server.closeAllConnections(); }),
  };
}

type TargetToken = {
  gcpToken?: Partial<Record<"source" | "target", string>>;
  gcpExpiresAt?: Partial<Record<"source" | "target", string>>;
};

/** 도착 GCP 진짜 토큰이 있으면 창구를 열어 넘기고, 끝나면 닫는다. 없으면(AWS·온프레·흉내) cred 없이 그대로 부른다 */
export async function withGcpCred<T>(roles: TargetToken, projectId: string | null | undefined, fn: (cred?: GcpTerraformCred) => Promise<T>): Promise<T> {
  if (!roles.gcpToken?.target) return fn();
  const server = await startGcpTokenServer(() => {
    const token = roles.gcpToken?.target, expiresAt = roles.gcpExpiresAt?.target;
    return token && expiresAt ? { token, expiresAt } : undefined;
  });
  try {
    return await fn({ metadataHost: server.host, token: () => roles.gcpToken!.target!, ...(projectId ? { projectId } : {}) });
  } finally {
    await server.close();
  }
}

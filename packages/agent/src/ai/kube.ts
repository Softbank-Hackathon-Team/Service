import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

// 아주 작은 kube API 클라이언트 (의존성 없이 node:http). k3d 샌드박스와 vCluster 백엔드가 쓴다.
// 기본 접속: 맥에서 `kubectl --context k3d-agent-sbx proxy --port 8001` 을 띄우고 http://127.0.0.1:8001 로 붙는다.
//   → 인증서·kubeconfig 는 kubectl 이 들고 있고, 이 프로세스는 비밀을 하나도 안 받는다.
// 토큰 방식: tokenFile 은 요청마다 다시 읽는다 (서비스 계정 토큰은 kubelet 이 한 시간 안에 바꾼다)
// 인증서 방식: vCluster 관리자 kubeconfig (cert·key)
export interface KubeConfig {
  baseUrl: string; token?: string; tokenFile?: string; ca?: string; cert?: string; key?: string; timeoutMs?: number;
}
// warnings: 응답 Warning 머리 (PSA warn=restricted 위반, 지원 끝난 API 등). 적용은 됐고 사람이 볼 말
export interface KubeResponse { status: number; body: unknown; text: string; warnings: string[] }
export class KubeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface KubeClient {
  call(method: string, path: string, o?: { body?: unknown; contentType?: string }): Promise<KubeResponse>;
}

// 어느 API 서버에 어떤 권한으로 붙은 클라이언트인지 타입으로 나눈다. 모양은 같아도 서로 넘길 수 없다
//   HostKube: 플랫폼 클러스터, agent-worker 서비스 계정 (sbx-* 네임스페이스만)
//   VirtualAdminKube: vCluster 안 관리자. 결정 코드(리허설)만 쓴다
//   VirtualAgentKube: vCluster 안 조회 전용 서비스 계정 ai-agent. LLM 도구 몫
declare const kubeSide: unique symbol;
type Side<S extends string> = KubeClient & { readonly [kubeSide]: S };
export type HostKube = Side<"host">;
export type VirtualAdminKube = Side<"virtual-admin">;
export type VirtualAgentKube = Side<"virtual-agent">;
export const asHostKube = (c: KubeClient) => c as HostKube;

// Warning: 299 - "메시지" (RFC 7234). 같은 머리가 여러 줄 올 수 있어 rawHeaders 에서 하나씩 꺼낸다
function warningsOf(res: IncomingMessage): string[] {
  const out: string[] = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (res.rawHeaders[i]!.toLowerCase() !== "warning") continue;
    const v = res.rawHeaders[i + 1]!;
    const m = /^\d{3} \S+ "((?:[^"\\]|\\.)*)"/.exec(v);
    out.push(m ? m[1]!.replace(/\\(.)/g, "$1") : v);
  }
  return out;
}

export function kubeClient(c: KubeConfig): KubeClient {
  const base = new URL(c.baseUrl);
  const isHttps = base.protocol === "https:";
  const tls = isHttps ? { ...(c.ca ? { ca: c.ca } : {}), ...(c.cert ? { cert: c.cert } : {}), ...(c.key ? { key: c.key } : {}) } : {};
  return {
    call(method, path, o = {}) {
      const url = new URL(path, base);
      const payload = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      const headers: Record<string, string> = { accept: "application/json" };
      if (payload !== undefined) {
        headers["content-type"] = o.contentType ?? "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      const token = c.tokenFile ? readFileSync(c.tokenFile, "utf8").trim() : c.token;
      if (token) headers.authorization = `Bearer ${token}`;
      const req = isHttps ? httpsRequest : httpRequest;
      return new Promise<KubeResponse>((resolve, reject) => {
        const r = req(url, { method, headers, ...tls, timeout: c.timeoutMs ?? 15_000 }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = text;
            try { body = JSON.parse(text); } catch { /* 로그 같은 평문 */ }
            resolve({ status: res.statusCode ?? 0, body, text, warnings: warningsOf(res) });
          });
        });
        r.on("timeout", () => r.destroy(new KubeError("KUBE_TIMEOUT", `kube API 시간 초과: ${method} ${url.pathname}`)));
        r.on("error", (e) => reject(e instanceof KubeError ? e : new KubeError("KUBE_CONNECTION", `kube API 연결 실패 (${(e as NodeJS.ErrnoException).code ?? "?"})`)));
        if (payload !== undefined) r.write(payload);
        r.end();
      });
    },
  };
}

export const ok2xx = (s: number) => s >= 200 && s < 300;

// kube 오류 응답(Status)에서 사람이 읽을 한 줄만 꺼낸다
export const statusMessage = (r: KubeResponse) =>
  (r.body && typeof r.body === "object" && "message" in r.body ? String((r.body as { message: unknown }).message) : r.text).slice(0, 1000);

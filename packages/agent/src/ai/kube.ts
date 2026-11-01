import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// 아주 작은 kube API 클라이언트 (의존성 없이 node:http). k3d 샌드박스만 쓴다.
// 기본 접속: 맥에서 `kubectl --context k3d-agent-sbx proxy --port 8001` 을 띄우고 http://127.0.0.1:8001 로 붙는다.
//   → 인증서·kubeconfig 는 kubectl 이 들고 있고, 이 프로세스는 비밀을 하나도 안 받는다.
// 토큰 방식(선택): SANDBOX_KUBE_URL=https://127.0.0.1:6551 + SANDBOX_KUBE_TOKEN_FILE + SANDBOX_KUBE_CA_FILE (파일 경로만 env 에)
export interface KubeConfig { baseUrl: string; token?: string; ca?: string; timeoutMs?: number }
export interface KubeResponse { status: number; body: unknown; text: string }
export class KubeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface KubeClient {
  call(method: string, path: string, o?: { body?: unknown; contentType?: string }): Promise<KubeResponse>;
}

export function kubeClient(c: KubeConfig): KubeClient {
  const base = new URL(c.baseUrl);
  const isHttps = base.protocol === "https:";
  return {
    call(method, path, o = {}) {
      const url = new URL(path, base);
      const payload = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      const headers: Record<string, string> = { accept: "application/json" };
      if (payload !== undefined) {
        headers["content-type"] = o.contentType ?? "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      if (c.token) headers.authorization = `Bearer ${c.token}`;
      const req = isHttps ? httpsRequest : httpRequest;
      return new Promise<KubeResponse>((resolve, reject) => {
        const r = req(url, { method, headers, ...(isHttps && c.ca ? { ca: c.ca } : {}), timeout: c.timeoutMs ?? 15_000 }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = text;
            try { body = JSON.parse(text); } catch { /* 로그 같은 평문 */ }
            resolve({ status: res.statusCode ?? 0, body, text });
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

// kube 오류 응답(Status)에서 사람이 읽을 한 줄만 꺼낸다
export const statusMessage = (r: KubeResponse) =>
  (r.body && typeof r.body === "object" && "message" in r.body ? String((r.body as { message: unknown }).message) : r.text).slice(0, 1000);

// 시험용 가짜 CLI (discover 시험 공용). 명령 줄 정규식 → 응답. 표에 없는 kubectl 종류 목록은 빈 목록, 그 밖은 실패
import type { Exec } from "../src/terraform/real-runner.js";

export type Reply = { code?: number; out?: unknown; err?: string };
export const DIGEST = (c: string) => "sha256:" + c.repeat(64).slice(0, 64);

export function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit && /^kubectl get [a-z0-9.]+ (-n|-A)/.test(line)) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "", ms: 1 };
    if (!hit && /^kubectl api-resources/.test(line)) return { code: 0, stdout: "", stderr: "", ms: 1 };
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const r = hit[1];
    return { code: r.code ?? 0, stdout: typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}

/** 온프레 앱 하나 (Deployment shop-api + Service). over 로 종류별 목록을 바꾼다 */
export function onpremApp(over: Array<[RegExp, Reply]> = [], ns = "shop"): Array<[RegExp, Reply]> {
  return [
    ...over,
    [/^kubectl get nodes/, { out: { items: [{ metadata: { name: "n1" }, status: { nodeInfo: { kubeletVersion: "v1.31.5+k3s1" } } }] } }],
    [/^kubectl get deployments/, { out: { items: [{ metadata: { name: "shop-api", namespace: ns }, spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } },
      template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{ name: "api", image: `ghcr.io/demo/shop-api@${DIGEST("a")}`, ports: [{ containerPort: 8080 }] }] } } } }] } }],
    [/^kubectl get services/, { out: { items: [{ metadata: { name: "shop-api", namespace: ns }, spec: { selector: { app: "shop-api" }, ports: [{ port: 80, targetPort: 8080 }] } }] } }],
  ];
}

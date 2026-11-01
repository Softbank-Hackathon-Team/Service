// Z92: 온프레 Agent 실행기. k3s(k3d) 를 kubectl 로 읽어 보고를 만들고, 서명해 플랫폼 API 로 보낸다 (밖으로만 나감)
//   npm run agent:onprem -- heartbeat                한 번 보내기
//   npm run agent:onprem -- security
//   npm run agent:onprem -- deploy --migration <uuid> --bundle <해시>
//   npm run agent:onprem -- loop [--every 30]         heartbeat 30초마다 + security 10번에 1번 (Ctrl+C 로 멈춤)
// 필요한 .env: AGENT_REPORT_URL, AGENT_KEY_ID, AGENT_KEY_SECRET (agent:key 가 만든 .agent-key.env 를 --env-file 로 더 읽어도 된다)
//   선택: AGENT_NAMESPACE(app), AGENT_CNPG_CLUSTER(app-db), AGENT_KUBE_CONTEXT
// 출력: 보낼 때마다 JSON 한 줄 {kind, status, ok, body}
import {
  collectDeploy, collectHeartbeat, collectSecurity, kubectlExec, sendAgentReport, type AgentReport,
} from "@svc/agent";

const VERSION = "onprem-agent/0.1.0";
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`.env 에 ${k} 필요`); return v; };

const kubectl = kubectlExec({ context: process.env.AGENT_KUBE_CONTEXT || undefined });
const ns = process.env.AGENT_NAMESPACE || "app";
const base = { kubectl, agentVersion: VERSION };
const send = async (r: AgentReport) => {
  const res = await sendAgentReport(r, { baseUrl: need("AGENT_REPORT_URL"), keyId: need("AGENT_KEY_ID"), secret: need("AGENT_KEY_SECRET") });
  console.log(JSON.stringify({ kind: r.kind, status: res.status, ok: res.ok, body: res.body }));
  return res.ok;
};
const heartbeat = async () => send(await collectHeartbeat({ ...base, namespace: ns, cnpgCluster: process.env.AGENT_CNPG_CLUSTER || "app-db" }));
const security = async () => send(await collectSecurity(base));

async function main(): Promise<boolean> {
  switch (args[0]) {
    case "heartbeat": return heartbeat();
    case "security": return security();
    case "deploy": {
      const migrationId = opt("migration"), bundleHash = opt("bundle");
      if (!migrationId || !bundleHash) throw new Error("deploy --migration <uuid> --bundle <해시> 필요");
      return send(await collectDeploy({ ...base, namespace: ns, migrationId, bundleHash }));
    }
    case "loop": {
      const every = Math.max(5, Number(opt("every") ?? 30)) * 1000;
      let n = 0, stop = false;
      process.on("SIGINT", () => { stop = true; });
      process.on("SIGTERM", () => { stop = true; });
      while (!stop) {
        // 한 번 실패해도 멈추지 않는다 (API 재시작·네트워크 끊김). 다음 차례에 다시 보낸다
        await heartbeat().catch((e) => console.error(JSON.stringify({ kind: "heartbeat", ok: false, error: (e as Error).message })));
        if (n++ % 10 === 0) await security().catch((e) => console.error(JSON.stringify({ kind: "security", ok: false, error: (e as Error).message })));
        for (let w = 0; w < every && !stop; w += 500) await new Promise((r) => setTimeout(r, 500));
      }
      return true;
    }
    default: throw new Error("사용: onprem-agent.ts heartbeat | security | deploy --migration <uuid> --bundle <해시> | loop [--every 초]");
  }
}
main().then((ok) => process.exit(ok ? 0 : 1), (e) => { console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exit(1); });

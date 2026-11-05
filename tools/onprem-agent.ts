// Z92: 온프레 Agent 실행기. k3s(k3d) 를 kubectl 로 읽어 보고를 만들고, 서명해 플랫폼 API 로 보낸다 (밖으로만 나감)
//   npm run agent:onprem -- heartbeat                한 번 보내기
//   npm run agent:onprem -- security
//   npm run agent:onprem -- facts                    W5: 보안 사실 (TLS 강제·DB 버전·바깥 노출·권한 단계)
//   npm run agent:onprem -- deploys                  W4: 클러스터 안 Argo Application 이 끝났으면 deploy 보고 (app + 적용 커밋)
//   npm run agent:onprem -- deploy --migration <uuid> --bundle <해시>
//   npm run agent:onprem -- loop [--every 30]         heartbeat·deploys 30초마다 + security·facts 10번에 1번 (Ctrl+C 로 멈춤)
//     deploys 는 앱마다 (커밋, 결과)가 바뀔 때만 보낸다
//   SVC_ENROLL_TOKEN=<토큰> AGENT_REPORT_URL=<API> npm run agent:onprem -- --enroll [--out .agent-key.env]
//     L6: 화면에서 받은 10분 일회용 토큰으로 Agent 키를 받아 --out 파일(권한 600)에 쓰고 heartbeat 한 번 보낸다
//     토큰은 argv 대신 환경변수로 받는다 (ps·셸 기록에 덜 남는다)
// 필요한 .env: AGENT_REPORT_URL, AGENT_KEY_ID, AGENT_KEY_SECRET (agent:key 가 만든 .agent-key.env 를 --env-file 로 더 읽어도 된다)
//   선택: AGENT_NAMESPACE(app), AGENT_CNPG_CLUSTER(app-db), AGENT_KUBE_CONTEXT, AGENT_ARGOCD_NAMESPACE(argocd), AGENT_TENANT(svc.tenant 라벨로 거름)
//         SEALING_CERT_URL(facts 에 실을 sealed-secrets 공개 인증서 주소, 기본 클러스터 안 sealed-secrets-controller.kube-system:8080)
// 출력: 보낼 때마다 JSON 한 줄 {kind, status, ok, body}
import { chmodSync, writeFileSync } from "node:fs";
import {
  collectArgoDeploys, collectDeploy, collectFacts, collectHeartbeat, collectSecurity, DEFAULT_SEALING_CERT_URL, fetchSealingCert, kubectlExec,
  sendAgentReport, type AgentReport,
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
const sealingCert = () => fetchSealingCert(process.env.SEALING_CERT_URL || DEFAULT_SEALING_CERT_URL);
const facts = async () => send(await collectFacts({ ...base, sealingCert }));
// W4: 앱마다 마지막으로 보낸 (커밋, 결과). 같은 상태를 30초마다 다시 보내지 않는다 (재시작하면 한 번 다시 보낸다 = 해롭지 않음)
const lastDeploy = new Map<string, string>();
const deploys = async () => {
  const reps = await collectArgoDeploys({ ...base, argocdNamespace: process.env.AGENT_ARGOCD_NAMESPACE || "argocd", tenant: process.env.AGENT_TENANT || undefined });
  let ok = true;
  for (const r of reps) {
    const k = `${r.bundleHash}:${r.status}`;
    if (lastDeploy.get(r.app!) === k) continue;
    if (await send(r)) lastDeploy.set(r.app!, k); else ok = false;
  }
  return ok;
};

// L6: 등록. 받은 키는 파일에만 쓰고 화면엔 키 번호만. 이 프로세스의 환경에도 넣어 바로 heartbeat 를 보낸다
async function enroll(): Promise<boolean> {
  const token = need("SVC_ENROLL_TOKEN");
  const url = need("AGENT_REPORT_URL").replace(/\/+$/, "");
  const res = await fetch(`${url}/api/v1/agent/register`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollToken: token }) });
  const body = await res.json() as { envId?: string; keyId?: string; secret?: string; code?: string };
  if (res.status !== 201 || !body.keyId || !body.secret) {
    console.error(JSON.stringify({ kind: "enroll", status: res.status, ok: false, code: body.code ?? null }));
    return false;
  }
  const out = opt("out") ?? ".agent-key.env";
  writeFileSync(out, `AGENT_KEY_ID=${body.keyId}\nAGENT_KEY_SECRET=${body.secret}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);   // VL6: mode 는 새 파일에만 먹는다. 이미 있던 느슨한 권한의 파일(644)에 비밀을 쓰면 남이 읽을 수 있다
  console.log(JSON.stringify({ kind: "enroll", status: res.status, ok: true, keyId: body.keyId, envId: body.envId, secretFile: out }));
  process.env.AGENT_KEY_ID = body.keyId;
  process.env.AGENT_KEY_SECRET = body.secret;
  delete process.env.SVC_ENROLL_TOKEN;
  return heartbeat();
}

const USAGE = "사용: onprem-agent --enroll [--out 파일] | heartbeat | security | facts | deploys | deploy --migration <uuid> --bundle <해시> | loop [--every 초]";

async function main(): Promise<boolean> {
  // W1: 이미지 빌드 스모크(CI)가 부른다. 환경변수·kubectl 없이 끝나야 한다
  if (args[0] === "--help" || args[0] === "help") { console.log(`${VERSION}\n${USAGE}`); return true; }
  if (args.includes("--enroll")) return enroll();
  switch (args[0]) {
    case "heartbeat": return heartbeat();
    case "security": return security();
    case "facts": return facts();
    case "deploys": return deploys();
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
        await deploys().catch((e) => console.error(JSON.stringify({ kind: "deploy", ok: false, error: (e as Error).message })));
        if (n++ % 10 === 0) {
          await security().catch((e) => console.error(JSON.stringify({ kind: "security", ok: false, error: (e as Error).message })));
          await facts().catch((e) => console.error(JSON.stringify({ kind: "facts", ok: false, error: (e as Error).message })));
        }
        for (let w = 0; w < every && !stop; w += 500) await new Promise((r) => setTimeout(r, 500));
      }
      return true;
    }
    default: throw new Error(USAGE);
  }
}
main().then((ok) => process.exit(ok ? 0 : 1), (e) => { console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exit(1); });

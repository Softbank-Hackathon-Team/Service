// 데모 초기화의 트래픽 단계 (z75-29, 작업 Z78). tools/demo-reset.sh 가 부른다.
// 워커와 같은 트래픽 어댑터(switcherFromEnv)로 LB 가중치를 출발 100 / 도착 0 으로 한 번 맞추고 다시 읽어 확인한다 (setAndVerify).
// TRAFFIC_PROVIDER 가 cloudflare 가 아니면(빈 값·mock 포함) 아무것도 하지 않고 SKIP. mock 은 워커 메모리 안에만 있어 되돌릴 것이 없다.
// 비밀값(토큰)은 환경 변수에서만 읽고 찍지 않는다. LB 번호는 앞 4자리만 찍는다.
// 마지막 줄 한 줄이 결과다: "OK …" / "SKIP …" (끝 코드 0), 실패는 끝 코드 1.
import { setAndVerify, switcherFromEnv, type Weights } from "@svc/traffic";

const provider = process.env.TRAFFIC_PROVIDER || "mock";
const lbId = process.env.TRAFFIC_LB_ID;
const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const mask = (s: string) => `${s.slice(0, 4)}…`;
const fmt = (w: Weights) => `${Math.round(w.source * 100)}/${Math.round(w.target * 100)}`;

async function main(): Promise<number> {
  if (provider !== "cloudflare") { console.log(`SKIP (TRAFFIC_PROVIDER=${provider})`); return 0; }
  if (!lbId) { console.log("SKIP (TRAFFIC_LB_ID 없음)"); return 0; }
  if (!token) { console.log("SKIP (CLOUDFLARE_API_TOKEN 없음)"); return 0; }
  const t: string = token;
  const sw = switcherFromEnv(process.env, { tokens: () => async () => t });
  const before = await sw.get(lbId);
  const want: Weights = { source: 1, target: 0 };
  if (before.source === 1 && before.target === 0) { console.log(`OK 이미 100/0 (LB ${mask(lbId)})`); return 0; }
  const r = await setAndVerify(sw, lbId, want);
  console.log(`OK ${fmt(before)} → 100/0 (LB ${mask(lbId)}, 시도 ${r.attempts}번)`);
  return 0;
}

main().then((c) => process.exit(c), (e: unknown) => {
  console.log(`가중치 되돌리기 실패: ${(e as Error).message}`);
  process.exit(1);
});

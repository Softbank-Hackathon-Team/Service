import { api, isApiDown } from "./api";
import type { EnvStatus, EnvironmentView } from "./types";
import { inventoryApi, type CloudInventory } from "./pages/environments/inventory";

// Z101: 환경 건강 한 곳. 예전엔 GET /environments/:id/status 만 읽어서 aws·gcp·onprem 은 늘 "모름 · 조회 미구현"이었다
// (서버 실행기가 Azure Mock 뿐). 이제 status 가 실제 값을 주면 그대로 쓰고, 모름+빈 목록(또는 409 실행기 없음)이면
// GET /environments/:id/inventory (Z86, aws·gcloud·kubectl 읽기 명령) 결과로 건강을 센다. 서버 status 실조회(Z100 z100-01)가 들어오면 앞 길로 끝난다.
export type Health = EnvStatus["health"];
export interface EnvHealthView {
  health: Health; mock: boolean; count: number; region: string | null; checkedAt: string | null;
  source: "status" | "inventory"; note: string;
}

const BAD = /fail|error|notready|unhealthy|crashloop|suspend|stopp|terminat|degrad/i;

export function healthFromInventory(c: CloudInventory): EnvHealthView {
  const items = c.groups.flatMap((g) => g.items);
  const bad = items.filter((i) => i.status && BAD.test(i.status));
  const health: Health = c.status === "unavailable" ? "unknown" : c.status === "partial" || bad.length > 0 ? "degraded" : "healthy";
  const note = c.status === "unavailable" ? (c.reason ?? "확인 불가")
    : bad.length > 0 ? `문제 ${bad.length}개: ${bad.slice(0, 2).map((b) => `${b.name}(${b.status})`).join(", ")}`
    : c.status === "partial" ? (c.reason ?? "일부만 읽음") : "";
  return { health, mock: c.source === "azure-mock", count: items.length, region: c.region, checkedAt: c.checkedAt, source: "inventory", note };
}

const fromStatus = (s: EnvStatus): EnvHealthView =>
  ({ health: s.health, mock: s.mock, count: s.resources.length, region: s.region, checkedAt: s.checkedAt, source: "status", note: "" });

export async function readEnvHealth(e: EnvironmentView): Promise<EnvHealthView> {
  let s: EnvStatus | null = null;
  try { s = await api.envStatus(e.id); }
  catch (err) { if (isApiDown(err)) throw err; }
  if (s && (s.mock || s.health !== "unknown" || s.resources.length > 0)) return fromStatus(s);
  const inv = await inventoryApi.get(e.id);
  return healthFromInventory(inv.cloud);
}

import type { AppSpecV2 } from "@svc/contracts";
import { DEMO_SPEC } from "../src/index.js";

// 서비스 하나(shop-api) + 데이터 자원만 남긴 데모 명세. Azure Mock 처럼 신원을 하나만 그리는 도착용
export function oneService(spec: AppSpecV2 = DEMO_SPEC, keep = "shop-api"): AppSpecV2 {
  const ok = (id: string) => { const c = spec.components.find((x) => x.id === id); return !!c && ((c.kind !== "service" && c.kind !== "job") || id === keep); };
  const s = structuredClone(spec);
  s.components = s.components.filter((c) => ok(c.id));
  s.links = s.links.filter((l) => ok(l.from) && (typeof l.to !== "string" || ok(l.to)));
  if (s.entry) s.entry.hosts = s.entry.hosts.map((h) => ({ ...h, routes: h.routes.map((r) => ({ ...r, backends: r.backends.filter((b) => ok(b.to)) })).filter((r) => r.backends.length) })).filter((h) => h.routes.length);
  if (s.entry && !s.entry.hosts.length) delete s.entry;
  return s;
}

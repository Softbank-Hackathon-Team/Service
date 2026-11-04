import { AppSpecV2 } from "@svc/contracts";
import { DEMO_SPEC } from "@svc/adapters";

// 데모 명세에서 서비스 하나(shop-api) + postgres 하나만 남긴 판 (azure_mock 도착도 그릴 수 있는 모양)
export const ONE: AppSpecV2 = (() => {
  const keep = new Set(["shop-api", "shop-db"]);
  return AppSpecV2.parse({ ...DEMO_SPEC, components: DEMO_SPEC.components.filter((c) => keep.has(c.id)),
    links: DEMO_SPEC.links.filter((l) => keep.has(l.from) && keep.has(String(l.to))),
    entry: { ...DEMO_SPEC.entry!, hosts: DEMO_SPEC.entry!.hosts.map((h) => ({ ...h, routes: h.routes.filter((r) => r.backends.every((b) => keep.has(b.to))) })) } });
})();

// shop-api 의 props 를 바꾼 새 판 (시험에서 "승인 뒤 명세가 바뀜"을 만들 때)
export function withApi(spec: AppSpecV2, props: Record<string, unknown>): AppSpecV2 {
  return AppSpecV2.parse({ ...spec, components: spec.components.map((c) => c.id === "shop-api" ? { ...c, props: { ...c.props, ...props } } : c) });
}
export const apiImage = (spec: AppSpecV2, digestChar: string) => {
  const c = spec.components.find((x) => x.id === "shop-api")!;
  return withApi(spec, { image: { ...(c.props as { image: object }).image, digest: "sha256:" + digestChar.repeat(64) } });
};

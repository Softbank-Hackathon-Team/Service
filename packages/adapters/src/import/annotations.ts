// N10 DRAFT(ai): annotation 허용 목록. 비밀이 annotation 에 들어 있을 수 있어서 전부 읽지 않고, 동작에 영향을 주는 키만 읽어 그대로 옮긴다.
//   목록은 팀 검토 대상. 목록 밖 키는 discover 가 아예 안 읽는다(값이 메모리에도 안 남음).
//   snippet 계열(configuration-snippet·server-snippet)은 임의 설정이라 뺀다 (보안 가드레일과 같은 이유)
// AN-1 DRAFT(ai): 인증·접근 제한·인증서·고정 IP 키도 옮긴다 ("그대로" — 빠지면 출발에서 막혀 있던 화면이 열림).
//   auth-secret·auth-idp-* 는 비밀 이름(·클라이언트 id)만 담는 키라 값을 옮겨도 비밀값은 안 따라옴.
//   도착 입구가 이 뜻을 못 지키면 v2Blockers 가 사람에게 묻는다 (ACCESS_ANNOTATION)
const INGRESS = [
  /^nginx\.ingress\.kubernetes\.io\/(auth-(url|signin|signin-redirect-param|method|type|secret|secret-type|realm|response-headers|request-redirect|cache-key|cache-duration|always-set-cookie|proxy-set-headers)|auth-tls-(secret|verify-client|verify-depth|error-page|pass-certificate-to-upstream|match-cn)|denylist-source-range|ssl-passthrough|satisfy|global-auth-url)$/,
  /^alb\.ingress\.kubernetes\.io\/(inbound-cidrs|certificate-arn|ssl-policy|wafv2-acl-arn|waf-acl-id|shield-advanced-protection|security-groups|auth-(type|idp-cognito|idp-oidc|on-unauthenticated-request|scope|session-cookie|session-timeout)|(actions|conditions)\.[A-Za-z0-9_.-]+)$/,
  /^kubernetes\.io\/ingress\.(global-static-ip-name|regional-static-ip-name|allow-http)$/,
  /^networking\.gke\.io\/(managed-certificates|v1beta1\.FrontendConfig)$/,
  /^ingress\.gcp\.kubernetes\.io\/pre-shared-cert$/,
  /^nginx\.ingress\.kubernetes\.io\/(rewrite-target|use-regex|app-root|ssl-redirect|force-ssl-redirect|backend-protocol|proxy-body-size|proxy-(connect|read|send)-timeout|proxy-buffer(ing|-size|s-number)|proxy-next-upstream(-tries|-timeout)?|enable-cors|cors-(allow-origin|allow-methods|allow-headers|allow-credentials|expose-headers|max-age)|affinity|affinity-mode|session-cookie-(name|path|max-age|expires|samesite|secure)|limit-(rps|rpm|connections|burst-multiplier)|whitelist-source-range|allowlist-source-range|permanent-redirect|temporal-redirect|upstream-vhost|load-balance|client-body-buffer-size|server-alias|proxy-http-version|websocket-services|enable-access-log|custom-http-errors|default-backend|canary(-weight|-by-header|-by-header-value|-by-cookie)?)$/,
  /^traefik\.ingress\.kubernetes\.io\/router\.(entrypoints|middlewares|priority|tls)$/,
  /^alb\.ingress\.kubernetes\.io\/(scheme|target-type|healthcheck-path|listen-ports|ssl-redirect|group\.name|load-balancer-attributes|target-group-attributes)$/,
  /^kubernetes\.io\/ingress\.class$/,
];
const SERVICE = [
  /^service\.beta\.kubernetes\.io\/aws-load-balancer-(type|scheme|internal|nlb-target-type|cross-zone-load-balancing-enabled|backend-protocol|healthcheck-path|connection-idle-timeout|proxy-protocol)$/,
  /^networking\.gke\.io\/(load-balancer-type|internal-load-balancer-allow-global-access)$/,
  /^cloud\.google\.com\/(load-balancer-type|neg|backend-config|app-protocols)$/,
  /^metallb\.universe\.tf\/(address-pool|loadBalancerIPs|allow-shared-ip)$/,
  /^prometheus\.io\/(scrape|port|path|scheme)$/,
];
const POD = [
  /^prometheus\.io\/(scrape|port|path|scheme)$/,
  /^cluster-autoscaler\.kubernetes\.io\/safe-to-evict$/,
  /^kubectl\.kubernetes\.io\/default-container$/,
  /^sidecar\.istio\.io\/inject$/,
  // SS-V: Vault Agent 주입 (어느 경로를 어느 파일로). 템플릿 본문은 안 읽음
  /^vault\.hashicorp\.com\/(agent-inject|role|agent-pre-populate-only|agent-inject-secret-[A-Za-z0-9_.-]+|agent-inject-file-[A-Za-z0-9_.-]+|namespace)$/,
  /^linkerd\.io\/inject$/,
];
export const ANNOTATION_ALLOW = { ingress: INGRESS, service: SERVICE, pod: POD } as const;
export type AnnotationScope = keyof typeof ANNOTATION_ALLOW;

/** 클라우드 하나에서만 뜻이 있는 키 (도착 클라우드가 다르면 검토) */
export const CLOUD_ONLY: Array<{ re: RegExp; cloud: "aws" | "gcp" | "onprem" }> = [
  { re: /^(service\.beta\.kubernetes\.io\/aws-|alb\.ingress\.kubernetes\.io\/)/, cloud: "aws" },
  { re: /^(networking\.gke\.io\/|cloud\.google\.com\/|ingress\.gcp\.kubernetes\.io\/|kubernetes\.io\/ingress\.(global-static-ip-name|regional-static-ip-name|allow-http)$)/, cloud: "gcp" },
  { re: /^metallb\.universe\.tf\//, cloud: "onprem" },
];

/** 허용 키만 남긴다. 없으면 undefined */
export function allowAnnotations(scope: AnnotationScope, a: unknown): Record<string, string> | undefined {
  if (!a || typeof a !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>))
    if (typeof v === "string" && ANNOTATION_ALLOW[scope].some((r) => r.test(k))) out[k] = v;
  return Object.keys(out).length ? Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y))) : undefined;
}

// AN-1: 입구 인증·접근 제한 키 (도착 입구가 못 지키면 사람이 정함)
export const ACCESS_ANNOTATION = /^(nginx\.ingress\.kubernetes\.io\/(auth-|global-auth-url|whitelist-source-range|allowlist-source-range|denylist-source-range|satisfy)|alb\.ingress\.kubernetes\.io\/(inbound-cidrs|auth-|wafv2-acl-arn|waf-acl-id|security-groups))/;

// AN-1 DRAFT(ai): 허용 목록 밖이라도 동작과 상관없는 도구 기록 키 (버린 목록에 안 적음)
const BOOKKEEPING = /^(kubectl\.kubernetes\.io\/(last-applied-configuration|restartedAt)|deployment\.kubernetes\.io\/|kubernetes\.io\/change-cause|meta\.helm\.sh\/|argocd\.argoproj\.io\/|kustomize\.toolkit\.fluxcd\.io\/|helm\.toolkit\.fluxcd\.io\/|field\.cattle\.io\/|cloud\.google\.com\/neg-status$|ingress\.kubernetes\.io\/(backends|forwarding-rule|https-forwarding-rule|target-proxy|https-target-proxy|url-map|ssl-cert|static-ip|firewall-rule)$)/;

/** AN-1: 허용 목록에 없어 버린 키 이름 (값은 안 봄). 도구 기록 키는 뺀다. 정렬 */
export function droppedAnnotations(scope: AnnotationScope, a: unknown): string[] {
  if (!a || typeof a !== "object") return [];
  return Object.keys(a as Record<string, unknown>).filter((k) => !ANNOTATION_ALLOW[scope].some((r) => r.test(k)) && !BOOKKEEPING.test(k)).sort();
}

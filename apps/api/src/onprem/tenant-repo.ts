import { DomainError } from "@svc/core";

// 온프레 고객 Argo CD 가 읽을 회사 전용 gitops 레포와 그 레포에만 걸린 읽기 전용 배포 키 (Agent 등록 때 한 번).
//   왜: 공용 gitops 레포의 읽기 자격을 고객 서버에 두면 다른 회사 폴더까지 읽힌다 (GitHub 읽기 권한은 레포 단위).
//   배포 키의 비밀 반쪽은 고객 서버가 만들고 클러스터 밖으로 안 나간다. 플랫폼은 공개 반쪽만 받아 그 레포에 건다.
//   워커는 온프레 묶음을 같은 이름의 레포로 복사한다 (apps/worker/src/gitops/tenant-mirror.ts, 같은 GITOPS_TENANT_REPO_URL)
// 필요한 설정 (둘 다 있어야 켜진다):
//   GITOPS_TENANT_REPO_URL  예 https://github.com/<조직>/gitops-{tenant}.git  ({tenant} = 회사 slug)
//   GITOPS_TENANT_TOKEN     조직 레포 만들기 + 배포 키 걸기 권한 (fine-grained: 모든 레포 Administration·Contents 쓰기)
// 조직 설정에서 배포 키가 꺼져 있으면 GitHub 가 거부한다 → TENANT_REPO_DEPLOY_KEY_DENIED 로 알린다

export interface TenantRepoConfig { owner: string; nameTemplate: string; token: string; api: string }
export interface TenantRepo { owner: string; name: string; sshUrl: string }

const GH = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]*\{tenant\}[A-Za-z0-9._-]*?)(?:\.git)?$/;
const SLUG = /^t-[0-9a-f]{8}$/;
// 고객 서버가 만든 공개 키. ed25519 한 줄만 받는다 (설명 칸은 버린다)
const PUBKEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}(?:==|=)?$/;

export function tenantRepoConfig(env: NodeJS.ProcessEnv = process.env): TenantRepoConfig | null {
  const url = env.GITOPS_TENANT_REPO_URL?.trim(), token = env.GITOPS_TENANT_TOKEN?.trim();
  if (!url || !token) return null;
  const m = GH.exec(url);
  if (!m) throw new Error("GITOPS_TENANT_REPO_URL 은 https://github.com/<조직>/<이름에 {tenant}>.git 모양이어야 한다");
  return { owner: m[1]!, nameTemplate: m[2]!, token, api: env.GITHUB_API_URL?.trim() || "https://api.github.com" };
}

export const normalizePublicKey = (k: string): string | null => {
  // 여러 줄이면 거부 (키 두 개를 한 번에 거는 것 방지). 설명 칸(공백 뒤)만 버린다
  if (/[\r\n]/.test(k.trim())) return null;
  const [type, body] = k.trim().split(/[ \t]+/);
  const one = `${type} ${body}`;
  return PUBKEY.test(one) ? one : null;
};

export function tenantRepoFor(cfg: TenantRepoConfig, tenant: string): TenantRepo {
  if (!SLUG.test(tenant)) throw new DomainError(500, "TENANT_REPO_FAILED", "회사 이름 모양이 아니다");
  const name = cfg.nameTemplate.split("{tenant}").join(tenant);
  // SSH 를 443 으로 (ssh.github.com:443). 고객 방화벽이 나가는 22 를 막아도 읽힌다.
  //   Argo CD v2.13.3 기본 known_hosts 에 [ssh.github.com]:443 키가 들어 있다 (tools/argocd-core-install-v2.13.3.yaml)
  return { owner: cfg.owner, name, sshUrl: `ssh://git@ssh.github.com:443/${cfg.owner}/${name}.git` };
}

type Fetch = typeof fetch;

/** 회사 레포를 (없으면) 만들고, 고객 공개 키를 읽기 전용 배포 키로 건다. 같은 키가 이미 걸려 있으면 그대로 둔다 (설치를 다시 돌린 경우) */
export async function ensureTenantRepo(cfg: TenantRepoConfig, tenant: string, publicKey: string, keyTitle: string,
  f: Fetch = fetch): Promise<TenantRepo> {
  const repo = tenantRepoFor(cfg, tenant);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${cfg.api}${path}`, { method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${cfg.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
                 ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 본문이 JSON 이 아님 */ }
    return { status: res.status, json: json as Record<string, unknown> | Array<Record<string, unknown>> | null };
  };
  const fail = (code: string, what: string, status: number) =>
    new DomainError(502, code, `${what} 실패 (GitHub ${status}). 회사 레포 ${repo.owner}/${repo.name}`);

  const got = await call("GET", `/repos/${repo.owner}/${repo.name}`);
  if (got.status === 404) {
    // auto_init: 첫 가지(main)를 만들어 둔다 → 워커 첫 복사·고객 Argo CD 첫 읽기가 빈 레포로 실패하지 않는다
    const made = await call("POST", `/orgs/${repo.owner}/repos`, { name: repo.name, private: true, auto_init: true,
      description: `platform gitops bundles for ${tenant} (on-prem pull, written by the platform worker only)` });
    if (made.status !== 201 && made.status !== 422) throw fail("TENANT_REPO_FAILED", "회사 레포 만들기", made.status);
  } else if (got.status !== 200) throw fail("TENANT_REPO_FAILED", "회사 레포 확인", got.status);

  const keys = await call("GET", `/repos/${repo.owner}/${repo.name}/keys?per_page=100`);
  if (keys.status === 200 && Array.isArray(keys.json) && keys.json.some((k) => normalizePublicKey(String(k.key ?? "")) === publicKey))
    return repo;
  const add = await call("POST", `/repos/${repo.owner}/${repo.name}/keys`, { title: keyTitle, key: publicKey, read_only: true });
  if (add.status === 201) return repo;
  // 조직이 배포 키를 막아 두면 403/422 로 거부된다 (조직 설정 → Deploy keys 허용)
  if (add.status === 403 || add.status === 422) throw fail("TENANT_REPO_DEPLOY_KEY_DENIED", "읽기 전용 배포 키 걸기", add.status);
  throw fail("TENANT_REPO_FAILED", "읽기 전용 배포 키 걸기", add.status);
}

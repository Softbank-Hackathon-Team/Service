import { InventoryRefreshJob, type Provider } from "@svc/contracts";
import { withTenant, scrubString } from "@svc/core";
import { actionsOfCommands, envFor, gcpEnvFor, inventoryUnavailable, readAwsTargetFacts, readInventory, type AwsTargetFactsRead, type CloudInventory, type InventoryDeps } from "@svc/adapters";
import { StsCliError, TempRoleDenied, type TempRoleBroker } from "@svc/security";
import { realStsEnabled, tempRoles } from "../platform.js";

// #242: 환경 화면의 실자원 조회. api 는 클라우드 권한이 없으니 여기서 관찰 역할을 빌려 읽고 environment_inventory 에 저장한다
//   세 구간: ① 환경 다시 읽기 ② 트랜잭션 밖에서 역할 빌려 CLI 읽기 + 회수 ③ 저장
//   못 읽으면 던지지 않고 그 이유를 결과로 저장한다 (화면이 이유를 보여 주고, 60초 지나면 다음 화면 요청이 다시 넣는다)

// DRAFT(ai): 15분 (STS 최소값, 연결 확인과 같음). 읽기가 끝나면 바로 돌려준다
export const INVENTORY_TTL_SEC = 900;
// readInventory·readAwsTargetFacts 가 부르는 명령과 같은 목록. 표(observe-permissions)에 없는 명령이면 던진다
const AWS_COMMANDS = ["sts get-caller-identity", "eks list-clusters", "rds describe-db-instances", "ec2 describe-vpcs",
  "elbv2 describe-load-balancers", "ecr describe-repositories", "eks describe-cluster", "ec2 describe-subnets"] as const;
const GCP_COMMANDS = ["container clusters list", "sql instances list", "compute networks list", "compute forwarding-rules list",
  "artifacts repositories list"] as const;
export const inventoryObserveActions = (provider: "aws" | "gcp"): string[] =>
  provider === "aws" ? actionsOfCommands("aws", AWS_COMMANDS) : actionsOfCommands("gcp", GCP_COMMANDS);

export const MOCK_CREDENTIALS_REASON = "확인 불가: 가짜 자격 (MOCK_CREDENTIALS) — 콘솔 연결 링크로 만든 환경인지 확인";

export interface InventoryRefreshDeps { roles?: Pick<TempRoleBroker, "issue" | "use" | "revoke">; realSts?: boolean; read?: Pick<InventoryDeps, "exec">; env?: NodeJS.ProcessEnv }

interface EnvRow { provider: Provider; connection_status: string; account_id: string | null; region: string | null; cluster_name: string | null }
// 저장 모양 = 실자원(화면용) + AWS 도착 사실(계획·apply 가 읽음, env-layer.ts readInventoryFacts). api 는 targetFacts 를 빼고 읽는다
export type StoredInventory = CloudInventory & { targetFacts?: AwsTargetFactsRead };

export async function handleInventoryRefresh(raw: unknown, deps: InventoryRefreshDeps = {}): Promise<"saved" | "skipped"> {
  const job = InventoryRefreshJob.parse(raw);   // 큐 내용은 믿지 않는다: 모양부터
  const env = await withTenant(job.tenantId, async (tx) => (await tx.query(
    `SELECT provider, connection_status, account_id, region, cluster_name FROM environments WHERE id=$1`, [job.envId])).rows[0] as EnvRow | undefined);
  if (!env) return "skipped";
  // Azure Mock·온프레 Agent 보고는 api 가 바로 읽는다. 옛 설정에서 넣은 작업이 와도 저장하지 않는다
  const penv = deps.env ?? process.env;
  if (env.provider === "azure_mock" || (env.provider === "onprem" && penv.ONPREM_FLOOR_VIA_GIT !== "0")) return "skipped";

  const result = await readFor(job, env, deps, penv);
  await withTenant(job.tenantId, (tx) => tx.query(
    `INSERT INTO environment_inventory (environment_id, tenant_id, result, checked_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (environment_id) DO UPDATE SET result = EXCLUDED.result, checked_at = EXCLUDED.checked_at`,
    [job.envId, job.tenantId, JSON.stringify(result)]));
  return "saved";
}

async function readFor(job: InventoryRefreshJob, env: EnvRow, deps: InventoryRefreshDeps, penv: NodeJS.ProcessEnv): Promise<StoredInventory> {
  const read = deps.read ?? {};
  // AWS 는 같은 자격으로 연결 때 적은 도착 EKS 의 VPC·서브넷도 읽는다 (TF_FACT_* 없이 계획·apply 하려고)
  const readAws = async (e: NodeJS.ProcessEnv): Promise<StoredInventory> => ({
    ...(await readInventory("aws", { ...read, env: e })), targetFacts: await readAwsTargetFacts(env.cluster_name, { ...read, env: e }) });
  if (penv.INVENTORY_CLI === "0") return inventoryUnavailable(env.provider, "INVENTORY_CLI=0 (실자원 읽기 끔)");
  // 온프레 push 시연: 고객 역할이 없다. 워커의 kubectl context 로 읽는다
  if (env.provider !== "aws" && env.provider !== "gcp") return readInventory(env.provider, { ...read, env: penv });
  // 빌릴 역할이 없거나 끊긴 환경은 읽지 않는다 (가져오기와 같은 기준)
  if (env.connection_status !== "connected" && env.connection_status !== "unstable")
    return inventoryUnavailable(env.provider, `확인 불가: 환경이 연결 상태가 아님 (${env.connection_status})`);

  const roles = deps.roles ?? tempRoles();
  let ref: string | null = null;
  try {
    const cred = await roles.issue({ tenantId: job.tenantId, envId: job.envId, provider: env.provider, purpose: "observe",
      actions: inventoryObserveActions(env.provider), ttlSec: INVENTORY_TTL_SEC }, { step: "inventory" });
    ref = cred.credentialRef;
    if (cred.stub) {
      // #241 과 같은 규칙: 진짜 발급기 판에서 가짜 자격 = 연결 링크를 안 거친 환경. 프로세스 자격으로 읽으면 플랫폼 계정을 고객 자원처럼 보여 준다
      if (deps.realSts ?? realStsEnabled(penv)) return inventoryUnavailable(env.provider, MOCK_CREDENTIALS_REASON);
      // 로컬·시험(REAL_STS=0): 지금처럼 프로세스 자격
      return env.provider === "aws" ? await readAws(penv) : await readInventory(env.provider, { ...read, env: penv });
    }
    const k = roles.use(ref, job.tenantId);
    if (env.provider === "gcp") {
      if (k.kind !== "bearer") throw new Error("GCP 발급기가 bearer 자격이 아닌 것을 돌려줬다");
      if (!env.account_id) return inventoryUnavailable("gcp", "확인 불가: 환경에 GCP 프로젝트가 없음");
      // 프로젝트는 환경 값으로 덮어쓴다 (워커 자기 GCP_PROJECT 를 보면 플랫폼 프로젝트를 읽는다)
      const e = { ...gcpEnvFor(k.token, env.account_id, penv), GCP_PROJECT: env.account_id, ...(env.region ? { GCP_REGION: env.region } : {}) };
      return await readInventory("gcp", { ...read, env: e });
    }
    if (k.kind !== "aws") throw new Error("AWS 발급기가 aws 자격이 아닌 것을 돌려줬다");
    // DRAFT(ai): 환경에 리전이 없으면 서울 (import.ts borrowObserve 와 같음)
    const e = envFor({ AWS_ACCESS_KEY_ID: k.accessKeyId, AWS_SECRET_ACCESS_KEY: k.secretAccessKey, AWS_SESSION_TOKEN: k.sessionToken,
      AWS_REGION: env.region || "ap-northeast-2" }, penv);
    return await readAws(e);
  } catch (e) {
    if (e instanceof TempRoleDenied) return inventoryUnavailable(env.provider, `확인 불가: 관찰 역할을 못 빌림 (${e.code})`);
    if (e instanceof StsCliError && e.awsCode) return inventoryUnavailable(env.provider, `확인 불가: 관찰 역할을 못 빌림 (${e.awsCode})`);
    return inventoryUnavailable(env.provider, `확인 불가: ${scrubString((e as Error)?.message ?? String(e)).slice(0, 200)}`);
  } finally {
    if (ref) await roles.revoke(ref, job.tenantId, "inventory_done").then(() => undefined,
      (e) => console.error("inventory revoke", scrubString((e as Error).message)));
  }
}

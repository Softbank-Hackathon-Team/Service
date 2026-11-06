import type { PlanDoc, Provider, TfVars } from "@svc/contracts";
import { ENV_LAYER_KEYS, factsFromEnv, mergeFacts, readImported, workRootOf, type ImportedInfra } from "@svc/adapters";
import { tenantSlug } from "../gitops/bundle.js";
import { stableHash } from "./_step.js";

// G7-3·G7-4 DRAFT(ai): 계획서에 싣고 apply 가 다시 비교하는 "도착 사실" 두 가지. 계획(plan.ts)과 적용(apply-real.ts)이 같은 함수를 부른다.
//   targetFacts = Terraform 자리표시(<env:키>)가 실제로 쓰는 비밀 아닌 값 (계정 번호·VPC·서브넷·클러스터…). 환경 표 account_id + 워커 TF_FACT_*
//     tenantId·migrationId 는 이전 자체의 번호라 뺀다 (지문을 바꿀 뜻이 없음)
//   provision     = 작업 폴더 imported.json (이미 있는 도착 자원 재사용). 출력값은 지문만 싣는다 (주소 글자는 계획서에 안 남김)

const IDENTITY_KEYS = new Set(["tenantId", "migrationId"]);

/** 자리표시 이름 목록 (정렬) */
export function placeholdersOf(vars: TfVars): string[] {
  return [...new Set([...JSON.stringify(vars).matchAll(/<env:([A-Za-z0-9]+)>/g)].map((m) => m[1]!))].sort();
}

/** 계획·적용·배포가 같은 규칙으로 쓰는 자리표시 사실: 환경 층 DB 사실(dbFacts, ready 줄) > 워커 TF_FACT_* > 환경 표 계정 */
export function mergedFactsOf(env: NodeJS.ProcessEnv, provider: Provider, accountId: string | null | undefined,
    dbFacts?: Record<string, string> | null, known: Record<string, string | undefined> = {}): Record<string, string> {
  return mergeFacts(dbFacts, factsFromEnv(env, {
    ...known,
    accountId: provider === "aws" ? accountId ?? undefined : undefined,
    projectId: provider === "gcp" ? accountId ?? undefined : undefined,
  }));
}

/** 계획·적용이 같은 규칙으로 채우는 비밀 아닌 도착 사실. 아무것도 없으면 undefined (예전 지문 그대로) */
export function targetFactsOf(vars: TfVars, env: NodeJS.ProcessEnv, provider: Provider, accountId: string | null | undefined,
    dbFacts?: Record<string, string> | null): Record<string, string> | undefined {
  const facts = mergedFactsOf(env, provider, accountId, dbFacts);
  const out: Record<string, string> = {};
  for (const k of placeholdersOf(vars)) if (!IDENTITY_KEYS.has(k) && facts[k] !== undefined) out[k] = facts[k]!;
  return Object.keys(out).length ? out : undefined;
}

export function provisionOf(imp: ImportedInfra | null): PlanDoc["provision"] {
  if (!imp) return undefined;
  return { mode: "reuse", source: imp.source, resources: [...imp.resources].sort(), outputsHash: stableHash(imp.tfOutputs) };
}

/** 작업 폴더의 imported.json (없거나 못 읽으면 null. 깨진 파일은 던진다 = 재사용 여부를 모르는 채 계획하지 않음) */
export function importedFor(env: NodeJS.ProcessEnv, migrationId: string, tenantId: string): ImportedInfra | null {
  return readImported(workRootOf(env), migrationId, tenantSlug(tenantId));
}

/** apply 직전: 계획서에 실린 사실과 지금 다시 채운 값이 같은가. 다르면 이유 한 줄 (값 글자는 안 남기고 키 이름만) */
export function factsDrift(plan: PlanDoc, now: Record<string, string> | undefined, imp: ImportedInfra | null,
    layer?: { varsHash?: string } | null): string | null {
  // 환경 층 create 계획: 계획 때는 클러스터 이름·네트워크를 몰랐다 → 그 키는 빼고, 환경 층 입력 지문(varsHash)으로 대조
  const create = plan.envLayer?.mode === "create";
  const skip = new Set<string>(create ? ENV_LAYER_KEYS : []);
  // DRAFT(ai): targetFacts 가 없는 계획서(이 칸 전에 만든 판·흉내 길)는 비교하지 않는다 (옛 승인과 호환)
  if (plan.targetFacts) {
    const a = plan.targetFacts, b = now ?? {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => !skip.has(k) && a[k] !== b[k]);
    if (keys.length) return `승인한 도착 사실과 지금 값이 다르다: ${keys.join(", ")} (계정·VPC·클러스터가 승인 뒤 바뀜)`;
  }
  if (create) {
    if (!layer) return "승인한 계획은 환경 층을 만드는 것인데 환경 층 사실이 없다";
    if (layer.varsHash !== plan.envLayer!.varsHash) return "환경 층 입력 지문(vars_hash)이 승인과 다르다 (프로젝트·지역·이름이 승인 뒤 바뀜)";
  }
  const p = provisionOf(imp);
  if (!plan.provision && p) return "승인 뒤 imported.json 이 생겼다 (계획서는 새로 만들기였음)";
  if (plan.provision && !p) return "승인한 계획은 기존 자원 재사용인데 imported.json 이 없다";
  if (plan.provision && p && (plan.provision.outputsHash !== p.outputsHash || stableHash(plan.provision.resources) !== stableHash(p.resources)))
    return "승인 뒤 imported.json 의 자원·출력이 바뀜";
  return null;
}

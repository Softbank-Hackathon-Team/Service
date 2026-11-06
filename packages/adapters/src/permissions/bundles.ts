import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionBundleFile, type PermissionBundle, type PermissionRequiredWhen } from "@svc/contracts";
import { actionsFor, type PermTable } from "../common/actions.js";
import * as gcp from "../gcp/index.js";
import * as aws from "../aws/index.js";
import { DATA_TYPES } from "../target/data.js";
import { GRANT_TYPES_GCP } from "../target/grants.js";

// PERM-GATE: 고객 권한 "묶음". 단계·클라우드·기능마다 어느 고객 주체(SA·역할)에 무슨 권한·API 가 있어야 하는지.
//   손으로 적은 두 번째 목록을 만들지 않는다 — 입력은 이미 있는 원본뿐이다:
//     GCP 실행·환경 층 역할 = 권한표 PERMS 에서 export-permissions 가 만든 역할 파일, 관찰·확인 역할 = gcp-connect.sh 의 목록,
//     plan 역할 = 관찰 + 실행 역할 파일의 읽기 동사(스크립트 PLAN_READS 와 같은 규칙), AWS = export-permissions 가 만든 정책 문서.
//   이 파일은 그 목록을 "기능별로 나누고 필요 조건을 붙이는" 일만 한다 (나누기 기준 = 권한표의 자원 종류).
//   결과는 export-permissions 가 infra/permissions/permission-bundles.json(+ 연결 스크립트용 gcp-bundles.tsv)으로 낸다

/** 권한 판. 묶음 내용이 바뀌면 올린다 (시험 permission-bundles 가 PERMISSIONS_DIGEST 와 대조해 안 올리면 실패).
 *  같은 번호가 연결 스크립트 역할 설명·연결 템플릿 역할 태그에 박힌다 → 고객 쪽에 붙은 판을 관찰 역할로 읽는다 */
export const PERMISSIONS_VERSION = 1;
/** 판 1 의 묶음 지문 (bundleDigest). 묶음을 바꿨으면 PERMISSIONS_VERSION 을 올리고 이 값을 새 지문으로 바꾼다 */
export const PERMISSIONS_DIGEST = "b2c7859c08ee17cd";

/** AWS 관찰 역할이 실행 역할 정책을 흉내 평가하는 권한 (같은 계정 svc-* 역할에만, 연결 템플릿 observe-permcheck 문) */
export const AWS_PERMCHECK_ACTIONS = ["iam:SimulatePrincipalPolicy"] as const;
export const GCP_PERMCHECK_ROLE = "platform_observe_permcheck";

export interface BundleInputs {
  gcp: {
    /** 관찰·확인·허브·역할 정의 읽기(platform_observe_permcheck) 역할 목록 = gcp-connect.sh 원본 */
    observe: string[]; verify: string[]; hub: string[]; permcheck: string[];
    operate: string[]; operateIam: string[]; dbSecret: string[]; env: string[];
    /** 연결 스크립트가 켜는 API (원래 프로젝트 · 전용 프로젝트) */
    sourceApis: string[]; targetApis: string[];
  };
  aws: { observe: string[]; operatePolicy: PolicyDoc; relayPolicy: PolicyDoc };
}
export interface PolicyStatement { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> }
export interface PolicyDoc { Version?: string; Statement: PolicyStatement[] }

const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();
const isRead = (p: string) => /\.(get|list|getIamPolicy)$/.test(p);
const allPurposes = (t: PermTable, types: readonly string[]) => uniq(["plan", "apply", "destroy"].flatMap((p) => actionsFor(t, [...types], p as "plan")));
const actionsOf = (s: PolicyStatement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

// 권한 이름 앞머리 → 그 권한을 쓰려면 켜져 있어야 하는 API. 묶음의 API = 이 표로 뽑은 것 ∩ 연결 스크립트가 켜는 것 (링크로 켤 수 있는 것만 묻는다)
const API_OF_PREFIX: Record<string, string> = { resourcemanager: "cloudresourcemanager", cloudsql: "sqladmin" };
const apiOf = (perm: string) => `${API_OF_PREFIX[perm.split(".")[0]!] ?? perm.split(".")[0]}.googleapis.com`;
const apisFor = (perms: string[], on: string[]) => uniq(perms.map(apiOf).filter((a) => on.includes(a)));

/** 권한표 원본에서 묶음을 만든다 (순수). 실행 역할 파일의 권한은 하나도 빠짐없이 어느 실행 묶음엔가 들어간다 (시험이 대조) */
export function buildPermissionBundles(i: BundleInputs): PermissionBundle[] {
  const g = i.gcp;
  const b = (x: Omit<PermissionBundle, "apis" | "conditional"> & { apis?: string[]; conditional?: boolean }): PermissionBundle =>
    ({ conditional: false, apis: [], ...x, permissions: uniq(x.permissions) });
  // ── GCP 실행 역할(platform_operate) 나누기: 기능 = 권한표의 자원 종류 묶음 ──
  const operateSet = new Set(g.operate);
  const pick = (types: readonly string[], extra: string[] = []) => uniq([...allPurposes(gcp.PERMS, types), ...extra]).filter((p) => operateSet.has(p));
  const secretTypes = ["google_secret_manager_secret", "google_secret_manager_secret_iam_member"];
  const pgTypes = ["google_sql_database_instance", "google_sql_database", "google_sql_user", "random_password", "google_secret_manager_secret_version"];
  const dataTypes = [...Object.values(DATA_TYPES.gcp).flat(), ...GRANT_TYPES_GCP];
  const secrets = pick(secretTypes), postgres = pick([...pgTypes, ...secretTypes]), data = pick(dataTypes);
  // 기본 앱 = 나머지 전부 (앱 모듈의 늘 쓰는 종류 + gcp/root API 켜기·업그레이드 멈춤 + 이미지 복사 올리기). 기능 묶음에만 있는 권한은 뺀다
  const featureOnly = new Set([...secrets, ...postgres, ...data].filter((p) =>
    !pick([...gcp.resourceTypes({ secrets: false, database: false }), ...gcp.ROOT_TYPES]).includes(p)));
  const base = g.operate.filter((p) => !featureOnly.has(p));
  const plan = uniq([...g.observe, ...g.operate.filter(isRead)]);
  const observe = uniq([...g.observe, ...g.verify]);
  const sa = (s: string) => s;   // 주체 = SA 짧은 이름 (프로젝트는 side 로 정해진다)
  const gcpBundles: PermissionBundle[] = [
    b({ id: "gcp.observe.source", cloud: "gcp", stage: "observe", side: "source", principal: sa("svc-observe"), role: "platform_observe",
      // 관찰 묶음의 API = 연결 스크립트가 그 프로젝트에 켜는 것 전부 (빌리기 iamcredentials·결제 확인 cloudbilling 처럼 권한 이름과 안 이어지는 것 포함)
      permissions: observe, apis: uniq(g.sourceApis), requiredWhen: ["always"] }),
    b({ id: "gcp.observe.target", cloud: "gcp", stage: "observe", side: "target", principal: sa("svc-observe"), role: "platform_observe",
      permissions: observe, apis: uniq(g.targetApis), requiredWhen: ["always"] }),
    b({ id: "gcp.permcheck", cloud: "gcp", stage: "observe", side: "target", principal: sa("svc-observe"), role: GCP_PERMCHECK_ROLE,
      permissions: g.permcheck, requiredWhen: ["always"] }),
    b({ id: "gcp.plan", cloud: "gcp", stage: "plan", side: "target", principal: sa("svc-plan"), role: "platform_plan",
      permissions: plan, apis: apisFor(plan, g.targetApis), requiredWhen: ["always"] }),
    b({ id: "gcp.env", cloud: "gcp", stage: "env", side: "target", principal: sa("svc-env"), role: "platform_env",
      permissions: g.env, apis: apisFor(g.env, g.targetApis), requiredWhen: ["env_layer_create"] }),
    b({ id: "gcp.operate", cloud: "gcp", stage: "operate", side: "target", principal: sa("svc-operate"), role: "platform_operate",
      permissions: base, apis: apisFor(base, g.targetApis), requiredWhen: ["always"] }),
    b({ id: "gcp.operate.secrets", cloud: "gcp", stage: "operate", side: "target", principal: sa("svc-operate"), role: "platform_operate",
      permissions: secrets, apis: apisFor(secrets, g.targetApis), requiredWhen: ["secrets"] }),
    b({ id: "gcp.operate.postgres", cloud: "gcp", stage: "operate", side: "target", principal: sa("svc-operate"), role: "platform_operate",
      permissions: postgres, apis: apisFor(postgres, g.targetApis), requiredWhen: ["postgres"] }),
    b({ id: "gcp.operate.data", cloud: "gcp", stage: "operate", side: "target", principal: sa("svc-operate"), role: "platform_operate",
      permissions: data, apis: apisFor(data, g.targetApis), requiredWhen: ["data"] }),
    b({ id: "gcp.operate.iam", cloud: "gcp", stage: "operate", side: "target", principal: sa("svc-operate"), role: "platform_operate_iam",
      conditional: true, permissions: g.operateIam, requiredWhen: ["always"] }),
    b({ id: "gcp.operate.dbsecret", cloud: "gcp", stage: "operate", side: "target", principal: sa("svc-operate"), role: "platform_operate_db_secret",
      conditional: true, permissions: g.dbSecret, requiredWhen: ["postgres"] }),
    // Argo CD 허브가 이 회사 플랫폼 SA 로 도착 GKE 에 들어온다 (배포 단계). 주체는 고객 SA 가 아니라 플랫폼 SA
    b({ id: "gcp.hub", cloud: "gcp", stage: "deploy", side: "target", principal: "platform", role: "platform_hub_access",
      permissions: g.hub, requiredWhen: ["argo_hub"] }),
  ];
  // ── AWS: 정책 문서의 문장(Sid)을 기능으로 나눈다 ──
  const st = i.aws.operatePolicy.Statement;
  const sidActs = (f: (sid: string) => boolean) => uniq(st.filter((s) => f(s.Sid ?? "")).flatMap(actionsOf));
  const pgTypesAws = ["aws_db_instance", "aws_db_parameter_group", "aws_db_subnet_group"];
  const pgAws = new Set(allPurposes(aws.PERMS, pgTypesAws).filter((a) => a.startsWith("rds:")));
  const dataAws = sidActs((s) => s.startsWith("Data"));
  const pgAwsActs = uniq([...sidActs((s) => s === "AppDbSecretRead"), ...sidActs((s) => s.startsWith("App")).filter((a) => pgAws.has(a))]);
  const baseAws = sidActs((s) => !s.startsWith("Data") && s !== "AppDbSecretRead").filter((a) => !pgAws.has(a));
  const relayStatements = i.aws.relayPolicy.Statement.filter((s) => !["SourceDbEgressToRelay", "SourceDbMasterSecretRead"].includes(s.Sid ?? ""));
  const relaySource = uniq(relayStatements.filter((s) => s.Sid !== "TargetDbRulesForRelay").flatMap(actionsOf));
  const relayTarget = uniq(relayStatements.flatMap(actionsOf));
  const awsBundles: PermissionBundle[] = [
    b({ id: "aws.observe", cloud: "aws", stage: "observe", side: "both", principal: "svc-observe", role: "observe-extra",
      permissions: i.aws.observe, requiredWhen: ["always"] }),
    b({ id: "aws.permcheck", cloud: "aws", stage: "observe", side: "both", principal: "svc-observe", role: "observe-permcheck",
      permissions: [...AWS_PERMCHECK_ACTIONS], requiredWhen: ["always"] }),
    b({ id: "aws.operate", cloud: "aws", stage: "operate", side: "target", principal: "svc-operate", role: "svc-operate-policy",
      permissions: baseAws, requiredWhen: ["always"] }),
    b({ id: "aws.operate.postgres", cloud: "aws", stage: "operate", side: "target", principal: "svc-operate", role: "svc-operate-policy",
      permissions: pgAwsActs, requiredWhen: ["postgres"] }),
    b({ id: "aws.operate.data", cloud: "aws", stage: "operate", side: "target", principal: "svc-operate", role: "svc-operate-policy",
      permissions: dataAws, requiredWhen: ["data"] }),
    b({ id: "aws.relay.source", cloud: "aws", stage: "relay", side: "source", principal: "svc-operate", role: "relay",
      permissions: relaySource, requiredWhen: ["relay_aws_onprem", "relay_aws_gcp"] }),
    b({ id: "aws.relay.target", cloud: "aws", stage: "relay", side: "target", principal: "svc-operate", role: "relay",
      permissions: relayTarget, requiredWhen: ["relay_gcp_aws"] }),
  ];
  return [...gcpBundles, ...awsBundles].filter((x) => x.permissions.length > 0);
}

/** 묶음 지문: 판 번호를 올려야 하는지 시험이 본다. 순서·공백과 상관없이 내용만 */
export function bundleDigest(bundles: PermissionBundle[]): string {
  // 칸 순서를 고정한다 (파일에서 읽은 것·zod 로 거른 것·새로 만든 것의 키 순서가 달라도 같은 지문)
  const canon = [...bundles].sort((a, b) => a.id.localeCompare(b.id)).map((x) => [x.id, x.cloud, x.stage, x.side, x.principal, x.role, x.conditional,
    uniq(x.permissions), uniq(x.apis), uniq(x.requiredWhen)]);
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export const PERMISSION_BUNDLES_FILE = "permission-bundles.json";
export const GCP_BUNDLES_TSV = "gcp-bundles.tsv";
/** 파일 하나 (permission-bundles.json). 없거나 모양이 틀리면 null → 부르는 쪽이 "확인 못 함"으로 알린다 (조용히 통과시키지 않음) */
export function loadPermissionBundles(dir: string): PermissionBundleFile | null {
  try { return PermissionBundleFile.parse(JSON.parse(readFileSync(join(dir, PERMISSION_BUNDLES_FILE), "utf8"))); }
  catch { return null; }
}

// ── GCP 연결 스크립트(gcp-connect.sh)가 묶음 모드(ONLY_BUNDLES)에서 읽는 표 ──
//   한 줄 = 묶음 id · 쪽 · 주체 SA 이름 · 역할 ID · 역할 파일(- = 스크립트가 아는 목록) · 바인딩 모양 · API(쉼표).
//   바인딩 모양: plain(조건 없음) · plain_only(조건 바인딩이 있으면 걷어내고 조건 없이, 실행 역할) · cond:<조건 파일>
const ROLE_FILES: Record<string, string> = {
  platform_operate: "gcp-operate-custom-role.yaml", platform_operate_iam: "gcp-operate-iam-custom-role.yaml",
  platform_operate_db_secret: "gcp-operate-db-secret-role.yaml", platform_env: "gcp-env-custom-role.yaml",
};
const BINDING: Record<string, string> = {
  platform_operate: "plain_only", platform_operate_iam: "cond:gcp-operate-iam-binding-condition.json",
  platform_operate_db_secret: "cond:gcp-operate-db-secret-condition.json",
};
export function gcpBundlesTsv(version: number, bundles: PermissionBundle[]): string {
  const rows = bundles.filter((x) => x.cloud === "gcp").map((x) =>
    [x.id, x.side, x.principal, x.role, ROLE_FILES[x.role] ?? "-", BINDING[x.role] ?? "plain", x.apis.join(",") || "-"].join("\t"));
  return [`#version\t${version}`, "#id\tside\tprincipal\trole\trole_file\tbinding\tapis", ...rows].join("\n") + "\n";
}

/** 묶음에 맞는 필요 조건 사실 (이전 하나). 명세·계획·경로에서 worker 가 채운다 */
export interface BundleNeeds {
  sourceProvider: string; targetProvider: string;
  secrets: boolean; postgres: boolean; data: boolean; envLayerCreate: boolean;
  relay: "aws-onprem" | "aws-gcp" | "gcp-aws" | null; argoHub: boolean;
}
const met = (w: PermissionRequiredWhen, n: BundleNeeds): boolean => w === "always" ? true
  : w === "secrets" ? n.secrets : w === "postgres" ? n.postgres : w === "data" ? n.data : w === "env_layer_create" ? n.envLayerCreate
  : w === "argo_hub" ? n.argoHub : w === "relay_aws_onprem" ? n.relay === "aws-onprem" : w === "relay_aws_gcp" ? n.relay === "aws-gcp" : n.relay === "gcp-aws";
/** 이 이전이 쓰는 묶음 (쪽 = 그 쪽 환경이 묶음 클라우드일 때만) */
export function requiredBundles(bundles: PermissionBundle[], n: BundleNeeds): (PermissionBundle & { onSide: "source" | "target" })[] {
  const out: (PermissionBundle & { onSide: "source" | "target" })[] = [];
  for (const x of bundles) {
    if (!x.requiredWhen.some((w) => met(w, n))) continue;
    for (const side of ["source", "target"] as const) {
      if (x.side !== "both" && x.side !== side) continue;
      if ((side === "source" ? n.sourceProvider : n.targetProvider) === x.cloud) out.push({ ...x, onSide: side });
    }
  }
  return out;
}

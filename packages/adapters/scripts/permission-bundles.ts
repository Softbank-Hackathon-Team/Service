import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BundleInputs, PolicyDoc } from "../src/permissions/bundles.js";
import { OBSERVE_EXTRA_ACTIONS } from "./aws-connect-template.js";

// PERM-GATE: 묶음 생성기(src/permissions/bundles.ts)의 입력을 이미 있는 원본 파일에서 모은다 (손으로 적은 두 번째 목록 없음).
//   export-permissions 가 역할·정책 파일을 쓴 뒤 부르고, 시험(permission-bundles)이 같은 함수로 다시 만들어 커밋된 파일과 대조한다

const GCP_CONNECT = new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url);

/** 역할 YAML 의 includedPermissions (security parseGcpCustomRole 과 같은 규칙. adapters 는 security 를 안 받는다) */
export function roleYamlPermissions(yaml: string): string[] {
  const out: string[] = []; let inList = false;
  for (const line of yaml.split("\n")) {
    if (/^includedPermissions:/.test(line)) { inList = true; continue; }
    if (inList) { const m = line.match(/^\s*-\s+(\S+)/); if (m) out.push(m[1]!); else if (/^\S/.test(line)) inList = false; }
  }
  return out.sort();
}

/** gcp-connect.sh 에서 관찰·확인·허브 역할 목록과 켜는 API 를 읽는다. 모양이 바뀌어 하나라도 못 찾으면 던진다 (빈 묶음이 조용히 생기지 않게) */
export function connectScriptLists(sh: string): Pick<BundleInputs["gcp"], "observe" | "verify" | "hub" | "permcheck" | "sourceApis" | "targetApis"> {
  const items = (v: string) => v.split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("${"));
  const observe = [...sh.matchAll(/^OBSERVE_PERMS="([^"]*)"/gm)].flatMap((m) => items(m[1]!));
  const verify = items(/^VERIFY_PERMS="([^"]*)"/m.exec(sh)?.[1] ?? "");
  const hub = items(/^HUB_PERMS="([^"]*)"/m.exec(sh)?.[1] ?? "");
  const permcheck = items(/^PERMCHECK_PERMS="([^"]*)"/m.exec(sh)?.[1] ?? "");
  const orig = sh.slice(sh.indexOf("# ── 원래 프로젝트"), sh.indexOf("# ── 전용 프로젝트"));
  const sourceApis = [...orig.matchAll(/^ensure_api (\S+)/gm)].map((m) => m[1]!);
  const targetApis = (/^TARGET_APIS="([^"]*)"/m.exec(sh)?.[1] ?? "").split(/\s+/).filter(Boolean).map((a) => `${a}.googleapis.com`);
  for (const [k, v] of Object.entries({ observe, verify, hub, permcheck, sourceApis, targetApis }))
    if (!v.length) throw new Error(`gcp-connect.sh 에서 ${k} 목록을 못 찾음 (스크립트 모양이 바뀜 → permission-bundles.ts 를 같이 고친다)`);
  return { observe: [...new Set(observe)].sort(), verify: [...new Set(verify)].sort(), hub, permcheck, sourceApis, targetApis };
}

// 손으로 쓰는 원본(생성되지 않는 파일)은 늘 레포 폴더에서 읽는다 (임시 폴더로 export 할 때도)
const REPO_PERMS = new URL("../../../infra/permissions/", import.meta.url).pathname;
const HAND_WRITTEN = new Set(["gcp-operate-db-secret-role.yaml", "aws-relay-statements.json"]);
export function collectBundleInputs(permDir: string, gcpConnect: string | URL = GCP_CONNECT): BundleInputs {
  const read = (f: string) => readFileSync(join(HAND_WRITTEN.has(f) ? REPO_PERMS : permDir, f), "utf8");
  const json = (f: string) => JSON.parse(read(f)) as PolicyDoc;
  return {
    gcp: {
      ...connectScriptLists(readFileSync(gcpConnect, "utf8")),
      operate: roleYamlPermissions(read("gcp-operate-custom-role.yaml")),
      operateIam: roleYamlPermissions(read("gcp-operate-iam-custom-role.yaml")),
      dbSecret: roleYamlPermissions(read("gcp-operate-db-secret-role.yaml")),
      env: roleYamlPermissions(read("gcp-env-custom-role.yaml")),
    },
    aws: { observe: [...OBSERVE_EXTRA_ACTIONS].sort(), operatePolicy: json("aws-operate-role-policy.json"), relayPolicy: json("aws-relay-statements.json") },
  };
}

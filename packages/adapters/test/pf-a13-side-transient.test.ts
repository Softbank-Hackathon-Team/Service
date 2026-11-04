// PF-A13 (15회차 네트워크 장애, 둘째 바퀴): 명세에 들어가는 부가 읽기(RDS 파라미터·보안 그룹, 앱 신원 IAM)의 일시 오류는 SOURCE_TRANSIENT 로 던진다.
//   예전: note 만 남고 값이 빔 → "권한 확인" 검토 줄(파라미터)·unknown 방화벽(사전 점검 막힘)·IAM 은 바깥 side 가 삼켜 조용히 빠짐
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { pfExec } from "./pf-a-eks-demo-fixture.js";

const NET = "\nCould not connect to the endpoint URL: \"https://rds.ap-northeast-2.amazonaws.com/\"";
const DENY = "\nAn error occurred (AccessDenied) when calling the operation: User is not authorized";
const run = (cmd: string, err: string) => discoverAws({ exec: pfExec({ fail: (l) => l.startsWith(cmd) ? { code: 255, err } : null }).exec, env: {} }, { iam: true });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return String((e as { code?: string }).code); } };

for (const cmd of ["aws rds describe-db-parameters", "aws eks list-pod-identity-associations"]) {
  test(`PF-A13: ${cmd} 일시 오류 → SOURCE_TRANSIENT (재시도)`, async () => {
    assert.equal(await code(run(cmd, NET)), "SOURCE_TRANSIENT");
  });
}

test("PF-A13 거부 쪽: 거부는 예전처럼 검토 줄(파라미터 못 읽음·IAM 못 읽음), 가져오기는 끝남", async () => {
  const p = normalizeV2(await run("aws rds describe-db-parameters", DENY)).result;
  assert.equal(p.fieldMeta["components.platform-demo-db.parameters"]?.needs_review, true);
  const i = normalizeV2(await run("aws eks list-pod-identity-associations", DENY)).result;
  assert.ok(Object.keys(i.fieldMeta).some((k) => k.startsWith("unread.IAM.")), Object.keys(i.fieldMeta).join(","));
});

test("PF-A13: RDS 보안 그룹 읽기 일시 오류 → SOURCE_TRANSIENT (예전: 방화벽 unknown → 사전 점검 막힘)", async () => {
  assert.equal(await code(run("aws ec2 describe-security-groups", NET)), "SOURCE_TRANSIENT");
  const ok = normalizeV2(await discoverAws({ exec: pfExec().exec, env: {} }, { iam: true })).result;
  assert.match(String(ok.fieldMeta["components.platform-demo-db.network"]?.rationale), /보안 그룹에서 읽음/, "실검증 모양 SG(EKS 클러스터 SG 만 허용)는 읽힘");
});

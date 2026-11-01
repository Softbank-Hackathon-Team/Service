import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Z70 DRAFT(ai): 진짜 terraform apply 가 만든 도착 DB 주소·비밀번호를 복제 끝점에 넣는 길.
// REPL_TARGET_URL 같은 값에 {tf:키} 를 쓰면, 이전마다 TF_WORK_DIR/<이전 id>/ 의
//   outputs.json (terraform output, 비밀 아님) + db-secret.json (0600, 비밀번호) 에서 채운다.
//   예: REPL_TARGET_URL=postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/shop
// 파일이 없거나 키가 없으면 그 변수는 그대로 둔다 → 접속 실패로 드러난다 (조용히 다른 DB 로 붙지 않음)
// 대안 "작업마다 DB(infra_ready)에서 읽기" 는 버림: replicationFromEnv 를 부르는 5곳(sync·cutover·rollback·cleanup·reaper)을
//   전부 고쳐야 하고 비밀번호는 DB 에 넣지 않기로 했다. 파일 길은 이 함수 하나만 바뀐다
// 폴더 규칙은 packages/adapters/src/terraform/real-runner.ts 와 같다 (기본 ~/.svc-tf)
export function readTfFacts(migrationId: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!/^[0-9a-f-]{8,}$/i.test(migrationId)) return {};
  const root = env.TF_WORK_DIR || join(env.HOME ?? "/tmp", ".svc-tf");
  // Z89: 작업 폴더가 회사별(<뿌리>/t-xxxxxxxx/<이전>)로 바뀜. 회사 폴더 먼저, 없으면 예전 <뿌리>/<이전>
  //   (adapters findWorkDir 와 같은 규칙. replication 이 adapters 를 import 하지 않게 여기 따로 둔다)
  let dir = join(root, migrationId);
  try {
    for (const d of readdirSync(root)) if (/^t-[0-9a-f]{8}$/.test(d) && existsSync(join(root, d, migrationId, "outputs.json"))) { dir = join(root, d, migrationId); break; }
  } catch { /* 뿌리 없음 → 예전 경로 (없으면 아래 read 가 {} ) */ }
  const readAt = (p: string): Record<string, string> => {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch { return {}; }
  };
  return { ...readFactsFiles(env, readAt), ...readAt(join(dir, "outputs.json")), ...readAt(join(dir, "db-secret.json")) };
}

// Z102 (11차 실클라우드): 이전 폴더 밖의 사실 파일. REPL_FACTS_FILES=<절대 경로>,<절대 경로> (JSON, 문자열 값만).
//   온프레 DB 계정·Cloud SQL 계정처럼 terraform 이 이 이전에서 만들지 않은 끝점의 값을 {tf:키} 로 쓰게 한다.
//   이유: 맥 RC 는 .env 를 못 읽어서 기동 줄에 비밀값을 넣을 수 없다 → 사람이 0600 파일로 한 번 써 두고, 기동 줄엔 {tf:키} 만.
//   이전 폴더 값이 같은 키를 이긴다. 파일이 없거나 깨졌으면 빈 값 → 그 {tf:키} 는 그대로 남아 접속 실패로 드러난다.
// 대안 "이전 폴더마다 사실 파일을 합쳐 복사": 비밀 파일을 jq 로 읽고 합치는 손이 이전마다 생겨 버림.
function readFactsFiles(env: NodeJS.ProcessEnv, readAt: (p: string) => Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (env.REPL_FACTS_FILES ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!p.startsWith("/")) continue;
    Object.assign(out, readAt(p));
  }
  return out;
}

const REF = /\{tf:([a-z0-9_]+)\}/gi;
export const hasTfRef = (s: string | undefined) => !!s && /\{tf:[a-z0-9_]+\}/i.test(s);

/** {tf:키} 가 든 REPL_* 값만 바꾼 env 사본. 하나도 없으면 같은 객체를 돌려준다 (파일을 안 읽음) */
export function resolveTfRefs(env: NodeJS.ProcessEnv, migrationId: string, facts?: Record<string, string>): NodeJS.ProcessEnv {
  const keys = Object.keys(env).filter((k) => k.startsWith("REPL_") && hasTfRef(env[k]));
  if (!keys.length) return env;
  const f = facts ?? readTfFacts(migrationId, env);
  const out = { ...env };
  for (const k of keys) out[k] = env[k]!.replace(REF, (m, key: string) => {
    const v = f[key];
    return v === undefined ? m : (k.endsWith("_URL") ? encodeURIComponent(v) : v);
  });
  return out;
}

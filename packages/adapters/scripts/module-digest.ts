import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 모듈 폴더의 *.tf 내용 지문 (파일 이름순). moduleRef.gitSha가 없을 때 대신 쓴다.
// 모듈이 바뀌면 지문이 바뀌고 → tfPlanHash → planHash가 바뀐다 (사람이 본 계획 = 실행할 계획)
export function moduleDigest(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tf")).sort()) {
    h.update(f + "\0" + readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n") + "\0");
  }
  return "content-" + h.digest("hex").slice(0, 12);
}
export const MODULES = ["aws/app", "gcp/app", "onprem/app", "azure/app"] as const;

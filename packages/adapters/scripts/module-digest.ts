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
// v2: 고정 루트 + 종류 모듈은 폴더마다 따로 지문 (계획 지문엔 루트 + 켜진 모듈만 들어감). 새 폴더를 만들면 여기 손으로 추가 (시험이 빠진 폴더를 잡음)
export const MODULES = [
  "aws/app", "gcp/app", "onprem/app", "azure/app",
  "aws/root", "aws/kinds/cache", "aws/kinds/identity", "aws/kinds/job", "aws/kinds/namespace", "aws/kinds/object-store", "aws/kinds/postgres", "aws/kinds/queue", "aws/kinds/service-ecs", "aws/kinds/vm",
  "gcp/root", "gcp/kinds/cache", "gcp/kinds/identity", "gcp/kinds/job", "gcp/kinds/namespace", "gcp/kinds/object-store", "gcp/kinds/postgres", "gcp/kinds/queue", "gcp/kinds/service-cloudrun", "gcp/kinds/vm",
  "onprem/root", "onprem/kinds/namespace", "onprem/kinds/netpol",
  "gcp/env",   // 환경 층 (worker env-layer.ts 가 도착 GKE 가 없을 때 만든다). 계획서 envLayer.moduleDigest
] as const;

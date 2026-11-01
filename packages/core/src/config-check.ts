import { configProblems, type ConfigService } from "@svc/contracts";
import { createLogger } from "./obs/log.js";

// Z81-09: 시작할 때 설정 검사 (fail fast). 문제가 있으면 한 줄 JSON 로그(목록) + stderr 사람용 목록 + 끝 코드 2.
// 값은 찍지 않는다 (이름·이유만). main 의 첫 줄에서 부른다: 큐·DB·포트를 열기 전에 멈춰야 반쯤 뜬 상태가 안 생긴다
export function assertConfig(service: ConfigService, o: { env?: NodeJS.ProcessEnv; exit?: (code: number) => void; log?: (line: string) => void } = {}): void {
  const problems = configProblems(service, o.env ?? process.env);
  if (problems.length === 0) return;
  createLogger(service, { component: "config" }).error({ problems, count: problems.length }, "config invalid: not starting");
  const say = o.log ?? ((l: string) => process.stderr.write(l + "\n"));
  say(`설정 오류 ${problems.length}개 (${service} 시작 안 함):`);
  for (const p of problems) say(`  - ${p}`);
  (o.exit ?? ((c: number) => process.exit(c)))(2);
}

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODULES, moduleDigest } from "./module-digest.js";

// 실행: npm run gen:digests -w @svc/adapters  (infra/modules/*/app 을 고친 뒤)
const here = dirname(fileURLToPath(import.meta.url));
const infra = join(here, "../../../infra/modules");
const lines = MODULES.map((m) => `  "${m}": "${moduleDigest(join(infra, m))}",`);
writeFileSync(join(here, "../src/module-digests.ts"),
  `// 자동 생성 파일 (scripts/gen-module-digests.ts). 손으로 고치지 않는다. 테스트가 실제 파일과 대조한다\n` +
  `export const MODULE_DIGEST = {\n${lines.join("\n")}\n} as const;\n`);
console.log(lines.join("\n"));

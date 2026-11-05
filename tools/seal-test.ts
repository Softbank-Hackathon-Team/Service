// 시험용: sealed-secrets 공개 인증서로 SealedSecret YAML 한 장을 만들어 표준 출력으로 낸다 (워커의 sealedSecretValues 그대로)
//   npx tsx tools/seal-test.ts --cert <cert.pem> --namespace <ns> --name <secret> key=value [key2=value2 ...]
//   출력을 시험 클러스터에 넣으면 컨트롤러가 풀어 같은 이름의 Secret 을 만든다 → 봉인 형식이 맞는지 실제 컨트롤러로 확인
// 평문 값은 출력하지 않는다 (암호문만). 단 argv 로 받으므로 셸 기록·ps 에 남는다 → 시험 값만 쓴다
import { readFileSync } from "node:fs";
import { sealedSecretValues } from "../apps/worker/src/gitops/migration-secrets.js";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const USAGE = "사용: seal-test --cert <cert.pem> --namespace <ns> --name <secret> key=value [...]";

const cert = opt("cert"), namespace = opt("namespace"), name = opt("name");
// --옵션 과 그 값을 뺀 나머지가 key=value
const pairs: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i]!.startsWith("--")) i++; else pairs.push(args[i]!); }
if (!cert || !namespace || !name || pairs.length === 0 || pairs.some((p) => !p.includes("="))) {
  console.error(USAGE);
  process.exit(2);
}
const data: Record<string, string> = {};
for (const p of pairs) { const i = p.indexOf("="); data[p.slice(0, i)] = p.slice(i + 1); }

try {
  const v = sealedSecretValues(readFileSync(cert, "utf8"), namespace, name, data);
  // JSON 문자열은 YAML 스칼라로도 그대로 읽힌다 (따옴표·특수문자 걱정 없음)
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    "apiVersion: bitnami.com/v1alpha1",
    "kind: SealedSecret",
    "metadata:",
    `  name: ${q(v.name)}`,
    `  namespace: ${q(namespace)}`,
    "spec:",
    "  encryptedData:",
    ...Object.entries(v.encryptedData).map(([k, c]) => `    ${q(k)}: ${q(c)}`),
    "  template:",
    "    metadata:",
    `      name: ${q(v.name)}`,
    `      namespace: ${q(namespace)}`,
    "    type: Opaque",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

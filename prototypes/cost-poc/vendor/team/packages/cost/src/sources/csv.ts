import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

// 한 줄씩 받는 함수. 네트워크(httpLines)와 파일(fileLines)을 같은 모양으로 쓴다.
// 테스트는 fileLines로 고정 CSV를 넣어 네트워크 없이 돈다.
export type LineSource = (url: string) => AsyncIterable<string>;

// 큰 파일(EC2 서울 CSV는 약 200MB)을 메모리에 다 올리지 않고 한 줄씩 읽는다.
export const httpLines: LineSource = async function* (url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`HTTP_${res.status} ${url}`);
  const stream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  yield* createInterface({ input: stream, crlfDelay: Infinity });
};

export const fileLines = (path: string | URL) => async function* () {
  yield* createInterface({ input: createReadStream(path), crlfDelay: Infinity });
};

// 따옴표 안의 쉼표, "" 이스케이프를 처리하는 CSV 한 줄 파서.
// AWS 가격 CSV는 칸 안에 줄바꿈이 없다고 본다 【추정】(10/31 서울 EC2·RDS·ELB·EKS 파일에서 문제 없었음).
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

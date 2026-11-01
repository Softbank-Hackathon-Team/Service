import { readFileSync } from "node:fs";
import { fitLinear, type Fit } from "./core/resource.js";
import type { ResourcePoint } from "./core/types.js";

// DRAFT(ai): measure/run-measure.sh 원자료(data/measure/stages.jsonl) → 단계별 평균 사용량. 파일 읽기 외 부작용 없음.

export type RawStage = {
  round: number; t0: number; t1: number;
  s0: Record<"app" | "dbproxy" | "db", { cpuUsec: number; memBytes: number; inactiveFile: number; anon: number }>;
  s1: Record<"app" | "dbproxy" | "db", { cpuUsec: number; memBytes: number; inactiveFile: number; anon: number }>;
  dbSize0: number; dbSize1: number;
  load: { mix: string; targetRps: number; windowSec: number; requests: number; achievedRps: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; errorRate: number; bytesToClient: number; bytesFromClient: number; bytesPerRequest: number; err4xx: number; err5xx: number; netErr: number };
};

export type StageRow = {
  mix: string; targetRps: number; round: number; achievedRps: number;
  appCpu: number; proxyCpu: number; dbCpu: number;
  appMemGiB: number; proxyMemGiB: number; dbMemGiB: number;
  egressGBh: number; bytesPerRequest: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; errorRate: number;
  dbGrowthBytes: number; requests: number; windowSec: number;
};

export function parseStages(path: URL | string): StageRow[] {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return lines.map((l) => {
    const r = JSON.parse(l) as RawStage;
    const dt = r.t1 - r.t0;
    const cpu = (k: "app" | "dbproxy" | "db") => (r.s1[k].cpuUsec - r.s0[k].cpuUsec) / 1e6 / dt;
    // 작업 메모리 = memory.current - inactive_file (쿠버네티스 working set과 같은 정의)
    const mem = (k: "app" | "dbproxy" | "db") => (r.s1[k].memBytes - r.s1[k].inactiveFile) / 2 ** 30;
    return {
      mix: r.load.mix, targetRps: r.load.targetRps, round: r.round, achievedRps: r.load.achievedRps,
      appCpu: cpu("app"), proxyCpu: cpu("dbproxy"), dbCpu: cpu("db"),
      appMemGiB: mem("app"), proxyMemGiB: mem("dbproxy"), dbMemGiB: mem("db"),
      egressGBh: (r.load.bytesToClient / Math.max(r.load.windowSec, 1e-9)) * 3600 / 1e9,
      bytesPerRequest: r.load.bytesPerRequest,
      p50Ms: r.load.p50Ms, p95Ms: r.load.p95Ms, p99Ms: r.load.p99Ms, errorRate: r.load.errorRate,
      dbGrowthBytes: r.dbSize1 - r.dbSize0, requests: r.load.requests, windowSec: r.load.windowSec,
    };
  });
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// cpuScale: 로컬 코어 1개가 클라우드 vCPU 몇 개 몫인가 (가정). 이 값은 측정이 아니다.
export function toPoint(rows: StageRow[], lambda: number, cpuScale: number, storageGB: number): ResourcePoint {
  const r = rows.filter((x) => x.targetRps === lambda);
  if (r.length === 0) throw new Error(`NO_STAGE ${lambda}`);
  const p95s = r.map((x) => x.p95Ms).filter((x): x is number => x !== null);
  return {
    lambda,
    cpu: mean(r.map((x) => x.appCpu + x.proxyCpu)) * cpuScale,
    memGiB: mean(r.map((x) => x.appMemGiB + x.proxyMemGiB)),
    egressGBh: mean(r.map((x) => x.egressGBh)),
    storageGB,
    dbCpu: mean(r.map((x) => x.dbCpu)) * cpuScale,
    dbMemGiB: mean(r.map((x) => x.dbMemGiB)),
    ...(p95s.length ? { p95Ms: Math.max(...p95s) } : {}),
    errorRate: Math.max(...r.map((x) => x.errorRate)),
  };
}

export function growthPerRequest(rows: StageRow[]): number {
  const req = rows.reduce((a, r) => a + r.requests, 0);
  const grow = rows.reduce((a, r) => a + Math.max(0, r.dbGrowthBytes), 0);
  return req > 0 ? grow / req / 1e9 : 0;
}

export type FieldFit = Record<"cpu" | "memGiB" | "egressGBh" | "dbCpu" | "dbMemGiB", Fit>;

// 라운드별 원자료 전체로 회귀 (단계 평균이 아니라 표본 전체)
export function fitStages(rows: StageRow[], lambdas: number[], cpuScale: number): FieldFit {
  const r = rows.filter((x) => lambdas.includes(x.targetRps));
  const xs = r.map((x) => x.targetRps);
  return {
    cpu: fitLinear(xs, r.map((x) => (x.appCpu + x.proxyCpu) * cpuScale)),
    memGiB: fitLinear(xs, r.map((x) => x.appMemGiB + x.proxyMemGiB)),
    egressGBh: fitLinear(xs, r.map((x) => x.egressGBh)),
    dbCpu: fitLinear(xs, r.map((x) => x.dbCpu * cpuScale)),
    dbMemGiB: fitLinear(xs, r.map((x) => x.dbMemGiB)),
  };
}

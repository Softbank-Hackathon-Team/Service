import { fitLinear, makeResourceFn, type PointField } from "./resource.js";
import { type FieldEvidence, ResourceProfile, type ProfileSource, type ResourcePoint } from "./types.js";

// DRAFT(ai): 세 갈래를 같은 ResourceProfile 하나로 만든다.
// 규칙 (앞이 이긴다):
//   모양(기울기와 곡선) = 샌드박스 실측(measured) > 미리 잰 값(sample) > 가정(price-only)
//   크기(수준)         = 운영 지표(observed)가 있으면 그 λ에서 모양을 비율로 보정. 없으면 모양의 값 그대로
//   운영 지표 점이 2개 이상이고 λ 범위가 2배 이상이면 모양까지 운영 지표 회귀로 바꾼다 (실제 트래픽이 곧 가장 좋은 근거)
//   근거 표시 source = measured > observed > sample > price-only
// 보정 비율은 [1/10, 10]으로 자른다. [1/3, 3]을 벗어나면 경고를 남긴다(운영과 모양이 너무 달라 보정을 믿기 어렵다).

export const EVIDENCE_REL: Record<ProfileSource, Record<string, number>> = {
  // 상대 반폭. 값은 가정이다. measured 쪽은 적합 오차를 더한다. 실제 오차와의 비교는 report.md
  "price-only": { cpu: 0.6, memGiB: 0.5, egressGBh: 1.0, dbCpu: 0.6, dbMemGiB: 0.5 },
  sample: { cpu: 0.4, memGiB: 0.3, egressGBh: 0.5, dbCpu: 0.5, dbMemGiB: 0.3 },
  observed: { cpu: 0.2, memGiB: 0.15, egressGBh: 0.2, dbCpu: 0.25, dbMemGiB: 0.15 },
  measured: { cpu: 0.15, memGiB: 0.1, egressGBh: 0.1, dbCpu: 0.15, dbMemGiB: 0.1 },
};

const FIELDS: Exclude<PointField, "gpu" | "storageGB">[] = ["cpu", "memGiB", "egressGBh", "dbCpu", "dbMemGiB"];

export type PriceOnlyAssumption = {
  lambdas: number[];
  baseCpu: number; cpuPerRps: number;
  memGiB: number;
  bytesPerRequest: number;
  storageGB: number;
  dbBaseCpu: number; dbCpuPerRps: number; dbMemGiB: number;
  storageGrowthGBPerRequest?: number;
};

export function priceOnlyProfile(a: PriceOnlyAssumption): ResourceProfile {
  return ResourceProfile.parse({
    source: "price-only",
    storageGrowthGBPerRequest: a.storageGrowthGBPerRequest ?? 0,
    points: a.lambdas.map((lambda) => ({
      lambda, cpu: a.baseCpu + a.cpuPerRps * lambda, memGiB: a.memGiB,
      egressGBh: (lambda * a.bytesPerRequest * 3600) / 1e9, storageGB: a.storageGB,
      dbCpu: a.dbBaseCpu + a.dbCpuPerRps * lambda, dbMemGiB: a.dbMemGiB,
    })),
    note: "가정: 사용량을 측정하지 않았다",
  });
}

export type Layers = {
  priceOnly?: ResourceProfile;
  sample?: ResourceProfile;
  measured?: ResourceProfile;
  observed?: ResourcePoint[];     // 운영 지표 표본
};

export type LayeredResult = {
  profile: ResourceProfile;
  evidence: FieldEvidence[];
  warnings: string[];
  rel: Record<string, number>;
};

export function layerProfiles(layers: Layers, opts: { peakLambda?: number; fitRel?: Partial<Record<string, number>> } = {}): LayeredResult {
  const shapeSource: ProfileSource | null = layers.measured ? "measured" : layers.sample ? "sample" : layers.priceOnly ? "price-only" : null;
  const shape = layers.measured ?? layers.sample ?? layers.priceOnly;
  const obs = layers.observed ?? [];
  if (!shape && obs.length === 0) throw new Error("LAYER_EMPTY");
  const warnings: string[] = [];

  // 운영 지표만 있고 범위가 넓으면 그것이 곧 모양이다
  const lams = obs.map((o) => o.lambda);
  const obsWide = obs.length >= 2 && Math.max(...lams) >= 2 * Math.max(Math.min(...lams), 1e-9);
  const source: ProfileSource = layers.measured ? "measured" : obs.length > 0 ? "observed" : (shapeSource as ProfileSource);

  if (!shape && !obsWide) throw new Error("LAYER_NO_SHAPE");
  const base = shape ?? ResourceProfile.parse({ source: "observed", points: [...obs].sort((a, b) => a.lambda - b.lambda) });
  const fn = makeResourceFn(base, "segment");
  const alpha: Partial<Record<string, number>> = {};
  const evidence: FieldEvidence[] = [];
  const rel: Record<string, number> = {};
  const peak = opts.peakLambda;

  const useObsRegression = obsWide && !layers.measured;
  const obsFits = useObsRegression
    ? Object.fromEntries(FIELDS.map((f) => [f, fitLinear(lams, obs.map((o) => o[f] ?? 0))]))
    : null;

  for (const f of FIELDS) {
    let a = 1;
    if (obs.length > 0 && !useObsRegression) {
      // 표본이 여럿이면 평균 비율
      const rs = obs.map((o) => {
        const s = fn.at(o.lambda)[f];
        const v = o[f];
        return v === undefined || s <= 0 ? null : v / s;
      }).filter((x): x is number => x !== null);
      if (rs.length) {
        const raw = rs.reduce((x, y) => x + y, 0) / rs.length;
        a = Math.min(10, Math.max(0.1, raw));
        if (a !== raw) warnings.push(`${f}: 운영 보정 비율 ${raw.toFixed(2)}가 범위를 벗어나 ${a}로 잘랐다`);
        else if (raw > 3 || raw < 1 / 3) warnings.push(`${f}: 운영 보정 비율 ${raw.toFixed(2)}. 미리 잰 값과 실제 요청 구성이 많이 다르다`);
      }
    }
    alpha[f] = a;
    const shapeSrc: ProfileSource = useObsRegression ? "observed" : (shapeSource as ProfileSource);
    const levelSrc: ProfileSource = obs.length > 0 ? "observed" : shapeSrc;
    let u = Math.max(EVIDENCE_REL[levelSrc]![f]!, EVIDENCE_REL[shapeSrc]![f]! * (levelSrc === shapeSrc ? 1 : 0.75));
    // 운영 지표 한 점에서 피크까지 멀수록 불확실성이 커진다
    if (obs.length > 0 && !layers.measured && peak && peak > 0) {
      const lobs = lams.reduce((x, y) => x + y, 0) / lams.length;
      if (lobs > 0) u += 0.1 * Math.abs(Math.log(peak / lobs));
    }
    if (opts.fitRel?.[f] !== undefined) u = Math.sqrt(u ** 2 + opts.fitRel[f]! ** 2);
    rel[f] = u;
    evidence.push({ field: f, shape: shapeSrc, level: levelSrc, relUncertainty: u, calibration: a });
  }

  const knots = useObsRegression ? [...lams].sort((x, y) => x - y) : base.points.map((p) => p.lambda);
  const points: ResourcePoint[] = knots.map((lambda) => {
    const b = fn.at(lambda);
    const v = (f: (typeof FIELDS)[number]) => (useObsRegression ? Math.max(0, obsFits![f]!.intercept + obsFits![f]!.slope * lambda) : b[f] * (alpha[f] ?? 1));
    const src = base.points.find((p) => p.lambda === lambda);
    return {
      lambda, cpu: v("cpu"), memGiB: v("memGiB"), egressGBh: v("egressGBh"),
      storageGB: obs[obs.length - 1]?.storageGB ?? b.storageGB,
      dbCpu: v("dbCpu"), dbMemGiB: v("dbMemGiB"), gpu: b.gpu,
      ...(src?.p95Ms !== undefined ? { p95Ms: src.p95Ms } : {}), ...(src?.errorRate !== undefined ? { errorRate: src.errorRate } : {}),
    };
  });
  const profile = ResourceProfile.parse({
    source, points,
    storageGrowthGBPerRequest: base.storageGrowthGBPerRequest,
    note: `모양=${shapeSource ?? "observed"}${obs.length ? `, 수준=observed(${obs.length}점)` : ""}`,
  });
  return { profile, evidence, warnings, rel };
}

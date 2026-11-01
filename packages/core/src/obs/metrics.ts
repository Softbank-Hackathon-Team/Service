// Prometheus 텍스트 형식(0.0.4)을 직접 만든다. 카운터·게이지·히스토그램 세 가지만
// DRAFT(ai): prom-client 대신 손으로. 의존성 0, 100줄. 요약(summary)·기본 프로세스 지표는 안 한다
// 형식 규칙: # HELP / # TYPE 한 번, 그다음 이름{라벨="값"} 숫자. 히스토그램은 _bucket{le=…} 누적 + _sum + _count

export type Labels = Record<string, string>;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const fmtLabels = (l: Labels) => {
  const ks = Object.keys(l).sort();
  return ks.length ? `{${ks.map((k) => `${k}="${esc(l[k]!)}"`).join(",")}}` : "";
};
const fmtNum = (n: number) => (Number.isFinite(n) ? String(n) : n > 0 ? "+Inf" : n < 0 ? "-Inf" : "NaN");
const key = (l: Labels) => fmtLabels(l);

interface Metric { name: string; render(): string[] }

class Series<V> {
  private m = new Map<string, { labels: Labels; v: V }>();
  constructor(private init: () => V) {}
  get(l: Labels): V {
    const k = key(l);
    let e = this.m.get(k);
    if (!e) { e = { labels: { ...l }, v: this.init() }; this.m.set(k, e); }
    return e.v;
  }
  set(l: Labels, v: V) { this.m.set(key(l), { labels: { ...l }, v }); }
  entries() { return [...this.m.values()]; }
  clear() { this.m.clear(); }
}

export class Counter implements Metric {
  private s = new Series(() => ({ n: 0 }));
  constructor(readonly name: string, readonly help: string) {}
  inc(l: Labels = {}, by = 1) { this.s.get(l).n += by; }
  value(l: Labels = {}) { return this.s.get(l).n; }
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`,
      ...this.s.entries().map((e) => `${this.name}${fmtLabels(e.labels)} ${fmtNum(e.v.n)}`)];
  }
}

export class Gauge implements Metric {
  private s = new Series(() => ({ n: 0 }));
  constructor(readonly name: string, readonly help: string) {}
  set(l: Labels, v: number) { this.s.set(l, { n: v }); }
  reset() { this.s.clear(); }               // 수집할 때마다 새로 채우는 게이지용 (사라진 라벨 지우기)
  value(l: Labels = {}) { return this.s.get(l).n; }
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`,
      ...this.s.entries().map((e) => `${this.name}${fmtLabels(e.labels)} ${fmtNum(e.v.n)}`)];
  }
}

interface HistState { counts: number[]; sum: number; count: number }

export class Histogram implements Metric {
  private s: Series<HistState>;
  constructor(readonly name: string, readonly help: string, readonly buckets: readonly number[]) {
    this.s = new Series(() => ({ counts: buckets.map(() => 0), sum: 0, count: 0 }));
  }
  observe(l: Labels, v: number) {
    const h = this.s.get(l);
    this.buckets.forEach((le, i) => { if (v <= le) h.counts[i]!++; });
    h.sum += v; h.count++;
  }
  // DB 에서 미리 센 값을 통째로 넣을 때 (counts 는 이미 누적, 길이 = buckets 길이)
  setRaw(l: Labels, cumulative: number[], sum: number, count: number) {
    this.s.set(l, { counts: [...cumulative], sum, count });
  }
  reset() { this.s.clear(); }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const e of this.s.entries()) {
      this.buckets.forEach((le, i) =>
        out.push(`${this.name}_bucket${fmtLabels({ ...e.labels, le: fmtNum(le) })} ${e.v.counts[i]}`));
      out.push(`${this.name}_bucket${fmtLabels({ ...e.labels, le: "+Inf" })} ${e.v.count}`);
      out.push(`${this.name}_sum${fmtLabels(e.labels)} ${fmtNum(e.v.sum)}`);
      out.push(`${this.name}_count${fmtLabels(e.labels)} ${e.v.count}`);
    }
    return out;
  }
}

export class Registry {
  private ms: Metric[] = [];
  private collectors: (() => Promise<void>)[] = [];
  register<M extends Metric>(m: M): M { this.ms.push(m); return m; }
  counter(name: string, help: string) { return this.register(new Counter(name, help)); }
  gauge(name: string, help: string) { return this.register(new Gauge(name, help)); }
  histogram(name: string, help: string, buckets: readonly number[]) {
    return this.register(new Histogram(name, help, buckets));
  }
  // 수집 직전에 부르는 함수 (DB 에서 숫자 읽기 등). 실패해도 나머지 지표는 나간다
  onCollect(fn: () => Promise<void>) { this.collectors.push(fn); }
  async render(): Promise<string> {
    for (const c of this.collectors) await c();
    return this.ms.map((m) => m.render().join("\n")).join("\n") + "\n";
  }
}

export const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// 히스토그램 경계. 이전 단계는 STUB 일 때 0.2초, 실제 Terraform 이면 수 분이라 넓게 잡는다
// DRAFT(ai): 경계값은 첫 리허설 측정 뒤 다시 정한다
export const STATE_BUCKETS_SEC = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600] as const;
// 컷오버 멈춤 목표 = 1초 이하 (설계 목표). 그 주변을 촘촘하게
export const PAUSE_BUCKETS_MS = [50, 100, 250, 500, 750, 1000, 1500, 2000, 5000, 10000] as const;
export const JOB_BUCKETS_SEC = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 600] as const;
export const HTTP_BUCKETS_SEC = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

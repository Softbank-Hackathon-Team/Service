// VMIMPORT: EC2·GCE 읽기 공통 조각 (순수)
/** 비밀처럼 보이는 글자(태그·라벨 값이 이름으로 새는 것을 막는다) */
export const secretLooking = (s: string): boolean =>
  /(password|passwd|secret|token|apikey|api[_-]key|private[_-]?key|credential)/i.test(s) || /^(AKIA|ASIA)[0-9A-Z]{16}$/.test(s) || /^eyJ[A-Za-z0-9_-]{5,}\./.test(s)
  || /^(sk-|svc_pat_|et_)[A-Za-z0-9_-]{8,}/.test(s) || /:\/\/[^\s:/@]+:[^\s@/]+@/.test(s) || /^[A-Za-z0-9+/_=-]{32,}$/.test(s);

/** 이름 → 묶음 이름. 묶는 태그를 지정했으면 값 그대로, 아니면 끝 번호(-1, -02, _3)를 뗀다 */
export const groupNameOf = (raw: string, explicit: boolean): string => {
  const base = explicit ? raw : raw.replace(/[-_.]\d{1,3}$/, "");
  return base.slice(0, 60) || raw.slice(0, 60);
};

/** 1024 단위가 아니라 vCPU·GiB 로 알려진 GCE 머신 종류 → 크기. 모르면 null */
export function gceSize(machineType: string): { cpuMilli: number; memMiB: number } | null {
  const t = machineType.split("/").pop() ?? machineType;
  const custom = /^(?:[a-z0-9]+-)?custom-(\d+)-(\d+)(?:-ext)?$/.exec(t);
  if (custom) return { cpuMilli: Number(custom[1]) * 1000, memMiB: Number(custom[2]) };
  const shared: Record<string, [number, number]> = { "e2-micro": [2, 1024], "e2-small": [2, 2048], "e2-medium": [2, 4096], "f1-micro": [1, 614], "g1-small": [1, 1740] };
  if (shared[t]) return { cpuMilli: shared[t]![0] * 1000, memMiB: shared[t]![1] };
  const m = /^[a-z0-9]+-(standard|highmem|highcpu)-(\d+)$/.exec(t);
  if (!m) return null;
  const cpu = Number(m[2]), perCpuGiB = m[1] === "standard" ? 4 : m[1] === "highmem" ? 8 : 1;
  return { cpuMilli: cpu * 1000, memMiB: cpu * perCpuGiB * 1024 };
}

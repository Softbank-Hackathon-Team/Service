import { K8S_RAW_KINDS, type RawK8sCronJob } from "../raw-k8s.js";
import { appLabelsOf } from "../app-group.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";
import { podLabelsOf, workloadOf } from "./k8s-deployment.js";

// DRAFT(ai): k8s CronJob → job 리소스. 실행 규칙 필드(동시 실행·정지·재시도·마감)는 있는 것만 옮긴다 (PoC :175).
//   digest 없으면 리소스로 두고 checkV2 가 "digest 아님" 오류를 낸다 (PoC 와 같음. Deployment 의 R9 는 서비스만)
// G3-1 DRAFT(ai): k8s 가 받는 일정 줄임말(@hourly 등)은 IR 이 받는 cron 5필드로 바꾼다 (뜻은 같음, robfig/cron 표 그대로).
//   바꾼 뒤에도 5필드가 아니면(모르는 줄임말·@every·TZ= 앞붙이 등) 그 잡만 unmapped B 로 뺀다 (가져오기 전체를 막지 않음)
export const CRON_MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};
export function cronOf(schedule: string): { cron: string; macro?: string } | null {
  const t = schedule.trim();
  const m = CRON_MACROS[t.toLowerCase()];
  if (m) return { cron: m, macro: t };
  return t.split(/\s+/).length === 5 && t.length >= 9 ? { cron: t } : null;
}

export const k8sCronJobMapper: KindMapper = {
  nativeTypes: [K8S_RAW_KINDS.cronjob],
  kind: "job",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as RawK8sCronJob;
    const js = it.spec.jobTemplate.spec;
    const pod = js.template.spec;
    const c = pod.containers[0];
    if (!c) return { skip: "컨테이너 없음", grade: "C" };
    const ns = it.metadata.namespace;
    const src = `k8s:${ns ?? ""}/cronjob/${it.metadata.name}`;
    const cron = cronOf(String(it.spec.schedule ?? ""));
    if (!cron) return { skip: `일정(schedule) 모양을 cron 5필드로 못 바꿈: ${String(it.spec.schedule ?? "").slice(0, 60)} → 사람이 cron 으로 정해 넣는다`, grade: "B" };
    const w = workloadOf(ns, it.imageDigest ?? null, c, pod, `${src}.containers[0]`, it.containerDigests, it.nodeArch);
    if (it.digestReview && !c.image.includes("@")) w.meta.image = [`${src}.containers[0].image + job pod digest`, 0.6, it.digestReview];   // G3-4
    const cp = it.spec.concurrencyPolicy;
    const rp = pod.restartPolicy;
    const run: Record<string, unknown> = {
      concurrencyPolicy: cp === "Allow" || cp === "Forbid" || cp === "Replace" ? cp : undefined,
      suspend: it.spec.suspend, timeZone: it.spec.timeZone,
      backoffLimit: js.backoffLimit, activeDeadlineSec: js.activeDeadlineSeconds,
      restartPolicy: rp === "OnFailure" || rp === "Never" ? rp : undefined,
    };
    for (const k of Object.keys(run)) if (run[k] == null) delete run[k];
    const meta: Record<string, MetaTuple> = { ...w.meta, schedule: cron.macro
      ? [`${src}.spec.schedule`, 1, `줄임말 ${cron.macro} → cron "${cron.cron}" (같은 뜻)`] : [`${src}.spec.schedule`, 1] };
    return {
      name: it.metadata.name, ...(ns ? { ns } : {}), kind: "job",
      native: { type: K8S_RAW_KINDS.cronjob, name: it.metadata.name, ...(ns ? { namespace: ns } : {}), labels: js.template.metadata?.labels ?? {},
        ...(appLabelsOf(it.metadata.labels) ? { appLabels: appLabelsOf(it.metadata.labels) } : {}) },
      props: { ...w.props, ...podLabelsOf(js.template.metadata?.labels), schedule: cron.cron, ...run },
      ...(w.partial.length ? { partial: w.partial } : {}),
      meta,
    };
  },
};

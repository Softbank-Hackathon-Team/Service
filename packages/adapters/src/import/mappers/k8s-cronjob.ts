import { K8S_RAW_KINDS, type RawK8sCronJob } from "../raw-k8s.js";
import { appLabelsOf } from "../app-group.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";
import { workloadOf } from "./k8s-deployment.js";

// DRAFT(ai): k8s CronJob → job 리소스. 실행 규칙 필드(동시 실행·정지·재시도·마감)는 있는 것만 옮긴다 (PoC :175).
//   digest 없으면 리소스로 두고 checkV2 가 "digest 아님" 오류를 낸다 (PoC 와 같음. Deployment 의 R9 는 서비스만)
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
    const w = workloadOf(ns, it.imageDigest ?? null, c, pod, `${src}.containers[0]`);
    const cp = it.spec.concurrencyPolicy;
    const rp = pod.restartPolicy;
    const run: Record<string, unknown> = {
      concurrencyPolicy: cp === "Allow" || cp === "Forbid" || cp === "Replace" ? cp : undefined,
      suspend: it.spec.suspend, timeZone: it.spec.timeZone,
      backoffLimit: js.backoffLimit, activeDeadlineSec: js.activeDeadlineSeconds,
      restartPolicy: rp === "OnFailure" || rp === "Never" ? rp : undefined,
    };
    for (const k of Object.keys(run)) if (run[k] == null) delete run[k];
    const meta: Record<string, MetaTuple> = { ...w.meta, schedule: [`${src}.spec.schedule`, 1] };
    return {
      name: it.metadata.name, ...(ns ? { ns } : {}), kind: "job",
      native: { type: K8S_RAW_KINDS.cronjob, name: it.metadata.name, ...(ns ? { namespace: ns } : {}), labels: js.template.metadata?.labels ?? {},
        ...(appLabelsOf(it.metadata.labels) ? { appLabels: appLabelsOf(it.metadata.labels) } : {}) },
      props: { ...w.props, schedule: it.spec.schedule, ...run },
      meta,
    };
  },
};

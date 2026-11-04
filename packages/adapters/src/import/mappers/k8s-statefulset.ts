import { K8S_RAW_KINDS, type RawK8sDaemonSet, type RawK8sStatefulSet, type RawK8sVolumeClaimTemplate } from "../raw-k8s.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";
import { parseQuantity, serviceFromPodOwner } from "./k8s-deployment.js";

// D6 DRAFT(ai): StatefulSet·DaemonSet → service 리소스 (workloadKind 로 종류 보존). 도착에서도 같은 종류로 그린다 (Jeong 11/3 17:53Z).
//   볼륨 디스크 데이터는 옮기지 않는다(리플랫폼) → 볼륨마다 검토 표시. postgres 이미지 StatefulSet 은 Q-1(논리 복제) 몫.

const ACCESS: Record<string, "RWO" | "RWX" | "ROX" | "RWOP"> = { ReadWriteOnce: "RWO", ReadWriteMany: "RWX", ReadOnlyMany: "ROX", ReadWriteOncePod: "RWOP" };
const RETAIN = new Set(["Retain", "Delete"]);

/** 바이트 → GB(10^9 아님, GiB 기준으로 올림). 못 읽으면 undefined */
const gbOf = (q: string | undefined): number | undefined => {
  const v = parseQuantity(q);
  return v == null ? undefined : Math.ceil(v / 2 ** 30);
};

/** volumeClaimTemplates → IR volumes (마운트 경로는 주 컨테이너 volumeMounts 에서). 경로가 없으면 사이드카 마운트일 수 있어 검토 */
export function claimVolumesOf(vcts: RawK8sVolumeClaimTemplate[], mounts: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>, src: string) {
  const volumes: Array<Record<string, unknown>> = [];
  const meta: Record<string, MetaTuple> = {};
  for (const v of [...vcts].sort((a, b) => a.name.localeCompare(b.name))) {
    const mt = mounts.find((x) => x.name === v.name);
    const access = (v.accessModes ?? []).map((a) => ACCESS[a]).filter((x): x is NonNullable<typeof x> => !!x);
    const sizeGb = gbOf(v.storage);
    volumes.push(Object.fromEntries(Object.entries({
      name: v.name, mountPath: mt?.mountPath ?? "", sizeGb, access: access[0], storageClass: v.storageClassName, claimTemplate: true,
    }).filter(([, x]) => x !== undefined)));
    meta[`volumes.${v.name}`] = [`${src}.volumeClaimTemplates.${v.name}`, 0.6,
      !mt ? "주 컨테이너에 이 볼륨 마운트가 없음 (사이드카 마운트일 수 있음) → 경로 확인 필요. 디스크 데이터는 안 따라옴"
        : sizeGb == null ? "크기를 못 읽음 → 도착 기본 크기. 디스크 데이터는 안 따라옴"
        : "도착에 같은 크기·접근 방식의 빈 볼륨을 만든다. 디스크 데이터는 안 따라옴(리플랫폼) → 데이터 옮기기 방법 확인"];
    if (access.length > 1) meta[`volumes.${v.name}.access`] = [`${src}.volumeClaimTemplates.${v.name}.accessModes`, 0.6, `접근 방식 ${access.join(",")} 중 첫 번째만 옮김`];
  }
  return { volumes, meta };
}

export const k8sStatefulSetMapper: KindMapper = {
  nativeTypes: [K8S_RAW_KINDS.statefulset],
  kind: "service",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as RawK8sStatefulSet;
    const ns = it.metadata.namespace;
    const src = `k8s:${ns ?? ""}/statefulset/${it.metadata.name}`;
    const c = it.spec.template.spec.containers[0];
    const { volumes, meta } = claimVolumesOf(it.spec.volumeClaimTemplates ?? [], c?.volumeMounts ?? [], src);
    const pmp = it.spec.podManagementPolicy;
    const ret = it.spec.persistentVolumeClaimRetentionPolicy;
    const pvcRetention = ret && (RETAIN.has(ret.whenDeleted ?? "") || RETAIN.has(ret.whenScaled ?? ""))
      ? Object.fromEntries(Object.entries({ whenDeleted: RETAIN.has(ret.whenDeleted ?? "") ? ret.whenDeleted : undefined, whenScaled: RETAIN.has(ret.whenScaled ?? "") ? ret.whenScaled : undefined }).filter(([, x]) => x !== undefined))
      : undefined;
    const sts = it.spec.serviceName ? Object.fromEntries(Object.entries({
      serviceName: it.spec.serviceName,
      podManagementPolicy: pmp === "OrderedReady" || pmp === "Parallel" ? pmp : undefined,
      pvcRetention,
    }).filter(([, x]) => x !== undefined)) : undefined;
    return serviceFromPodOwner({ type: K8S_RAW_KINDS.statefulset, label: "statefulset", name: it.metadata.name, namespace: ns,
      labels: it.metadata.labels, podLabels: it.spec.template.metadata?.labels ?? {}, pod: it.spec.template.spec,
      imageDigest: it.imageDigest ?? null, replicas: it.spec.replicas ?? 1 }, {
      props: { workloadKind: "statefulset", ...(sts ? { statefulSet: sts } : {}), ...(volumes.length ? { volumes } : {}) },
      meta: {
        workloadKind: [src, 1, "StatefulSet → 도착도 StatefulSet"],
        ...(sts ? {} : { statefulSet: [`${src}.spec.serviceName`, 0.6, "serviceName 없음 → 파드별 고정 DNS 없음. 도착도 그대로 비워 둠"] as MetaTuple }),
        ...meta,
      },
    });
  },
};

export const k8sDaemonSetMapper: KindMapper = {
  nativeTypes: [K8S_RAW_KINDS.daemonset],
  kind: "service",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as RawK8sDaemonSet;
    const ns = it.metadata.namespace;
    const src = `k8s:${ns ?? ""}/daemonset/${it.metadata.name}`;
    // 개수는 노드 수를 따른다 → replicas 는 읽은 시점 값(참고). 도착 차트는 DaemonSet 에 replicas 를 안 그림
    const n = it.status?.desiredNumberScheduled ?? 1;
    return serviceFromPodOwner({ type: K8S_RAW_KINDS.daemonset, label: "daemonset", name: it.metadata.name, namespace: ns,
      labels: it.metadata.labels, podLabels: it.spec.template.metadata?.labels ?? {}, pod: it.spec.template.spec,
      imageDigest: it.imageDigest ?? null, replicas: n }, {
      props: { workloadKind: "daemonset" },
      meta: {
        workloadKind: [src, 1, "DaemonSet → 도착도 DaemonSet (노드마다 하나)"],
        replicas: [`${src}.status.desiredNumberScheduled`, 0.9, "DaemonSet 개수는 도착 노드 수를 따름 (이 값은 출발 참고값)"],
      },
    });
  },
};

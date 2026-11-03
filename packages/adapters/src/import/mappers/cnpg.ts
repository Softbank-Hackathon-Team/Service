import { DB_RAW_KINDS } from "../raw-k8s.js";
import type { KindMapper, MappedComponent, RawItem } from "../types.js";
import { mibOf } from "./k8s-deployment.js";
import { majorOf } from "./rds.js";

// DRAFT(ai): 온프레 CloudNativePG Cluster → postgres 리소스.
//   R10: 버전은 spec.postgresVersion → spec.imageName 태그 순. 둘 다 없으면 null (오퍼레이터 기본 이미지, 버전 모름)
//   endpoint = <이름>-rw.<네임스페이스>.svc (CNPG 가 만드는 읽기·쓰기 Service)
type Cnpg = { metadata?: { name?: string; namespace?: string }; spec?: { postgresVersion?: string | number; imageName?: string; storage?: { size?: string | null }; instances?: number | null } };
export const cnpgMapper: KindMapper = {
  nativeTypes: [DB_RAW_KINDS.cnpg],
  kind: "postgres",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as Cnpg;
    const name = it.metadata?.name;
    if (!name) return { skip: "metadata.name 없음 (깨진 원본)", grade: "C" };
    const ns = it.metadata?.namespace;
    const sp = it.spec ?? {};
    const verSrc = sp.postgresVersion != null ? "spec.postgresVersion" : sp.imageName ? "spec.imageName" : null;
    const major = sp.postgresVersion != null ? majorOf(sp.postgresVersion) : sp.imageName ? majorOf(String(sp.imageName).split(":").pop()) : null;
    const mib = mibOf(sp.storage?.size);
    const storage = mib == null ? null : Math.ceil(mib / 1024);
    const props: Record<string, unknown> = { majorVersion: major, storageGb: storage };
    if (typeof sp.instances === "number") props.ha = sp.instances > 1;
    return {
      name, ...(ns ? { ns } : {}), kind: "postgres",
      native: { type: DB_RAW_KINDS.cnpg, name, ...(ns ? { namespace: ns } : {}), endpoint: ns ? `${name}-rw.${ns}.svc` : `${name}-rw`,
        ...(ns ? { aliases: [`${name}-rw.${ns}.svc.cluster.local`, `${name}-rw.${ns}`] } : {}) },
      props,
      meta: {
        majorVersion: major ? [`cnpg:${name}.${verSrc}`, 1] : [`cnpg:${name}.spec.imageName`, 0.6, "postgresVersion·imageName 없음 → 오퍼레이터 기본 이미지(버전 모름)"],
        storageGb: storage ? [`cnpg:${name}.spec.storage.size`, 1] : [`cnpg:${name}.spec.storage.size`, 0.6, "용량 못 읽음"],
        ...(props.ha !== undefined ? { ha: [`cnpg:${name}.spec.instances`, 1] as [string, 1] } : {}),
      },
    };
  },
};

import { DB_RAW_KINDS } from "../raw-k8s.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";
import { cnpgComputeOf, cnpgTls, strParams } from "./pg-settings.js";
import { mibOf } from "./k8s-deployment.js";
import { majorOf } from "./rds.js";

// DRAFT(ai): 온프레 CloudNativePG Cluster → postgres 리소스.
//   R10: 버전은 spec.postgresVersion → spec.imageName(없으면 status.image) 태그 순. 둘 다 없으면 null (오퍼레이터 기본 이미지, 버전 모름)
//   DM-3: 태그 자리만 본다 (digest "@sha256:…" 앞, 마지막 "/" 뒤의 ":" 뒤). 태그가 없거나 숫자로 시작하지 않으면 null + 0.6 (지어내지 않음)
//   endpoint = <이름>-rw.<네임스페이스>.svc (CNPG 가 만드는 읽기·쓰기 Service)
//   DM-4: CNPG 는 읽기 전용 <이름>-ro·아무 인스턴스 <이름>-r Service 도 만든다 → 별칭에 같이 (.ns·.svc·.svc.cluster.local)
type Cnpg = { metadata?: { name?: string; namespace?: string }; status?: { image?: string }; spec?: { postgresVersion?: string | number; imageName?: string; storage?: { size?: string | null }; walStorage?: { size?: string | null }; instances?: number | null;
  // N8·SSL-1
  postgresql?: { parameters?: Record<string, unknown>; pg_hba?: string[] }; bootstrap?: { initdb?: { database?: string; owner?: string } }; resources?: Record<string, unknown>;
  backup?: { retentionPolicy?: string | null; barmanObjectStore?: boolean | null } | null } };
/** DM-3: 이미지 글자에서 태그만. "reg:5000/postgresql" → null, "…:16.4@sha256:40e1…" → "16.4" */
export const imageTagOf = (image: string): string | null => {
  const noDigest = image.split("@")[0]!;
  const last = noDigest.slice(noDigest.lastIndexOf("/") + 1);
  const i = last.indexOf(":");
  return i < 0 ? null : last.slice(i + 1) || null;
};
/** DM-3: 태그가 "16"·"16.4"·"16-bookworm"·"16.4-1" 처럼 메이저 숫자로 시작할 때만 메이저 */
export const majorOfTag = (tag: string | null): string | null => {
  const m = tag ? /^(\d{1,2})(?=$|[.\-_])/.exec(tag) : null;
  return m ? m[1]! : null;
};
const CNPG_SERVICES = ["rw", "ro", "r"] as const;

export const cnpgMapper: KindMapper = {
  nativeTypes: [DB_RAW_KINDS.cnpg],
  kind: "postgres",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const it = item as unknown as Cnpg;
    const name = it.metadata?.name;
    if (!name) return { skip: "metadata.name 없음 (깨진 원본)", grade: "C" };
    const ns = it.metadata?.namespace;
    const sp = it.spec ?? {};
    const image = sp.imageName ?? it.status?.image ?? null;
    const verSrc = sp.postgresVersion != null ? "spec.postgresVersion" : sp.imageName ? "spec.imageName" : image ? "status.image" : null;
    const major = sp.postgresVersion != null ? majorOf(sp.postgresVersion) : image ? majorOfTag(imageTagOf(String(image))) : null;
    const mib = mibOf(sp.storage?.size);
    const storage = mib == null ? null : Math.ceil(mib / 1024);
    const props: Record<string, unknown> = { majorVersion: major, storageGb: storage };
    if (typeof sp.instances === "number") props.ha = sp.instances > 1;
    // DM-8: WAL 전용 볼륨 (있으면). 크기를 못 읽으면 칸은 비우고 검토
    const walMib = sp.walStorage ? mibOf(sp.walStorage.size) : null;
    if (walMib != null) props.walStorageGb = Math.ceil(walMib / 1024);
    // N8·SSL-1 (가져오기가 이 칸들을 읽은 경우만 = postgresql·bootstrap·resources 키가 원본에 있음)
    const extra: Record<string, MetaTuple> = {};
    const compute = cnpgComputeOf(sp.resources);
    if (compute) { props.compute = compute; extra.compute = [`cnpg:${name}.spec.resources`, 1]; }
    const params = strParams(sp.postgresql?.parameters);
    if (params && Object.keys(params).length) { props.parameters = params; extra.parameters = [`cnpg:${name}.spec.postgresql.parameters`, 1]; }
    if (sp.bootstrap?.initdb?.database) { props.databases = [sp.bootstrap.initdb.database]; extra.databases = [`cnpg:${name}.spec.bootstrap.initdb.database`, 1]; }
    // DBN-1: CNPG initdb 의 앱 DB·소유 역할. 둘 중 하나만 적으면 CNPG 는 owner = database 이름 【사실: CNPG initdb 규칙. 둘 다 없으면 app/app】
    const idb = sp.bootstrap?.initdb;
    if (idb?.database || idb?.owner) {
      props.appDatabase = idb.database ?? "app"; extra.appDatabase = [`cnpg:${name}.spec.bootstrap.initdb.database`, idb.database ? 1 : 0.9, ...(idb.database ? [] : ["database 칸 없음 → CNPG 기본 app"])] as MetaTuple;
      props.appUser = idb.owner ?? idb.database!; extra.appUser = [`cnpg:${name}.spec.bootstrap.initdb.owner`, idb.owner ? 1 : 0.9, ...(idb.owner ? [] : ["owner 칸 없음 → CNPG 규칙상 database 이름과 같음"])] as MetaTuple;
    }
    // BK-1: spec.backup 이 없으면(가져오기가 읽었는데 null) 백업 없음 = 0. retentionPolicy "30d" → 30 (주·달 단위는 못 읽음 → null)
    if ("backup" in sp) {
      const rp = sp.backup?.retentionPolicy ? /^(\d+)d$/.exec(sp.backup.retentionPolicy) : null;
      props.backup = sp.backup ? { retentionDays: rp ? Number(rp[1]) : null, pitr: sp.backup.barmanObjectStore === true } : { retentionDays: 0, pitr: false };
      extra.backup = sp.backup && !rp ? [`cnpg:${name}.spec.backup.retentionPolicy`, 0.6, `보관 기간 ${String(sp.backup.retentionPolicy ?? "없음")} 을 날로 못 읽음`] : [`cnpg:${name}.spec.backup`, 1];
    }
    if ("postgresql" in sp || "bootstrap" in sp || "resources" in sp) { const tls = cnpgTls(sp.postgresql?.pg_hba, name); props.tlsRequired = tls.v; extra.tlsRequired = tls.meta; }
    return {
      name, ...(ns ? { ns } : {}), kind: "postgres",
      native: { type: DB_RAW_KINDS.cnpg, name, ...(ns ? { namespace: ns } : {}), endpoint: ns ? `${name}-rw.${ns}.svc` : `${name}-rw`,
        // 맨 이름(<이름>-ro)은 우연히 같은 글자일 수 있어 별칭에 안 넣는다 (rw 와 같은 규칙)
        ...(ns ? { aliases: CNPG_SERVICES.flatMap((k) => [`${name}-${k}.${ns}`, `${name}-${k}.${ns}.svc`, `${name}-${k}.${ns}.svc.cluster.local`])
          .filter((a) => a !== `${name}-rw.${ns}.svc`) } : {}) },
      props,
      meta: {
        majorVersion: major ? [`cnpg:${name}.${verSrc}`, 1]
          : image ? [`cnpg:${name}.${verSrc}`, 0.6, `이미지 ${String(image)} 의 태그에서 메이저 버전을 못 읽음 (태그 없음·digest 만·숫자 아님) → 사람이 확인`]
          : [`cnpg:${name}.spec.imageName`, 0.6, "postgresVersion·imageName 없음 → 오퍼레이터 기본 이미지(버전 모름)"],
        storageGb: storage ? [`cnpg:${name}.spec.storage.size`, 1] : [`cnpg:${name}.spec.storage.size`, 0.6, "용량 못 읽음"],
        ...(props.ha !== undefined ? { ha: [`cnpg:${name}.spec.instances`, 1] as [string, 1] } : {}),
        ...(sp.walStorage ? { walStorageGb: (walMib != null ? [`cnpg:${name}.spec.walStorage.size`, 1] : [`cnpg:${name}.spec.walStorage.size`, 0.6, "WAL 전용 볼륨이 있지만 크기를 못 읽음"]) as MetaTuple } : {}),
        ...extra,
      },
    };
  },
};

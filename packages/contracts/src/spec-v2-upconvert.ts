import type { AppSpec } from "./spec.js";
import type { AppSpecV2, ComponentV2, EnvVarV2, FieldMetaV2, ImportResultV2, LinkV2 } from "./spec-v2.js";
import { hasVendorHost } from "./spec-v2-check.js";

// DRAFT(ai): v1 → v2 올리기 (설계 20번 4.6장, PoC upconvertV1). DB 의 spec_versions v1 판을 버리지 않는다.
//   순수 함수. 올리기는 정보를 더하지 못하므로 v1 이 지어냈거나 잃은 필드는 0.6 + needs_review.
//   벤더 주소가 env 값으로 남은 판은 checkV2(…, { legacy: true }) 로만 깨끗하다 → 계획 전에 다시 가져오기.

const V1_CPU: Record<string, number> = { "250m": 250, "500m": 500, "1": 1000 };
const V1_MEM: Record<string, number> = { "512Mi": 512, "1Gi": 1024, "2Gi": 2048 };

// "repo/name@sha256:…" → { repository, digest }. digest 가 없으면 null (checkV2 가 오류로 잡음)
const splitImage = (ref: string): { repository: string; digest: string | null } => {
  const at = ref.lastIndexOf("@");
  return at < 0 ? { repository: ref, digest: null } : { repository: ref.slice(0, at), digest: ref.slice(at + 1) };
};

const review = (source: string, rationale: string) => ({ source, confidence: 0.6 as const, needs_review: true, rationale });

export function upconvertV1(v1: AppSpec): ImportResultV2 {
  const main = v1.app.name;   // v1 이름 규칙(^[a-z][a-z0-9-]{1,30}$)은 v2 id 규칙 안에 들어간다
  // DRAFT(ai): DB id 는 "db". 앱 이름이 "db" 면 겹치므로 "db-postgres"
  const dbId = main === "db" ? "db-postgres" : "db";
  const s = v1.service;
  const { repository, digest } = splitImage(s.image);

  // v1 secretRefs.name 은 "환경변수 이름"이다(비밀 이름은 v1 에 안 남음). 비밀 이름 자리에 변수 이름을 둔다
  const env: EnvVarV2[] = [
    ...s.env.map((e): EnvVarV2 => ({ name: e.name, value: e.value })),
    ...s.secretRefs.map((r): EnvVarV2 => ({ name: r.name, fromSecret: { secret: r.name, key: r.key } })),
  ];

  const components: ComponentV2[] = [{
    id: main, kind: "service",
    props: {
      runtime: "k8s",
      origin: { runtime: "k8s", product: "unknown" },
      image: { source: "registry", repository, digest },
      ports: [{ port: s.port, protocol: "TCP" }],
      probes: { readiness: { type: "http", path: s.healthPath, port: s.port } },
      replicas: { min: s.replicas, max: s.replicas },
      serviceAccount: "default",
      resources: { request: { cpuMilli: V1_CPU[s.cpu] ?? null, memMiB: V1_MEM[s.memory] ?? null } },
      env,
    },
  }];
  const links: LinkV2[] = [];
  const fieldMeta: FieldMetaV2 = {
    [`components.${main}.resources`]: review("v1.service.cpu/memory", "v1 은 cpu·memory 를 표 값으로 올려 잡음 → 실제 출발 값 아님"),
    [`components.${main}.probes`]: review("v1.service.healthPath", "v1 은 프로브 없으면 /healthz 로 채움"),
    [`components.${main}.serviceAccount`]: review("v1 (필드 없음)", "v1 에 신원 필드 없음"),
    [`components.${main}.origin`]: review("v1 (필드 없음)", "v1 에 출발 실행 방식 필드 없음 → k8s 로 둠"),
  };
  for (const r of s.secretRefs)
    fieldMeta[`components.${main}.env.${r.name}`] = review("v1.service.secretRefs", "v1 은 비밀 이름을 안 남김 → 변수 이름으로 둠");
  for (const e of s.env)
    if (hasVendorHost(e.value))
      fieldMeta[`components.${main}.env.${e.name}`] = review("v1.service.env", "벤더 주소 값. v1 엔 의존성 근거가 없어 fromLink 로 못 바꿈 → 다시 가져오기 필요");

  if (v1.database) {
    components.push({ id: dbId, kind: "postgres", props: { majorVersion: v1.database.majorVersion, storageGb: v1.database.storageGb } });
    links.push({ from: main, to: dbId, intent: "connect" });
    fieldMeta[`components.${dbId}.storageGb`] = review("v1.database.storageGb", "v1 은 100GB 에서 잘렸을 수 있음");
  }

  const spec: AppSpecV2 = {
    schemaVersion: "2",
    app: { name: main },
    components,
    links,
    entry: {
      via: v1.ingress.entry,
      hosts: [{
        hostnames: [v1.ingress.hostname],
        routes: [{ matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: main, port: s.port, weight: 1 }] }],
      }],
    },
    posture: { permissions: [], network: [] },
  };
  // ids: v1 에는 벤더 고유 키가 없다 → 빈 표. 다시 가져오면 매퍼가 채운다
  return { spec, fieldMeta, unmapped: [], ids: {} };
}

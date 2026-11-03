// VNEW (상태: AI 초안): VMIMPORT·CRIMPORT 가 base 에서 처음 합쳐진 discover gcp 조건 교차 검증.
//   GKE(앱 있음·빈 클러스터·없음) × VM(있음·없음) × Cloud Run(서비스 있음·없음·못 읽음) 조합 → 무엇을 읽고, 언제 멈추는지. 가짜 gcloud·kubectl 만 (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AWS_COMMAND_ACTIONS, discoverAws, discoverGcp, GCP_COMMAND_PERMISSIONS, KIND_MAPPERS, normalizeV2 } from "../src/index.js";

const P = "cust-prj", REG = "asia-northeast3";
const DG = "sha256:" + "d4".repeat(32);
type Gke = "app" | "empty" | "none";
type Run = "svc" | "none" | "fail";
const dep = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
  spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } },
    spec: { containers: [{ name: "api", image: `r/shop-api@${DG}`, ports: [{ containerPort: 8080 }], resources: { requests: { cpu: "100m", memory: "64Mi" } } }] } } } };
const runSvc = { metadata: { name: "shop-web", labels: { "cloud.googleapis.com/location": REG } }, spec: { template: { spec: { containers: [{ image: `r/shop-web@${DG}`, ports: [{ containerPort: 8080 }] }] } } },
  status: { url: "https://shop-web-x.a.run.app", latestReadyRevisionName: "shop-web-1" } };
const vmInst = { name: "legacy-1", status: "RUNNING", zone: `z/${REG}-a`, machineType: "m/e2-small", tags: { items: [] }, networkInterfaces: [] };

/** 한 조합의 가짜 실행기. 부른 명령 줄을 모은다 */
function gcpExec(o: { gke: Gke; vm: boolean; run: Run }) {
  const calls: string[] = [];
  const j = (x: unknown) => ({ code: 0, stdout: JSON.stringify(x), stderr: "", ms: 1 });
  const exec = async (bin: string, args: string[]) => {
    const s = `${bin} ${args.join(" ")}`; calls.push(s);
    if (bin === "kubectl") {
      if (args[1] === "deployments" && o.gke === "app") return j({ items: [dep] });
      return j({ items: [] });
    }
    if (/container clusters list/.test(s)) return j(o.gke === "none" ? [] : [{ name: "gke-1", location: REG }]);
    if (/container clusters get-credentials/.test(s)) return j({});
    if (/compute instances list/.test(s)) return j(o.vm ? [vmInst] : []);
    if (/^gcloud run services list/.test(s)) return o.run === "fail" ? { code: 1, stdout: "", stderr: "PERMISSION_DENIED: run.services.list", ms: 1 } : j(o.run === "svc" ? [runSvc] : []);
    if (/^gcloud run revisions describe/.test(s)) return j({ status: { imageDigest: DG } });
    if (/^gcloud run services get-iam-policy/.test(s)) return j({ bindings: [] });
    return j([]);
  };
  return { exec, calls };
}
const kindsOf = (items: unknown[]) => (items as Array<{ kind: string }>).map((i) => i.kind);

const CASES: Array<{ gke: Gke; vm: boolean; run: Run; ok: boolean; want: string[]; vmRead: boolean }> = [
  // 셋 다: GKE 앱 + Cloud Run 은 늘 읽고, VM 은 GKE 가 있으면 명시(IMPORT_VM)가 없어 안 읽음
  { gke: "app", vm: true, run: "svc", ok: true, want: ["k8s.deployment", "cloudrun.service"], vmRead: false },
  { gke: "app", vm: false, run: "none", ok: true, want: ["k8s.deployment"], vmRead: false },
  // 하나만
  { gke: "none", vm: true, run: "none", ok: true, want: ["vm.group"], vmRead: true },
  { gke: "none", vm: false, run: "svc", ok: true, want: ["cloudrun.service"], vmRead: true },
  { gke: "none", vm: true, run: "svc", ok: true, want: ["vm.group", "cloudrun.service"], vmRead: true },
  // VNEW 수정: 빈 GKE(앱 Deployment 없음)라도 Cloud Run 앱이 있으면 그것만 가져온다 (예전: SOURCE_INCOMPLETE)
  { gke: "empty", vm: false, run: "svc", ok: true, want: ["cloudrun.service"], vmRead: false },
  // 거부: 없음 · 빈 GKE 뿐 · Cloud Run 을 못 읽고 다른 것도 없음
  { gke: "none", vm: false, run: "none", ok: false, want: [], vmRead: true },
  { gke: "empty", vm: false, run: "none", ok: false, want: [], vmRead: false },
  { gke: "none", vm: false, run: "fail", ok: false, want: [], vmRead: true },
];

for (const c of CASES) {
  test(`discover gcp v2 조합: GKE ${c.gke} · VM ${c.vm ? "있음" : "없음"} · Cloud Run ${c.run} → ${c.ok ? "읽음" : "SOURCE_INCOMPLETE"}`, async () => {
    const { exec, calls } = gcpExec(c);
    const run = discoverGcp({ exec: exec as never, env: { GCP_PROJECT: P } }, { ir: "v2" });
    if (!c.ok) {
      await assert.rejects(run, (e: unknown) => (e as { code?: string }).code === "SOURCE_INCOMPLETE");
      if (c.run === "fail") await assert.rejects(discoverGcp({ exec: gcpExec(c).exec as never, env: { GCP_PROJECT: P } }, { ir: "v2" }), /Cloud Run 서비스도 없음: Cloud Run 못 읽음: .*PERMISSION_DENIED/);
      return;
    }
    const inv = await run;
    const kinds = kindsOf(inv.items);
    for (const k of c.want) assert.ok(kinds.includes(k), `${k} 없음: ${kinds.join(",")}`);
    for (const k of ["k8s.deployment", "cloudrun.service", "vm.group"].filter((x) => !c.want.includes(x))) assert.ok(!kinds.includes(k), `${k} 가 섞임`);
    assert.equal(calls.some((s) => s.includes("compute instances list")), c.vmRead, "VM 읽기 여부");
    assert.equal(calls.some((s) => s.includes("get-credentials")), c.gke !== "none");
    // 모든 명령이 권한 표에 있는 읽기 명령 (kubectl 은 get 만)
    for (const s of calls) {
      const [bin, ...a] = s.split(" ");
      if (bin === "kubectl") { assert.equal(a[0], "get", s); continue; }
      const words = a.filter((w) => !w.startsWith("-"));
      const hit = [4, 3, 2].map((n) => words.slice(0, n).join(" ")).find((k) => k in GCP_COMMAND_PERMISSIONS);
      assert.ok(hit, `권한 표에 없는 명령: ${s}`);
    }
    // 같은 원본 → normalizeV2 가 갈래별 리소스를 만든다 (빈 GKE 쪽은 리소스 0)
    const out = normalizeV2(inv).result;
    assert.ok(out.spec.components.length >= c.want.length, JSON.stringify(out.spec.components.map((x) => x.id)));
    if (c.gke === "empty") assert.ok(kinds.includes("import.note") && JSON.stringify(inv.items).includes("앱 Deployment 없음 → Cloud Run 만 가져옴"));
  });
}

test("거부: v1 은 빈 GKE 에 Cloud Run 이 있어도 지금처럼 멈춘다 (Cloud Run 안 부름)", async () => {
  const { exec, calls } = gcpExec({ gke: "empty", vm: false, run: "svc" });
  await assert.rejects(discoverGcp({ exec: exec as never, env: { GCP_PROJECT: P } }, {}), (e: unknown) => (e as { code?: string }).code === "SOURCE_INCOMPLETE");
  assert.ok(!calls.some((s) => /^gcloud run /.test(s)));
});

test("aws 같은 규칙: 빈 EKS + ECS 서비스면 ECS 만, 빈 EKS 뿐이면 멈춤", async () => {
  const ecsTable = (withSvc: boolean) => async (bin: string, args: string[]) => {
    const s = `${bin} ${args.join(" ")}`;
    const j = (x: unknown) => ({ code: 0, stdout: JSON.stringify(x), stderr: "", ms: 1 });
    if (bin === "kubectl") return j({ items: [] });
    if (/sts get-caller-identity/.test(s)) return j({ Account: "000000000000" });
    if (/eks list-clusters/.test(s)) return j({ clusters: ["eks-1"] });
    if (/eks describe-cluster/.test(s)) return j({ cluster: { name: "eks-1", resourcesVpcConfig: { vpcId: "vpc-1" } } });
    if (/eks update-kubeconfig/.test(s)) return { code: 0, stdout: "", stderr: "", ms: 1 };
    if (/ecs list-clusters/.test(s)) return j({ clusterArns: withSvc ? ["arn:aws:ecs:ap-northeast-2:000000000000:cluster/c1"] : [] });
    if (/ecs list-services/.test(s)) return j({ serviceArns: ["arn:aws:ecs:ap-northeast-2:000000000000:service/c1/shop"] });
    if (/ecs describe-services/.test(s)) return j({ services: [{ serviceName: "shop", serviceArn: "arn:aws:ecs:ap-northeast-2:000000000000:service/c1/shop", clusterArn: "arn:aws:ecs:ap-northeast-2:000000000000:cluster/c1",
      taskDefinition: "arn:aws:ecs:ap-northeast-2:000000000000:task-definition/shop:1", desiredCount: 1, launchType: "FARGATE", loadBalancers: [] }] });
    if (/ecs describe-task-definition/.test(s)) return j({ taskDefinition: { family: "shop", cpu: "256", memory: "512", containerDefinitions: [{ name: "shop", image: `r/shop@${DG}`, essential: true, portMappings: [{ containerPort: 80 }] }] } });
    if (/ecs list-tasks/.test(s)) return j({ taskArns: [] });
    return j({});
  };
  const inv = await discoverAws({ exec: ecsTable(true) as never, env: { AWS_REGION: "ap-northeast-2" } }, { ir: "v2" });
  const kinds = kindsOf(inv.items);
  assert.ok(kinds.includes("ecs.service") && !kinds.includes("k8s.deployment"), kinds.join(","));
  assert.ok(JSON.stringify(inv.items).includes("EKS eks-1 에 앱 Deployment 없음 → ECS 만 가져옴"));
  await assert.rejects(discoverAws({ exec: ecsTable(false) as never, env: { AWS_REGION: "ap-northeast-2" } }, { ir: "v2" }), (e: unknown) => (e as { code?: string }).code === "SOURCE_INCOMPLETE");
  assert.ok(Object.keys(AWS_COMMAND_ACTIONS).includes("ecs list-services"));
});

test("pipeline KIND_MAPPERS: vm·cloudrun 서비스·잡 매퍼 다 있고, 원본 종류 하나에 매퍼 하나 (겹침 0)", () => {
  const types = KIND_MAPPERS.flatMap((m) => m.nativeTypes);
  for (const t of ["vm.group", "cloudrun.service", "cloudrun.job", "ecs.service", "k8s.deployment"]) assert.ok(types.includes(t), `${t} 매퍼 없음: ${types.join(",")}`);
  assert.deepEqual(types.filter((t, i) => types.indexOf(t) !== i), []);
});

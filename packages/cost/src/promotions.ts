import type { CostBreakdown, CostProjection, CostPromotion, Provider } from "@svc/contracts";
import type { Lang } from "./evidence-text.js";

// 도착에 적용할 수 있는 프로모션 (2026-11-06 공식 문서로 확인, Notion "본선(11/7–8)에 쓸 수 있는 AWS·GCP 프로모션과 서울 단가 조사").
// 세 갈래로 다룬다
//   applied     = 조건 없이 이 견적에 들어감 → 금액에서 뺀다 (GKE 무료 등급)
//   conditional = 스스로 확인할 수 있는 조건(새 결제 계정)을 채우면 들어감 → "조건 충족 시" 금액에만 뺀다
//   conditional + 금액 0 = 신청·심사·영업 계약이 있어야 하고 금액을 미리 알 수 없음 → 조건과 출처만 보인다 (금액에 넣지 않음)
// DRAFT(ai): 이 표는 손으로 옮긴 것이라 날짜(checkedAt)를 같이 싣는다. 프로그램 조건이 바뀌면 이 표를 고친다

const CHECKED = "2026-11-06";
type L = Record<Lang, string>;
type Def = {
  id: string; provider: Provider; kind: CostPromotion["kind"]; sourceUrl: string; validUntil: string | null;
  title: L; condition: L; appliesTo: L; note: L | null;
};

const DEFS: Record<string, Def> = {
  gkeFree: {
    id: "gcp-gke-free-tier", provider: "gcp", kind: "recurring_credit", validUntil: null,
    sourceUrl: "https://cloud.google.com/kubernetes-engine/pricing",
    title: { ko: "GKE 무료 등급 월 $74.40", en: "GKE free tier $74.40/mo", ja: "GKE 無料枠 月 $74.40" },
    condition: { ko: "결제 계정당 하나, 존 클러스터·Autopilot 클러스터만. 남은 크레딧은 다음 달로 넘어가지 않음", en: "One per billing account, zonal or Autopilot clusters only; unused credit does not roll over", ja: "請求先アカウントごとに 1 つ、ゾーンクラスターと Autopilot のみ。未使用分は繰り越さない" },
    appliesTo: { ko: "GKE 클러스터 관리비", en: "GKE cluster fee", ja: "GKE クラスター管理料金" },
    note: { ko: "같은 결제 계정의 다른 존 클러스터가 이미 쓰고 있으면 빠집니다", en: "Not available if another zonal cluster on the same billing account already uses it", ja: "同じ請求先アカウントの別ゾーンクラスターが使っていれば対象外" },
  },
  gcpTrial: {
    id: "gcp-free-trial-300", provider: "gcp", kind: "trial_credit", validUntil: null,
    sourceUrl: "https://docs.cloud.google.com/free/docs/free-cloud-features",
    title: { ko: "무료 체험 $300 (90일)", en: "Free Trial $300 (90 days)", ja: "無料トライアル $300 (90 日)" },
    condition: { ko: "Google Cloud·Maps·Firebase 를 유료로 쓴 적 없는 새 고객. 동시 8코어 한도, 할당량 증설 불가", en: "New customers who never paid for Google Cloud, Maps or Firebase; 8 concurrent cores, no quota increases", ja: "Google Cloud・Maps・Firebase を有料で使ったことのない新規顧客。同時 8 コアまで、割り当て増加不可" },
    appliesTo: { ko: "첫 3개월 사용액", en: "Spend in the first 3 months", ja: "最初の 3 か月の利用額" },
    note: { ko: "약관 2026-02-12 판 기준", en: "Per terms version of 2026-02-12", ja: "2026-02-12 版の規約による" },
  },
  gcpStartups: {
    id: "gcp-startups-start", provider: "gcp", kind: "program_credit", validUntil: null,
    sourceUrl: "https://cloud.google.com/startup",
    title: { ko: "Google for Startups (Start $2,000 ~ Scale $350K)", en: "Google for Startups (Start $2,000 to Scale $350K)", ja: "Google for Startups (Start $2,000 〜 Scale $350K)" },
    condition: { ko: "Start: 설립 2년 안·동작하는 MVP. Scale: Pre-Seed~Series A 투자 확인. 신청·심사 필요", en: "Start: founded within 2 years with a working MVP. Scale: verified Pre-Seed to Series A funding. Application required", ja: "Start: 設立 2 年以内・動く MVP。Scale: Pre-Seed〜Series A の資金調達確認。申請・審査が必要" },
    appliesTo: { ko: "사용액 전반", en: "General usage", ja: "利用額全般" },
    note: { ko: "심사로 금액이 정해져 견적 금액에 넣지 않았습니다", en: "Amount set by review; not included in the estimate", ja: "審査で金額が決まるため見積額には含めていません" },
  },
  gcpRamp: {
    id: "gcp-ramp", provider: "gcp", kind: "program_credit", validUntil: null,
    sourceUrl: "https://cloud.google.com/solutions/cloud-migration-program",
    title: { ko: "RaMP 이전 지원", en: "RaMP migration incentives", ja: "RaMP 移行支援" },
    condition: { ko: "영업 계약과 프로젝트 태깅 필요, 기존 사용액은 제외. 분기 사용액의 25% 크레딧(연간 예상액 30% 또는 $3M 한도)", en: "Requires a RaMP agreement and project tagging; pre-existing spend excluded. 25% of quarterly spend as credits (up to 30% of projected annual run rate or $3M)", ja: "営業契約とプロジェクトのタグ付けが必要、既存利用額は対象外。四半期利用額の 25% をクレジット (年間見込みの 30% または $3M まで)" },
    appliesTo: { ko: "이전한 워크로드 사용액", en: "Spend on migrated workloads", ja: "移行したワークロードの利用額" },
    note: { ko: "계약으로 금액이 정해져 견적 금액에 넣지 않았습니다 (약관 2026-10-05 판)", en: "Amount set by contract; not included (terms of 2026-10-05)", ja: "契約で金額が決まるため見積額に含めていません (2026-10-05 版規約)" },
  },
  gcpExit: {
    id: "gcp-exit-data-transfer", provider: "gcp", kind: "data_transfer_waiver", validUntil: null,
    sourceUrl: "https://cloud.google.com/exit-cloud",
    title: { ko: "GCP 를 떠날 때 데이터 전송료 면제", en: "Free data transfer when leaving GCP", ja: "GCP 退出時のデータ転送料免除" },
    condition: { ko: "그 서비스의 모든 워크로드·데이터를 옮길 때. Exit Notice → 30일 안 시작 → 완료 통지", en: "When moving all workloads and data of that service. Exit Notice, start within 30 days, then completion notice", ja: "そのサービスの全ワークロード・データを移すとき。Exit Notice → 30 日以内に開始 → 完了通知" },
    appliesTo: { ko: "출발 쪽 일회성 인터넷 전송료 (월 비용 밖)", en: "One-time internet egress at the source (outside the monthly cost)", ja: "出発側の一回限りのインターネット転送料 (月額外)" },
    note: null,
  },
  awsFreeTier: {
    id: "aws-free-tier-credits", provider: "aws", kind: "signup_credit", validUntil: null,
    sourceUrl: "https://aws.amazon.com/free/free-tier-faqs/",
    title: { ko: "프리 티어 크레딧 $100 (+활동 최대 $100)", en: "Free Tier credits $100 (+ up to $100 for activities)", ja: "無料利用枠クレジット $100 (+ アクティビティで最大 $100)" },
    condition: { ko: "2025-07-15 이후 처음 만든 AWS 계정. t3.medium 같은 노드는 Free 플랜 대상이 아니라 Paid 플랜이 필요(크레딧은 그대로). 크레딧은 계정 만든 날부터 12개월", en: "AWS accounts first created on or after 2025-07-15. Nodes like t3.medium need the Paid plan (credits still apply). Credits last 12 months from account creation", ja: "2025-07-15 以降に初めて作成した AWS アカウント。t3.medium などのノードは Free プラン対象外のため Paid プランが必要 (クレジットは有効)。クレジットは作成から 12 か月" },
    appliesTo: { ko: "EC2·RDS·EKS·ELB 등 사용액", en: "Usage such as EC2, RDS, EKS, ELB", ja: "EC2・RDS・EKS・ELB などの利用額" },
    note: { ko: "확실한 가입 크레딧 $100만 셌습니다. 2026-10 새 가입 절차는 한국 계정을 시드니 리전에 두므로 서울을 쓰려면 고급 가입이 필요", en: "Only the sure $100 sign-up credit is counted. The Oct 2026 sign-up flow places Korean accounts in Sydney; Seoul needs advanced sign-up", ja: "確実な登録クレジット $100 のみ計上。2026-10 の新しい登録手順では韓国のアカウントはシドニーになるため、ソウル利用には高度な登録が必要" },
  },
  awsLift: {
    id: "aws-lift-apj", provider: "aws", kind: "program_credit", validUntil: null,
    sourceUrl: "https://aws.amazon.com/events/apj/aws-lift/faq/",
    title: { ko: "AWS Lift (아태, 한국·일본 포함)", en: "AWS Lift (APJ, incl. Korea and Japan)", ja: "AWS Lift (アジア太平洋、韓国・日本を含む)" },
    condition: { ko: "직전 3개월 평균 AWS 사용 $750 미만, 다른 프로모션 크레딧 $500 이하, Activate 크레딧을 받은 적 없음. $250부터 12개월 안 최대 $83,500, 묶음마다 4개월", en: "Average spend under $750/mo over the prior 3 months, at most $500 of other promo credits, never received Activate. From $250 up to $83,500 within 12 months, each tranche valid 4 months", ja: "直近 3 か月の平均利用 $750 未満、他のプロモクレジット $500 以下、Activate 未受領。$250 から 12 か月で最大 $83,500、各分は 4 か月有効" },
    appliesTo: { ko: "사용액 전반", en: "General usage", ja: "利用額全般" },
    note: { ko: "신청으로 금액이 정해져 견적 금액에 넣지 않았습니다", en: "Amount set by application; not included", ja: "申請で金額が決まるため見積額に含めていません" },
  },
  awsActivate: {
    id: "aws-activate", provider: "aws", kind: "program_credit", validUntil: null,
    sourceUrl: "https://aws.amazon.com/startups/credits",
    title: { ko: "AWS Activate (Founders 최대 $5,000)", en: "AWS Activate (Founders up to $5,000)", ja: "AWS Activate (Founders 最大 $5,000)" },
    condition: { ko: "Pre-Series B, 설립 10년 안, Paid 플랜 계정. Portfolio 는 최대 $200,000", en: "Pre-Series B, founded within 10 years, Paid plan account. Portfolio up to $200,000", ja: "Pre-Series B、設立 10 年以内、Paid プランのアカウント。Portfolio は最大 $200,000" },
    appliesTo: { ko: "사용액 전반", en: "General usage", ja: "利用額全般" },
    note: { ko: "심사로 금액이 정해져 견적 금액에 넣지 않았습니다", en: "Amount set by review; not included", ja: "審査で金額が決まるため見積額に含めていません" },
  },
  awsMap: {
    id: "aws-map", provider: "aws", kind: "program_credit", validUntil: null,
    sourceUrl: "https://aws.amazon.com/migration-acceleration-program/terms/",
    title: { ko: "Migration Acceleration Program (MAP)", en: "Migration Acceleration Program (MAP)", ja: "Migration Acceleration Program (MAP)" },
    condition: { ko: "MAP 계약과 이전 계획, 자원에 map-migrated 태그. 계약 뒤 만든 자원만", en: "MAP agreement and migration plan, resources tagged map-migrated, launched after the agreement", ja: "MAP 契約と移行計画、map-migrated タグ、契約後に作ったリソースのみ" },
    appliesTo: { ko: "이전한 자원 사용액", en: "Spend on migrated resources", ja: "移行したリソースの利用額" },
    note: { ko: "금액 기준이 공개되지 않아 견적 금액에 넣지 않았습니다", en: "Amounts are not public; not included", ja: "金額基準が非公開のため見積額に含めていません" },
  },
  awsExit: {
    id: "aws-exit-data-transfer", provider: "aws", kind: "data_transfer_waiver", validUntil: null,
    sourceUrl: "https://aws.amazon.com/blogs/aws/free-data-transfer-out-to-internet-when-moving-out-of-aws/",
    title: { ko: "AWS 를 떠날 때 데이터 전송료 면제", en: "Free data transfer when leaving AWS", ja: "AWS 退出時のデータ転送料免除" },
    condition: { ko: "모든 데이터를 옮기고 지우거나 계정을 닫을 때. 이전 시작 두 달 전에 지원 센터에 요청, 180일 안에 완료", en: "When moving all data off and deleting it or closing the account. Ask Support two months before starting; finish within 180 days", ja: "全データを移して削除するかアカウントを閉じるとき。開始 2 か月前にサポートへ依頼し、180 日以内に完了" },
    appliesTo: { ko: "출발 쪽 일회성 인터넷 전송료 (월 비용 밖)", en: "One-time internet egress at the source (outside the monthly cost)", ja: "出発側の一回限りのインターネット転送料 (月額外)" },
    note: null,
  },
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const zeros = () => Array.from({ length: 12 }, () => 0);

function make(d: Def, lang: Lang, status: CostPromotion["status"], monthly: number[], note?: string | null): CostPromotion {
  return {
    id: d.id, provider: d.provider, title: d.title[lang], kind: d.kind, status,
    condition: d.condition[lang], appliesTo: d.appliesTo[lang],
    firstYearUsd: r2(monthly.reduce((a, b) => a + b, 0)), monthlyUsd: monthly.map(r2),
    validUntil: d.validUntil, sourceUrl: d.sourceUrl, checkedAt: CHECKED,
    note: note === undefined ? (d.note?.[lang] ?? null) : note,
  };
}

/** 정가에서 이미 빠진 금액을 뺀 나머지에 한도 있는 크레딧을 달마다 쓴다 (months 개월 안) */
function spend(limit: number, months: number, left: number[]): number[] {
  const out = zeros();
  let rest = limit;
  for (let m = 0; m < months && rest > 0; m++) {
    const use = Math.min(rest, Math.max(0, left[m]!));
    out[m] = use;
    rest -= use;
  }
  return out;
}

export interface PromoContext {
  target: Provider;
  source?: Provider | undefined;
  breakdown: CostBreakdown;
  /** GKE 무료 등급 대상(존·Autopilot) 클러스터의 관리비 줄 id */
  freeTierClusterLineIds: string[];
  /** 도착 노드 vCPU 합 (GCP 무료 체험 8코어 한도 확인) */
  nodeVcpu: number;
  lang: Lang;
  /** 지금 환경 비용이면 true: 새 계정 크레딧·프로그램은 보이지 않는다 (이미 쓰는 계정) */
  current?: boolean;
}

export function promotionsFor(c: PromoContext): CostPromotion[] {
  const { lang } = c;
  const out: CostPromotion[] = [];
  const monthly = c.breakdown.monthlyUsd;
  const left = Array.from({ length: 12 }, () => monthly);
  if (c.target === "gcp") {
    const fees = c.breakdown.lines.filter((l) => c.freeTierClusterLineIds.includes(l.id)).map((l) => l.monthlyUsd);
    if (fees.length > 0) {
      // 결제 계정당 하나 → 대상 클러스터 하나의 관리비까지 (월 $74.40 한도)
      const per = Math.min(74.4, Math.max(...fees));
      const m = Array.from({ length: 12 }, () => per);
      m.forEach((v, i) => { left[i] = left[i]! - v; });
      out.push(make(DEFS.gkeFree!, lang, "applied", m));
    } else if (c.breakdown.lines.some((l) => l.id.startsWith("cluster:"))) {
      out.push(make(DEFS.gkeFree!, lang, "not_applicable", zeros(),
        { ko: "지역(regional) 클러스터라 대상이 아닙니다", en: "Regional clusters are not eligible", ja: "リージョンクラスターは対象外です" }[lang]));
    }
    if (!c.current) {
      if (c.nodeVcpu > 8) {
        out.push(make(DEFS.gcpTrial!, lang, "not_applicable", zeros(),
          { ko: `노드 vCPU 합 ${c.nodeVcpu}개가 무료 체험 동시 8코어 한도를 넘습니다`, en: `Node vCPUs total ${c.nodeVcpu}, above the trial's 8 concurrent cores`, ja: `ノード vCPU 合計 ${c.nodeVcpu} が無料トライアルの同時 8 コア上限を超えます` }[lang]));
      } else {
        out.push(make(DEFS.gcpTrial!, lang, "conditional", spend(300, 3, left)));
      }
      out.push(make(DEFS.gcpStartups!, lang, "conditional", zeros()));
      out.push(make(DEFS.gcpRamp!, lang, "conditional", zeros()));
    }
  }
  if (c.target === "aws" && !c.current) {
    out.push(make(DEFS.awsFreeTier!, lang, "conditional", spend(100, 12, left)));
    out.push(make(DEFS.awsLift!, lang, "conditional", zeros()));
    out.push(make(DEFS.awsActivate!, lang, "conditional", zeros()));
    out.push(make(DEFS.awsMap!, lang, "conditional", zeros()));
  }
  // 출발 쪽을 떠날 때의 면제 (도착 월 비용과 별개, 금액 0 으로 알리기만)
  if (!c.current && c.source && c.source !== c.target) {
    if (c.source === "aws") out.push(make(DEFS.awsExit!, lang, "conditional", zeros()));
    if (c.source === "gcp") out.push(make(DEFS.gcpExit!, lang, "conditional", zeros()));
  }
  return out;
}

/** 한 달·1년 금액. applied 는 늘 빼고, conditional 은 "조건 충족 시" 금액에만 뺀다 */
export function projectionOf(b: CostBreakdown, promotions: CostPromotion[]): CostProjection {
  const yearly = b.monthlyUsd * 12;
  const sum = (s: CostPromotion["status"]) => promotions.filter((p) => p.status === s).reduce((a, p) => a + p.firstYearUsd, 0);
  const lastMonthApplied = promotions.filter((p) => p.status === "applied").reduce((a, p) => a + (p.monthlyUsd[11] ?? 0), 0);
  const applied = sum("applied");
  return {
    monthlyUsd: r2(b.monthlyUsd), yearlyUsd: r2(yearly),
    appliedYearlyUsd: r2(yearly - applied),
    conditionalYearlyUsd: r2(yearly - applied - sum("conditional")),
    appliedMonthlyUsd: r2(b.monthlyUsd - lastMonthApplied),
    promotions,
  };
}

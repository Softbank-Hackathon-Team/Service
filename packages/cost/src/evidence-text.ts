// 비용 근거 문장 (한국어 원문 + 영어·일본어). 화면이 고른 언어로 API 가 문장을 만들어 준다 (GET ...?lang=ja).
// 웹 i18n 표는 고정 문장만 바꿀 수 있어, 숫자·자원 이름이 섞인 근거 문장은 서버가 언어별로 만든다.
// 자리 {이름} 은 fill() 이 채운다.

export const LANGS = ["ko", "en", "ja"] as const;
export type Lang = (typeof LANGS)[number];
export const asLang = (x: unknown): Lang => (LANGS as readonly unknown[]).includes(x) ? (x as Lang) : "ko";

type Entry = Record<Lang, string>;

const T = {
  // ---- 항 이름 ----
  eks: { ko: "EKS 클러스터 관리비 · {name}", en: "EKS cluster fee · {name}", ja: "EKS クラスター管理料金 · {name}" },
  gke: { ko: "GKE 클러스터 관리비 · {name}", en: "GKE cluster fee · {name}", ja: "GKE クラスター管理料金 · {name}" },
  k3s: { ko: "k3s 클러스터 (관리비 없음)", en: "k3s cluster (no fee)", ja: "k3s クラスター (管理料金なし)" },
  node: { ko: "{cluster} 노드 {type}", en: "{cluster} node {type}", ja: "{cluster} ノード {type}" },
  vm: { ko: "VM {type}", en: "VM {type}", ja: "VM {type}" },
  nodeDisk: { ko: "노드 디스크 · {type}", en: "Node disk · {type}", ja: "ノードディスク · {type}" },
  db: { ko: "{product} {cls} · {name}", en: "{product} {cls} · {name}", ja: "{product} {cls} · {name}" },
  dbVcpu: { ko: "{product} vCPU · {name}", en: "{product} vCPU · {name}", ja: "{product} vCPU · {name}" },
  dbMem: { ko: "{product} 메모리 · {name}", en: "{product} memory · {name}", ja: "{product} メモリ · {name}" },
  dbStorage: { ko: "DB 저장 공간 · {name}", en: "DB storage · {name}", ja: "DB ストレージ · {name}" },
  alb: { ko: "Application Load Balancer", en: "Application Load Balancer", ja: "Application Load Balancer" },
  fwd: { ko: "부하 분산 포워딩 규칙", en: "Load balancing forwarding rules", ja: "負荷分散転送ルール" },
  natAws: { ko: "NAT 게이트웨이", en: "NAT gateway", ja: "NAT ゲートウェイ" },
  natGcp: { ko: "Cloud NAT 게이트웨이", en: "Cloud NAT gateway", ja: "Cloud NAT ゲートウェイ" },
  ipInUse: { ko: "공인 IPv4 주소", en: "Public IPv4 addresses", ja: "パブリック IPv4 アドレス" },
  ipIdle: { ko: "쓰지 않는 고정 공인 주소", en: "Unused static public addresses", ja: "未使用の静的パブリックアドレス" },
  onpremServer: { ko: "서버 감가", en: "Server depreciation", ja: "サーバー減価償却" },
  onpremPower: { ko: "전기 (냉각 포함)", en: "Power (incl. cooling)", ja: "電力 (冷却込み)" },
  onpremSpace: { ko: "상면 (랙 공간)", en: "Colocation (rack space)", ja: "ラックスペース" },
  // ---- 단위 ----
  uMachines: { ko: "대", en: " machines", ja: "台" },
  uCount: { ko: "개", en: "", ja: "個" },
  uVm: { ko: " VM", en: " VMs", ja: " VM" },
  uVcpu: { ko: " vCPU", en: " vCPU", ja: " vCPU" },
  uGib: { ko: " GiB", en: " GiB", ja: " GiB" },
  uServers: { ko: "대", en: " servers", ja: "台" },
  perHour: { ko: "/시간", en: "/h", ja: "/時間" },
  hours: { ko: "{h}시간", en: "{h} h", ja: "{h}時間" },
  perMonth: { ko: "/월", en: "/mo", ja: "/月" },
  perGbMonth: { ko: "/GB·월", en: "/GB-mo", ja: "/GB·月" },
  haDouble: { ko: "2 (다중 영역)", en: "2 (multi-zone)", ja: "2 (マルチゾーン)" },
  // ---- 수량 근거 ----
  bInstances: { ko: "실자원 조회(ec2 describe-instances)에서 {type} {n}대가 실행 중", en: "Inventory (ec2 describe-instances): {n} running {type}", ja: "実リソース照会 (ec2 describe-instances): {type} が {n} 台稼働中" },
  bGceInstances: { ko: "실자원 조회(compute instances list)에서 {type} {n}대가 실행 중", en: "Inventory (compute instances list): {n} running {type}", ja: "実リソース照会 (compute instances list): {type} が {n} 台稼働中" },
  bGkePool: { ko: "GKE 클러스터 {cluster} 의 노드 {n}대, 노드 풀 머신 {type} (인스턴스 목록을 못 읽어 클러스터 정보로 셈)", en: "GKE cluster {cluster}: {n} nodes of {type} (counted from cluster info; instance list unavailable)", ja: "GKE クラスター {cluster}: {type} ノード {n} 台 (インスタンス一覧が読めずクラスター情報から算出)" },
  bClusters: { ko: "실자원 조회에서 클러스터 {n}개", en: "Inventory: {n} cluster(s)", ja: "実リソース照会: クラスター {n} 個" },
  bDb: { ko: "실자원 조회에서 {cls}, 저장 공간 {gb} GB{ha}", en: "Inventory: {cls}, {gb} GB storage{ha}", ja: "実リソース照会: {cls}, ストレージ {gb} GB{ha}" },
  bDbHa: { ko: ", 다중 영역", en: ", multi-zone", ja: ", マルチゾーン" },
  bLb: { ko: "실자원 조회에서 {n}개", en: "Inventory: {n}", ja: "実リソース照会: {n} 個" },
  bNat: { ko: "실자원 조회에서 NAT {n}개", en: "Inventory: {n} NAT gateway(s)", ja: "実リソース照会: NAT {n} 個" },
  bGcpNat: { ko: "Cloud NAT {nats}개 뒤의 VM {n}대 (32대부터 고정 요금)", en: "{n} VMs behind {nats} Cloud NAT gateway(s) (flat fee from 32)", ja: "Cloud NAT {nats} 個の背後の VM {n} 台 (32 台以上は定額)" },
  bIps: { ko: "인스턴스·고정 주소·NAT 의 공인 주소 {a}개 + 공개 로드 밸런서의 영역별 주소 {b}개", en: "{a} public addresses on instances, static IPs and NAT + {b} per-zone addresses of public load balancers", ja: "インスタンス・静的IP・NAT のパブリックアドレス {a} 個 + 公開ロードバランサーのゾーン別アドレス {b} 個" },
  bIdle: { ko: "고정 주소 중 붙은 곳이 없는 {n}개", en: "{n} static addresses attached to nothing", ja: "どこにも割り当てられていない静的アドレス {n} 個" },
  bNodeDiskAws: { ko: "EKS 관리형 노드 그룹 기본 디스크 20 GiB x 노드 {n}대 (디스크 크기는 읽지 않음, 문서 기본값)", en: "EKS managed node group default disk 20 GiB x {n} nodes (size not read; documented default)", ja: "EKS マネージドノードグループの既定ディスク 20 GiB x ノード {n} 台 (サイズは未取得、ドキュメントの既定値)" },
  bNodeDiskGcp: { ko: "GKE 노드 기본 부팅 디스크 100 GB(pd-balanced) x 노드 {n}대 (문서 기본값)", en: "GKE node default boot disk 100 GB (pd-balanced) x {n} nodes (documented default)", ja: "GKE ノード既定ブートディスク 100 GB (pd-balanced) x ノード {n} 台 (ドキュメントの既定値)" },
  bOnpremServers: { ko: "서버 {n}대 (서버 1대 = {vcpu} 스레드·{mem} GiB 가정)", en: "{n} server(s) (1 server = {vcpu} threads, {mem} GiB, assumed)", ja: "サーバー {n} 台 (1 台 = {vcpu} スレッド・{mem} GiB と仮定)" },
  bOnpremAgent: { ko: "Agent 보고에 서버 사양이 없어 서버 1대로 셈", en: "Agent reports carry no server specs; counted as 1 server", ja: "Agent 報告にサーバー仕様がないため 1 台で算出" },
  // ---- 도착 대응 근거 ----
  mNode: { ko: "출발 {from} {n}대와 같은 크기 이상({vcpu} vCPU·{mem} GiB) 중 가장 싼 {to}", en: "Cheapest {to} with at least the size of source {from} ({vcpu} vCPU, {mem} GiB), {n} machines", ja: "出発 {from} {n} 台以上のサイズ ({vcpu} vCPU・{mem} GiB) で最安の {to}" },
  mNodeDefault: { ko: "출발 노드 크기를 몰라 플랫폼 환경 층의 기본 노드({to} x {n})로 셈", en: "Source node size unknown; uses the platform environment default ({to} x {n})", ja: "出発ノードのサイズ不明のため、プラットフォーム既定ノード ({to} x {n}) で算出" },
  mDb: { ko: "출발 DB {from}({vcpu} vCPU·{mem} GiB) 이상 중 가장 싼 {to}", en: "Cheapest {to} at least the size of source DB {from} ({vcpu} vCPU, {mem} GiB)", ja: "出発 DB {from} ({vcpu} vCPU・{mem} GiB) 以上で最安の {to}" },
  mDbDefault: { ko: "출발 DB 크기를 몰라 플랫폼 기본 등급({to})으로 셈", en: "Source DB size unknown; uses the platform default class ({to})", ja: "出発 DB のサイズ不明のため、プラットフォーム既定クラス ({to}) で算出" },
  mDbDefaultGcp: { ko: "출발 DB 크기를 몰라 Cloud SQL 전용 코어 최소 크기(1 vCPU·3.75 GiB)로 셈. 플랫폼 기본 db-f1-micro(공유 코어)는 서울 단가를 확인하지 못함", en: "Source DB size unknown; uses the smallest dedicated Cloud SQL size (1 vCPU, 3.75 GiB). The platform default db-f1-micro (shared core) has no confirmed Seoul price", ja: "出発 DB のサイズ不明のため Cloud SQL 専用コア最小 (1 vCPU・3.75 GiB) で算出。既定の db-f1-micro (共有コア) はソウル単価未確認" },
  mDbCnpg: { ko: "온프레는 클러스터 안 CloudNativePG 로 돌아 서버 비용에 들어감", en: "On-prem runs it as CloudNativePG inside the cluster, covered by server cost", ja: "オンプレではクラスター内 CloudNativePG で動き、サーバー費用に含まれる" },
  mCluster: { ko: "도착에 관리형 클러스터 1개 (플랫폼 환경 층: {where})", en: "One managed cluster at the target (platform environment layer: {where})", ja: "到着側にマネージドクラスター 1 個 (プラットフォーム環境レイヤー: {where})" },
  mLb: { ko: "도착은 Cloudflare 터널(cloudflared)로 들어와 클라우드 로드 밸런서를 만들지 않음", en: "Traffic enters the target via Cloudflare Tunnel (cloudflared); no cloud load balancer is created", ja: "到着側は Cloudflare Tunnel (cloudflared) 経由で受けるため、クラウドのロードバランサーは作らない" },
  mNat: { ko: "플랫폼 환경 층({where})이 사설 노드용 NAT 1개와 고정 공인 주소 1개를 만듦", en: "The platform environment layer ({where}) creates one NAT and one static public address for private nodes", ja: "プラットフォーム環境レイヤー ({where}) がプライベートノード用に NAT 1 個と静的パブリックアドレス 1 個を作る" },
  mOnprem: { ko: "출발 노드 vCPU 합 {vcpu}·메모리 합 {mem} GiB 를 서버 {n}대에 올림", en: "Source nodes total {vcpu} vCPU and {mem} GiB, placed on {n} server(s)", ja: "出発ノードの vCPU 合計 {vcpu}・メモリ合計 {mem} GiB をサーバー {n} 台に配置" },
  // ---- 합계에서 뺀 것 ----
  gEgress: { ko: "인터넷 전송량", en: "Internet data transfer", ja: "インターネット転送量" },
  gEgressWhy: { ko: "실제 전송량(GB)을 읽지 않아 뺐습니다. 서울 단가: AWS $0.126/GB(월 100GB 무료), GCP Premium $0.19/GiB", en: "Actual transfer (GB) is not read. Seoul rates: AWS $0.126/GB (first 100 GB/mo free), GCP Premium $0.19/GiB", ja: "実際の転送量 (GB) を読んでいないため除外。ソウル単価: AWS $0.126/GB (月 100GB 無料)、GCP Premium $0.19/GiB" },
  gNatData: { ko: "NAT 처리량", en: "NAT data processing", ja: "NAT 処理量" },
  gNatDataWhy: { ko: "처리 GB 를 읽지 않아 뺐습니다 (AWS $0.059/GB, GCP $0.045/GiB)", en: "Processed GB is not read (AWS $0.059/GB, GCP $0.045/GiB)", ja: "処理量 (GB) を読んでいないため除外 (AWS $0.059/GB、GCP $0.045/GiB)" },
  gLcu: { ko: "로드 밸런서 처리 단위(LCU)", en: "Load balancer capacity units (LCU)", ja: "ロードバランサー処理単位 (LCU)" },
  gLcuWhy: { ko: "사용량을 읽지 않아 뺐습니다. 최소 1 LCU 면 ALB 1개당 월 약 $5.84", en: "Usage is not read. At 1 LCU it is about $5.84/mo per ALB", ja: "使用量を読んでいないため除外。最小 1 LCU なら ALB 1 個あたり月約 $5.84" },
  gNoPrice: { ko: "{what}", en: "{what}", ja: "{what}" },
  gNoPriceWhy: { ko: "가격표에 {sku} 단가가 없어 뺐습니다 (지어내지 않음)", en: "No price for {sku} in the price list; left out (not guessed)", ja: "価格表に {sku} の単価がないため除外 (推測しない)" },
  gSpot: { ko: "스팟 인스턴스 {type} {n}대", en: "{n} spot {type}", ja: "スポットインスタンス {type} {n} 台" },
  gSpotWhy: { ko: "스팟 가격은 시세라 뺐습니다. 정가면 월 약 ${usd}", en: "Spot price floats; left out. At on-demand it is about ${usd}/mo", ja: "スポット価格は変動するため除外。オンデマンドなら月約 ${usd}" },
  gAutopilot: { ko: "Autopilot 파드 요금 · {name}", en: "Autopilot pod charges · {name}", ja: "Autopilot Pod 料金 · {name}" },
  gAutopilotWhy: { ko: "Autopilot 은 파드 요청량으로 청구하는데 요청량을 읽지 않아 뺐습니다", en: "Autopilot bills pod requests, which are not read", ja: "Autopilot は Pod リクエスト量で課金されるが、リクエスト量を読んでいないため除外" },
  gStandaloneDisk: { ko: "클러스터 밖 VM 디스크", en: "Disks of VMs outside clusters", ja: "クラスター外 VM のディスク" },
  gStandaloneDiskWhy: { ko: "디스크 크기를 읽지 않아 뺐습니다", en: "Disk sizes are not read", ja: "ディスクサイズを読んでいないため除外" },
  gOnpremLine: { ko: "회선 (1 Gbps)", en: "Network line (1 Gbps)", ja: "回線 (1 Gbps)" },
  gOnpremOps: { ko: "운영 인력 (0.25명)", en: "Operations staff (0.25 FTE)", ja: "運用人員 (0.25 人)" },
  gOnpremWhy: { ko: "회사마다 크게 달라 합계에서 뺐습니다 (가정값)", en: "Varies widely by company; left out of the total (assumed value)", ja: "会社ごとの差が大きいため合計から除外 (仮定値)" },
  gRegion: { ko: "리전 {region}", en: "Region {region}", ja: "リージョン {region}" },
  gRegionWhy: { ko: "가격표에 {region} 값이 없어 서울 단가로 셌습니다", en: "No prices for {region}; Seoul prices used", ja: "{region} の価格がないためソウル単価で算出" },
  // ---- 상태·이유 ----
  rNoInventory: { ko: "실자원을 아직 읽지 않았습니다", en: "Resources have not been read yet", ja: "実リソースをまだ読んでいません" },
  rPartial: { ko: "일부 자원을 읽지 못해 실제보다 낮을 수 있습니다: {what}", en: "Some resources could not be read, so this may be low: {what}", ja: "一部のリソースが読めず、実際より低い可能性があります: {what}" },
  rNoBilling: { ko: "비용 계산용 정보가 없는 예전 조회 결과입니다. 다시 읽으면 채워집니다", en: "This inventory predates cost facts; it fills in on the next read", ja: "費用計算用の情報がない古い照会結果です。再読み込みで埋まります" },
  rAzure: { ko: "Azure 는 모의 환경이라 비용을 세지 않습니다", en: "Azure is a mock environment; cost is not computed", ja: "Azure はモック環境のため費用を計算しません" },
  rOnpremCapacity: { ko: "서버 {n}대가 필요합니다 (가정 서버 사양 기준)", en: "Needs {n} servers (assumed server spec)", ja: "サーバー {n} 台が必要です (仮定のサーバー仕様)" },
  sNamespaces: { ko: "네임스페이스로는 노드를 나눌 수 없어 클러스터 노드 전체로 셌습니다", en: "Nodes cannot be split by namespace; all cluster nodes are counted", ja: "ネームスペース単位ではノードを分けられないため、クラスターの全ノードで算出" },
  sStandalone: { ko: "클러스터에 속하지 않은 VM {n}대는 옮길 범위에서 뺐습니다", en: "{n} VM(s) outside clusters are excluded from the move", ja: "クラスターに属さない VM {n} 台は移行範囲から除外" },
} satisfies Record<string, Entry>;

export type TextKey = keyof typeof T;

export function fill(lang: Lang, key: TextKey, p: Record<string, string | number> = {}): string {
  return T[key][lang].replace(/\{(\w+)\}/g, (all, k: string) => (k in p ? String(p[k]) : all));
}

/** $0.052 · $0.10 · $73.00 · $1,234.50 처럼. 1 달러 아래는 유효 숫자 3개 (소수 둘째 자리까지는 채움) */
export function usdText(x: number): string {
  if (x === 0) return "$0";
  if (Math.abs(x) < 1) return `$${Number(x.toPrecision(3)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

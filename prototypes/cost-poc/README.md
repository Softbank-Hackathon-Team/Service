# cost-poc (비용 알고리즘 POC)

상태: AI 초안 (팀 검토 전). 플랫폼에 붙이기 전에 로직을 검증하는 코드다. 레포의 npm workspace 밖에 있어 기존 빌드와 시험에 영향을 주지 않고, 이 폴더 안에서 따로 설치한다. 결과 보고서는 Notion의 "비용 알고리즘 POC 구현" 카드에 있다.

| 항목 | 내용 |
|---|---|
| 목적 | 측정으로 얻는 자원 함수 r_v와 벤더별 가격 함수 C_v를 분리·합성해 "어떤 트래픽에서 어느 벤더가 유리한지, 역전점은 어디인지, 옮길 가치가 있는지"를 숫자로 낸다 |
| 받는 것 | `ResourceProfile`(공통 입력), `VendorPricing[]`, `Sizing`, `Traffic`, 제약, 출발 벤더, 일회성 비용 파라미터 |
| 넘기는 것 | `KrossEstimate`: 벤더별 월 비용·범위·분해, 역전점(실제 C / 근사 C̃), 최저 벤더 구간, 비용 기울기, 이전 판단(옮기세요·옮기지 마세요·근거 부족) |
| 부작용 | 계산 코어(`src/core`)는 없음. 네트워크는 `src/collect`만, 도커는 `measure/`만 쓴다 |
| 계산과 AI | 계산은 코드가 한다. AI는 이 코드에 들어 있지 않다 |

## 실행

Node 22. 네트워크 없이 끝나는 명령은 `test`, `run-all`, `charts`다.

```bash
npm install
npm test                # node:test + tsx
npm run typecheck
npm run run-all         # data/ → outputs/results.json, 콘솔 요약
python3 -m venv .venv && .venv/bin/pip install matplotlib   # 그림용, 한 번만
npm run charts          # outputs/*.png(맥 글꼴 사용), outputs/summary.html
```

가격을 다시 모으거나 다시 잴 때만:

```bash
npm run collect                 # data/prices/*.json. 공개 소스만, 자격 증명 없음. EC2 CSV 200MB 이상 스트리밍
SHOP_DIR=<examples/shop 사본> NODE=<node22> npm run measure   # 로컬 도커. 약 30분
bash scripts/sync-team.sh       # vendor/team을 origin/main으로 다시 고정
```

- GCP Cloud SQL·송신·GKE 값은 공식 페이지에서 지역을 서울로 고른 뒤 옮겨 적은 `data/prices/gcp-official-transcript.json`을 읽는다. 키 없이 받을 수 있는 공식 API가 없어서다. 가격이 바뀌면 이 파일을 손으로 고친다.

## 입력 형식

카드 초안에 선택 칸을 더했다. 앞 다섯 칸만 있어도 돈다.

```ts
ResourceProfile {
  source: "price-only" | "sample" | "observed" | "measured",
  points: [{ lambda, cpu, memGiB, egressGBh, storageGB,      // 필수
             gpu?, dbCpu?, dbMemGiB?, p95Ms?, errorRate? }], // 선택
  storageGrowthGBPerRequest?: number,                        // 스토리지 누적 r_m(t)
}
```

- `cpu`, `memGiB`는 앱 계층 사용량이고 여유분을 넣지 않은 값이다. 여유분은 `Sizing.targetUtil`이 입힌다.
- `lambda`는 순증가해야 한다. 어기면 parse 실패.
- 갈래를 고르는 일은 `layerProfiles({ priceOnly, sample, observed, measured })`가 한다. 우선순위는 `src/core/layering.ts` 맨 위 주석.

## 파일

- `src/core/` 순수 계산: `cost.ts`(C_v, C̃_v), `resource.ts`(r_v, 회귀), `gradient.ts`(∂Cost/∂λ), `crossover.ts`(λ*), `monthly.ts`(월 적분), `layering.ts`(세 갈래), `decide.ts`(회수 기간), `overlay.ts`(보안 프로필), `estimate.ts`(진입점), `types.ts`(Zod 계약)
- `src/collect/` 수집: AWS Price List Bulk, Azure Retail Prices API, GCP(2차 자료 + 공식 페이지 옮겨 적기), 온프레 가정
- `src/match.ts` 비슷한 사양 매칭 규칙과 할당 가능량 공식. 규칙과 한계는 파일 맨 위 주석
- `src/adapter/team.ts` 팀 계약(`CostEstimateRequest`, `CostEstimate`, `PriceCatalog`)과의 어댑터
- `src/measure-parse.ts`, `measure/` 로컬 측정과 원자료 해석
- `scripts/run-all.ts` 세 갈래, 역전점, 사례, 민감도, 팀 대조 → `outputs/results.json`
- `vendor/team/` 팀 코드 고정 사본(`COMMIT` 파일의 커밋). `packages/contracts`, `packages/cost`만
- `data/prices/*.json` 수집 결과. 줄마다 `evidence`, `sourceUrl`, `sourceDetail`, `fetchedAt`
- `data/measure/stages.jsonl` 단계별 원자료, `env.txt` 측정 환경
- `data/integration/` 팀 API 경로에 어댑터를 끼운 스크래치 검증의 시험 파일과 결과
- `outputs/results.json`, `outputs/run-all.log`, `outputs/*.png`, `outputs/summary.html` 결과물
- 완료 보고서: https://app.notion.com/p/40a8bee9ada481e7a7a5d760f794c623

## 한계

요약만 적는다. 수치는 `outputs/results.json`과 `outputs/run-all.log`.

- 측정은 로컬 도커(Apple M3 Pro)다. 클라우드에서 재지 않았다. CPU는 가정 배수 2.5를 곱했다.
- 앱 복제본 1개, 합성 부하, 데이터 26만 행. 운영 데이터가 아니다.
- 단일 노드 풀만 다룬다. 노드 종류는 한 달 동안 하나로 고정한다. 다중 노드 풀은 범위 밖이다.
- VM, Postgres 외 DB, GPU 가격 수집은 범위 밖이다. GPU는 식과 시험만 있다.
- 벤더별 p95 차이는 재지 않았다. `vendorSlo`로 넣을 자리만 있다.
- 온프레 값은 전부 가정이다.

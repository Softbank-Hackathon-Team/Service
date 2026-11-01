# 이전 증적 리포트

상태: 자동 생성 | 리포트 지문 `46312132121986c1` | 생성 2026-10-31T16:29:21.706Z

- 이전: `49c3152c-0045-48fa-8b64-352fe25505e2`
- 경로: aws(report-aws) → gcp(report-gcp)
- 현재 상태: **completed**
- 총 소요: 8.13초, 상태 전이 14번, 컷오버 도달 예, 롤백 없음
- 감사 기록 무결성: 통과 (감사 539줄의 지문을 다시 계산해 모두 일치)

## 1. 측정값

| 이름 | 값 | 단위 | 환경 | 시각 |
|---|---:|---|---|---|
| replication_lag_ms | 120 | ms | target | 2026-10-31T16:29:16.582Z |
| cutover_pause_ms | 850 | ms | target | 2026-10-31T16:29:18.085Z |

트래픽 판정 3번, 지나간 가중치 10→50→100%, 나쁨 판정 0번, 도착 쪽 최대 오류율 0%, 최대 p95 80ms.

## 2. 상태 전이 시간표

| seq | 시각 | 전이 | 누가 | 앞 상태 머문 ms |
|---:|---|---|---|---:|
| 588 | 2026-10-31T16:29:13.486Z | draft → importing | user:dev | - |
| 591 | 2026-10-31T16:29:13.884Z | importing → spec_review | worker | 398 |
| 592 | 2026-10-31T16:29:13.941Z | spec_review → prechecking | user:dev | 57 |
| 594 | 2026-10-31T16:29:14.582Z | prechecking → planning | worker | 641 |
| 596 | 2026-10-31T16:29:15.092Z | planning → awaiting_approval | worker | 510 |
| 599 | 2026-10-31T16:29:15.117Z | awaiting_approval → approved | user:dev | 25 |
| 600 | 2026-10-31T16:29:15.141Z | approved → provisioning | user:dev | 24 |
| 604 | 2026-10-31T16:29:15.587Z | provisioning → deploying | worker | 446 |
| 609 | 2026-10-31T16:29:16.085Z | deploying → syncing | worker | 498 |
| 613 | 2026-10-31T16:29:16.584Z | syncing → shifting | worker | 499 |
| 623 | 2026-10-31T16:29:17.485Z | shifting → cutover | worker | 901 |
| 625 | 2026-10-31T16:29:18.085Z | cutover → rollback_window | worker | 600 |
| 627 | 2026-10-31T16:29:21.389Z | rollback_window → cleanup | worker | 3304 |
| 630 | 2026-10-31T16:29:21.611Z | cleanup → completed | worker | 222 |

## 3. 승인

| 계획 | 결정 | 누가 | 시각 | 본 지문 = 저장 지문 |
|---|---|---|---|---|
| `1bf3466b` | approve | user:dev | 2026-10-31T16:29:15.117Z | 일치 |

## 4. 사전 점검

- [info] PC-01: STUB: 출발·도착 환경 연결 확인됨
- [info] PC-02: STUB: 실행 역할 권한 확인됨

## 5. 비용 비교 (월, USD)

비용 추정 없음.

## 6. 거부·오류 기록

없음.

## 7. 비어 있는 것

- 비용 추정 없음
- 일부 단계 결과가 STUB(가짜 구현) 값

## 검증 방법

감사 줄마다 sha256(정렬한 JSON(actor, action, target, result, detail, tenantId, prevHash))를 다시 계산해 저장된 hash와 비교하고, 다음 줄의 prevHash가 앞 줄 hash와 같은지 본다. 첫 줄의 prevHash는 "genesis"다.

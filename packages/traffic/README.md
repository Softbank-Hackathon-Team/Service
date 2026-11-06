# @svc/traffic (5번 트래픽 전환·자동 롤백)

상태: AI 초안 (팀 검토 전). 전환기 3종 진짜 구현(요청 모양 시험 고정) + Mock, 지표는 Prometheus 진짜 구현 + STUB

| 항목 | 내용 |
|---|---|
| 목적 | 도착 비율을 10→50→100%로 올리고, 지표가 나쁘면 출발 100%로 되돌린다. 결과를 상태 머신 한 칸으로 바꾼다 |
| 받는 것 | 이전 번호, LB 번호, `TrafficSwitcher`(Cloudflare·GCLB·ALB·Mock), `MetricsSource`(Prometheus·STUB), 판정 기준(워커는 승인 계획 `rollbackCriteria` 를 `ruleFromCriteria` 로 바꿔 넘긴다), `shouldPause` |
| 넘기는 것 | `ShiftResult`(reached_100 / rolled_back / rollback_failed / paused), 판정마다 `TrafficJudgement`, `shiftTransition()` → `{to, evidence, enqueue, failureCode}`, `restoreSource()` → T35 증거 |
| 부작용 | 전환기 `set()`(제공자 API PATCH), 지표 GET. DB·`advance()`·감사는 부르는 워커가 한다 |
| 실패 코드 | `INVALID_WEIGHTS`, `TRAFFIC_SWITCH_FAILED`(3번 재시도 후), `TRAFFIC_PROVIDER_ERROR`. 결과 failureCode: `TRAFFIC_ERROR_RATE`, `TRAFFIC_LATENCY`, `TRAFFIC_INSUFFICIENT_SAMPLES`, `TRAFFIC_PAUSED` |

## 상태 머신과 맞물리는 곳

| 상태 이동 | 이 패키지가 주는 것 | core 전이 조건 |
|---|---|---|
| shifting → cutover | `weightPct: 100`, `observedSec`(100%에서 정상 판정 수 × 1초), `targetLogsSeen` | T22 |
| shifting → rolling_back | 긴급 되돌림(PATCH+GET) 뒤 `enqueue: "rollback"` | 없음 |
| shifting → paused | 밖에서 상태가 바뀌면 그 자리에서 멈춤, 가중치 유지 | T30 |
| paused → shifting | `resumeFromPct` 로 멈춘 비율부터 다시 (10%로 안 내림) | T31 |
| rolling_back → rolled_back | `restoreSource()`: 출발 100% 확인(이미 됐으면 PATCH 안 함), 출발 5xx ≤ 1% | T35 |

## 파일

- `rule.ts` 판정 함수(그대로). `Side.p95Ms` 가 있으면 그 값을 쓴다(Prometheus)
- `controller.ts` `runShift`: 단계마다 `setAndVerify`(바꾸고 다시 읽어 확인, 3번), 일시정지, 재개, 되돌리기 실패 시 `rollback_failed`
- `state.ts` `shiftTransition`, `restoreSource`, `TRAFFIC_ACTIVE_STATES`
- `providers/cloudflare.ts` 기본. `/zones/{zone}/load_balancers/{lb}` PATCH, `random_steering.pool_weights`, 전환 전 `cloudflarePreflight`(proxied, 쿠키 고정 없음, fallback=출발)
- `providers/gcp-gclb.ts` URL map `defaultRouteAction.weightedBackendServices`, fingerprint 잠금, 전역 작업 DONE 대기
- `providers/aws-alb.ts` 리스너 ForwardConfig 가중치, 고정 세션 끔. SDK 연결은 STUB(`AlbApi` 주입)
- `providers/mock.ts` 메모리 LB + 실패 주입(set 실패, 옛 값 읽기)
- `providers/index.ts` `switcherFromEnv`(기본 mock. 워커는 흉내를 허락한 판(MOCK_IAC=1·MOCK_TRAFFIC=1)이 아니면 mock 전환기·가짜 지표로 shift 하지 않고 `TRAFFIC_NOT_CONFIGURED` 로 멈춘다). 트래픽 전환은 임시 역할이 아니라 전역 CLOUDFLARE_API_TOKEN 으로 돈다 (apps/worker platform.ts trafficSwitcher). 토큰 범위: 워커(전환·롤백)는 Zone · Load Balancers: Edit 하나, 검증 스크립트(자원 생성)는 + Account · Load Balancing: Monitors and Pools: Edit
- `metrics.ts` `prometheusMetrics`(PromQL 3줄 × 2쪽, 이전 번호 UUID 검사로 주입 방지), `stubMetrics`

```bash
npm run typecheck && node --import tsx --test packages/traffic/test/*.test.ts   # 기대: pass 26, fail 0
```

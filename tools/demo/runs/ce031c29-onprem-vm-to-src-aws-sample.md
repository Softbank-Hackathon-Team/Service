# 이전 ce031c29: onprem-vm (onprem) → src-aws-sample (aws)

- 상태: **completed**
- 전체 43분 00초 = 자동 26분 33초 + 사람 대기 1분 15초 + 멈춤 13분 11초 + 고정 대기(롤백 창) 2분 00초
- **멈춤·사람 대기를 뺀 순수 소요(자동 + 고정)**: 28분 33초

| 단계 | 시작(KST) | 걸린 시간 | 구분 | 비고 |
|---|---|---|---|---|
| 가져오기 | 12:40:16 | 0초 | 자동 |  |
| 명세 확정 대기 | 12:40:16 | 19초 | 사람 |  |
| 사전 점검 | 12:40:35 | 1분 05초 | 자동 |  |
| 계획 만들기 | 12:41:40 | 4초 | 자동 |  |
| 계획 승인 대기 | 12:41:44 | 56초 | 사람 |  |
| 승인됨 | 12:42:40 | 0초 | 자동 |  |
| 자원 생성 | 12:42:40 | 7분 52초 | 자동 |  |
| 앱 배포 | 12:50:32 | 2초 | 자동 |  |
| 멈춤 | 12:50:34 | 23초 | 멈춤 | SECRET_VALUES_MISSING |
| 앱 배포 | 12:50:57 | 1분 48초 | 자동 |  |
| 멈춤 | 12:52:45 | 11분 20초 | 멈춤 | GITOPS_VALIDATE_FAILED |
| 앱 배포 | 13:04:05 | 10분 07초 | 자동 |  |
| 멈춤 | 13:14:12 | 1분 28초 | 멈춤 | ARGO_TIMEOUT |
| 앱 배포 | 13:15:41 | 3분 01초 | 자동 |  |
| DB 복제 | 13:18:42 | 3초 | 자동 |  |
| 트래픽 이동 | 13:18:45 | 1분 43초 | 자동 |  |
| DB 컷오버 | 13:20:28 | 1초 | 자동 |  |
| 롤백 대기 | 13:20:29 | 2분 00초 | 고정 |  |
| 정리 | 13:22:29 | 46초 | 자동 |  |

## 안쪽

- **자원 생성 7분 52초** = terraform 7분 08초 (init 11초 · plan 9초 · apply 6분 29초 · output 13초 · secret 3초 · secret 4초) + 그 밖(중계기 EC2 등) 약 44초 (추정: 차이로 계산)
- **앱 배포 14분 59초** (시도 4번: 2초, 1분 48초, 10분 07초, 3분 01초)
  - 12:50:34 멈춤 SECRET_VALUES_MISSING
  - 12:51:03 리허설 queued → 60초 뒤 다시 확인 (폴링 대기)
  - 12:52:05 리허설 running → 60초 뒤 다시 확인 (폴링 대기)
  - 12:52:42 리허설 passed: apply 5초 · check 1분 10초 · create 21초 · delete 1초 (합 1분 37초)
  - 12:52:45 멈춤 GITOPS_VALIDATE_FAILED
  - 13:14:12 멈춤 ARGO_TIMEOUT
  - 배포 확인 결과: synced_healthy
- **트래픽 이동**: 제공자 mock, 흉내=예 (실제 사용자 트래픽은 안 옮김), 단계 10% → 50% → 100%, 단계마다 30초 유지, 100% 관측 30초
- **DB 복제 측정값**: replication_lag_ms 3.1ms · initial_copy_ms 484ms
- **DB 컷오버 측정값**: cutover_pause_ms 106.2ms · apply_worker_wait_ms 3ms · fence_terminated_sessions 1count · sequences_synced 1count · reverse_apply_grants 6count · c1_pause_ms 0.2ms · c2_fence_ms 24.5ms · c3_catchup_ms 51.7ms · c4_sequences_ms 6.1ms · c5_slots_ms 23.9ms · c5b_unfence_ms 0ms · c6_resume_ms 0ms · reverse_subscribed_ms 349.4ms · forward_slot_dropped_ms 38.7ms
- **정리 결과**: 남은 자원 []

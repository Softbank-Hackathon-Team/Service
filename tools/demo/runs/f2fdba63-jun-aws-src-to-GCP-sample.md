# 이전 f2fdba63: jun-aws-src (aws) → GCP-sample (gcp)

- 상태: **completed**
- 전체 18분 15초 = 자동 17분 45초 + 사람 대기 10초 + 멈춤 0초 + 고정 대기(롤백 창) 20초
- **멈춤·사람 대기를 뺀 순수 소요(자동 + 고정)**: 18분 05초

| 단계 | 시작(KST) | 걸린 시간 | 구분 | 비고 |
|---|---|---|---|---|
| 가져오기 | 17:02:42 | 1분 21초 | 자동 |  |
| 명세 확정 대기 | 17:04:03 | 5초 | 사람 |  |
| 사전 점검 | 17:04:08 | 50초 | 자동 |  |
| 계획 만들기 | 17:04:58 | 2초 | 자동 |  |
| 계획 승인 대기 | 17:05:00 | 5초 | 사람 |  |
| 승인됨 | 17:05:05 | 2초 | 자동 |  |
| 자원 생성 | 17:05:07 | 6분 34초 | 자동 |  |
| 앱 배포 | 17:11:40 | 7분 20초 | 자동 |  |
| DB 복제 | 17:19:00 | 4초 | 자동 |  |
| 트래픽 이동 | 17:19:05 | 40초 | 자동 |  |
| DB 컷오버 | 17:19:45 | 7초 | 자동 |  |
| 롤백 대기 | 17:19:52 | 20초 | 고정 |  |
| 정리 | 17:20:12 | 45초 | 자동 |  |

## 안쪽

- **자원 생성 6분 34초** = terraform 1분 02초 (init 5초 · plan 16초 · apply 38초 · output 1초 · secret 1초 · secret 1초) + 그 밖(중계기 EC2 등) 약 5분 32초 (추정: 차이로 계산)
- **앱 배포 7분 20초** (시도 1번: 7분 20초)
  - 17:11:51 리허설 queued → 15초 뒤 다시 확인 (폴링 대기)
  - 17:12:10 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 17:12:30 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 17:12:56 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 17:13:22 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 17:13:31 리허설 passed: apply 7초 · check 1분 08초 · create 21초 · delete 1초 (합 1분 38초)
  - 배포 확인 결과: synced_healthy
- **트래픽 이동**: 제공자 mock, 흉내=예 (실제 사용자 트래픽은 안 옮김), 단계 10% → 50% → 100%, 단계마다 30초 유지, 100% 관측 10초
- **DB 복제 측정값**: replication_lag_ms 4.6ms · initial_copy_ms 337ms
- **DB 컷오버 측정값**: cutover_pause_ms 51ms · apply_worker_wait_ms 5ms · fence_terminated_sessions 1count · sequences_synced 1count · c1_pause_ms 0.2ms · c2_fence_ms 11.2ms · c3_catchup_ms 5.1ms · c4_sequences_ms 5.7ms · c5_slots_ms 28.9ms · c5b_unfence_ms 0ms · c6_resume_ms 0.1ms · reverse_subscribed_ms 88ms · forward_slot_dropped_ms 12.3ms
- **정리 결과**: 남은 자원 []

# 이전 a3d161d5: demo1-aws-source (aws) → demo1-gcp-target (gcp)

- 상태: **completed**
- 전체 25분 08초 = 자동 16분 21초 + 사람 대기 1분 27초 + 멈춤 7분 00초 + 고정 대기(롤백 창) 20초
- **멈춤·사람 대기를 뺀 순수 소요(자동 + 고정)**: 16분 41초

| 단계 | 시작(KST) | 걸린 시간 | 구분 | 비고 |
|---|---|---|---|---|
| 가져오기 | 11:28:43 | 1분 09초 | 자동 |  |
| 명세 확정 대기 | 11:29:52 | 42초 | 사람 |  |
| 사전 점검 | 11:30:34 | 52초 | 자동 |  |
| 계획 만들기 | 11:31:25 | 5초 | 자동 |  |
| 계획 승인 대기 | 11:31:30 | 45초 | 사람 |  |
| 승인됨 | 11:32:16 | 0초 | 자동 |  |
| 자원 생성 | 11:32:16 | 6분 35초 | 자동 |  |
| 앱 배포 | 11:38:50 | 5초 | 자동 |  |
| 멈춤 | 11:38:55 | 4분 43초 | 멈춤 | SECRET_VALUES_MISSING |
| 앱 배포 | 11:43:38 | 14초 | 자동 |  |
| 멈춤 | 11:43:52 | 2분 16초 | 멈춤 | REHEARSAL_SANDBOX_UNAVAILABLE |
| 앱 배포 | 11:46:08 | 5분 58초 | 자동 |  |
| DB 복제 | 11:52:06 | 6초 | 자동 |  |
| 트래픽 이동 | 11:52:12 | 43초 | 자동 |  |
| DB 컷오버 | 11:52:55 | 3초 | 자동 |  |
| 롤백 대기 | 11:52:58 | 20초 | 고정 |  |
| 정리 | 11:53:18 | 33초 | 자동 |  |

## 안쪽

- 자원 생성 시도 11:38:50 성공: terraform 48초 (init 2초 · plan 10초 · apply 33초 · output 1초 · secret 1초 · secret 1초)
- **자원 생성 6분 35초** = terraform 합 48초 (시도 1번) + 그 밖(중계기 EC2 등) 약 5분 47초 (추정: 차이로 계산)
- **앱 배포 6분 16초** (시도 3번: 5초, 14초, 5분 58초)
  - 11:38:55 멈춤 SECRET_VALUES_MISSING
  - 11:43:46 리허설 queued → 15초 뒤 다시 확인 (폴링 대기)
  - 11:43:47 리허설 error: apply 0초 · check 0초 · create 0초 · delete 0초 (합 0초)
  - 11:43:52 멈춤 REHEARSAL_SANDBOX_UNAVAILABLE
  - 11:46:16 리허설 queued → 15초 뒤 다시 확인 (폴링 대기)
  - 11:46:39 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:46:58 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:47:18 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:47:37 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:47:57 리허설 passed: apply 6초 · check 1분 12초 · create 21초 · delete 1초 (합 1분 40초)
  - 배포 확인 결과: synced_healthy
- **트래픽 이동**: 제공자 mock, 흉내=예 (실제 사용자 트래픽은 안 옮김), 단계 10% → 50% → 100%, 단계마다 30초 유지, 100% 관측 10초
- **DB 복제 측정값**: replication_lag_ms 5.3ms · initial_copy_ms 380ms
- **DB 컷오버 측정값**: cutover_pause_ms 59.6ms · apply_worker_wait_ms 6ms · fence_terminated_sessions 1count · sequences_synced 1count · c1_pause_ms 0.1ms · c2_fence_ms 19.1ms · c3_catchup_ms 5.1ms · c4_sequences_ms 6ms · c5_slots_ms 29.4ms · c5b_unfence_ms 0ms · c6_resume_ms 0ms · reverse_subscribed_ms 85.7ms · forward_slot_dropped_ms 6.7ms
- **정리 결과**: 남은 자원 []

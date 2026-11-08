# 이전 c8291bda: onprem-vm (onprem) → src-aws-sample (aws)

- 상태: **completed**
- 전체 48분 29초 = 자동 13분 46초 + 사람 대기 2분 27초 + 멈춤 31분 55초 + 고정 대기(롤백 창) 20초
- **멈춤·사람 대기를 뺀 순수 소요(자동 + 고정)**: 14분 07초

| 단계 | 시작(KST) | 걸린 시간 | 구분 | 비고 |
|---|---|---|---|---|
| 가져오기 | 23:55:16 | 0초 | 자동 |  |
| 명세 확정 대기 | 23:55:17 | 5초 | 사람 |  |
| 사전 점검 | 23:55:21 | 45초 | 자동 |  |
| 계획 만들기 | 23:56:06 | 1초 | 자동 |  |
| 계획 승인 대기 | 23:56:07 | 2분 23초 | 사람 |  |
| 승인됨 | 23:58:30 | 1초 | 자동 |  |
| 자원 생성 | 23:58:31 | 7분 09초 | 자동 |  |
| 실패(재시도 대기) | 00:05:40 | 3분 50초 | 멈춤 | TF_APPLY_FAILED |
| 자원 생성 | 00:09:31 | 1분 45초 | 자동 |  |
| 앱 배포 | 00:11:16 | 2초 | 자동 |  |
| 멈춤 | 00:11:18 | 28분 05초 | 멈춤 | SECRET_VALUES_MISSING |
| 앱 배포 | 00:39:23 | 2분 33초 | 자동 |  |
| DB 복제 | 00:41:56 | 3초 | 자동 |  |
| 트래픽 이동 | 00:41:59 | 41초 | 자동 |  |
| DB 컷오버 | 00:42:39 | 1초 | 자동 |  |
| 롤백 대기 | 00:42:40 | 20초 | 고정 |  |
| 정리 | 00:43:00 | 45초 | 자동 |  |

## 안쪽

- 자원 생성 시도 00:05:40 실패: terraform 7분 08초 (init 10초 · plan 9초 · apply 6분 49초)
- 자원 생성 시도 00:11:16 성공: terraform 32초 (init 7초 · plan 10초 · apply 9초 · output 3초 · secret 2초 · secret 1초)
- **자원 생성 8분 55초** = terraform 합 7분 40초 (시도 2번) + 그 밖(중계기 EC2 등) 약 1분 15초 (추정: 차이로 계산)
- **앱 배포 2분 35초** (시도 2번: 2초, 2분 33초)
  - 00:11:18 멈춤 SECRET_VALUES_MISSING
  - 00:39:29 리허설 queued → 15초 뒤 다시 확인 (폴링 대기)
  - 00:39:46 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 00:40:03 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 00:40:20 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 00:40:37 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 00:40:54 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 00:41:06 리허설 passed: apply 5초 · check 1분 08초 · create 21초 · delete 1초 (합 1분 36초)
  - 배포 확인 결과: synced_healthy
- **트래픽 이동**: 제공자 mock, 흉내=예 (실제 사용자 트래픽은 안 옮김), 단계 10% → 50% → 100%, 단계마다 30초 유지, 100% 관측 10초
- **DB 복제 측정값**: replication_lag_ms 3.3ms · initial_copy_ms 404ms
- **DB 컷오버 측정값**: cutover_pause_ms 50.3ms · apply_worker_wait_ms 3ms · fence_terminated_sessions 1count · sequences_synced 1count · reverse_apply_grants 6count · c1_pause_ms 0ms · c2_fence_ms 19.8ms · c3_catchup_ms 7.2ms · c4_sequences_ms 5.8ms · c5_slots_ms 17.6ms · c5b_unfence_ms 0ms · c6_resume_ms 0ms · reverse_subscribed_ms 335.8ms · forward_slot_dropped_ms 21.3ms
- **정리 결과**: 남은 자원 []

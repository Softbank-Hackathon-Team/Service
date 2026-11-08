# 이전 a5f79727: src-aws-sample (aws) → onprem-vm (onprem)

- 상태: **completed**
- 전체 22분 39초 = 자동 18분 35초 + 사람 대기 57초 + 멈춤 1분 07초 + 고정 대기(롤백 창) 2분 00초
- **멈춤·사람 대기를 뺀 순수 소요(자동 + 고정)**: 20분 35초

| 단계 | 시작(KST) | 걸린 시간 | 구분 | 비고 |
|---|---|---|---|---|
| 가져오기 | 11:52:42 | 2분 04초 | 자동 |  |
| 명세 확정 대기 | 11:54:47 | 24초 | 사람 |  |
| 사전 점검 | 11:55:11 | 38초 | 자동 |  |
| 계획 만들기 | 11:55:49 | 0초 | 자동 |  |
| 계획 승인 대기 | 11:55:50 | 33초 | 사람 |  |
| 승인됨 | 11:56:22 | 0초 | 자동 |  |
| 자원 생성 | 11:56:23 | 37초 | 자동 |  |
| 앱 배포 | 11:57:00 | 12분 08초 | 자동 |  |
| 멈춤 | 12:09:08 | 1분 07초 | 멈춤 | AGENT_DEPLOY_TIMEOUT |
| 앱 배포 | 12:10:15 | 13초 | 자동 |  |
| DB 복제 | 12:10:27 | 6초 | 자동 |  |
| 트래픽 이동 | 12:10:33 | 1분 52초 | 자동 |  |
| DB 컷오버 | 12:12:25 | 3초 | 자동 |  |
| 롤백 대기 | 12:12:28 | 2분 00초 | 고정 |  |
| 정리 | 12:14:28 | 53초 | 자동 |  |

## 안쪽

- **자원 생성 37초**: terraform 단계 기록 없음 (온프레 도착은 클라우드 자원을 안 만든다); 중계기 EC2 생성이 대부분 (추정)
- **앱 배포 12분 21초** (시도 2번: 12분 08초, 13초)
  - 11:57:16 리허설 queued → 60초 뒤 다시 확인 (폴링 대기)
  - 11:58:19 리허설 running → 60초 뒤 다시 확인 (폴링 대기)
  - 11:58:58 리허설 passed: apply 7초 · check 1분 10초 · create 21초 · delete 1초 (합 1분 40초)
  - 12:09:08 멈춤 AGENT_DEPLOY_TIMEOUT
  - 배포 확인 결과: applied
- **트래픽 이동**: 제공자 cloudflare, 흉내=아니오, 단계 10% → 50% → 100%, 단계마다 30초 유지, 100% 관측 30초
- **DB 복제 측정값**: replication_lag_ms 68.1ms · initial_copy_ms 1492ms
- **DB 컷오버 측정값**: cutover_pause_ms 113.4ms · apply_worker_wait_ms 7ms · fence_terminated_sessions 1count · sequences_synced 1count · c1_pause_ms 0.1ms · c2_fence_ms 16.2ms · c3_catchup_ms 57.9ms · c4_sequences_ms 8.3ms · c5_slots_ms 30.9ms · c5b_unfence_ms 0ms · c6_resume_ms 0ms · reverse_subscribed_ms 136.5ms · forward_slot_dropped_ms 7ms
- **정리 결과**: 남은 자원 []

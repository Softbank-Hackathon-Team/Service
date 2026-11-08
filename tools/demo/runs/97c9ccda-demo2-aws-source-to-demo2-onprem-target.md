# 이전 97c9ccda: demo2-aws-source (aws) → demo2-onprem-target (onprem)

- 상태: **completed**
- 전체 28분 02초 = 자동 17분 38초 + 사람 대기 1분 01초 + 멈춤 9분 03초 + 고정 대기(롤백 창) 20초
- **멈춤·사람 대기를 뺀 순수 소요(자동 + 고정)**: 17분 58초

| 단계 | 시작(KST) | 걸린 시간 | 구분 | 비고 |
|---|---|---|---|---|
| 가져오기 | 11:29:10 | 1분 27초 | 자동 |  |
| 명세 확정 대기 | 11:30:37 | 14초 | 사람 |  |
| 사전 점검 | 11:30:51 | 26초 | 자동 |  |
| 계획 만들기 | 11:31:17 | 0초 | 자동 |  |
| 계획 승인 대기 | 11:31:17 | 48초 | 사람 |  |
| 승인됨 | 11:32:05 | 0초 | 자동 |  |
| 자원 생성 | 11:32:05 | 49초 | 자동 |  |
| 앱 배포 | 11:32:54 | 12분 19초 | 자동 |  |
| 멈춤 | 11:45:13 | 9분 03초 | 멈춤 | AGENT_DEPLOY_TIMEOUT |
| 앱 배포 | 11:54:16 | 41초 | 자동 |  |
| DB 복제 | 11:54:57 | 5초 | 자동 |  |
| 트래픽 이동 | 11:55:02 | 53초 | 자동 |  |
| DB 컷오버 | 11:55:56 | 3초 | 자동 |  |
| 롤백 대기 | 11:55:58 | 20초 | 고정 |  |
| 정리 | 11:56:18 | 53초 | 자동 |  |

## 안쪽

- **자원 생성 49초**: terraform 단계 기록 없음 (온프레 도착은 클라우드 자원을 안 만든다); 중계기 EC2 생성이 대부분 (추정)
- **앱 배포 13분 00초** (시도 2번: 12분 19초, 41초)
  - 11:33:19 리허설 queued → 15초 뒤 다시 확인 (폴링 대기)
  - 11:33:37 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:33:54 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:34:12 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:34:29 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:34:47 리허설 running → 15초 뒤 다시 확인 (폴링 대기)
  - 11:35:03 리허설 passed: apply 8초 · check 1분 12초 · create 21초 · delete 1초 (합 1분 42초)
  - 11:45:13 멈춤 AGENT_DEPLOY_TIMEOUT
  - 배포 확인 결과: applied
- **트래픽 이동**: 제공자 cloudflare, 흉내=아니오, 단계 10% → 50% → 100%, 단계마다 30초 유지, 100% 관측 10초
- **DB 복제 측정값**: replication_lag_ms 36.1ms · initial_copy_ms 443ms
- **DB 컷오버 측정값**: cutover_pause_ms 104.6ms · apply_worker_wait_ms 9ms · fence_terminated_sessions 1count · sequences_synced 1count · c1_pause_ms 0ms · c2_fence_ms 11.6ms · c3_catchup_ms 9.1ms · c4_sequences_ms 51.4ms · c5_slots_ms 32.5ms · c5b_unfence_ms 0ms · c6_resume_ms 0ms · reverse_subscribed_ms 135.3ms · forward_slot_dropped_ms 6.8ms
- **정리 결과**: 남은 자원 []

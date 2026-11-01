-- 0014 (작업 Z49 성능 프로파일링, DRAFT(ai)): 보안 표의 임시 자격 장부 읽기용 인덱스
-- forward-only: 되돌릴 때는 아래 "-- Down Migration" 을 사람이 직접 돌린다
--
-- 왜: GET /migrations/:id/security 가 이전 한 건의 장부를 상태와 상관없이 다 읽는다
--     (apps/api/src/security/load.ts: WHERE migration_id = $1 ORDER BY issued_at).
--     0009 인덱스 temp_credentials_migration 은 status <> 'revoked' 부분 인덱스, 0013 temp_credentials_due 는 (tenant_id, expires_at)
--     활성 줄만이라 이 조회에 못 쓴다 → 표 전체 훑기.
-- 측정 (docs/PERF.md 4절): 장부 1.89만 줄(회수된 줄 대부분)에서 4.17ms → 0.15ms. 줄 수에 비례해 늘던 것이 이전 한 건 크기로 고정
-- 대가: 쓰기마다 인덱스 1개 더 (발급·회수 때만, 이전 한 건에 몇 줄)
-- 다른 조회 점검 결과(EXPLAIN): 목록·상세·타임라인·감사 꼬리·실패 횟수·계획·명세는 이미 인덱스를 탄다. 더할 것 없음
-- 번호: 0013 = Z39(임시 자격 수명), 0014 = 이 파일(통합 담당 확정), Z61 = 0015

CREATE INDEX IF NOT EXISTS temp_credentials_migration_all
  ON temp_credentials (tenant_id, migration_id, issued_at);

-- Down Migration
-- DROP INDEX IF EXISTS temp_credentials_migration_all;

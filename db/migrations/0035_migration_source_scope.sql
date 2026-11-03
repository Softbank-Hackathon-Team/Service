-- 0035 (K-1): 이전 한 건의 출발 범위(어느 클러스터·네임스페이스·앱 묶음·DB 를 가져올지). 예전엔 워커 환경변수(IMPORT_*) 하나라 회사·이전마다 못 달랐다
-- 모양은 packages/contracts SourceScope (Zod). 이전을 만들 때 API 가 넣고, 가져오기 작업이 DB 에서 다시 읽는다 (큐 내용은 안 믿음)
-- 빈 객체 = 예전처럼 자동 고르기 + 검토 줄. 옛 행은 '{}' 로 채워진다
ALTER TABLE migrations ADD COLUMN source_scope jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE migrations ADD CONSTRAINT migrations_source_scope_object CHECK (jsonb_typeof(source_scope) = 'object');

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- ALTER TABLE migrations DROP COLUMN source_scope;

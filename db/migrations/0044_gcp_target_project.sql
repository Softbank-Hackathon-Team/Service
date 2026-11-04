-- 0044 (GCP 이전 전용 프로젝트, 결정 3번 A안): 도착 자원은 고객 원래 프로젝트가 아니라 "이전 전용 프로젝트"에만 만든다
--   environments.gcp_target_project        : 이전 전용 GCP 프로젝트 ID. 실행·plan 역할(svc-operate|svc-plan@<이 프로젝트>)과 도착 Terraform project_id 가 쓴다
--                                            관찰 역할(svc-observe)은 account_id(원래 프로젝트) 그대로. 비어 있으면 예전처럼 account_id 하나로 (옛 환경)
--   environments.gcp_target_project_number : 첫 연결 확인 성공 때 고정하는 전용 프로젝트 번호 (gcp_project_number 와 같은 규칙)
-- DRAFT(ai): 번호 0044 는 로컬 통합용(0041~0043 은 다른 묶음 자리로 비워 둠). PR 때 머지 순서대로 다시 매긴다
-- 권한: app_user 는 environments SELECT·UPDATE (0001) 이미 있음 → 추가 GRANT 없음
ALTER TABLE environments ADD COLUMN gcp_target_project text
  CHECK (gcp_target_project ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$');
ALTER TABLE environments ADD COLUMN gcp_target_project_number text
  CHECK (gcp_target_project_number ~ '^[0-9]{6,20}$');
-- 원래 프로젝트와 같으면 "따로 방"이 아니다 → 거부
ALTER TABLE environments ADD CONSTRAINT environments_gcp_target_project_differs
  CHECK (gcp_target_project IS NULL OR account_id IS NULL OR gcp_target_project <> account_id);

-- forward-only: 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- ALTER TABLE environments DROP CONSTRAINT environments_gcp_target_project_differs;
-- ALTER TABLE environments DROP COLUMN gcp_target_project_number;
-- ALTER TABLE environments DROP COLUMN gcp_target_project;

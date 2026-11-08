-- 2026-11-08 시연 이름 되돌리기
BEGIN;
UPDATE environments SET name = 'jun-aws-src' WHERE id = '8492d605-7815-426f-896a-947ef40a3210' AND name = 'demo1-aws-source';
UPDATE environments SET name = 'GCP-sample' WHERE id = 'acd6fdb5-c681-40d0-bc80-16df82cb8dc6' AND name = 'demo1-gcp-target';
UPDATE environments SET name = 'src-aws-sample' WHERE id = '783df2ef-8dbf-4a20-904d-bb02aeb96332' AND name = 'demo2-aws-source';
UPDATE environments SET name = 'onprem-vm' WHERE id = '37653b15-f150-4cb3-a34b-9dde8ea30b5d' AND name = 'demo2-onprem-target';
COMMIT;

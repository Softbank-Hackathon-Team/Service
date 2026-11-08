-- 2026-11-08 시연용 숨김 되돌리기: 이 파일을 플랫폼 DB 에 그대로 실행하면 원래 이름으로 돌아간다
BEGIN;
UPDATE environments SET name = 'ㅁㄴㅇㄹ' WHERE id = '8328e4f0-0520-465f-bfaa-763468bd7758' AND name = 'tmp-ㅁㄴㅇㄹ';
UPDATE environments SET name = 'dev-aws' WHERE id = '22222222-2222-4222-8222-222222222222' AND name = 'tmp-dev-aws';
UPDATE environments SET name = 'dev-azure-mock' WHERE id = '44444444-4444-4444-8444-444444444444' AND name = 'tmp-dev-azure-mock';
UPDATE environments SET name = 'dev-gcp' WHERE id = '33333333-3333-4333-8333-333333333333' AND name = 'tmp-dev-gcp';
UPDATE environments SET name = 'dev-onprem-k3d' WHERE id = '55555555-5555-4555-8555-555555555555' AND name = 'tmp-dev-onprem-k3d';
UPDATE environments SET name = 'jeong-onprem' WHERE id = '84dce1f5-3793-4f9d-99c2-1babc984837d' AND name = 'tmp-jeong-onprem';
UPDATE environments SET name = 'jeong-sample' WHERE id = 'ef114bd9-32a1-4fc6-9ae0-76bd491e6e2e' AND name = 'tmp-jeong-sample';
UPDATE environments SET name = 'jeong-vm' WHERE id = '86d00168-4867-4977-8362-0a7b0e6b7fef' AND name = 'tmp-jeong-vm';
UPDATE environments SET name = 'jun-aws-target' WHERE id = 'c86fea63-ca3d-4f90-8291-b10f361f956f' AND name = 'tmp-jun-aws-target';
UPDATE environments SET name = 'sample-target' WHERE id = 'e14a7e4a-b8c2-4e19-8076-56ef3090d3d3' AND name = 'tmp-sample-target';
UPDATE environments SET name = 'shop-target-gcp' WHERE id = '10f37d28-b5e7-466c-a898-11a4e666ea89' AND name = 'tmp-shop-target-gcp';
COMMIT;

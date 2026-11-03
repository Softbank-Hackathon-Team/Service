-- 0023 공통 명세 v2 칸 (가져오기 I3b). spec_versions 한 줄에 v1(spec)과 v2(spec_v2 = ImportResultV2)를 같이 둔다
-- 교살자 방식: 계획·적용은 계속 spec(v1)을 읽는다. spec_v2 는 IMPORT_IR=v2 가져오기 판(version 1)에만 채우고, 나머지는 NULL
-- 권한: app_user 는 0001 에서 spec_versions 표 단위 GRANT 를 이미 가짐 → 추가 GRANT 없음
ALTER TABLE spec_versions ADD COLUMN spec_v2 jsonb;

-- Down Migration
-- ALTER TABLE spec_versions DROP COLUMN spec_v2;

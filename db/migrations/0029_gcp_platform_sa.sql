-- 0029 (L7i): GCP 연결용 칸 둘
--   tenants.gcp_platform_sa : 이 회사 전용 플랫폼 서비스 계정(SA) 이름(ID 부분). "t-" + md5(회사 UUID) 16진 앞 28자 (SA ID 최대 30자). UUID 앞부분을 그대로 자르면 끝 4자리만 다른 번호(시험·시드)끼리 겹친다
--     발급기는 이 칸을 회사 번호로만 DB 에서 읽는다 (요청 값 무시 → 혼동된 대리인 방어, IA 6.2 "회사별 t-<회사>@" MUST). 전역 유일
--     새 회사는 트리거가 채운다 (DEFAULT 는 다른 칸을 못 봄). 이메일은 <이름>@<GCP_PLATFORM_PROJECT>.iam.gserviceaccount.com
--   environments.gcp_project_number : 첫 연결 확인 성공 때 고정하는 GCP 프로젝트 번호. 이후 확인은 이 번호와 같아야 한다
--     (프로젝트 ID 를 지우고 남이 다시 만들어도 번호는 달라 알아챔)
-- DRAFT(ai) L7i: 번호 0029 는 로컬 통합용 고정. PR 때 머지 순서대로 다시 매긴다
-- 권한: app_user 는 tenants SELECT (0001), environments UPDATE (0001) 이미 있음 → 추가 GRANT 없음
ALTER TABLE tenants ADD COLUMN gcp_platform_sa text;
UPDATE tenants SET gcp_platform_sa = 't-' || substr(md5(id::text), 1, 28) WHERE gcp_platform_sa IS NULL;
ALTER TABLE tenants ALTER COLUMN gcp_platform_sa SET NOT NULL;
ALTER TABLE tenants ADD CONSTRAINT tenants_gcp_platform_sa_fmt CHECK (gcp_platform_sa ~ '^t-[0-9a-f]{28}$');
ALTER TABLE tenants ADD CONSTRAINT tenants_gcp_platform_sa_uq UNIQUE (gcp_platform_sa);

CREATE FUNCTION tenants_fill_gcp_platform_sa() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.gcp_platform_sa IS NULL THEN
    NEW.gcp_platform_sa := 't-' || substr(md5(NEW.id::text), 1, 28);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_fill_gcp_platform_sa BEFORE INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_fill_gcp_platform_sa();
-- NOT NULL 은 트리거가 채운 뒤에 검사되므로 INSERT 가 깨지지 않는다 (BEFORE 트리거는 제약 검사 앞)

ALTER TABLE environments ADD COLUMN gcp_project_number text CHECK (gcp_project_number ~ '^[0-9]{6,20}$');

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- ALTER TABLE environments DROP COLUMN gcp_project_number;
-- DROP TRIGGER tenants_fill_gcp_platform_sa ON tenants; DROP FUNCTION tenants_fill_gcp_platform_sa();
-- ALTER TABLE tenants DROP COLUMN gcp_platform_sa;

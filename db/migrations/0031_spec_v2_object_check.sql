-- 0031 (I8apifix): spec_versions.spec_v2 는 NULL 이거나 JSON 객체(ImportResultV2)만. 스칼라·배열이 들어가면 GET /spec 이 v1 판처럼 보이던 구멍을 DB 에서 막는다
-- I8apifix2: 이미 돌던 DB 에 스칼라·배열(JSON null 포함) spec_v2 줄이 있으면 CHECK 가 실패하므로, 같은 파일 안에서 먼저 그 줄의 spec_v2 만 NULL 로 돌린다
--   (v1 spec·field_meta 는 그대로 = 그 판은 v1 판으로 보인다) + 회사 감사 사슬에 한 줄 (core/audit.ts writeAudit 와 같은 해시)
--   주인이 슈퍼유저가 아니어도 FORCE RLS 를 지나게 회사마다 app.tenant_id 를 켜고 돈다 (tenants 는 회사 벽 밖 표)
-- DRAFT(ai): 깨진 v2 는 지우지 않고 NULL 로 (값 복구 불가, 원래 모양은 감사 detail 의 jsonType 만). 감사 actor "system", action "spec.v2_cleared"
-- DRAFT(ai): 번호 0031 은 로컬 통합용 고정. PR 때 머지 순서대로 다시 매긴다
DO $$
DECLARE
  t uuid;
  r record;
  prev text;
  body text;
BEGIN
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    FOR r IN SELECT migration_id, version, jsonb_typeof(spec_v2) AS jt FROM spec_versions
              WHERE tenant_id = t AND spec_v2 IS NOT NULL AND jsonb_typeof(spec_v2) <> 'object'
              ORDER BY migration_id, version LOOP
      UPDATE spec_versions SET spec_v2 = NULL WHERE tenant_id = t AND migration_id = r.migration_id AND version = r.version;
      PERFORM pg_advisory_xact_lock(hashtext('audit:' || t::text));
      SELECT hash INTO prev FROM audit_events WHERE tenant_id = t ORDER BY seq DESC LIMIT 1;
      prev := COALESCE(prev, 'genesis');
      -- canonical(): 키 정렬 JSON. body 키 action·actor·detail·prevHash·result·target·tenantId, detail 키 jsonType·reason·version
      body := '{"action":"spec.v2_cleared","actor":"system","detail":{"jsonType":' || to_json(r.jt)::text
           || ',"reason":"spec_v2_not_object","version":' || r.version::text || '},"prevHash":' || to_json(prev)::text
           || ',"result":"ok","target":' || to_json(r.migration_id::text)::text || ',"tenantId":' || to_json(t::text)::text || '}';
      INSERT INTO audit_events (tenant_id, actor, action, target, result, detail, prev_hash, hash)
      VALUES (t, 'system', 'spec.v2_cleared', r.migration_id::text, 'ok',
              jsonb_build_object('jsonType', r.jt, 'reason', 'spec_v2_not_object', 'version', r.version),
              prev, encode(sha256(convert_to(body, 'UTF8')), 'hex'));
    END LOOP;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE spec_versions ADD CONSTRAINT spec_versions_spec_v2_object
  CHECK (spec_v2 IS NULL OR jsonb_typeof(spec_v2) = 'object');

-- forward-only: 실행기(tools/db-migrate.sh)는 앞으로만 간다. 되돌리기는 아래를 사람이 직접 돌린다
-- Down Migration
-- ALTER TABLE spec_versions DROP CONSTRAINT spec_versions_spec_v2_object;
-- (NULL 로 돌린 spec_v2 는 되돌릴 수 없다. audit_events 의 spec.v2_cleared 줄이 어떤 판이었는지 남긴다)

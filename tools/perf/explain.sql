-- 작업 Z49: 화면이 쓰는 주요 조회의 실행 계획 (앱 계정 + 회사 표시로 RLS 그대로). 실행: psql "$DATABASE_URL" -f tools/perf/explain.sql
\set t '11111111-1111-4111-8111-111111111111'
select set_config('app.tenant_id', :'t', false);
select id as mid from migrations where status='completed' order by created_at desc limit 1 \gset
select max(seq) as last from audit_events where target = :'mid' \gset
\echo == 1 chain read (security/report)
explain (analyze, buffers, costs off, summary on) SELECT * FROM (SELECT seq, tenant_id, at, actor, action, target, result, detail, prev_hash, hash FROM audit_events WHERE seq <= :last ORDER BY seq DESC LIMIT 20000) x ORDER BY seq;
\echo == 2 chain count
explain (analyze, costs off, summary on) SELECT count(*)::int FROM audit_events WHERE seq <= :last;
\echo == 3 events of one migration (timeline/report)
explain (analyze, costs off, summary on) SELECT seq FROM audit_events WHERE target = :'mid' ORDER BY seq;
\echo == 4 list
explain (analyze, costs off, summary on) SELECT id FROM migrations ORDER BY updated_at DESC LIMIT 50;
\echo == 5 audit tail (writeAudit)
explain (analyze, costs off, summary on) SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1;
\echo == 6 failedAttempts
explain (analyze, costs off, summary on) SELECT count(*) FROM audit_events WHERE target = :'mid' AND action = 'sync.attempt_failed';
\echo == 7 ledger (security)
explain (analyze, costs off, summary on) SELECT credential_ref FROM temp_credentials WHERE migration_id = :'mid' ORDER BY issued_at;
\echo == 8 environments list
explain (analyze, costs off, summary on) SELECT id FROM environments ORDER BY name;

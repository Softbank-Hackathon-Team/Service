-- 작업 Z49: 최근 이전 N건의 큐 작업별 대기(들어옴→집힘)·처리(집힘→끝) 시간. 실행: psql "$OWNER_DATABASE_URL" -v n=5 -f tools/perf/stages.sql
-- 이전 N건의 작업별: 대기(created→started) / 처리(started→completed)
with m as (select id from migrations order by created_at desc limit :n)
select j.name,
  count(*) n,
  round(avg(extract(epoch from j.started_on - j.created_on))*1000) wait_ms_avg,
  round(max(extract(epoch from j.started_on - j.created_on))*1000) wait_ms_max,
  round(avg(extract(epoch from j.completed_on - j.started_on))*1000) work_ms_avg,
  round(max(extract(epoch from j.completed_on - j.started_on))*1000) work_ms_max
from pgboss.job j join m on j.data->>'migrationId' = m.id::text
group by j.name order by min(j.created_on);

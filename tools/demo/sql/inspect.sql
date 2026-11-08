\pset format unaligned
\pset tuples_only on
select 'db_setconfig', coalesce((select array_to_string(setconfig, ',') from pg_db_role_setting s join pg_database d on d.oid=s.setdatabase where d.datname=current_database() and s.setrole=0), '-');
select 'shop_app_insert', has_table_privilege('shop_app','public.orders','INSERT');
select 'shop_app_seq_usage', coalesce(bool_and(has_sequence_privilege('shop_app', c.oid, 'USAGE')), true) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and n.nspname='public';
select 'fence_saved_rows', case when to_regclass('_repl.fence_saved') is null then -1 else (select count(*) from _repl.fence_saved) end;
select 'slots', count(*) from pg_replication_slots;
select 'publications', count(*) from pg_publication;
select 'orders_rows', count(*) from public.orders;

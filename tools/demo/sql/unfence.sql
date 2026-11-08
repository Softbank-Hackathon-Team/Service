DO $svc_u$ DECLARE saved jsonb; g jsonb; obj text; kind text; priv text; BEGIN
    EXECUTE format('ALTER DATABASE %I RESET default_transaction_read_only', current_database());
    IF to_regclass('_repl.fence_saved') IS NOT NULL THEN
      EXECUTE 'SELECT grants FROM "_repl"."fence_saved" WHERE schema_name = $1 AND app_role = $2' INTO saved USING 'public', 'shop_app';
    END IF;
    IF saved IS NULL THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', 'public', 'shop_app');
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', 'public', 'shop_app');
      EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', 'public', 'shop_app');
      PERFORM set_config('svc_repl.unfence', 'default:0', true);
      RETURN;
    END IF;
    FOR g IN SELECT * FROM jsonb_array_elements(saved) LOOP
      kind := g->>'kind'; priv := g->>'privilege';
      CONTINUE WHEN NOT ((kind = 'table' AND priv IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) OR (kind = 'sequence' AND priv IN ('USAGE', 'UPDATE')));
      obj := format('%I.%I', 'public', g->>'name');
      CONTINUE WHEN to_regclass(obj) IS NULL;
      EXECUTE format('GRANT %s ON %s %s TO %I%s', priv, CASE kind WHEN 'sequence' THEN 'SEQUENCE' ELSE 'TABLE' END, obj, 'shop_app',
                     CASE WHEN (g->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    EXECUTE 'DELETE FROM "_repl"."fence_saved" WHERE schema_name = $1 AND app_role = $2' USING 'public', 'shop_app';
    PERFORM set_config('svc_repl.unfence', 'saved:' || jsonb_array_length(saved), true);
  END $svc_u$; SELECT current_setting('svc_repl.unfence', true) AS r;

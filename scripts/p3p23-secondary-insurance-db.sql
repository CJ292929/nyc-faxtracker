-- Database verification of P3-P23 (0023_add_secondary_insurance.sql):
-- optional Secondary / Supplemental Insurance on patients.
--
-- ALWAYS ROLLS BACK. Everything runs inside one DO block that ends by
-- raising an exception carrying the results, so no synthetic user, patient,
-- or audit row can ever be committed -- regardless of how the client wraps
-- statements. Only synthetic uuids (d2300000-...) and synthetic names are
-- written; no real patient is read or changed (only a COUNT of existing
-- patients with secondary values, taken before any synthetic insert).
-- Writes run as the real `authenticated` / `anon` roles with
-- request.jwt.claims set, exactly how PostgREST runs browser REST calls, so
-- RLS, 0020 attribution/audit triggers and the 0023 trigger all apply.
--
-- Run (read the raised message; "P3P23 RESULT: n failed" must be 0):
--   supabase db query --linked -f scripts/p3p23-secondary-insurance-db.sql
-- Pre-apply dry run: prepend the migration in one file, e.g.
--   (echo 'BEGIN;'; cat drizzle/migrations/0023_add_secondary_insurance.sql;
--    cat scripts/p3p23-secondary-insurance-db.sql) > /tmp/dry.sql
-- and run that file the same way; the raised exception aborts the
-- transaction, so the migration is rolled back too.
DO $verify$
DECLARE
  _owner text := current_user;
  _staff uuid := 'd2300000-0000-0000-0000-000000000001';
  _admin uuid := 'd2300000-0000-0000-0000-000000000002';
  _norole uuid := 'd2300000-0000-0000-0000-000000000003';
  _out text[] := '{}';
  _failed int := 0;
  _n int;
  _p uuid;
  _blank uuid;
  _row public.patients%ROWTYPE;
  _changes jsonb;
  _actor text;
  _msg text;
BEGIN

  -- ---- schema -----------------------------------------------------------
  SELECT count(*) INTO _n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'patients'
     AND column_name IN ('secondary_insurance', 'secondary_insurance_member_id')
     AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL;
  _out := _out || format('%s - both columns nullable text, no default', CASE WHEN _n = 2 THEN 'ok' ELSE 'FAIL' END);
  IF _n <> 2 THEN _failed := _failed + 1; END IF;

  SELECT count(*) INTO _n FROM pg_trigger
   WHERE tgrelid = 'public.patients'::regclass AND tgname = 'normalize_patient_secondary_insurance' AND NOT tgisinternal;
  _out := _out || format('%s - normalize trigger installed', CASE WHEN _n = 1 THEN 'ok' ELSE 'FAIL' END);
  IF _n <> 1 THEN _failed := _failed + 1; END IF;

  SELECT count(*) INTO _n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'normalize_patient_secondary_insurance'
     AND NOT has_function_privilege('authenticated', p.oid, 'execute')
     AND NOT has_function_privilege('anon', p.oid, 'execute');
  _out := _out || format('%s - trigger function not executable by anon/authenticated', CASE WHEN _n = 1 THEN 'ok' ELSE 'FAIL' END);
  IF _n <> 1 THEN _failed := _failed + 1; END IF;

  SELECT count(*) INTO _n FROM pg_constraint
   WHERE conrelid = 'public.patients'::regclass
     AND conname IN ('patients_secondary_insurance_length', 'patients_secondary_insurance_member_id_length');
  _out := _out || format('%s - both length CHECK constraints present', CASE WHEN _n = 2 THEN 'ok' ELSE 'FAIL' END);
  IF _n <> 2 THEN _failed := _failed + 1; END IF;

  SELECT count(*) INTO _n FROM pg_index i
   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
   WHERE i.indrelid = 'public.patients'::regclass AND i.indisunique
     AND a.attname IN ('secondary_insurance', 'secondary_insurance_member_id');
  _out := _out || format('%s - secondary Member ID is not a unique identifier', CASE WHEN _n = 0 THEN 'ok' ELSE 'FAIL' END);
  IF _n <> 0 THEN _failed := _failed + 1; END IF;

  SELECT count(*) INTO _n FROM public.patients
   WHERE secondary_insurance IS NOT NULL OR secondary_insurance_member_id IS NOT NULL;
  _out := _out || format('info - existing patients with a secondary value: %s', _n);

  -- ---- synthetic accounts -------------------------------------------------
  INSERT INTO auth.users (id) VALUES (_staff), (_admin), (_norole);
  INSERT INTO public.user_logins (user_id, username)
    VALUES (_staff, 'p3p23_staff'), (_admin, 'p3p23_admin'), (_norole, 'p3p23_norole');
  INSERT INTO public.user_roles (user_id, role) VALUES (_staff, 'staff'), (_admin, 'admin');

  -- ---- staff create: trimmed, leading zeros + punctuation preserved ------
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _staff::text, true);
  INSERT INTO public.patients (first_name, last_name, patient_id, insurance, insurance_member_id,
                               secondary_insurance, secondary_insurance_member_id)
    VALUES ('P3P23', 'Synthetic', 'P3P23-TEST-1', 'Medicare', '0001234',
            E'  Aetna Supplemental \t', ' 00123-AB/4 ')
    RETURNING id INTO _p;
  INSERT INTO public.patients (first_name, last_name, patient_id, secondary_insurance, secondary_insurance_member_id)
    VALUES ('P3P23', 'Blank', 'P3P23-TEST-2', '', '   ')
    RETURNING id INTO _blank;
  EXECUTE format('set local role %I', _owner);

  SELECT * INTO _row FROM public.patients WHERE id = _p;
  _out := _out || format('%s - staff create: values trimmed, Member ID "00123-AB/4" preserved (got %L / %L)',
    CASE WHEN _row.secondary_insurance = 'Aetna Supplemental' AND _row.secondary_insurance_member_id = '00123-AB/4' THEN 'ok' ELSE 'FAIL' END,
    _row.secondary_insurance, _row.secondary_insurance_member_id);
  IF NOT (_row.secondary_insurance = 'Aetna Supplemental' AND _row.secondary_insurance_member_id = '00123-AB/4') THEN _failed := _failed + 1; END IF;
  _out := _out || format('%s - staff create attributed to p3p23_staff',
    CASE WHEN _row.created_by = _staff AND _row.created_by_name = 'p3p23_staff' THEN 'ok' ELSE 'FAIL' END);
  IF NOT (_row.created_by = _staff AND _row.created_by_name = 'p3p23_staff') THEN _failed := _failed + 1; END IF;
  _out := _out || format('%s - primary Insurance / Member ID untouched (got %L / %L)',
    CASE WHEN _row.insurance = 'Medicare' AND _row.insurance_member_id = '0001234' THEN 'ok' ELSE 'FAIL' END,
    _row.insurance, _row.insurance_member_id);
  IF NOT (_row.insurance = 'Medicare' AND _row.insurance_member_id = '0001234') THEN _failed := _failed + 1; END IF;

  SELECT * INTO _row FROM public.patients WHERE id = _blank;
  _out := _out || format('%s - blank / whitespace-only values accepted and stored as NULL',
    CASE WHEN _row.secondary_insurance IS NULL AND _row.secondary_insurance_member_id IS NULL THEN 'ok' ELSE 'FAIL' END);
  IF NOT (_row.secondary_insurance IS NULL AND _row.secondary_insurance_member_id IS NULL) THEN _failed := _failed + 1; END IF;

  -- ---- admin edit: Member ID only (fields are independent) ---------------
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _admin::text, true);
  UPDATE public.patients SET secondary_insurance_member_id = '0007' WHERE id = _p;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.patients WHERE id = _p;
  _out := _out || format('%s - admin edit saved Member ID "0007", insurance unchanged, attributed to p3p23_admin',
    CASE WHEN _row.secondary_insurance_member_id = '0007' AND _row.secondary_insurance = 'Aetna Supplemental'
          AND _row.updated_by = _admin AND _row.updated_by_name = 'p3p23_admin' THEN 'ok' ELSE 'FAIL' END);
  IF NOT (_row.secondary_insurance_member_id = '0007' AND _row.secondary_insurance = 'Aetna Supplemental'
          AND _row.updated_by = _admin AND _row.updated_by_name = 'p3p23_admin') THEN _failed := _failed + 1; END IF;
  SELECT changes, actor_username INTO _changes, _actor FROM public.audit_logs
   WHERE patient_id = _p AND action = 'patients_update' ORDER BY created_at DESC, id DESC LIMIT 1;
  _out := _out || format('%s - history: admin actor, only secondary Member ID changed 00123-AB/4 -> 0007 (got %s by %s)',
    CASE WHEN _actor = 'p3p23_admin' AND _changes = jsonb_build_object('secondary_insurance_member_id',
          jsonb_build_object('from', '00123-AB/4', 'to', '0007')) THEN 'ok' ELSE 'FAIL' END, _changes, _actor);
  IF NOT (_actor = 'p3p23_admin' AND _changes = jsonb_build_object('secondary_insurance_member_id',
          jsonb_build_object('from', '00123-AB/4', 'to', '0007'))) THEN _failed := _failed + 1; END IF;

  -- ---- whitespace-only re-save is not an edit ----------------------------
  SELECT count(*) INTO _n FROM public.audit_logs WHERE patient_id = _p;
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _staff::text, true);
  UPDATE public.patients SET secondary_insurance = '  Aetna Supplemental  ', secondary_insurance_member_id = ' 0007' WHERE id = _p;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.patients WHERE id = _p;
  _out := _out || format('%s - whitespace-only re-save: no history row, still attributed to admin',
    CASE WHEN (SELECT count(*) FROM public.audit_logs WHERE patient_id = _p) = _n AND _row.updated_by = _admin THEN 'ok' ELSE 'FAIL' END);
  IF NOT ((SELECT count(*) FROM public.audit_logs WHERE patient_id = _p) = _n AND _row.updated_by = _admin) THEN _failed := _failed + 1; END IF;

  -- ---- staff clear both --------------------------------------------------
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _staff::text, true);
  UPDATE public.patients SET secondary_insurance = '', secondary_insurance_member_id = NULL WHERE id = _p;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.patients WHERE id = _p;
  SELECT changes, actor_username INTO _changes, _actor FROM public.audit_logs
   WHERE patient_id = _p AND action = 'patients_update' ORDER BY created_at DESC, id DESC LIMIT 1;
  _out := _out || format('%s - staff clear: both NULL, history by p3p23_staff lists both fields (got %s)',
    CASE WHEN _row.secondary_insurance IS NULL AND _row.secondary_insurance_member_id IS NULL AND _actor = 'p3p23_staff'
          AND _changes ? 'secondary_insurance' AND _changes ? 'secondary_insurance_member_id' THEN 'ok' ELSE 'FAIL' END, _changes);
  IF NOT (_row.secondary_insurance IS NULL AND _row.secondary_insurance_member_id IS NULL AND _actor = 'p3p23_staff'
          AND _changes ? 'secondary_insurance' AND _changes ? 'secondary_insurance_member_id') THEN _failed := _failed + 1; END IF;

  -- ---- length limits -----------------------------------------------------
  BEGIN
    UPDATE public.patients SET secondary_insurance = repeat('x', 200), secondary_insurance_member_id = repeat('9', 100) WHERE id = _p;
    _out := _out || text 'ok - 200-char insurance / 100-char Member ID accepted';
  EXCEPTION WHEN others THEN
    _failed := _failed + 1; _out := _out || ('FAIL - limit-length values rejected: ' || SQLERRM);
  END;
  BEGIN
    UPDATE public.patients SET secondary_insurance = repeat('x', 201) WHERE id = _p;
    _failed := _failed + 1; _out := _out || text 'FAIL - 201-char insurance accepted';
  EXCEPTION WHEN check_violation THEN _out := _out || text 'ok - 201-char insurance rejected';
  END;
  BEGIN
    UPDATE public.patients SET secondary_insurance_member_id = repeat('9', 101) WHERE id = _p;
    _failed := _failed + 1; _out := _out || text 'FAIL - 101-char Member ID accepted';
  EXCEPTION WHEN check_violation THEN _out := _out || text 'ok - 101-char Member ID rejected';
  END;

  -- ---- anonymous / role-less writes stay denied --------------------------
  BEGIN
    EXECUTE 'set local role anon';
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO public.patients (first_name, last_name, patient_id, secondary_insurance) VALUES ('Anon', 'X', 'P3P23-ANON', 'S');
    _failed := _failed + 1; _out := _out || text 'FAIL - anon insert accepted';
  EXCEPTION WHEN others THEN _out := _out || ('ok - anon insert denied (' || SQLSTATE || ')');
  END;
  EXECUTE format('set local role %I', _owner);
  BEGIN
    EXECUTE 'set local role anon';
    UPDATE public.patients SET secondary_insurance = 'anon' WHERE id = _p;
    GET DIAGNOSTICS _n = ROW_COUNT;
    EXECUTE format('set local role %I', _owner);
    IF _n = 0 THEN _out := _out || text 'ok - anon update affects 0 rows';
    ELSE _failed := _failed + 1; _out := _out || text 'FAIL - anon update changed a row'; END IF;
  EXCEPTION WHEN others THEN _out := _out || ('ok - anon update denied (' || SQLSTATE || ')');
  END;
  EXECUTE format('set local role %I', _owner);
  BEGIN
    EXECUTE 'set local role authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', _norole, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', _norole::text, true);
    INSERT INTO public.patients (first_name, last_name, patient_id, secondary_insurance) VALUES ('NoRole', 'X', 'P3P23-NOROLE', 'S');
    _failed := _failed + 1; _out := _out || text 'FAIL - role-less insert accepted';
  EXCEPTION WHEN others THEN _out := _out || ('ok - role-less insert denied (' || SQLSTATE || ')');
  END;
  EXECUTE format('set local role %I', _owner);
  BEGIN
    EXECUTE 'set local role authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('sub', _norole, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', _norole::text, true);
    UPDATE public.patients SET secondary_insurance = 'norole' WHERE id = _p;
    GET DIAGNOSTICS _n = ROW_COUNT;
    EXECUTE format('set local role %I', _owner);
    IF _n = 0 THEN _out := _out || text 'ok - role-less update affects 0 rows';
    ELSE _failed := _failed + 1; _out := _out || text 'FAIL - role-less update changed a row'; END IF;
  EXCEPTION WHEN others THEN _out := _out || ('ok - role-less update denied (' || SQLSTATE || ')');
  END;
  EXECUTE format('set local role %I', _owner);

  _msg := format('P3P23 RESULT: %s failed', _failed);
  RAISE EXCEPTION '%', _msg || E'\n' || array_to_string(_out, E'\n') || E'\n' || _msg || ' (rolled back)';
END
$verify$;

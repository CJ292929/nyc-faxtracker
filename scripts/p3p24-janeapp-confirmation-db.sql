-- Database verification of P3-P24 (0024_add_janeapp_upload_confirmation.sql):
-- "Uploaded to JaneApp?" confirmation on documents.
--
-- ALWAYS ROLLS BACK. Everything runs inside one DO block that ends by
-- raising an exception carrying the results, so no synthetic user, patient,
-- document or audit row can ever be committed. Only synthetic uuids
-- (d2400000-...) and synthetic names are written; no real record is read or
-- changed (only a COUNT of existing documents with a non-NULL value, taken
-- before any synthetic insert). Writes run as the real `authenticated` /
-- `anon` roles with request.jwt.claims set, exactly how PostgREST runs
-- browser REST calls, so RLS, 0020 attribution/audit and 0022 direction
-- triggers all apply.
--
-- Run (read the raised message; "P3P24 RESULT: n failed" must be 0):
--   supabase db query --linked -f scripts/p3p24-janeapp-confirmation-db.sql
-- Pre-apply dry run: prepend the migration in one file, e.g.
--   (cat drizzle/migrations/0024_add_janeapp_upload_confirmation.sql;
--    cat scripts/p3p24-janeapp-confirmation-db.sql) > dry.sql
-- and run that file the same way; the raised exception aborts the
-- transaction, so the migration is rolled back too.
DO $verify$
DECLARE
  _owner text := current_user;
  _staff uuid := 'd2400000-0000-0000-0000-000000000001';
  _admin uuid := 'd2400000-0000-0000-0000-000000000002';
  _norole uuid := 'd2400000-0000-0000-0000-000000000003';
  _out text[] := '{}';
  _failed int := 0;
  _n int;
  _p uuid;
  _out_doc uuid;
  _in_doc uuid;
  _row public.documents%ROWTYPE;
  _changes jsonb;
  _actor text;
  _ok boolean;
  _msg text;
BEGIN
  -- ---- schema -----------------------------------------------------------
  SELECT count(*) INTO _n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'janeapp_uploaded'
     AND data_type = 'boolean' AND is_nullable = 'YES' AND column_default IS NULL;
  _ok := _n = 1;
  _out := _out || format('%s - janeapp_uploaded is a nullable boolean with no default', CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  SELECT count(*) INTO _n FROM public.documents WHERE janeapp_uploaded IS NOT NULL;
  _out := _out || format('info - existing documents with a JaneApp answer: %s (expected 0 right after apply)', _n);

  -- ---- synthetic accounts ------------------------------------------------
  INSERT INTO auth.users (id) VALUES (_staff), (_admin), (_norole);
  INSERT INTO public.user_logins (user_id, username)
    VALUES (_staff, 'p3p24_staff'), (_admin, 'p3p24_admin'), (_norole, 'p3p24_norole');
  INSERT INTO public.user_roles (user_id, role) VALUES (_staff, 'staff'), (_admin, 'admin');

  -- ---- staff creates patient, outgoing and incoming documents ------------
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _staff::text, true);
  INSERT INTO public.patients (first_name, last_name, patient_id) VALUES ('P3P24', 'Synthetic', 'P3P24-TEST-1')
    RETURNING id INTO _p;
  INSERT INTO public.documents (patient_id, document_type) VALUES (_p, 'Progress Note') RETURNING id INTO _out_doc;
  INSERT INTO public.documents (patient_id, document_type, direction, received, received_date, received_from)
    VALUES (_p, 'Initial Evaluation', 'incoming', true, now(), 'P3P24 Sender') RETURNING id INTO _in_doc;
  EXECUTE format('set local role %I', _owner);

  SELECT count(*) INTO _n FROM public.documents WHERE id IN (_out_doc, _in_doc) AND janeapp_uploaded IS NULL;
  _ok := _n = 2;
  _out := _out || format('%s - new outgoing and incoming documents start Unconfirmed (NULL)', CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  -- ---- staff: Unconfirmed -> No ------------------------------------------
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _staff::text, true);
  UPDATE public.documents SET janeapp_uploaded = false WHERE id = _out_doc;
  GET DIAGNOSTICS _n = ROW_COUNT;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.documents WHERE id = _out_doc;
  SELECT changes, actor_username INTO _changes, _actor FROM public.audit_logs
   WHERE document_id = _out_doc AND action = 'documents_update' ORDER BY created_at DESC, id DESC LIMIT 1;
  _ok := _n = 1 AND _row.janeapp_uploaded = false AND _row.updated_by = _staff AND _actor = 'p3p24_staff'
     AND _changes = jsonb_build_object('janeapp_uploaded', jsonb_build_object('from', NULL, 'to', false));
  _out := _out || format('%s - staff No saved; attributed; history null -> false by p3p24_staff (got %s by %s)',
    CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END, _changes, _actor);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  -- ---- admin: No -> Yes --------------------------------------------------
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _admin::text, true);
  UPDATE public.documents SET janeapp_uploaded = true WHERE id = _out_doc;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.documents WHERE id = _out_doc;
  SELECT changes, actor_username INTO _changes, _actor FROM public.audit_logs
   WHERE document_id = _out_doc AND action = 'documents_update' ORDER BY created_at DESC, id DESC LIMIT 1;
  _ok := _row.janeapp_uploaded = true AND _row.updated_by = _admin AND _actor = 'p3p24_admin'
     AND _changes = jsonb_build_object('janeapp_uploaded', jsonb_build_object('from', false, 'to', true));
  _out := _out || format('%s - admin Yes saved; history false -> true by p3p24_admin (got %s by %s)',
    CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END, _changes, _actor);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  -- ---- unrelated edits preserve the answer; Uploaded flag independent ----
  EXECUTE 'set local role authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _staff, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _staff::text, true);
  UPDATE public.documents SET notes = 'P3P24 unrelated edit', uploaded = true, uploaded_date = now() WHERE id = _out_doc;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.documents WHERE id = _out_doc;
  SELECT changes INTO _changes FROM public.audit_logs
   WHERE document_id = _out_doc AND action = 'documents_update' ORDER BY created_at DESC, id DESC LIMIT 1;
  _ok := _row.janeapp_uploaded = true AND _row.uploaded = true AND NOT (_changes ? 'janeapp_uploaded');
  _out := _out || format('%s - notes + Uploaded-to-patient-system edit keeps JaneApp Yes; history omits janeapp_uploaded',
    CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  EXECUTE 'set local role authenticated';
  UPDATE public.documents SET uploaded = false, uploaded_date = NULL WHERE id = _out_doc;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.documents WHERE id = _out_doc;
  _ok := _row.janeapp_uploaded = true AND _row.uploaded = false;
  _out := _out || format('%s - clearing Uploaded-to-patient-system leaves JaneApp Yes', CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  -- ---- Yes -> No -> cleared back to Unconfirmed --------------------------
  EXECUTE 'set local role authenticated';
  UPDATE public.documents SET janeapp_uploaded = false WHERE id = _out_doc;
  UPDATE public.documents SET janeapp_uploaded = NULL WHERE id = _out_doc;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.documents WHERE id = _out_doc;
  SELECT changes, actor_username INTO _changes, _actor FROM public.audit_logs
   WHERE document_id = _out_doc AND action = 'documents_update' ORDER BY created_at DESC, id DESC LIMIT 1;
  _ok := _row.janeapp_uploaded IS NULL AND _actor = 'p3p24_staff'
     AND _changes = jsonb_build_object('janeapp_uploaded', jsonb_build_object('from', false, 'to', NULL));
  _out := _out || format('%s - Yes -> No -> cleared: NULL stored, history false -> null (got %s)',
    CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END, _changes);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  -- ---- incoming fax accepts the confirmation, stays incoming ------------
  EXECUTE 'set local role authenticated';
  UPDATE public.documents SET janeapp_uploaded = true WHERE id = _in_doc;
  GET DIAGNOSTICS _n = ROW_COUNT;
  EXECUTE format('set local role %I', _owner);
  SELECT * INTO _row FROM public.documents WHERE id = _in_doc;
  _ok := _n = 1 AND _row.janeapp_uploaded = true AND _row.direction = 'incoming' AND _row.received = true
     AND _row.uploaded = false AND _row.recipient_name IS NULL;
  _out := _out || format('%s - incoming fax: Yes saved; direction/received/uploaded/recipient unchanged',
    CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  -- ---- invalid values rejected by type ----------------------------------
  BEGIN
    EXECUTE 'set local role authenticated';
    EXECUTE format('UPDATE public.documents SET janeapp_uploaded = %L WHERE id = %L', 'maybe', _out_doc);
    _failed := _failed + 1; _out := _out || text 'FAIL - "maybe" accepted';
  EXCEPTION WHEN invalid_text_representation THEN _out := _out || text 'ok - non-boolean value rejected';
  END;
  EXECUTE format('set local role %I', _owner);

  -- ---- anonymous / role-less updates stay denied -------------------------
  BEGIN
    EXECUTE 'set local role anon';
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.documents SET janeapp_uploaded = true WHERE id = _out_doc;
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
    UPDATE public.documents SET janeapp_uploaded = true WHERE id = _out_doc;
    GET DIAGNOSTICS _n = ROW_COUNT;
    EXECUTE format('set local role %I', _owner);
    IF _n = 0 THEN _out := _out || text 'ok - role-less update affects 0 rows';
    ELSE _failed := _failed + 1; _out := _out || text 'FAIL - role-less update changed a row'; END IF;
  EXCEPTION WHEN others THEN _out := _out || ('ok - role-less update denied (' || SQLSTATE || ')');
  END;
  EXECUTE format('set local role %I', _owner);
  SELECT janeapp_uploaded IS NULL INTO _ok FROM public.documents WHERE id = _out_doc;
  _out := _out || format('%s - denied writes left the saved value Unconfirmed', CASE WHEN _ok THEN 'ok' ELSE 'FAIL' END);
  IF NOT _ok THEN _failed := _failed + 1; END IF;

  _msg := format('P3P24 RESULT: %s failed', _failed);
  RAISE EXCEPTION '%', _msg || E'\n' || array_to_string(_out, E'\n') || E'\n' || _msg || ' (rolled back)';
END
$verify$;

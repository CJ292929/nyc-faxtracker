-- P3-P17: audited, atomic deletion of a single document (and only that
-- document's fax_attempts/fax_attempt_corrections/document_files), without
-- touching the patient or any other document -- a lighter-weight sibling of
-- public.delete_patient_permanently (0012).
--
-- Same pattern as 0012: a SECURITY DEFINER function that re-checks the
-- caller's role from auth.uid() (never trusts the browser), takes an
-- advisory lock, deletes the document's attempts/files/document row
-- atomically, records a minimal audit event, and queues any attachment
-- storage paths into the existing patient_file_cleanup_queue outbox for
-- durable removal (drained by the same scripts/retry-patient-file-cleanup.mjs
-- worker -- it is not patient-delete-specific, it just drains whatever rows
-- are pending). No schema change to that table is needed: it was never an
-- FK to begin with (see 0012's comment), so reusing it here with
-- patient_ref = this document's patient_id is a safe, minimal extension.
--
-- Unlike delete_patient_permanently, this function takes no confirmation
-- token: a single document is much lower blast-radius than an entire
-- patient, and the client-side confirmation dialog already names the
-- patient and document before calling this function. The advisory lock +
-- server-side role re-check is what makes this safe, not a typed code.
CREATE OR REPLACE FUNCTION public.delete_document(
  _document_id uuid
)
RETURNS TABLE (
  document_id uuid,
  patient_id uuid,
  attempts_deleted integer,
  files_deleted integer,
  storage_paths text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
  _patient_id uuid;
  _paths text[];
  _attempt_count integer;
  _file_count integer;
BEGIN
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT public.is_staff(_caller_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: only staff or admin accounts can delete documents' USING ERRCODE = '28000';
  END IF;

  -- Serialize deletes of the same document so a duplicate/racing submit
  -- (e.g. a fast double-click) cannot both pass the existence check below;
  -- the second caller instead gets NOT_FOUND once the first has committed.
  PERFORM pg_advisory_xact_lock(hashtext('public.delete_document:' || _document_id::text));

  SELECT d.patient_id INTO _patient_id FROM public.documents d WHERE d.id = _document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: document does not exist' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(array_agg(df.storage_path), '{}')
  INTO _paths
  FROM public.document_files df
  WHERE df.document_id = _document_id;

  SELECT count(*) INTO _file_count
  FROM public.document_files df
  WHERE df.document_id = _document_id;

  -- Cascades to fax_attempt_corrections automatically via its existing
  -- ON DELETE CASCADE (0011_correct_fax_attempts.sql).
  DELETE FROM public.fax_attempts fa WHERE fa.document_id = _document_id;
  GET DIAGNOSTICS _attempt_count = ROW_COUNT;

  DELETE FROM public.document_files df WHERE df.document_id = _document_id;

  -- Exactly one row: the patient row and every other document (including
  -- one with otherwise-identical values) are untouched.
  DELETE FROM public.documents d WHERE d.id = _document_id;

  IF array_length(_paths, 1) > 0 THEN
    INSERT INTO public.patient_file_cleanup_queue (storage_path, patient_ref)
    SELECT path, _patient_id FROM unnest(_paths) AS path;
  END IF;

  -- Minimal audit event: actor, time (created_at default), and
  -- non-identifying references (document_id/patient_id, already the
  -- convention for audit_logs -- no document contents are ever written
  -- here).
  INSERT INTO public.audit_logs (user_id, patient_id, document_id, action, description)
  VALUES (
    _caller_id,
    _patient_id,
    _document_id,
    'document_deleted_permanently',
    format('Permanently deleted document (attempts=%s, files=%s)', _attempt_count, _file_count)
  );

  RETURN QUERY SELECT _document_id, _patient_id, _attempt_count, _file_count, _paths;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_document(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_document(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_document(uuid) FROM anon;

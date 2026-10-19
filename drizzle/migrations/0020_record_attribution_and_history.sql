-- P3-P18: record attribution (created by / last updated by), per-record
-- View History, and a filterable admin activity log -- built on the
-- existing public.audit_logs table and the audit trigger installed by
-- 0000_create_fax_tracker.sql, not a competing audit system.
--
-- Gaps this closes (all found by tracing the write paths before 0020):
--   * log_fax_change (0000) records the actor (auth.uid()) but no changed
--     fields, no username, and logs a row for every UPDATE even when nothing
--     changed (e.g. re-saving the Upload or Received dialog unchanged).
--   * patients/documents had no creator/editor columns, and updated_at was
--     never maintained (it stayed equal to created_at forever).
--   * fax_attempts.created_by, documents.uploaded_by and
--     document_files.uploaded_by were browser-supplied, so a direct REST
--     call could forge them.
--   * delete_staff_account (0014) removes public.user_logins, so a deleted
--     account's past audit rows could no longer be resolved to a username.
--   * fax_attempt_corrected rows had no patient_id, so they could not appear
--     in patient-level history.
--
-- Attribution is always derived inside the database from auth.uid() (the
-- verified JWT of the PostgREST request) -- never from a column value the
-- client sent. A write with no authenticated user (service role,
-- migrations, maintenance scripts) is recorded honestly as 'system', and a
-- record whose creator cannot be proven from existing evidence is
-- 'unknown' (shown as "Unknown — recorded before tracking.").

-- ---------------------------------------------------------------------------
-- 1. Stop the old generic trigger first, so none of the backfill UPDATEs
--    below fire it and fabricate "updated" events attributed to nobody.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_patients ON public.patients;
DROP TRIGGER IF EXISTS audit_documents ON public.documents;
DROP TRIGGER IF EXISTS audit_attempts ON public.fax_attempts;
DROP TRIGGER IF EXISTS audit_files ON public.document_files;
DROP FUNCTION IF EXISTS public.log_fax_change();

-- ---------------------------------------------------------------------------
-- 2. Columns
-- ---------------------------------------------------------------------------
-- actor_username is a snapshot taken at write time, so renaming or deleting
-- the account later never makes a past event unattributable or point at
-- someone else. record_type/record_id identify exactly what the event is
-- about (patient_id/document_id remain the parent links used for history).
-- changes holds only the business fields that actually changed, as
-- {"field": {"from": <old>, "to": <new>}} -- never passwords, tokens,
-- storage paths, or file contents.
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS actor_username text;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS actor_kind text;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS record_type text;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS record_id uuid;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS changes jsonb;
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_actor_kind_check CHECK (actor_kind IS NULL OR actor_kind IN ('user','system'));
-- Wall-clock time, not now() (frozen at transaction start): several events
-- written in one transaction (e.g. a document deletion's scrub + deletion
-- event, or a correction) must keep their real order in history instead of
-- tying and sorting by random id. The backfill below only reads timestamps
-- already stored, so it is unaffected.
ALTER TABLE public.audit_logs ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- *_kind: 'user' (an authenticated account, *_by/*_by_name set), 'system'
-- (no authenticated user: service role / maintenance), or 'unknown'
-- (recorded before tracking and not provable from existing evidence).
-- Existing rows start as 'unknown' and are upgraded below only on exact
-- evidence.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS created_by_kind text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS updated_by uuid;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS updated_by_name text;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS updated_by_kind text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.patients
  ADD CONSTRAINT patients_created_by_kind_check CHECK (created_by_kind IN ('user','system','unknown')),
  ADD CONSTRAINT patients_updated_by_kind_check CHECK (updated_by_kind IN ('user','system','unknown'));

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS created_by_kind text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS updated_by uuid;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS updated_by_name text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS updated_by_kind text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.documents
  ADD CONSTRAINT documents_created_by_kind_check CHECK (created_by_kind IN ('user','system','unknown')),
  ADD CONSTRAINT documents_updated_by_kind_check CHECK (updated_by_kind IN ('user','system','unknown'));

-- fax_attempts.created_by already exists (0000); add the name snapshot and
-- kind so each attempt can show who recorded it.
ALTER TABLE public.fax_attempts ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE public.fax_attempts ADD COLUMN IF NOT EXISTS created_by_kind text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.fax_attempts
  ADD CONSTRAINT fax_attempts_created_by_kind_check CHECK (created_by_kind IN ('user','system','unknown'));

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON public.audit_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_patient_idx ON public.audit_logs (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_document_idx ON public.audit_logs (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON public.audit_logs (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Shared helpers
-- ---------------------------------------------------------------------------
-- Field diff used by both the attribution trigger (to decide whether an
-- UPDATE really changed anything) and the audit trigger (to record what
-- changed), so "last updated by" and the history can never disagree.
-- NULL and '' are treated as the same "blank" value: the patient form
-- writes '' where bulk upload writes NULL, and re-saving a form unchanged
-- must not show up as an edit.
CREATE OR REPLACE FUNCTION public.audit_field_changes(_old jsonb, _new jsonb, _excluded text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
  FROM jsonb_each(_new) n
  JOIN jsonb_each(_old) o USING (key)
  WHERE NOT (n.key = ANY(_excluded))
    AND (CASE WHEN n.value IN ('null'::jsonb, '""'::jsonb) THEN NULL ELSE n.value END)
        IS DISTINCT FROM
        (CASE WHEN o.value IN ('null'::jsonb, '""'::jsonb) THEN NULL ELSE o.value END)
$$;

-- Columns that are bookkeeping, not business data: never shown as a
-- "changed field" and never count as an edit on their own.
CREATE OR REPLACE FUNCTION public.audit_excluded_fields()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['id','created_at','updated_at','created_by','created_by_name','created_by_kind',
               'updated_by','updated_by_name','updated_by_kind','uploaded_by']::text[]
$$;

REVOKE ALL ON FUNCTION public.audit_field_changes(jsonb, jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_excluded_fields() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Attribution trigger (BEFORE INSERT/UPDATE) -- anti-forgery
-- ---------------------------------------------------------------------------
-- Overwrites every attribution column on every write, so values sent in a
-- direct REST insert/update are ignored. On UPDATE the original creation
-- attribution is always carried over from OLD, and the editor/updated_at
-- only move when a business field really changed.
CREATE OR REPLACE FUNCTION public.set_record_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _name text;
  _kind text := CASE WHEN _uid IS NULL THEN 'system' ELSE 'user' END;
BEGIN
  IF _uid IS NOT NULL THEN
    SELECT username INTO _name FROM public.user_logins WHERE user_id = _uid;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A signed-in user cannot backdate a record; system/maintenance writes
    -- (e.g. seeded demo data) may supply their own timestamp.
    IF _uid IS NOT NULL OR NEW.created_at IS NULL THEN
      NEW.created_at := now();
    END IF;
    NEW.created_by := _uid;
    NEW.created_by_name := _name;
    NEW.created_by_kind := _kind;
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := _uid;
    NEW.updated_by_name := _name;
    NEW.updated_by_kind := _kind;
    IF TG_TABLE_NAME = 'documents' THEN
      NEW.uploaded_by := CASE WHEN NEW.uploaded THEN _uid END;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: creation attribution is immutable.
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.created_by_name := OLD.created_by_name;
  NEW.created_by_kind := OLD.created_by_kind;

  IF TG_TABLE_NAME = 'documents' THEN
    IF NEW.uploaded IS DISTINCT FROM OLD.uploaded OR NEW.uploaded_date IS DISTINCT FROM OLD.uploaded_date THEN
      NEW.uploaded_by := CASE WHEN NEW.uploaded THEN _uid END;
    ELSE
      NEW.uploaded_by := OLD.uploaded_by;
    END IF;
  END IF;

  IF public.audit_field_changes(to_jsonb(OLD), to_jsonb(NEW), public.audit_excluded_fields()) IS NULL THEN
    -- Nothing a person would call an edit: keep the previous editor.
    NEW.updated_at := OLD.updated_at;
    NEW.updated_by := OLD.updated_by;
    NEW.updated_by_name := OLD.updated_by_name;
    NEW.updated_by_kind := OLD.updated_by_kind;
  ELSE
    NEW.updated_at := now();
    NEW.updated_by := _uid;
    NEW.updated_by_name := _name;
    NEW.updated_by_kind := _kind;
  END IF;
  RETURN NEW;
END;
$$;

-- fax_attempts / document_files: only INSERT is possible from clients (no
-- UPDATE policy exists; corrections go through correct_fax_attempt), so the
-- recorder is fixed at insert time from auth.uid().
CREATE OR REPLACE FUNCTION public.set_child_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF TG_TABLE_NAME = 'fax_attempts' THEN
    NEW.created_by := _uid;
    NEW.created_by_kind := CASE WHEN _uid IS NULL THEN 'system' ELSE 'user' END;
    NEW.created_by_name := NULL;
    IF _uid IS NOT NULL THEN
      SELECT username INTO NEW.created_by_name FROM public.user_logins WHERE user_id = _uid;
    END IF;
  ELSIF TG_TABLE_NAME = 'document_files' THEN
    NEW.uploaded_by := _uid;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Audit trigger (AFTER INSERT/UPDATE) -- same transaction as the write
-- ---------------------------------------------------------------------------
-- Replaces log_fax_change. Runs in the same transaction as the mutation, so
-- an audit failure aborts the write (no unaudited successful change), and a
-- rejected/rolled-back write never leaves a success event behind. A no-op
-- UPDATE writes no event. Action codes keep the names already present in
-- historical rows (patients_insert, documents_update, ...) so old and new
-- events filter together; document updates that only touch the received or
-- upload fields get their own codes.
CREATE OR REPLACE FUNCTION public.audit_record_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _changes jsonb;
  _keys text[];
  _action text;
  _description text;
  _patient uuid;
  _document uuid;
  _record_type text;
  _received_fields text[] := ARRAY['received','received_date','received_document_type','received_from','received_fax','received_notes'];
  _upload_fields text[] := ARRAY['uploaded','uploaded_date'];
BEGIN
  IF TG_TABLE_NAME = 'patients' THEN
    _record_type := 'patient';
    _patient := NEW.id;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    _record_type := 'document';
    _patient := NEW.patient_id;
    _document := NEW.id;
  ELSIF TG_TABLE_NAME = 'fax_attempts' THEN
    _record_type := 'fax_attempt';
    _document := NEW.document_id;
    SELECT d.patient_id INTO _patient FROM public.documents d WHERE d.id = _document;
  ELSIF TG_TABLE_NAME = 'document_files' THEN
    _record_type := 'document_file';
    _document := NEW.document_id;
    SELECT d.patient_id INTO _patient FROM public.documents d WHERE d.id = _document;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    _changes := public.audit_field_changes(to_jsonb(OLD), to_jsonb(NEW), public.audit_excluded_fields());
    IF _changes IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT array_agg(k) INTO _keys FROM jsonb_object_keys(_changes) k;
    IF TG_TABLE_NAME = 'patients' THEN
      _action := 'patients_update';
      _description := 'Patient updated';
    ELSIF _keys <@ _received_fields THEN
      _action := 'document_received_updated';
      _description := 'Received status updated';
    ELSIF _keys <@ _upload_fields THEN
      _action := 'document_upload_updated';
      _description := 'Upload status updated';
    ELSE
      _action := 'documents_update';
      _description := 'Document updated';
    END IF;
  ELSE
    -- Creation: the record itself holds its values, so only the few fields
    -- needed to identify the event in history are copied here.
    IF TG_TABLE_NAME = 'patients' THEN
      _action := 'patients_insert';
      _description := 'Patient created';
    ELSIF TG_TABLE_NAME = 'documents' THEN
      _action := 'documents_insert';
      _description := 'Document created';
      _changes := jsonb_strip_nulls(jsonb_build_object(
        'document_type', jsonb_build_object('to', NEW.document_type),
        'document_number', CASE WHEN NEW.document_number IS NOT NULL THEN jsonb_build_object('to', NEW.document_number) END));
    ELSIF TG_TABLE_NAME = 'fax_attempts' THEN
      _action := 'fax_attempts_insert';
      _description := format('Fax attempt #%s recorded', NEW.attempt_number);
      _changes := jsonb_strip_nulls(jsonb_build_object(
        'attempt_number', jsonb_build_object('to', NEW.attempt_number),
        'status', jsonb_build_object('to', NEW.status),
        'attempted_at', jsonb_build_object('to', NEW.attempted_at),
        'failure_reason', CASE WHEN NULLIF(btrim(NEW.failure_reason), '') IS NOT NULL THEN jsonb_build_object('to', NEW.failure_reason) END));
    ELSE
      _action := 'document_files_insert';
      _description := 'File attached';
      -- File name only: never the storage path or the file contents.
      _changes := jsonb_build_object('file_name', jsonb_build_object('to', NEW.file_name));
    END IF;
  END IF;

  INSERT INTO public.audit_logs (user_id, patient_id, document_id, action, description, record_type, record_id, changes)
  VALUES (auth.uid(), _patient, _document, _action, _description, _record_type, NEW.id, _changes);
  RETURN NULL;
END;
$$;

-- Every audit row gets its actor snapshot and kind from the database, no
-- matter which server path inserted it (triggers, SECURITY DEFINER
-- functions, or the service-role account-admin server functions). Clients
-- cannot insert into audit_logs at all (SELECT-only grant, no INSERT policy).
CREATE OR REPLACE FUNCTION public.audit_logs_fill_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.actor_kind := CASE WHEN NEW.user_id IS NULL THEN 'system' ELSE 'user' END;
  NEW.actor_username := NULL;
  IF NEW.user_id IS NOT NULL THEN
    SELECT username INTO NEW.actor_username FROM public.user_logins WHERE user_id = NEW.user_id;
  END IF;
  IF NEW.record_type IS NULL THEN
    NEW.record_type := CASE
      WHEN NEW.action IN ('role_changed','account_created','password_reset','account_deleted') THEN 'account'
      WHEN NEW.action = 'patient_deleted_permanently' THEN 'patient'
      WHEN NEW.action IN ('document_deleted_permanently','attachment_cleanup_completed','attachment_cleanup_pending') THEN 'document'
      WHEN NEW.action = 'fax_attempt_corrected' THEN 'fax_attempt'
    END;
    IF NEW.record_id IS NULL THEN
      NEW.record_id := CASE NEW.record_type
        WHEN 'patient' THEN NEW.patient_id
        WHEN 'document' THEN NEW.document_id
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Permanent deletion must not be defeated by the audit trail: when a
-- patient or document row is deleted (only possible through
-- delete_patient_permanently / delete_document -- there is no DELETE
-- policy), strip the field values from that record's past events in the
-- same transaction. The minimal skeleton (who, what action, when) stays,
-- and the deletion event itself is written after this runs.
CREATE OR REPLACE FUNCTION public.scrub_audit_details_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    UPDATE public.audit_logs a SET
      changes = NULL,
      description = CASE WHEN a.action = 'fax_attempt_corrected' THEN 'Fax attempt corrected' ELSE a.description END
    WHERE a.document_id = OLD.id AND (a.changes IS NOT NULL OR a.action = 'fax_attempt_corrected');
  ELSE
    UPDATE public.audit_logs a SET
      changes = NULL,
      description = CASE WHEN a.action = 'fax_attempt_corrected' THEN 'Fax attempt corrected' ELSE a.description END
    WHERE a.patient_id = OLD.id AND (a.changes IS NOT NULL OR a.action = 'fax_attempt_corrected');
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.set_record_attribution() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_child_attribution() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_record_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_logs_fill_actor() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scrub_audit_details_on_delete() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Backfill -- exact evidence only, never inferred
-- ---------------------------------------------------------------------------
-- audit_logs rows written by log_fax_change carry the server-derived
-- auth.uid() and were inserted in the same transaction as the row, so their
-- created_at equals the row's created_at exactly (both now()). A creator is
-- only filled in when exactly one such insert event matches; a NULL actor
-- on a matching event means no signed-in user (service role/migration) and
-- is recorded as 'system'. Anything else stays 'unknown'.

-- 6a. Actor snapshot and record linkage on existing audit rows. Usernames
-- have never been renameable in this app, so the current mapping is the
-- name the account had when it acted; rows from already-deleted accounts
-- keep a NULL name and are shown as a removed account.
UPDATE public.audit_logs a SET
  actor_kind = CASE WHEN a.user_id IS NULL THEN 'system' ELSE 'user' END,
  actor_username = (SELECT ul.username FROM public.user_logins ul WHERE ul.user_id = a.user_id),
  record_type = CASE
    WHEN a.action IN ('patients_insert','patients_update','patient_deleted_permanently') THEN 'patient'
    WHEN a.action IN ('documents_insert','documents_update','document_deleted_permanently') THEN 'document'
    WHEN a.action IN ('fax_attempts_insert','fax_attempt_corrected') THEN 'fax_attempt'
    WHEN a.action = 'document_files_insert' THEN 'document_file'
    WHEN a.action IN ('role_changed','account_created','password_reset','account_deleted') THEN 'account'
  END,
  record_id = CASE
    WHEN a.action IN ('patients_insert','patients_update','patient_deleted_permanently') THEN a.patient_id
    WHEN a.action IN ('documents_insert','documents_update','document_deleted_permanently') THEN a.document_id
  END;

UPDATE public.audit_logs a SET record_id = m.id
FROM (
  SELECT a2.id AS audit_id, min(fa.id::text)::uuid AS id
  FROM public.audit_logs a2
  JOIN public.fax_attempts fa ON fa.document_id = a2.document_id AND fa.created_at = a2.created_at
  WHERE a2.action = 'fax_attempts_insert'
  GROUP BY a2.id
  HAVING count(*) = 1
) m
WHERE a.id = m.audit_id;

UPDATE public.audit_logs a SET record_id = m.id
FROM (
  SELECT a2.id AS audit_id, min(df.id::text)::uuid AS id
  FROM public.audit_logs a2
  JOIN public.document_files df ON df.document_id = a2.document_id AND df.uploaded_at = a2.created_at
  WHERE a2.action = 'document_files_insert'
  GROUP BY a2.id
  HAVING count(*) = 1
) m
WHERE a.id = m.audit_id;

-- Corrections: link to the attempt, add the patient (so they appear in
-- patient history), and recover the field diff + reason from the matching
-- fax_attempt_corrections row (written in the same transaction).
UPDATE public.audit_logs a SET
  record_id = m.attempt_id,
  patient_id = m.patient_id,
  changes = coalesce(public.audit_field_changes(m.before, m.after, public.audit_excluded_fields()), '{}'::jsonb)
            || jsonb_build_object('correction_reason', jsonb_build_object('to', m.reason))
FROM (
  SELECT a2.id AS audit_id, min(c.attempt_id::text)::uuid AS attempt_id, min(d.patient_id::text)::uuid AS patient_id,
         (array_agg(c.before))[1] AS before, (array_agg(c.after))[1] AS after, (array_agg(c.reason))[1] AS reason
  FROM public.audit_logs a2
  JOIN public.fax_attempt_corrections c ON c.created_at = a2.created_at
  JOIN public.fax_attempts fa ON fa.id = c.attempt_id AND fa.document_id = a2.document_id
  JOIN public.documents d ON d.id = fa.document_id
  WHERE a2.action = 'fax_attempt_corrected'
  GROUP BY a2.id
  HAVING count(*) = 1
) m
WHERE a.id = m.audit_id;

-- 6b. Creation attribution.
UPDATE public.patients p SET
  created_by = e.user_id,
  created_by_name = e.actor_username,
  created_by_kind = e.actor_kind
FROM (
  SELECT a.patient_id, min(a.user_id::text)::uuid AS user_id, min(a.actor_username) AS actor_username,
         min(a.actor_kind) AS actor_kind, a.created_at
  FROM public.audit_logs a
  WHERE a.action = 'patients_insert'
  GROUP BY a.patient_id, a.created_at
  HAVING count(*) = 1
) e
WHERE e.patient_id = p.id AND e.created_at = p.created_at;

UPDATE public.documents d SET
  created_by = e.user_id,
  created_by_name = e.actor_username,
  created_by_kind = e.actor_kind
FROM (
  SELECT a.document_id, min(a.user_id::text)::uuid AS user_id, min(a.actor_username) AS actor_username,
         min(a.actor_kind) AS actor_kind, a.created_at
  FROM public.audit_logs a
  WHERE a.action = 'documents_insert'
  GROUP BY a.document_id, a.created_at
  HAVING count(*) = 1
) e
WHERE e.document_id = d.id AND e.created_at = d.created_at;

-- A user-attributed creator whose account was already deleted before this
-- migration has a provable id but no recoverable name: keep it 'unknown'
-- rather than show a blank or guessed name.
UPDATE public.patients SET created_by_kind = 'unknown', created_by = NULL
  WHERE created_by_kind = 'user' AND created_by_name IS NULL;
UPDATE public.documents SET created_by_kind = 'unknown', created_by = NULL
  WHERE created_by_kind = 'user' AND created_by_name IS NULL;

-- Attempts: the server-derived audit actor replaces the browser-supplied
-- created_by only where exactly one insert event matches; otherwise the
-- attempt is 'unknown' and its legacy created_by is not displayed.
UPDATE public.fax_attempts fa SET
  created_by = a.user_id,
  created_by_name = a.actor_username,
  created_by_kind = CASE WHEN a.actor_kind = 'user' AND a.actor_username IS NULL THEN 'unknown' ELSE a.actor_kind END
FROM public.audit_logs a
WHERE a.action = 'fax_attempts_insert' AND a.record_id = fa.id;

-- 6c. Last-update attribution: the most recent recorded update event for
-- the record (every UPDATE has been audited since 0000). With no update
-- event the record has not been edited since creation, so "last updated"
-- equals the creation attribution (including 'unknown').
UPDATE public.patients SET
  updated_at = created_at, updated_by = created_by, updated_by_name = created_by_name, updated_by_kind = created_by_kind;
UPDATE public.documents SET
  updated_at = created_at, updated_by = created_by, updated_by_name = created_by_name, updated_by_kind = created_by_kind;

UPDATE public.patients p SET
  updated_at = e.created_at,
  updated_by = CASE WHEN e.actor_kind = 'user' AND e.actor_username IS NULL THEN NULL ELSE e.user_id END,
  updated_by_name = e.actor_username,
  updated_by_kind = CASE WHEN e.actor_kind = 'user' AND e.actor_username IS NULL THEN 'unknown' ELSE e.actor_kind END
FROM (
  SELECT DISTINCT ON (a.patient_id) a.patient_id, a.user_id, a.actor_username, a.actor_kind, a.created_at
  FROM public.audit_logs a
  WHERE a.action = 'patients_update'
  ORDER BY a.patient_id, a.created_at DESC, a.id DESC
) e
WHERE e.patient_id = p.id AND e.created_at >= p.created_at;

UPDATE public.documents d SET
  updated_at = e.created_at,
  updated_by = CASE WHEN e.actor_kind = 'user' AND e.actor_username IS NULL THEN NULL ELSE e.user_id END,
  updated_by_name = e.actor_username,
  updated_by_kind = CASE WHEN e.actor_kind = 'user' AND e.actor_username IS NULL THEN 'unknown' ELSE e.actor_kind END
FROM (
  SELECT DISTINCT ON (a.document_id) a.document_id, a.user_id, a.actor_username, a.actor_kind, a.created_at
  FROM public.audit_logs a
  WHERE a.action = 'documents_update'
  ORDER BY a.document_id, a.created_at DESC, a.id DESC
) e
WHERE e.document_id = d.id AND e.created_at >= d.created_at;

-- ---------------------------------------------------------------------------
-- 7. Install triggers (after the backfill, so it fired none of them)
-- ---------------------------------------------------------------------------
CREATE TRIGGER set_patient_attribution BEFORE INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.set_record_attribution();
CREATE TRIGGER set_document_attribution BEFORE INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_record_attribution();
CREATE TRIGGER set_attempt_attribution BEFORE INSERT ON public.fax_attempts
  FOR EACH ROW EXECUTE FUNCTION public.set_child_attribution();
CREATE TRIGGER set_file_attribution BEFORE INSERT ON public.document_files
  FOR EACH ROW EXECUTE FUNCTION public.set_child_attribution();

CREATE TRIGGER audit_patients AFTER INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
CREATE TRIGGER audit_documents AFTER INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
CREATE TRIGGER audit_attempts AFTER INSERT ON public.fax_attempts
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
CREATE TRIGGER audit_files AFTER INSERT ON public.document_files
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();

CREATE TRIGGER audit_logs_fill_actor BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_fill_actor();

CREATE TRIGGER scrub_audit_on_document_delete AFTER DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.scrub_audit_details_on_delete();
CREATE TRIGGER scrub_audit_on_patient_delete AFTER DELETE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.scrub_audit_details_on_delete();

-- ---------------------------------------------------------------------------
-- 8. correct_fax_attempt / delete_document: richer audit rows
-- ---------------------------------------------------------------------------
-- Same 15-arg signature and body as 0018 (role recheck, reason/failure/NPI
-- validation, advisory lock, CONFLICT concurrency check all unchanged); the
-- only difference is the audit_logs insert now records the patient, the
-- attempt, and the changed fields + reason, so corrections show up once
-- (not duplicated) in document and patient history.
CREATE OR REPLACE FUNCTION public.correct_fax_attempt(
  _attempt_id uuid,
  _expected_updated_at timestamptz,
  _attempted_at timestamptz,
  _status text,
  _failure_reason text,
  _confirmation_number text,
  _notes text,
  _reason text,
  _md_name text,
  _recipient_type text,
  _recipient_name text,
  _recipient_fax text,
  _md_npi text,
  _md_office_phone text,
  _md_fax text
)
RETURNS TABLE (
  id uuid, document_id uuid, attempt_number integer, attempted_at timestamptz,
  status text, failure_reason text, confirmation_number text, notes text, updated_at timestamptz, md_name text,
  recipient_type text, recipient_name text, recipient_fax text,
  md_npi text, md_office_phone text, md_fax text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
  _before public.fax_attempts%ROWTYPE;
  _after public.fax_attempts%ROWTYPE;
  _caller_username text;
  _patient_id uuid;
BEGIN
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT public.is_staff(_caller_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: only staff or admin accounts can correct fax attempts' USING ERRCODE = '28000';
  END IF;

  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a correction reason is required' USING ERRCODE = '23514';
  END IF;

  IF _status = 'Failed' AND (_failure_reason IS NULL OR btrim(_failure_reason) = '') THEN
    RAISE EXCEPTION 'FAILURE_REASON_REQUIRED: a failure reason is required for Failed status' USING ERRCODE = '23514';
  END IF;

  IF _md_npi IS NOT NULL AND btrim(_md_npi) <> '' AND btrim(_md_npi) !~ '^[0-9]{10}$' THEN
    RAISE EXCEPTION 'MD_NPI_INVALID: MD NPI must be exactly 10 digits' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.correct_fax_attempt:' || _attempt_id::text));

  SELECT fa.* INTO _before FROM public.fax_attempts fa WHERE fa.id = _attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: attempt does not exist' USING ERRCODE = 'P0002';
  END IF;

  IF _before.updated_at IS DISTINCT FROM _expected_updated_at THEN
    RAISE EXCEPTION 'CONFLICT: attempt was changed by someone else since it was loaded';
  END IF;

  -- attempt_number, document_id, created_by, created_at are never touched.
  UPDATE public.fax_attempts fa SET
    attempted_at = _attempted_at,
    status = _status,
    failure_reason = NULLIF(btrim(_failure_reason), ''),
    confirmation_number = NULLIF(btrim(_confirmation_number), ''),
    notes = NULLIF(btrim(_notes), ''),
    md_name = NULLIF(btrim(_md_name), ''),
    recipient_type = NULLIF(btrim(_recipient_type), ''),
    recipient_name = NULLIF(btrim(_recipient_name), ''),
    recipient_fax = NULLIF(btrim(_recipient_fax), ''),
    md_npi = NULLIF(btrim(_md_npi), ''),
    md_office_phone = NULLIF(btrim(_md_office_phone), ''),
    md_fax = NULLIF(btrim(_md_fax), ''),
    updated_at = clock_timestamp()
  WHERE fa.id = _attempt_id;

  SELECT fa.* INTO _after FROM public.fax_attempts fa WHERE fa.id = _attempt_id;
  SELECT username INTO _caller_username FROM public.user_logins WHERE user_id = _caller_id;
  SELECT d.patient_id INTO _patient_id FROM public.documents d WHERE d.id = _before.document_id;

  INSERT INTO public.fax_attempt_corrections (attempt_id, corrected_by, corrected_by_username, reason, before, after)
  VALUES (_attempt_id, _caller_id, _caller_username, _reason, to_jsonb(_before), to_jsonb(_after));

  INSERT INTO public.audit_logs (user_id, patient_id, document_id, action, description, record_type, record_id, changes)
  VALUES (
    _caller_id,
    _patient_id,
    _before.document_id,
    'fax_attempt_corrected',
    format('Corrected attempt #%s: status %s -> %s (%s)', _before.attempt_number, _before.status, _status, _reason),
    'fax_attempt',
    _attempt_id,
    coalesce(public.audit_field_changes(to_jsonb(_before), to_jsonb(_after), public.audit_excluded_fields()), '{}'::jsonb)
      || jsonb_build_object('correction_reason', jsonb_build_object('to', _reason))
  );

  RETURN QUERY SELECT fa.id, fa.document_id, fa.attempt_number, fa.attempted_at, fa.status, fa.failure_reason, fa.confirmation_number, fa.notes, fa.updated_at, fa.md_name,
    fa.recipient_type, fa.recipient_name, fa.recipient_fax,
    fa.md_npi, fa.md_office_phone, fa.md_fax
    FROM public.fax_attempts fa WHERE fa.id = _attempt_id;
END;
$$;

-- Same signature and body as 0019; the deletion event now also names the
-- deleted document (type and number only -- no contents) so the surviving
-- patient's history says which document was removed, and states that
-- attachment removal was queued rather than implying it already finished.
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
  _label text;
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

  PERFORM pg_advisory_xact_lock(hashtext('public.delete_document:' || _document_id::text));

  SELECT d.patient_id, d.document_type || coalesce(' #' || d.document_number, '')
    INTO _patient_id, _label
    FROM public.documents d WHERE d.id = _document_id;
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

  DELETE FROM public.fax_attempts fa WHERE fa.document_id = _document_id;
  GET DIAGNOSTICS _attempt_count = ROW_COUNT;

  DELETE FROM public.document_files df WHERE df.document_id = _document_id;

  DELETE FROM public.documents d WHERE d.id = _document_id;

  IF array_length(_paths, 1) > 0 THEN
    INSERT INTO public.patient_file_cleanup_queue (storage_path, patient_ref)
    SELECT path, _patient_id FROM unnest(_paths) AS path;
  END IF;

  INSERT INTO public.audit_logs (user_id, patient_id, document_id, action, description, record_type, record_id, changes)
  VALUES (
    _caller_id,
    _patient_id,
    _document_id,
    'document_deleted_permanently',
    format('Permanently deleted document (attempts=%s, files=%s; attachment removal queued)', _attempt_count, _file_count),
    'document',
    _document_id,
    jsonb_build_object('document', jsonb_build_object('from', _label))
  );

  RETURN QUERY SELECT _document_id, _patient_id, _attempt_count, _file_count, _paths;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Read RPCs
-- ---------------------------------------------------------------------------
-- Record history for staff/admin. audit_logs itself stays admin-only (RLS
-- from 0000); this function exposes only the events of one record the
-- caller can access, applying the same predicate as the patients/documents
-- SELECT policies (public.is_staff). user_logins is never exposed -- only
-- the actor snapshot already on each event.
CREATE OR REPLACE FUNCTION public.get_record_history(
  _record_type text,
  _record_id uuid,
  _limit integer DEFAULT 50,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  action text,
  description text,
  actor_username text,
  actor_kind text,
  actor_account_removed boolean,
  record_type text,
  record_id uuid,
  document_id uuid,
  document_label text,
  attempt_number integer,
  changes jsonb,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
BEGIN
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_staff(_caller_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: only staff or admin accounts can view record history' USING ERRCODE = '28000';
  END IF;
  IF _record_type NOT IN ('patient','document') THEN
    RAISE EXCEPTION 'INVALID: unsupported record type' USING ERRCODE = '22023';
  END IF;
  IF _record_type = 'patient' AND NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.id = _record_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: record does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF _record_type = 'document' AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.id = _record_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: record does not exist' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT a.id, a.created_at, a.action, a.description, a.actor_username, a.actor_kind,
         (a.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_logins ul WHERE ul.user_id = a.user_id)),
         a.record_type, a.record_id, a.document_id,
         coalesce(d.document_type || coalesce(' #' || d.document_number, ''), a.changes #>> '{document,from}'),
         coalesce(fa.attempt_number, (a.changes #>> '{attempt_number,to}')::integer),
         a.changes,
         count(*) OVER ()
  FROM public.audit_logs a
  LEFT JOIN public.documents d ON d.id = a.document_id
  LEFT JOIN public.fax_attempts fa ON a.record_type = 'fax_attempt' AND fa.id = a.record_id
  WHERE CASE WHEN _record_type = 'patient' THEN a.patient_id = _record_id ELSE a.document_id = _record_id END
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(_limit, 50), 1), 100)
  OFFSET greatest(coalesce(_offset, 0), 0);
END;
$$;

-- Account-status flags for the "Created by / Last updated by" line, so an
-- attribution to a since-deleted account is labelled as such instead of
-- looking like a current account (usernames can be reused after deletion).
CREATE OR REPLACE FUNCTION public.get_actor_status(_user_ids uuid[])
RETURNS TABLE (user_id uuid, account_removed boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN: only staff or admin accounts can view attribution' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT u, NOT EXISTS (SELECT 1 FROM public.user_logins ul WHERE ul.user_id = u)
  FROM unnest(_user_ids[1:50]) AS u
  WHERE u IS NOT NULL;
END;
$$;

-- Global activity log: admin only, server-side filters and pagination.
-- Re-checks the admin role from auth.uid() on every call, so a staff
-- account calling it directly over REST is rejected.
CREATE OR REPLACE FUNCTION public.get_audit_activity(
  _actor_id uuid DEFAULT NULL,
  _actor_kind text DEFAULT NULL,
  _from timestamptz DEFAULT NULL,
  _to timestamptz DEFAULT NULL,
  _action text DEFAULT NULL,
  _record_type text DEFAULT NULL,
  _limit integer DEFAULT 50,
  _offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  action text,
  description text,
  user_id uuid,
  actor_username text,
  actor_kind text,
  actor_account_removed boolean,
  record_type text,
  record_id uuid,
  patient_id uuid,
  patient_code text,
  document_id uuid,
  document_label text,
  attempt_number integer,
  changes jsonb,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
BEGIN
  IF _caller_id IS NULL OR NOT public.has_role(_caller_id, 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: only administrators can view the activity log' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  SELECT a.id, a.created_at, a.action, a.description, a.user_id, a.actor_username, a.actor_kind,
         (a.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_logins ul WHERE ul.user_id = a.user_id)),
         a.record_type, a.record_id, a.patient_id, p.patient_id, a.document_id,
         coalesce(d.document_type || coalesce(' #' || d.document_number, ''), a.changes #>> '{document,from}'),
         coalesce(fa.attempt_number, (a.changes #>> '{attempt_number,to}')::integer),
         a.changes,
         count(*) OVER ()
  FROM public.audit_logs a
  LEFT JOIN public.patients p ON p.id = a.patient_id
  LEFT JOIN public.documents d ON d.id = a.document_id
  LEFT JOIN public.fax_attempts fa ON a.record_type = 'fax_attempt' AND fa.id = a.record_id
  WHERE (_actor_id IS NULL OR a.user_id = _actor_id)
    AND (_actor_kind IS NULL OR a.actor_kind = _actor_kind)
    AND (_from IS NULL OR a.created_at >= _from)
    AND (_to IS NULL OR a.created_at < _to)
    AND (_action IS NULL OR a.action = _action)
    AND (_record_type IS NULL OR a.record_type = _record_type)
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT least(greatest(coalesce(_limit, 50), 1), 100)
  OFFSET greatest(coalesce(_offset, 0), 0);
END;
$$;

-- Accounts for the activity-log filter: every current login (admins
-- included, since admins edit records too) plus any removed account that
-- still appears in the log under its snapshot name.
CREATE OR REPLACE FUNCTION public.list_audit_actors()
RETURNS TABLE (user_id uuid, username text, role text, account_removed boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: only administrators can view the activity log' USING ERRCODE = '28000';
  END IF;
  RETURN QUERY
  SELECT x.uid, x.uname, x.urole, x.removed
  FROM (
    SELECT ul.user_id AS uid, ul.username AS uname, ur.role::text AS urole, false AS removed
    FROM public.user_logins ul
    LEFT JOIN public.user_roles ur ON ur.user_id = ul.user_id
    UNION ALL
    SELECT r.user_id, r.actor_username, NULL::text, true
    FROM (
      SELECT DISTINCT ON (a.user_id) a.user_id, a.actor_username
      FROM public.audit_logs a
      WHERE a.user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.user_logins ul2 WHERE ul2.user_id = a.user_id)
      ORDER BY a.user_id, a.created_at DESC
    ) r
  ) x
  ORDER BY x.removed, x.uname NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.get_record_history(text, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_record_history(text, uuid, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.get_actor_status(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_actor_status(uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.get_audit_activity(uuid, text, timestamptz, timestamptz, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_audit_activity(uuid, text, timestamptz, timestamptz, text, text, integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.list_audit_actors() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_audit_actors() TO authenticated;

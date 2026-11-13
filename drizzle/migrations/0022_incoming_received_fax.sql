-- P3-P21: incoming / received fax recorded without a prior outbound fax.
--
-- Model: one explicit column, documents.direction ('outgoing' | 'incoming').
-- An incoming fax is a documents row that is born received. Its sender and
-- receipt details reuse the existing received_* columns, which already mean
-- "what came in, from whom, when" and are already shown in View History
-- (0020 labels), searched and exported:
--   received_date -> received date/time (required)
--   received_from -> sender / provider name (required)
--   received_fax  -> sender fax number (optional)
--   received_notes is not used by the incoming form (documents.notes is).
-- The outbound recipient columns (recipient_type/name/fax) stay NULL, and no
-- fax_attempts row is ever created, so nothing is fabricated: no Sent date,
-- no successful send, no confirmation number. fax_attempts stays reserved
-- for real outbound attempts (enforced below for every caller).
--
-- Legacy rows: before this migration the ONLY document writer was the
-- outbound "Add document / fax" form (bulk upload creates patients only, and
-- the demo seed in 0000 creates outbound documents with outbound attempts).
-- So every existing row is an outgoing document by construction; the
-- DEFAULT records that fact. Direction is NOT inferred from received status:
-- a received outgoing document (a response to our fax) stays outgoing.
-- ADD COLUMN with a constant default is metadata-only on PG 11+ (no table
-- rewrite, no row values changed).
--
-- The browser writes public.documents directly through PostgREST, so the
-- BEFORE trigger below is the trusted write boundary for incoming rows. Who
-- may write is unchanged (existing staff/admin RLS); attribution is
-- unchanged (0020 set_record_attribution).

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outgoing';
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_direction_check;
ALTER TABLE public.documents
  ADD CONSTRAINT documents_direction_check CHECK (direction IN ('outgoing', 'incoming'));

-- ---------------------------------------------------------------------------
-- 1. Incoming-document integrity (BEFORE INSERT OR UPDATE)
-- ---------------------------------------------------------------------------
-- * direction is fixed at creation (an outgoing row cannot be relabelled
--   incoming to hide its attempts, and vice versa).
-- * Outgoing rows: untouched -- returns immediately, legacy behavior kept.
-- * Incoming rows: always received; received date/time and sender name are
--   required (sender trimmed); outbound recipient fields must be blank;
--   status is kept at 'Received' (the app derives the displayed status).
-- Name sorts after set_document_attribution and validate_document_type
-- (BEFORE triggers fire alphabetically); they are independent.
CREATE OR REPLACE FUNCTION public.validate_document_direction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.direction IS DISTINCT FROM OLD.direction THEN
    RAISE EXCEPTION 'A document''s direction (incoming/outgoing) cannot be changed.' USING ERRCODE = '23514';
  END IF;

  IF NEW.direction <> 'incoming' THEN
    RETURN NEW;
  END IF;

  -- Trim spaces, tabs, line breaks, NBSP (160) and BOM (65279).
  NEW.received_from := NULLIF(btrim(coalesce(NEW.received_from, ''),
    E' \t\r\n' || chr(160) || chr(65279)), '');
  NEW.received_fax := NULLIF(btrim(coalesce(NEW.received_fax, ''),
    E' \t\r\n' || chr(160) || chr(65279)), '');

  IF NEW.received IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'An incoming fax is always received.' USING ERRCODE = '23514';
  END IF;
  IF NEW.received_date IS NULL THEN
    RAISE EXCEPTION 'Received date and time is required for an incoming fax.' USING ERRCODE = '23514';
  END IF;
  IF NEW.received_from IS NULL THEN
    RAISE EXCEPTION 'Sender / provider name is required for an incoming fax.' USING ERRCODE = '23514';
  END IF;
  IF char_length(NEW.received_from) > 200 THEN
    RAISE EXCEPTION 'Sender / provider name must be 200 characters or fewer.' USING ERRCODE = '23514';
  END IF;
  IF NULLIF(btrim(coalesce(NEW.recipient_type, '')), '') IS NOT NULL
     OR NULLIF(btrim(coalesce(NEW.recipient_name, '')), '') IS NOT NULL
     OR NULLIF(btrim(coalesce(NEW.recipient_fax, '')), '') IS NOT NULL THEN
    RAISE EXCEPTION 'An incoming fax has a sender, not an outbound recipient.' USING ERRCODE = '23514';
  END IF;

  NEW.recipient_type := NULL;
  NEW.recipient_name := NULL;
  NEW.recipient_fax := NULL;
  NEW.status := 'Received';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_document_direction() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_document_direction ON public.documents;
CREATE TRIGGER validate_document_direction
  BEFORE INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.validate_document_direction();

-- ---------------------------------------------------------------------------
-- 2. fax_attempts stay outbound-only
-- ---------------------------------------------------------------------------
-- Clients can only INSERT fax_attempts (no UPDATE policy; corrections go
-- through correct_fax_attempt on an existing attempt). SECURITY DEFINER so
-- the direction lookup is not affected by the caller's RLS view.
CREATE OR REPLACE FUNCTION public.reject_attempt_on_incoming_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.documents d WHERE d.id = NEW.document_id AND d.direction = 'incoming') THEN
    RAISE EXCEPTION 'Fax attempts are only for outgoing faxes; this document is an incoming fax.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_attempt_on_incoming_document() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS reject_attempt_on_incoming_document ON public.fax_attempts;
CREATE TRIGGER reject_attempt_on_incoming_document
  BEFORE INSERT OR UPDATE OF document_id ON public.fax_attempts
  FOR EACH ROW EXECUTE FUNCTION public.reject_attempt_on_incoming_document();

-- ---------------------------------------------------------------------------
-- 3. View History: identify an incoming fax's creation event
-- ---------------------------------------------------------------------------
-- Same function as 0020 with one change: a documents INSERT with
-- direction = 'incoming' is described as "Incoming fax recorded" and its
-- creation event also carries direction, sender and received time (business
-- fields only, scrubbed on permanent deletion exactly like every other
-- document event). Action codes are unchanged (documents_insert), so
-- existing filters and history keep working; outgoing creation events are
-- byte-identical to 0020.
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
      _changes := jsonb_strip_nulls(jsonb_build_object(
        'document_type', jsonb_build_object('to', NEW.document_type),
        'document_number', CASE WHEN NEW.document_number IS NOT NULL THEN jsonb_build_object('to', NEW.document_number) END));
      IF NEW.direction = 'incoming' THEN
        _description := 'Incoming fax recorded';
        _changes := _changes || jsonb_strip_nulls(jsonb_build_object(
          'direction', jsonb_build_object('to', NEW.direction),
          'received_from', jsonb_build_object('to', NEW.received_from),
          'received_fax', CASE WHEN NEW.received_fax IS NOT NULL THEN jsonb_build_object('to', NEW.received_fax) END,
          'received_date', jsonb_build_object('to', NEW.received_date)));
      ELSE
        _description := 'Document created';
      END IF;
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

REVOKE ALL ON FUNCTION public.audit_record_change() FROM PUBLIC, anon, authenticated;

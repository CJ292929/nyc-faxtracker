-- P3-P19: "Other" Document Type with custom text.
--
-- Storage choice: no new column. The custom text is stored directly in the
-- existing documents.document_type, so every existing display, search,
-- export, View History diff (audit_documents already records document_type
-- from/to) and Activity Log label (0020 builds them from document_type)
-- shows the actual text unchanged. The literal "Other" is never stored, so
-- the client can always tell a custom type apart from a predefined one when
-- reconstructing the edit form (src/lib/document-type.ts).
--
-- The browser writes public.documents directly through PostgREST, so this
-- BEFORE trigger is the trusted write boundary: it trims leading/trailing
-- whitespace and rejects empty/whitespace-only values, values longer than
-- 100 characters, and the bare placeholder "Other" -- for every caller,
-- including direct REST requests. Who may write is unchanged (existing RLS
-- and role checks); attribution and audit are unchanged (0020 triggers).
--
-- Compatibility: the rules apply only on INSERT and on an UPDATE that
-- actually changes document_type. Existing rows are never rewritten or
-- remapped, and a legacy row with a nonstandard value can still have its
-- other fields edited (the app re-sends the unchanged document_type, which
-- is skipped here). The currently deployed app only sends predefined
-- types, all of which pass. No table rewrite, no backfill.
--
-- Trigger name sorts before set_document_attribution (BEFORE triggers fire
-- alphabetically); the two are independent either way. audit_documents is
-- AFTER, so View History records the trimmed value.
CREATE OR REPLACE FUNCTION public.validate_document_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document_type IS NOT DISTINCT FROM OLD.document_type THEN
    RETURN NEW;
  END IF;

  NEW.document_type := regexp_replace(
    coalesce(NEW.document_type, ''),
    '^[[:space:] ﻿]+|[[:space:] ﻿]+$', '', 'g'
  );

  IF NEW.document_type = '' THEN
    RAISE EXCEPTION 'Document type is required.' USING ERRCODE = '23514';
  END IF;
  IF char_length(NEW.document_type) > 100 THEN
    RAISE EXCEPTION 'Document type must be 100 characters or fewer.' USING ERRCODE = '23514';
  END IF;
  IF lower(NEW.document_type) = 'other' THEN
    RAISE EXCEPTION 'Specify the actual document type instead of "Other".' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_document_type() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_document_type ON public.documents;
CREATE TRIGGER validate_document_type
  BEFORE INSERT OR UPDATE OF document_type ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.validate_document_type();

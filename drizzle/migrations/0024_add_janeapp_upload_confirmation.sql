-- P3-P24: "Uploaded to JaneApp?" confirmation on documents (incoming and
-- outgoing faxes).
--
-- Files are uploaded directly in JaneApp; FaxTracker only records whether
-- staff confirmed that upload. No existing column means this:
--   * documents.uploaded / uploaded_date ("Uploaded to patient system?") is
--     a two-state flag set from the attachment dialog and cannot express
--     "not answered yet";
--   * document_files rows are FaxTracker attachments;
--   * received / fax_attempts are fax delivery and receipt.
-- None of those is read, changed, or used to infer this value.
--
-- Three states in one nullable boolean:
--   true  = confirmed uploaded to JaneApp
--   false = confirmed NOT uploaded to JaneApp
--   NULL  = unconfirmed (never answered, or cleared back)
-- No default and no backfill: every existing document stays NULL
-- (Unconfirmed). ADD COLUMN without a default is metadata-only (no table
-- rewrite), and the boolean type itself rejects any other value.
--
-- Who may write is unchanged: the existing staff/admin RLS on documents
-- applies; anon and role-less callers stay denied. 0020's
-- set_record_attribution and audit_record_change diff to_jsonb(OLD/NEW)
-- generically, so changes are attributed and appear in View History with
-- no function changes here. 0022's validate_document_direction only checks
-- direction/sender/recipient fields, so incoming rows accept this column.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS janeapp_uploaded boolean;

COMMENT ON COLUMN public.documents.janeapp_uploaded IS
  'Uploaded to JaneApp? true = Yes, false = No, NULL = Unconfirmed. Confirmation only; independent of uploaded, document_files and received.';

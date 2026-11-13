-- P3-P23: optional Secondary / Supplemental Insurance on patients.
--
-- No existing column could hold this: patients only has the primary
-- insurance / insurance_member_id pair (0000), which stays unchanged. Two
-- nullable text columns are added and never backfilled, so every existing
-- patient keeps its data and simply shows "Not specified" until staff/admin
-- fill them in. Member ID is text so leading zeros and internal punctuation
-- ("00123-AB/4") are stored exactly as entered. ADD COLUMN without a default
-- is metadata-only (no table rewrite).
--
-- Both fields are independently optional: either may be set without the
-- other. Neither is an identifier -- no UNIQUE constraint or index, and bulk
-- upload never uses the secondary Member ID to match patients.
--
-- Who may write is unchanged (existing staff/admin RLS on patients).
-- Attribution and View History are unchanged too: 0020's
-- set_record_attribution and audit_record_change diff to_jsonb(OLD/NEW)
-- generically, so changes to these columns are attributed and recorded with
-- no function changes here.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS secondary_insurance text;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS secondary_insurance_member_id text;

-- One normalization for every caller (patient form, bulk upload, direct
-- REST): trim surrounding whitespace and store blank as NULL. The trigger
-- name sorts before set_patient_attribution (BEFORE triggers fire in name
-- order), so attribution and the audit diff only ever see normalized values
-- and a whitespace-only re-save is never recorded as an edit.
CREATE OR REPLACE FUNCTION public.normalize_patient_secondary_insurance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.secondary_insurance := NULLIF(btrim(NEW.secondary_insurance, E' \t\r\n\f\x0B'), '');
  NEW.secondary_insurance_member_id := NULLIF(btrim(NEW.secondary_insurance_member_id, E' \t\r\n\f\x0B'), '');
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.normalize_patient_secondary_insurance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS normalize_patient_secondary_insurance ON public.patients;
CREATE TRIGGER normalize_patient_secondary_insurance BEFORE INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.normalize_patient_secondary_insurance();

-- Length limits match the primary pair's bulk-upload limits (Insurance 200,
-- Member ID 100) and the UI maxLength (src/lib/secondary-insurance.ts).
-- The columns are new and all NULL, so validation is instant.
ALTER TABLE public.patients
  ADD CONSTRAINT patients_secondary_insurance_length
    CHECK (secondary_insurance IS NULL OR char_length(secondary_insurance) BETWEEN 1 AND 200),
  ADD CONSTRAINT patients_secondary_insurance_member_id_length
    CHECK (secondary_insurance_member_id IS NULL OR char_length(secondary_insurance_member_id) BETWEEN 1 AND 100);

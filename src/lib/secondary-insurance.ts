// Optional Secondary / Supplemental Insurance on a patient (P3-P23).
// Limits and normalization mirror migration 0023 (CHECK constraints and the
// normalize_patient_secondary_insurance trigger), so the UI, bulk upload and
// database agree: trim surrounding whitespace, blank -> null, Member ID kept
// as text (leading zeros / punctuation preserved). Both fields are
// independently optional and never used to identify a patient.
export const SECONDARY_INSURANCE_MAX_LENGTH = 200;
export const SECONDARY_MEMBER_ID_MAX_LENGTH = 100;

export const SECONDARY_INSURANCE_LABEL = "Secondary / Supplemental Insurance";
export const SECONDARY_MEMBER_ID_LABEL = "Secondary / Supplemental Insurance Member ID";

/** Trims and maps blank to null -- the single stored form of "not specified". */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** Returns user-facing errors for the two fields; empty when valid. */
export function validateSecondaryInsurance(fields: {
  secondary_insurance: string | null;
  secondary_insurance_member_id: string | null;
}): string[] {
  const errors: string[] = [];
  if ((fields.secondary_insurance ?? "").length > SECONDARY_INSURANCE_MAX_LENGTH)
    errors.push(
      `${SECONDARY_INSURANCE_LABEL} exceeds ${SECONDARY_INSURANCE_MAX_LENGTH} characters.`,
    );
  if ((fields.secondary_insurance_member_id ?? "").length > SECONDARY_MEMBER_ID_MAX_LENGTH)
    errors.push(
      `${SECONDARY_MEMBER_ID_LABEL} exceeds ${SECONDARY_MEMBER_ID_MAX_LENGTH} characters.`,
    );
  return errors;
}

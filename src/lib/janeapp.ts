// "Uploaded to JaneApp?" confirmation (P3-P24, migration 0024).
//
// Files are uploaded directly in JaneApp; FaxTracker stores only staff's
// confirmation in documents.janeapp_uploaded. Three states:
//   true  -> "Yes"          confirmed uploaded, no alert
//   false -> "No"           alert "Not uploaded to JaneApp"
//   null  -> "Unconfirmed"  alert "JaneApp upload not confirmed"
// This is independent of documents.uploaded ("Uploaded to patient system?"),
// FaxTracker attachments (document_files) and received/fax status. Never
// infer it from any of those.

export type JaneAppChoice = "Yes" | "No" | "Unconfirmed";

export const JANEAPP_FIELD_LABEL = "Uploaded to JaneApp?";
export const JANEAPP_CHOICES: readonly JaneAppChoice[] = ["Yes", "No", "Unconfirmed"];

export const janeAppChoiceOf = (value: boolean | null | undefined): JaneAppChoice =>
  value === true ? "Yes" : value === false ? "No" : "Unconfirmed";

// Stored value for a choice. Throws on anything else so a bad form value can
// never be silently written as Unconfirmed.
export function janeAppValueOf(choice: string): boolean | null {
  if (choice === "Yes") return true;
  if (choice === "No") return false;
  if (choice === "Unconfirmed") return null;
  throw new Error("Choose Yes, No, or Unconfirmed.");
}

// Text shown wherever the status appears (badge, list cell, history).
export const janeAppStatusText = (value: boolean | null | undefined): string =>
  value === true
    ? "Uploaded to JaneApp"
    : value === false
      ? "Not uploaded to JaneApp"
      : "JaneApp upload not confirmed";

// Alert text, or null when no alert should show (only a saved Yes clears it).
export const janeAppAlertOf = (value: boolean | null | undefined): string | null =>
  value === true ? null : janeAppStatusText(value);

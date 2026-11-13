// Recipient type options for outgoing faxes and attempts.
//
// The stored value "Referring MD" predates the "Provider" terminology rename
// (P3-P22). It stays as the stable value in documents.recipient_type and
// fax_attempts.recipient_type so existing rows, audit history, and any
// comparisons keep working; only the display label changed. Compare against
// REFERRING_PROVIDER_RECIPIENT_TYPE, never against the display label.
export const REFERRING_PROVIDER_RECIPIENT_TYPE = "Referring MD";

export type RecipientTypeOption = { value: string; label: string };

export const RECIPIENT_TYPE_OPTIONS: RecipientTypeOption[] = [
  { value: REFERRING_PROVIDER_RECIPIENT_TYPE, label: "Referring Provider" },
  { value: "Insurance", label: "Insurance" },
  { value: "Other", label: "Other" },
];

// Display label for a stored recipient_type value. Unknown/legacy values are
// shown as stored rather than hidden or rewritten.
export function recipientTypeLabel(value: string | null | undefined): string {
  if (!value) return "";
  return RECIPIENT_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

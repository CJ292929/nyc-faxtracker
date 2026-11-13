// P3-P19: "Other" Document Type with custom text.
//
// Storage: the custom text is stored directly in documents.document_type (no
// new column). Every list, detail, search, export, View History and Activity
// Log path already renders document_type (via titleOf or the 0020 SQL
// labels), so a custom type displays its actual text everywhere with no
// per-view changes.
//
// "Other" itself is never stored: the database (0021 trigger) rejects the
// literal value, so a stored value that is not one of the predefined types is
// unambiguously custom text. That is how Edit reconstructs the form state:
// predefined value -> that option; anything else -> "Other" + that exact text.
// Historical nonstandard values therefore show as Other with their original
// text, and are saved back unchanged unless the user edits them.
//
// The same trim/required/length/"not Other" rules are enforced server-side by
// public.validate_document_type (drizzle/migrations/0021_document_type_other.sql).
import { documentTypes } from "./fax.ts";

export const OTHER_DOCUMENT_TYPE = "Other";
// Keep in sync with public.validate_document_type in 0021.
export const DOCUMENT_TYPE_MAX_LENGTH = 100;
export const documentTypeOptions = [...documentTypes, OTHER_DOCUMENT_TYPE];

export const isPredefinedDocumentType = (value: string | null | undefined) =>
  value != null && documentTypes.includes(value);

/** Edit-form state for a stored document_type. */
export function documentTypeFormState(stored: string | null | undefined): {
  selection: string;
  custom: string;
} {
  if (stored == null || stored === "")
    return { selection: documentTypes[0] ?? OTHER_DOCUMENT_TYPE, custom: "" };
  if (isPredefinedDocumentType(stored)) return { selection: stored, custom: "" };
  // Legacy literal "Other" (never written by this app) has no custom text.
  if (stored.trim().toLowerCase() === OTHER_DOCUMENT_TYPE.toLowerCase())
    return { selection: OTHER_DOCUMENT_TYPE, custom: "" };
  return { selection: OTHER_DOCUMENT_TYPE, custom: stored };
}

export type DocumentTypeResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Value to persist for a form selection. A predefined selection saves only
 * that type (any custom text is discarded). "Other" requires trimmed,
 * non-empty text of at most DOCUMENT_TYPE_MAX_LENGTH characters; text that
 * matches a predefined type (case-insensitively) saves that predefined type.
 */
export function resolveDocumentType(
  selection: string,
  custom: string | null | undefined,
): DocumentTypeResult {
  if (selection !== OTHER_DOCUMENT_TYPE) {
    return isPredefinedDocumentType(selection)
      ? { ok: true, value: selection }
      : { ok: false, error: "Choose a document type." };
  }
  const text = (custom ?? "").trim();
  if (!text) return { ok: false, error: "Specify the document type." };
  if (text.length > DOCUMENT_TYPE_MAX_LENGTH)
    return {
      ok: false,
      error: `Document type must be ${DOCUMENT_TYPE_MAX_LENGTH} characters or fewer.`,
    };
  if (text.toLowerCase() === OTHER_DOCUMENT_TYPE.toLowerCase())
    return { ok: false, error: 'Specify the actual document type instead of "Other".' };
  const predefined = documentTypes.find((t) => t.toLowerCase() === text.toLowerCase());
  return { ok: true, value: predefined ?? text };
}

/** Document-type filter: "Other" matches every custom (non-predefined) type. */
export function matchesDocumentTypeFilter(stored: string, filter: string, allLabel = "All types") {
  if (filter === allLabel) return true;
  if (filter === OTHER_DOCUMENT_TYPE) return !isPredefinedDocumentType(stored);
  return stored === filter;
}

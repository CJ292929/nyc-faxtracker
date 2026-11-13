// P3-P21: incoming / received fax recorded without a prior outbound fax.
//
// Model (drizzle/migrations/0022_incoming_received_fax.sql): a documents row
// with direction = 'incoming' that is born received. Sender details reuse the
// existing received_* columns:
//   received_date -> received date/time (required)
//   received_from -> sender / provider name (required)
//   received_fax  -> sender fax number (optional)
// Outbound recipient columns stay NULL and no fax_attempts row is ever made,
// so an incoming fax never shows a Sent date, a successful send or a
// confirmation number. Legacy rows default to 'outgoing' (every pre-0022
// document came from the outbound form); direction is never inferred from
// received status.
//
// The same required/blank-recipient rules are enforced server-side by
// public.validate_document_direction (0022) for every caller.
import { resolveDocumentType } from "./document-type.ts";

export const INCOMING = "incoming";
export const OUTGOING = "outgoing";
// Keep in sync with public.validate_document_direction in 0022.
export const SENDER_NAME_MAX_LENGTH = 200;
export const directionOptions = ["Incoming", "Outgoing"] as const;

type WithDirection = { direction?: string | null };

export const isIncoming = (d: WithDirection | null | undefined) => d?.direction === INCOMING;
export const directionLabel = (d: WithDirection | null | undefined) =>
  isIncoming(d) ? "Incoming" : "Outgoing";

/** Direction filter: "All directions" | "Incoming" | "Outgoing". */
export function matchesDirectionFilter(
  d: WithDirection,
  filter: string,
  allLabel = "All directions",
) {
  if (filter === allLabel) return true;
  return directionLabel(d) === filter;
}

const NPI_RE = /^\d{10}$/;

export type IncomingFaxInput = {
  patientId: string | null | undefined;
  documentTypeSelection: string;
  documentTypeCustom: string | null | undefined;
  documentNumber?: string | null | undefined;
  documentDate?: string | null | undefined;
  /** Value of a datetime-local input, e.g. "2026-11-13T09:30". */
  receivedAt: string | null | undefined;
  senderName: string | null | undefined;
  senderFax?: string | null | undefined;
  mdName?: string | null | undefined;
  mdNpi?: string | null | undefined;
  mdOfficePhone?: string | null | undefined;
  mdFax?: string | null | undefined;
  notes?: string | null | undefined;
};

export type IncomingFaxPayload = {
  patient_id: string;
  direction: typeof INCOMING;
  document_type: string;
  document_number: number | null;
  document_date: string | null;
  received: true;
  received_date: string;
  received_from: string;
  received_fax: string | null;
  md_name: string | null;
  md_npi: string | null;
  md_office_phone: string | null;
  md_fax: string | null;
  notes: string | null;
  status: "Received";
};

export type IncomingFaxResult =
  { ok: true; value: IncomingFaxPayload } | { ok: false; error: string };

const clean = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/**
 * Validates the incoming-fax form and builds the documents row to insert (or
 * update). Never includes recipient_* fields or anything attempt-related.
 * `now` is injectable for tests.
 */
export function buildIncomingFaxPayload(
  input: IncomingFaxInput,
  now: Date = new Date(),
): IncomingFaxResult {
  if (!clean(input.patientId)) return { ok: false, error: "Choose the patient this fax is for." };
  const type = resolveDocumentType(input.documentTypeSelection, input.documentTypeCustom);
  if (!type.ok) return type;

  const receivedRaw = clean(input.receivedAt);
  if (!receivedRaw) return { ok: false, error: "Enter the date and time the fax was received." };
  const received = new Date(receivedRaw);
  if (Number.isNaN(received.getTime()))
    return { ok: false, error: "Enter a valid received date and time." };
  // Small allowance for clock skew between the device and the server.
  if (received.getTime() > now.getTime() + 5 * 60_000)
    return { ok: false, error: "The received date and time cannot be in the future." };

  const sender = clean(input.senderName);
  if (!sender) return { ok: false, error: "Enter the sender / provider name." };
  if (sender.length > SENDER_NAME_MAX_LENGTH)
    return {
      ok: false,
      error: `Sender / provider name must be ${SENDER_NAME_MAX_LENGTH} characters or fewer.`,
    };

  const npi = clean(input.mdNpi);
  if (npi && !NPI_RE.test(npi)) return { ok: false, error: "MD NPI must be exactly 10 digits." };

  const numberRaw = clean(input.documentNumber);
  let documentNumber: number | null = null;
  if (numberRaw) {
    const n = Number(numberRaw);
    if (!Number.isInteger(n) || n < 0)
      return { ok: false, error: "Document number must be a whole number." };
    documentNumber = n;
  }

  const documentDate = clean(input.documentDate);
  if (documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(documentDate))
    return { ok: false, error: "Enter a valid document date." };

  return {
    ok: true,
    value: {
      patient_id: String(clean(input.patientId)),
      direction: INCOMING,
      document_type: type.value,
      document_number: documentNumber,
      document_date: documentDate,
      received: true,
      received_date: received.toISOString(),
      received_from: sender,
      received_fax: clean(input.senderFax),
      md_name: clean(input.mdName),
      md_npi: npi,
      md_office_phone: clean(input.mdOfficePhone),
      md_fax: clean(input.mdFax),
      notes: clean(input.notes),
      status: "Received",
    },
  };
}

/** Patient search for the "Record Received Fax" patient selector. */
export function matchesPatientQuery(
  p: {
    first_name: string;
    last_name: string;
    patient_id: string;
    insurance_member_id?: string | null;
  },
  query: string,
) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay =
    `${p.first_name} ${p.last_name} ${p.last_name}, ${p.first_name} ${p.patient_id} ${p.insurance_member_id ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

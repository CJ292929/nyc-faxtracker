// Shared presentation + data-access helpers for record attribution, record
// View History, and the admin Activity Log (P3-P18). Pure functions and
// injectable RPC clients only -- no React, no network of its own -- so
// scripts/test-audit-history.mjs can exercise them without credentials.
//
// Every value shown here comes from the database: actor names are the
// snapshot public.audit_logs / the *_by_name columns took at write time
// from auth.uid(), never anything the browser supplied.

export const LEGACY_UNKNOWN = "Unknown — recorded before tracking.";
export const SYSTEM_ACTOR = "System / maintenance";

export type AttributionKind = "user" | "system" | "unknown";
export type HistoryRecordType = "patient" | "document";

export type FieldChange = { from?: unknown; to?: unknown };
export type Changes = Record<string, FieldChange>;

export type HistoryEvent = {
  id: string;
  created_at: string;
  action: string;
  description: string | null;
  actor_username: string | null;
  actor_kind: string | null;
  actor_account_removed: boolean;
  record_type: string | null;
  record_id: string | null;
  document_id: string | null;
  document_label: string | null;
  attempt_number: number | null;
  changes: unknown;
};

export type ActivityEvent = HistoryEvent & {
  user_id: string | null;
  patient_id: string | null;
  patient_code: string | null;
};

export type ActivityFilters = {
  // A user id, "system" for events with no signed-in account, or "" for all.
  actor: string;
  from: string; // YYYY-MM-DD, viewer-local calendar day, inclusive
  to: string; // YYYY-MM-DD, viewer-local calendar day, inclusive
  action: string;
  recordType: string;
};

export type AuditActor = {
  user_id: string;
  username: string | null;
  role: string | null;
  account_removed: boolean;
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
const PATIENT_FIELDS: Record<string, string> = {
  first_name: "First name",
  last_name: "Last name",
  patient_id: "Patient ID",
  date_of_birth: "Date of birth",
  phone: "Patient Phone",
  email: "Email",
  address: "Address",
  insurance: "Insurance",
  insurance_member_id: "Insurance member ID",
  referring_physician: "Referring Provider",
  referring_physician_npi: "Referring Provider NPI",
  referring_physician_office_phone: "Referring Provider Office Number",
  referring_physician_fax: "Referring Provider Fax Number",
  status: "Status",
  notes: "Notes",
  deleted_at: "Archived at",
  is_demo: "Demo record",
};

const DOCUMENT_FIELDS: Record<string, string> = {
  document: "Document",
  document_type: "Document type",
  document_number: "Document number",
  document_date: "Document date",
  recipient_type: "Recipient",
  recipient_name: "Recipient name",
  recipient_fax: "Recipient fax number",
  md_name: "Document MD",
  md_npi: "Document MD NPI",
  md_office_phone: "Document MD Office Number",
  md_fax: "Document MD Fax Number",
  notes: "Notes",
  status: "Status",
  received: "Received?",
  received_date: "Received date & time",
  received_document_type: "Received document",
  received_from: "Received from",
  received_fax: "Received fax number",
  received_notes: "Received notes",
  uploaded: "Uploaded to patient system?",
  uploaded_date: "Date uploaded",
  patient_id: "Patient",
  assigned_staff: "Assigned staff",
  is_demo: "Demo record",
};

const ATTEMPT_FIELDS: Record<string, string> = {
  attempt_number: "Attempt #",
  attempted_at: "Date & time faxed",
  status: "Fax status",
  failure_reason: "Failure reason",
  confirmation_number: "Confirmation / reference number",
  notes: "Fax notes",
  md_name: "MD",
  md_npi: "MD NPI",
  md_office_phone: "MD Office Number",
  md_fax: "MD Fax Number",
  recipient_type: "Recipient",
  recipient_name: "Recipient name",
  recipient_fax: "Recipient fax number",
  document_id: "Document",
  is_demo: "Demo record",
  correction_reason: "Correction reason",
};

const FILE_FIELDS: Record<string, string> = { file_name: "File name" };

const FIELDS_BY_RECORD: Record<string, Record<string, string>> = {
  patient: PATIENT_FIELDS,
  document: DOCUMENT_FIELDS,
  fax_attempt: ATTEMPT_FIELDS,
  document_file: FILE_FIELDS,
};

export function fieldLabel(recordType: string | null, field: string): string {
  const label = FIELDS_BY_RECORD[recordType ?? ""]?.[field];
  if (label) return label;
  const words = field.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const ACTION_LABELS: Record<string, string> = {
  patients_insert: "Patient created",
  patients_update: "Patient edited",
  patient_deleted_permanently: "Patient permanently deleted",
  documents_insert: "Document created",
  documents_update: "Document edited",
  document_received_updated: "Received status updated",
  document_upload_updated: "Upload status updated",
  document_deleted_permanently: "Document permanently deleted",
  fax_attempts_insert: "Fax attempt recorded",
  fax_attempt_corrected: "Fax attempt corrected",
  document_files_insert: "File attached",
  attachment_cleanup_completed: "Attachment removal completed",
  attachment_cleanup_pending: "Attachment removal pending (will retry)",
  role_changed: "Role changed",
  account_created: "Account created",
  password_reset: "Password reset",
  account_deleted: "Account deleted",
};

export const RECORD_TYPE_LABELS: Record<string, string> = {
  patient: "Patient",
  document: "Document / fax",
  fax_attempt: "Fax attempt",
  document_file: "Attachment",
  account: "Account",
};

export function actionLabel(event: Pick<HistoryEvent, "action" | "attempt_number">): string {
  if (event.action === "fax_attempts_insert" && event.attempt_number) {
    return event.attempt_number > 1
      ? `Follow-up fax attempt #${event.attempt_number} recorded`
      : `Fax attempt #${event.attempt_number} recorded`;
  }
  if (event.action === "fax_attempt_corrected" && event.attempt_number) {
    return `Fax attempt #${event.attempt_number} corrected`;
  }
  return ACTION_LABELS[event.action] ?? event.action.replaceAll("_", " ");
}

// What the event is about, for patient history and the admin log, where
// events of several records are listed together.
export function eventContext(
  event: Pick<HistoryEvent, "record_type" | "document_label" | "attempt_number" | "document_id">,
): string | null {
  const doc = event.document_label ?? (event.document_id ? "Deleted document" : null);
  if (event.record_type === "fax_attempt") {
    const attempt = event.attempt_number ? `Attempt #${event.attempt_number}` : "Fax attempt";
    return doc ? `${attempt} · ${doc}` : attempt;
  }
  if (event.record_type === "document_file") return doc ? `Attachment · ${doc}` : "Attachment";
  if (event.record_type === "document") return doc;
  return null;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
const TIMESTAMP_FIELDS = new Set(["attempted_at", "received_date", "uploaded_date", "deleted_at"]);
const DATE_ONLY_FIELDS = new Set(["date_of_birth", "document_date"]);
const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Event times are shown in the viewer's local time zone with the zone name,
// so staff working from different time zones read the same instant
// unambiguously.
export function dateTimeWithZone(date?: string | null, timeZone?: string): string {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function formatValue(field: string, value: unknown, timeZone?: string): string {
  if (value === null || value === undefined || value === "") return "(blank)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && DATE_ONLY_FIELDS.has(field)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) return `${MONTH_ABBR[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  }
  if (typeof value === "string" && TIMESTAMP_FIELDS.has(field)) {
    return dateTimeWithZone(value, timeZone);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type ChangeRow = {
  field: string;
  label: string;
  from: string | null; // null when the event only records a resulting value
  to: string;
};

export function changeRows(
  recordType: string | null,
  changes: unknown,
  timeZone?: string,
): ChangeRow[] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const entries = Object.entries(changes as Changes).filter(
    ([, c]) => c && typeof c === "object" && ("from" in c || "to" in c),
  );
  // The order fields appear in on that record's form; anything else follows
  // alphabetically, and the correction reason always comes last.
  const order = Object.keys(FIELDS_BY_RECORD[recordType ?? ""] ?? {});
  const rank = (f: string) => {
    if (f === "correction_reason") return Number.MAX_SAFE_INTEGER;
    const i = order.indexOf(f);
    return i === -1 ? order.length : i;
  };
  entries.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  return entries.map(([field, c]) => {
    const isDeletionLabel = field === "document" && !("to" in c);
    return {
      field,
      label: fieldLabel(recordType, field),
      from: "from" in c && !isDeletionLabel ? formatValue(field, c.from, timeZone) : null,
      to: formatValue(field, isDeletionLabel ? c.from : c.to, timeZone),
    };
  });
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------
export function actorLabel(
  username: string | null,
  kind: string | null,
  accountRemoved: boolean,
): string {
  if (kind === "system") return SYSTEM_ACTOR;
  if (!username) return "Removed account";
  return accountRemoved ? `${username} (account removed)` : username;
}

// "Created by" / "Last updated by" text for a record's attribution columns.
export function attributionLabel(
  kind: string | null | undefined,
  name: string | null | undefined,
  accountRemoved = false,
): string {
  if (kind === "user") {
    if (!name) return LEGACY_UNKNOWN;
    return accountRemoved ? `${name} (account removed)` : name;
  }
  if (kind === "system") return SYSTEM_ACTOR;
  return LEGACY_UNKNOWN;
}

// ---------------------------------------------------------------------------
// Admin filters
// ---------------------------------------------------------------------------
// Converts inclusive viewer-local calendar days into the half-open
// [from, to) instant range the database filters on.
export function dateRangeToIso(
  from: string,
  to: string,
): { from: string | null; to: string | null } {
  const parse = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const start = parse(from);
  const end = parse(to);
  if (end) end.setDate(end.getDate() + 1);
  return { from: start ? start.toISOString() : null, to: end ? end.toISOString() : null };
}

export const ACTIVITY_PAGE_SIZE = 50;
export const HISTORY_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Data access (caller-scoped Supabase client; the database enforces access)
// ---------------------------------------------------------------------------
type RpcResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export interface AuditRpcClient {
  rpc(
    fn: "get_record_history",
    args: { _record_type: string; _record_id: string; _limit: number; _offset: number },
  ): RpcResult<HistoryEvent & { total_count: number }>;
  rpc(
    fn: "get_audit_activity",
    args: {
      _actor_id: string | null;
      _actor_kind: string | null;
      _from: string | null;
      _to: string | null;
      _action: string | null;
      _record_type: string | null;
      _limit: number;
      _offset: number;
    },
  ): RpcResult<ActivityEvent & { total_count: number }>;
  rpc(fn: "list_audit_actors"): RpcResult<AuditActor>;
  rpc(
    fn: "get_actor_status",
    args: { _user_ids: string[] },
  ): RpcResult<{ user_id: string; account_removed: boolean }>;
}

export type Page<T> = { ok: true; rows: T[]; total: number } | { ok: false; error: string };

function friendlyError(message: string, scope: "history" | "activity"): string {
  if (message.startsWith("FORBIDDEN")) {
    return scope === "activity"
      ? "Only administrators can view the activity log."
      : "You don't have access to this record's history.";
  }
  if (message.startsWith("NOT_FOUND")) return "This record no longer exists.";
  return scope === "activity"
    ? "Unable to load activity. Please try again."
    : "Unable to load history. Please try again.";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchRecordHistory(
  client: AuditRpcClient,
  recordType: HistoryRecordType,
  recordId: string,
  offset = 0,
  limit = HISTORY_PAGE_SIZE,
): Promise<Page<HistoryEvent>> {
  if (!UUID_RE.test(recordId)) return { ok: false, error: "Invalid record." };
  const { data, error } = await client.rpc("get_record_history", {
    _record_type: recordType,
    _record_id: recordId,
    _limit: limit,
    _offset: offset,
  });
  if (error) return { ok: false, error: friendlyError(error.message, "history") };
  const rows = data ?? [];
  return { ok: true, rows, total: Number(rows[0]?.total_count ?? (offset > 0 ? offset : 0)) };
}

export async function fetchActivity(
  client: AuditRpcClient,
  filters: ActivityFilters,
  offset = 0,
  limit = ACTIVITY_PAGE_SIZE,
): Promise<Page<ActivityEvent>> {
  const range = dateRangeToIso(filters.from, filters.to);
  const { data, error } = await client.rpc("get_audit_activity", {
    _actor_id: UUID_RE.test(filters.actor) ? filters.actor : null,
    _actor_kind: filters.actor === "system" ? "system" : null,
    _from: range.from,
    _to: range.to,
    _action: filters.action || null,
    _record_type: filters.recordType || null,
    _limit: limit,
    _offset: offset,
  });
  if (error) return { ok: false, error: friendlyError(error.message, "activity") };
  const rows = data ?? [];
  return { ok: true, rows, total: Number(rows[0]?.total_count ?? (offset > 0 ? offset : 0)) };
}

export async function fetchActors(
  client: AuditRpcClient,
): Promise<{ ok: true; actors: AuditActor[] } | { ok: false; error: string }> {
  const { data, error } = await client.rpc("list_audit_actors");
  if (error) return { ok: false, error: friendlyError(error.message, "activity") };
  return { ok: true, actors: data ?? [] };
}

export async function fetchRemovedActors(
  client: AuditRpcClient,
  userIds: (string | null | undefined)[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && UUID_RE.test(id)))];
  if (!ids.length) return new Set();
  const { data, error } = await client.rpc("get_actor_status", { _user_ids: ids });
  if (error || !data) return new Set();
  return new Set(data.filter((r) => r.account_removed).map((r) => r.user_id));
}

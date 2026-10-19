#!/usr/bin/env node
// Isolated fixture test for the P3-P18 attribution/history helpers: field
// labels (Referring Provider terminology), value formatting, actor and
// legacy-attribution wording, the admin date-range conversion, the RPC
// wrappers' argument mapping and error handling, and the storage-cleanup
// follow-up event. No network, no real credentials -- the authoritative
// checks (auth.uid() attribution, anti-forgery, RLS/role gating, deletion
// scrubbing) live in the database and are covered by
// scripts/p3p18-attribution-live.mjs.
//   node --experimental-strip-types scripts/test-audit-history.mjs
import {
  LEGACY_UNKNOWN,
  SYSTEM_ACTOR,
  actionLabel,
  actorLabel,
  attributionLabel,
  changeRows,
  dateRangeToIso,
  eventContext,
  fetchActivity,
  fetchRecordHistory,
  fetchRemovedActors,
  fieldLabel,
  formatValue,
} from "../src/lib/audit-history.ts";
import { cleanupAuditRow } from "../src/lib/attachment-cleanup-audit.ts";

let failures = 0;
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok" : "FAIL"} - ${name}`);
  if (!pass) {
    failures++;
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
  }
}

const RECORD = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

// Labels
check("legacy wording is exact", LEGACY_UNKNOWN, "Unknown — recorded before tracking.");
check(
  "patient Referring Provider label",
  fieldLabel("patient", "referring_physician"),
  "Referring Provider",
);
check(
  "patient Referring Provider NPI label",
  fieldLabel("patient", "referring_physician_npi"),
  "Referring Provider NPI",
);
check(
  "patient Referring Provider fax label",
  fieldLabel("patient", "referring_physician_fax"),
  "Referring Provider Fax Number",
);
check("document MD label", fieldLabel("document", "md_name"), "Document MD");
check(
  "attempt notes label differs from document notes",
  fieldLabel("fax_attempt", "notes"),
  "Fax notes",
);
check(
  "unknown field falls back to readable text",
  fieldLabel("patient", "some_new_field"),
  "Some new field",
);

// Actions
check(
  "first attempt",
  actionLabel({ action: "fax_attempts_insert", attempt_number: 1 }),
  "Fax attempt #1 recorded",
);
check(
  "later attempt is a follow-up",
  actionLabel({ action: "fax_attempts_insert", attempt_number: 3 }),
  "Follow-up fax attempt #3 recorded",
);
check(
  "correction names attempt",
  actionLabel({ action: "fax_attempt_corrected", attempt_number: 2 }),
  "Fax attempt #2 corrected",
);
check(
  "received update",
  actionLabel({ action: "document_received_updated", attempt_number: null }),
  "Received status updated",
);
check(
  "unknown action readable",
  actionLabel({ action: "something_new", attempt_number: null }),
  "something new",
);

// Context
check(
  "attempt context in patient history",
  eventContext({
    record_type: "fax_attempt",
    attempt_number: 2,
    document_label: "Progress Note #1",
    document_id: RECORD,
  }),
  "Attempt #2 · Progress Note #1",
);
check(
  "deleted document context",
  eventContext({
    record_type: "document",
    attempt_number: null,
    document_label: null,
    document_id: RECORD,
  }),
  "Deleted document",
);

// Values
check("blank", formatValue("phone", null), "(blank)");
check("empty string blank", formatValue("phone", ""), "(blank)");
check("boolean", formatValue("received", true), "Yes");
check("date-only never shifts a day", formatValue("date_of_birth", "1958-01-15"), "Jan 15, 1958");
check(
  "timestamp shows zone",
  formatValue("attempted_at", "2026-10-19T14:05:00Z", "America/New_York"),
  "Oct 19, 2026, 10:05 AM EDT",
);

// Change rows
check(
  "update rows ordered like the form, reason last",
  changeRows(
    "fax_attempt",
    {
      correction_reason: { to: "typo" },
      status: { from: "Failed", to: "Sent Successfully" },
      attempted_at: { from: "2026-10-19T14:05:00Z", to: "2026-10-19T15:05:00Z" },
    },
    "America/New_York",
  ),
  [
    {
      field: "attempted_at",
      label: "Date & time faxed",
      from: "Oct 19, 2026, 10:05 AM EDT",
      to: "Oct 19, 2026, 11:05 AM EDT",
    },
    { field: "status", label: "Fax status", from: "Failed", to: "Sent Successfully" },
    { field: "correction_reason", label: "Correction reason", from: null, to: "typo" },
  ],
);
check(
  "patient edit uses Referring Provider labels",
  changeRows("patient", { referring_physician: { from: null, to: "Dr. A" } }),
  [{ field: "referring_physician", label: "Referring Provider", from: "(blank)", to: "Dr. A" }],
);
check(
  "deleted-document label shows as a value, not a change",
  changeRows("document", { document: { from: "Progress Note #2" } }),
  [{ field: "document", label: "Document", from: null, to: "Progress Note #2" }],
);
check("scrubbed (null) changes render nothing", changeRows("patient", null), []);

// Actors / attribution
check("system actor", actorLabel(null, "system", false), SYSTEM_ACTOR);
check(
  "removed account keeps snapshot name",
  actorLabel("jdoe", "user", true),
  "jdoe (account removed)",
);
check("legacy row with no recoverable name", actorLabel(null, "user", true), "Removed account");
check("attribution user", attributionLabel("user", "jdoe"), "jdoe");
check("attribution unknown", attributionLabel("unknown", null), LEGACY_UNKNOWN);
check("attribution system", attributionLabel("system", null), SYSTEM_ACTOR);
check("attribution never shows a blank user", attributionLabel("user", null), LEGACY_UNKNOWN);

// Date range: inclusive local days -> half-open instants
{
  const r = dateRangeToIso("2026-10-01", "2026-10-01");
  const from = new Date(r.from);
  const to = new Date(r.to);
  check(
    "range starts at local midnight",
    [from.getHours(), from.getMinutes(), from.getDate()],
    [0, 0, 1],
  );
  check("range end is the next local midnight (exclusive)", [to.getHours(), to.getDate()], [0, 2]);
  check("empty range", dateRangeToIso("", ""), { from: null, to: null });
}

// RPC wrappers
{
  const calls = [];
  const client = {
    rpc: async (fn, args) => {
      calls.push([fn, args]);
      return { data: [{ id: "e1", total_count: 7 }], error: null };
    },
  };
  const r = await fetchRecordHistory(client, "patient", RECORD, 50);
  check("history maps rows + total", r, {
    ok: true,
    rows: [{ id: "e1", total_count: 7 }],
    total: 7,
  });
  check("history args", calls[0], [
    "get_record_history",
    { _record_type: "patient", _record_id: RECORD, _limit: 50, _offset: 50 },
  ]);
  check(
    "invalid record id never reaches the server",
    await fetchRecordHistory(client, "patient", "x"),
    {
      ok: false,
      error: "Invalid record.",
    },
  );
  check("no extra call for invalid id", calls.length, 1);

  await fetchActivity(client, {
    actor: "system",
    from: "",
    to: "",
    action: "patients_update",
    recordType: "patient",
  });
  check(
    "activity: system filter maps to actor_kind",
    [calls[1][1]._actor_id, calls[1][1]._actor_kind],
    [null, "system"],
  );
  check(
    "activity: action/record type passed through",
    [calls[1][1]._action, calls[1][1]._record_type],
    ["patients_update", "patient"],
  );
  await fetchActivity(client, { actor: USER, from: "", to: "", action: "", recordType: "" }, 100);
  check(
    "activity: account filter + page offset",
    [calls[2][1]._actor_id, calls[2][1]._actor_kind, calls[2][1]._action, calls[2][1]._offset],
    [USER, null, null, 100],
  );
}
{
  const denied = {
    rpc: async () => ({
      data: null,
      error: { message: "FORBIDDEN: only administrators can view the activity log" },
    }),
  };
  check(
    "activity forbidden message",
    await fetchActivity(denied, { actor: "", from: "", to: "", action: "", recordType: "" }),
    {
      ok: false,
      error: "Only administrators can view the activity log.",
    },
  );
  check("history forbidden message", await fetchRecordHistory(denied, "document", RECORD), {
    ok: false,
    error: "You don't have access to this record's history.",
  });
  const gone = {
    rpc: async () => ({ data: null, error: { message: "NOT_FOUND: record does not exist" } }),
  };
  check("history not found message", await fetchRecordHistory(gone, "document", RECORD), {
    ok: false,
    error: "This record no longer exists.",
  });
  const flaky = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
  check(
    "removed-actor lookup fails closed to 'not removed'",
    [...(await fetchRemovedActors(flaky, [USER]))],
    [],
  );
  const status = {
    rpc: async () => ({ data: [{ user_id: USER, account_removed: true }], error: null }),
  };
  check(
    "removed-actor lookup",
    [...(await fetchRemovedActors(status, [USER, null, USER]))],
    [USER],
  );
}

// Storage cleanup follow-up event
check(
  "cleanup completed for a document",
  cleanupAuditRow({ patientId: RECORD, documentId: USER }, 2, "completed"),
  {
    user_id: null,
    patient_id: RECORD,
    document_id: USER,
    record_type: "document",
    record_id: USER,
    action: "attachment_cleanup_completed",
    description: "Removed 2 attachments from storage",
  },
);
check(
  "cleanup pending for a patient is not labelled completed",
  cleanupAuditRow({ patientId: RECORD }, 1, "pending"),
  {
    user_id: null,
    patient_id: RECORD,
    document_id: null,
    record_type: "patient",
    record_id: RECORD,
    action: "attachment_cleanup_pending",
    description: "Storage removal of 1 attachment failed; queued for retry",
  },
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);

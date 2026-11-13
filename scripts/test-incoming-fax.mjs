#!/usr/bin/env node
// Isolated fixture test for P3-P21 incoming / received fax helpers
// (src/lib/incoming-fax.ts, statusOf in src/lib/fax.ts, View History labels
// in src/lib/audit-history.ts). No network, no credentials. The
// authoritative write-boundary rules live in
// drizzle/migrations/0022_incoming_received_fax.sql and are exercised against
// a real Postgres by scripts/p3p21-incoming-fax-db.mjs.
//   node --experimental-strip-types scripts/test-incoming-fax.mjs
import { readFileSync } from "node:fs";
import { statusOf } from "../src/lib/fax.ts";
import {
  INCOMING,
  SENDER_NAME_MAX_LENGTH,
  buildIncomingFaxPayload,
  directionLabel,
  isIncoming,
  matchesDirectionFilter,
  matchesPatientQuery,
} from "../src/lib/incoming-fax.ts";
import { actionLabel, changeRows, formatValue } from "../src/lib/audit-history.ts";

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

const NOW = new Date("2026-11-13T15:00:00Z");
const base = {
  patientId: "11111111-1111-1111-1111-111111111111",
  documentTypeSelection: "Progress Note",
  documentTypeCustom: "",
  documentNumber: "",
  documentDate: "2026-11-10",
  receivedAt: "2026-11-13T09:30:00Z",
  senderName: "  Dr. Outside Clinic  ",
  senderFax: " 212-555-0100 ",
  mdName: "",
  mdNpi: "",
  mdOfficePhone: "",
  mdFax: "",
  notes: "",
};
const build = (over) => buildIncomingFaxPayload({ ...base, ...over }, NOW);

// --- Payload ---------------------------------------------------------------
const ok = build({});
check("valid input builds a payload", ok.ok, true);
check(
  "payload is incoming + received",
  [ok.value.direction, ok.value.received, ok.value.status],
  ["incoming", true, "Received"],
);
check("sender trimmed", ok.value.received_from, "Dr. Outside Clinic");
check("sender fax trimmed", ok.value.received_fax, "212-555-0100");
check("received time stored as ISO", ok.value.received_date, "2026-11-13T09:30:00.000Z");
check("document date kept as calendar date", ok.value.document_date, "2026-11-10");
check(
  "no outbound recipient / attempt fields are ever sent",
  Object.keys(ok.value).filter((k) =>
    /recipient|attempt|confirmation|attempted_at|fax_status/.test(k),
  ),
  [],
);
check(
  "blank optional fields become null",
  [ok.value.md_name, ok.value.md_npi, ok.value.notes],
  [null, null, null],
);

check("patient required", build({ patientId: "" }).ok, false);
check("received date/time required", build({ receivedAt: "" }).ok, false);
check("invalid received date/time rejected", build({ receivedAt: "not-a-date" }).ok, false);
check("future received time rejected", build({ receivedAt: "2026-11-14T15:00:00Z" }).ok, false);
check("small clock skew allowed", build({ receivedAt: "2026-11-13T15:03:00Z" }).ok, true);
check("sender required", build({ senderName: "   " }).ok, false);
check(
  "sender max length",
  [
    build({ senderName: "x".repeat(SENDER_NAME_MAX_LENGTH) }).ok,
    build({ senderName: "x".repeat(SENDER_NAME_MAX_LENGTH + 1) }).ok,
  ],
  [true, false],
);
check("bad NPI rejected", build({ mdNpi: "123" }).ok, false);
check("10-digit NPI accepted", build({ mdNpi: "1234567890" }).value?.md_npi, "1234567890");
check("document number parsed", build({ documentNumber: "3" }).value?.document_number, 3);
check("bad document number rejected", build({ documentNumber: "1.5" }).ok, false);
check("document date optional", build({ documentDate: "" }).value?.document_date, null);

// Document type: shares the P3-P19 rules (Other + required custom text).
check(
  "Other + custom text saves the text",
  build({ documentTypeSelection: "Other", documentTypeCustom: "  Referral " }).value?.document_type,
  "Referral",
);
check(
  "Other without text rejected",
  build({ documentTypeSelection: "Other", documentTypeCustom: " " }).ok,
  false,
);
check(
  'literal "Other" rejected',
  build({ documentTypeSelection: "Other", documentTypeCustom: "other" }).ok,
  false,
);

// --- Status / direction ----------------------------------------------------
const incoming = {
  id: "d1",
  direction: INCOMING,
  received: true,
  uploaded: false,
  status: "Received",
};
const outgoingDraft = {
  id: "d2",
  direction: "outgoing",
  received: false,
  uploaded: false,
  status: "Draft",
};
const legacyReceived = {
  id: "d3",
  direction: "outgoing",
  received: true,
  uploaded: false,
  status: "Draft",
};
const sent = [{ document_id: "d2", attempt_number: 1, status: "Sent Successfully" }];
check("incoming not uploaded shows Received", statusOf(incoming, []), "Received");
check(
  "incoming uploaded shows Uploaded",
  statusOf({ ...incoming, uploaded: true }, []),
  "Uploaded",
);
check(
  "incoming never Awaiting Response even if an attempt existed",
  statusOf(incoming, [{ document_id: "d1", attempt_number: 1, status: "Sent Successfully" }]),
  "Received",
);
check("outgoing sent still Awaiting Response", statusOf(outgoingDraft, sent), "Awaiting Response");
check("outgoing draft unchanged", statusOf(outgoingDraft, []), "Draft");
check(
  "legacy received outgoing still Awaiting Upload (direction not inferred from received)",
  [statusOf(legacyReceived, []), directionLabel(legacyReceived)],
  ["Awaiting Upload", "Outgoing"],
);
check(
  "missing direction treated as outgoing",
  [isIncoming({}), directionLabel({})],
  [false, "Outgoing"],
);
check(
  "direction filter",
  [
    matchesDirectionFilter(incoming, "All directions"),
    matchesDirectionFilter(incoming, "Incoming"),
    matchesDirectionFilter(incoming, "Outgoing"),
    matchesDirectionFilter(outgoingDraft, "Outgoing"),
  ],
  [true, true, false, true],
);

// --- Patient search --------------------------------------------------------
const pat = {
  first_name: "Maria",
  last_name: "Lopez",
  patient_id: "NYC-0042",
  insurance_member_id: "MBR77",
};
check(
  "patient search by name, last-first, id, member id",
  ["maria", "lopez maria", "lopez,", "nyc-0042", "mbr77", ""].map((q) =>
    matchesPatientQuery(pat, q),
  ),
  [true, true, true, true, true, true],
);
check("patient search non-match", matchesPatientQuery(pat, "smith"), false);

// --- View History ----------------------------------------------------------
check(
  "incoming creation labelled",
  actionLabel({
    action: "documents_insert",
    attempt_number: null,
    description: "Incoming fax recorded",
  }),
  "Incoming fax recorded",
);
check(
  "outgoing creation label unchanged",
  actionLabel({
    action: "documents_insert",
    attempt_number: null,
    description: "Document created",
  }),
  "Document created",
);
check("direction value formatted", formatValue("direction", "incoming"), "Incoming");
check(
  "creation changes show direction + sender rows",
  changeRows("document", {
    document_type: { to: "Referral" },
    direction: { to: "incoming" },
    received_from: { to: "Dr. Outside" },
  }).map((r) => [r.label, r.to]),
  [
    ["Direction", "Incoming"],
    ["Document type", "Referral"],
    ["Received from", "Dr. Outside"],
  ],
);

// --- Migration / UI parity -------------------------------------------------
const sql = readFileSync(
  new URL("../drizzle/migrations/0022_incoming_received_fax.sql", import.meta.url),
  "utf8",
);
check(
  "DB sender length limit matches UI",
  sql.includes(`char_length(NEW.received_from) > ${SENDER_NAME_MAX_LENGTH}`),
  true,
);
check("DB description matches UI label", sql.includes("'Incoming fax recorded'"), true);
const journal = JSON.parse(
  readFileSync(new URL("../drizzle/migrations/meta/_journal.json", import.meta.url), "utf8"),
);
check(
  "0022 journaled after 0021",
  journal.entries.slice(-2).map((e) => e.tag),
  ["0021_document_type_other", "0022_incoming_received_fax"],
);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall incoming-fax checks passed");

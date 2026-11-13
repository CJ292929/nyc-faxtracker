#!/usr/bin/env node
// Isolated fixture test for P3-P19 "Other" Document Type helpers
// (src/lib/document-type.ts): edit-state reconstruction, save resolution
// (trim / required / length / predefined switch), and the document-type
// filter. No network, no credentials. The authoritative write-boundary
// rules live in drizzle/migrations/0021_document_type_other.sql and are
// exercised against a real Postgres by scripts/p3p19-document-type-db.mjs.
//   node --experimental-strip-types scripts/test-document-type-other.mjs
import { documentTypes, titleOf } from "../src/lib/fax.ts";
import {
  DOCUMENT_TYPE_MAX_LENGTH,
  OTHER_DOCUMENT_TYPE,
  documentTypeFormState,
  documentTypeOptions,
  isPredefinedDocumentType,
  matchesDocumentTypeFilter,
  resolveDocumentType,
} from "../src/lib/document-type.ts";
import { readFileSync } from "node:fs";

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

// Options: every predefined type preserved, in order, plus Other last.
check("dropdown keeps all predefined types then Other", documentTypeOptions, [
  ...documentTypes,
  "Other",
]);
check("predefined list unchanged (8 types)", documentTypes.length, 8);

// Edit-state reconstruction.
check("predefined restores that option", documentTypeFormState("Progress Note"), {
  selection: "Progress Note",
  custom: "",
});
check("custom restores Other + exact text", documentTypeFormState("Plan of Care"), {
  selection: "Other",
  custom: "Plan of Care",
});
check(
  "legacy nonstandard value preserved as Other text",
  documentTypeFormState("progress note (old)"),
  { selection: "Other", custom: "progress note (old)" },
);
check("legacy literal Other -> Other with empty text", documentTypeFormState("Other"), {
  selection: "Other",
  custom: "",
});
check("new document defaults to first predefined", documentTypeFormState(undefined), {
  selection: "Initial Evaluation",
  custom: "",
});

// Save resolution.
check(
  "predefined saves only predefined (custom discarded)",
  resolveDocumentType("Discharge Note", "Plan of Care"),
  { ok: true, value: "Discharge Note" },
);
check("Other trims custom text", resolveDocumentType("Other", "  Plan of Care \t"), {
  ok: true,
  value: "Plan of Care",
});
check("Other rejects empty", resolveDocumentType("Other", "").ok, false);
check("Other rejects whitespace-only", resolveDocumentType("Other", "   \t\n ").ok, false);
check("Other rejects null", resolveDocumentType("Other", null).ok, false);
check(
  "Other accepts exactly max length",
  resolveDocumentType("Other", "x".repeat(DOCUMENT_TYPE_MAX_LENGTH)).ok,
  true,
);
check(
  "Other rejects max length + 1",
  resolveDocumentType("Other", "x".repeat(DOCUMENT_TYPE_MAX_LENGTH + 1)).ok,
  false,
);
check(
  "length counted after trim",
  resolveDocumentType("Other", `  ${"x".repeat(DOCUMENT_TYPE_MAX_LENGTH)}  `).ok,
  true,
);
check("Other rejects literal 'other' text", resolveDocumentType("Other", " other ").ok, false);
check(
  "custom text matching a predefined type saves the predefined spelling",
  resolveDocumentType("Other", "progress note"),
  { ok: true, value: "Progress Note" },
);
check("unknown non-Other selection rejected", resolveDocumentType("Bogus", "").ok, false);
check("max length is 100", DOCUMENT_TYPE_MAX_LENGTH, 100);

// Round trip: Other -> predefined -> Other.
let stored = resolveDocumentType("Other", "Plan of Care").value;
let state = documentTypeFormState(stored);
check("round trip 1: Other restores text", state, { selection: "Other", custom: "Plan of Care" });
stored = resolveDocumentType("Re-evaluation", state.custom).value;
check("round trip 2: switch to predefined clears custom", documentTypeFormState(stored), {
  selection: "Re-evaluation",
  custom: "",
});
stored = resolveDocumentType("Other", "Home Exercise Program").value;
check("round trip 3: back to Other with new text", documentTypeFormState(stored), {
  selection: "Other",
  custom: "Home Exercise Program",
});

// Display value is the actual text everywhere titleOf is used (lists, detail,
// Add Attempt summary, search haystack, CSV/Excel/PDF export rows).
check(
  "titleOf shows custom text",
  titleOf({ document_type: "Plan of Care", document_number: null }),
  "Plan of Care",
);
check(
  "titleOf predefined unchanged",
  titleOf({ document_type: "Progress Note", document_number: 3 }),
  "Progress Note #3",
);

// Filters.
check("All types matches custom", matchesDocumentTypeFilter("Plan of Care", "All types"), true);
check("Other filter matches custom", matchesDocumentTypeFilter("Plan of Care", "Other"), true);
check(
  "Other filter matches legacy nonstandard",
  matchesDocumentTypeFilter("Legacy Thing", "Other"),
  true,
);
check(
  "Other filter excludes predefined",
  matchesDocumentTypeFilter("Progress Note", "Other"),
  false,
);
check("predefined filter exact", matchesDocumentTypeFilter("Progress Note", "Progress Note"), true);
check(
  "predefined filter excludes custom",
  matchesDocumentTypeFilter("Plan of Care", "Progress Note"),
  false,
);
check("isPredefined('Other') is false", isPredefinedDocumentType(OTHER_DOCUMENT_TYPE), false);

// UI and DB limits stay in sync.
const sql = readFileSync(
  new URL("../drizzle/migrations/0021_document_type_other.sql", import.meta.url),
  "utf8",
);
check(
  "migration enforces the same max length",
  sql.includes(`char_length(NEW.document_type) > ${DOCUMENT_TYPE_MAX_LENGTH}`),
  true,
);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall document-type checks passed");

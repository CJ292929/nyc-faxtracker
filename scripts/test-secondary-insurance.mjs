#!/usr/bin/env node
// Focused fixture test for P3-P23 Secondary / Supplemental Insurance -- no
// network, no Supabase, synthetic values only. Covers normalization and
// limits, the new eleven-column bulk template, older template
// compatibility, duplicate detection (secondary Member ID is never an
// identifier), retry reconciliation, search and View History labels.
// Run with:
//   node --experimental-strip-types scripts/test-secondary-insurance.mjs
import {
  TEMPLATE_HEADERS,
  PROVIDER_TEMPLATE_HEADERS,
  LEGACY_MD_TEMPLATE_HEADERS,
  LEGACY_TEMPLATE_HEADERS,
  detectTemplate,
  parseRows,
  markDuplicatesAgainstExisting,
  importedRowMatches,
  IMPORTED_PATIENT_COLUMNS,
} from "../src/lib/bulk-upload.ts";
import {
  SECONDARY_INSURANCE_LABEL,
  SECONDARY_MEMBER_ID_LABEL,
  SECONDARY_INSURANCE_MAX_LENGTH,
  SECONDARY_MEMBER_ID_MAX_LENGTH,
  normalizeOptionalText,
  validateSecondaryInsurance,
} from "../src/lib/secondary-insurance.ts";
import { matchesPatientQuery } from "../src/lib/incoming-fax.ts";
import { fieldLabel } from "../src/lib/audit-history.ts";

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
const ok = (name, cond) => check(name, !!cond, true);

// --- normalization / limits ---
check("trim surrounding whitespace", normalizeOptionalText("  Aetna Supp \t"), "Aetna Supp");
check("blank -> null", normalizeOptionalText("   "), null);
check("null stays null", normalizeOptionalText(null), null);
check("leading zeros + punctuation kept", normalizeOptionalText(" 00123-AB/4 "), "00123-AB/4");
check(
  "both blank is valid",
  validateSecondaryInsurance({ secondary_insurance: null, secondary_insurance_member_id: null }),
  [],
);
check(
  "insurance without Member ID is valid",
  validateSecondaryInsurance({ secondary_insurance: "Aetna", secondary_insurance_member_id: null }),
  [],
);
check(
  "Member ID without insurance is valid",
  validateSecondaryInsurance({ secondary_insurance: null, secondary_insurance_member_id: "0007" }),
  [],
);
check(
  "values at the limit are valid",
  validateSecondaryInsurance({
    secondary_insurance: "x".repeat(SECONDARY_INSURANCE_MAX_LENGTH),
    secondary_insurance_member_id: "9".repeat(SECONDARY_MEMBER_ID_MAX_LENGTH),
  }),
  [],
);
check(
  "over-limit values are rejected",
  validateSecondaryInsurance({
    secondary_insurance: "x".repeat(SECONDARY_INSURANCE_MAX_LENGTH + 1),
    secondary_insurance_member_id: "9".repeat(SECONDARY_MEMBER_ID_MAX_LENGTH + 1),
  }).length,
  2,
);
check(
  "limits match migration 0023",
  [SECONDARY_INSURANCE_MAX_LENGTH, SECONDARY_MEMBER_ID_MAX_LENGTH],
  [200, 100],
);

// --- template shapes ---
check("current template has 11 columns", TEMPLATE_HEADERS.length, 11);
check(
  "secondary columns are appended last, earlier positions unchanged",
  [TEMPLATE_HEADERS.slice(0, 9), TEMPLATE_HEADERS.slice(9)],
  [[...PROVIDER_TEMPLATE_HEADERS], [SECONDARY_INSURANCE_LABEL, SECONDARY_MEMBER_ID_LABEL]],
);
check("current header detected", detectTemplate([...TEMPLATE_HEADERS]).kind, "current");
check(
  "previous 9-column Referring Provider header detected",
  detectTemplate([...PROVIDER_TEMPLATE_HEADERS]).kind,
  "legacy_provider9",
);
check(
  "9-column Referring MD header detected",
  detectTemplate([...LEGACY_MD_TEMPLATE_HEADERS]).kind,
  "legacy_md9",
);
check("6-column header detected", detectTemplate([...LEGACY_TEMPLATE_HEADERS]).kind, "legacy");
check(
  "header detection is case-insensitive",
  detectTemplate(TEMPLATE_HEADERS.map((h) => h.toUpperCase())).kind,
  "current",
);
const tenCols = detectTemplate(TEMPLATE_HEADERS.slice(0, 10));
ok(
  "10-column header rejected with a clear message",
  tenCols.kind === null && /Expected 11 columns/.test(tenCols.errors[0]),
);
const wrongSecondary = detectTemplate([...TEMPLATE_HEADERS.slice(0, 10), "Tertiary Member ID"]);
check("misnamed secondary column reported by position", wrongSecondary.errors, [
  `Column 11 must be "${SECONDARY_MEMBER_ID_LABEL}" (found "Tertiary Member ID").`,
]);

// --- new template round-trip ---
const base = [
  "Round Trip",
  "0001234",
  "03/14/1980",
  "555-0100",
  "Medicare",
  "Dr. Lee",
  "1234567893",
  "555-0101",
  "555-0102",
];
const current = parseRows([
  [...TEMPLATE_HEADERS],
  [...base, "  Aetna Supplemental ", " 00123-AB/4 "],
  ["Only Insurance", "", "", "", "", "", "", "", "", "Cigna Medigap", ""],
  ["Only Member", "", "", "", "", "", "", "", "", "", "0007"],
  ["No Secondary", "", "", "", "", "", "", "", "", "", ""],
  ["Too Long", "", "", "", "", "", "", "", "", "x".repeat(201), "9".repeat(101)],
]);
check("current template parses without file errors", current.fileErrors, []);
const [rt, onlyIns, onlyMember, none, tooLong] = current.rows;
check(
  "secondary values trimmed, leading zeros kept",
  [rt.secondary_insurance, rt.secondary_insurance_member_id, rt.member_id],
  ["Aetna Supplemental", "00123-AB/4", "0001234"],
);
check("row with secondary values is valid", rt.errors, []);
check(
  "insurance alone is valid",
  [onlyIns.errors, onlyIns.secondary_insurance_member_id],
  [[], ""],
);
check("Member ID alone is valid", [onlyMember.errors, onlyMember.secondary_insurance], [[], ""]);
check("no secondary values is valid", [none.errors, none.secondary_insurance], [[], ""]);
check("over-limit secondary values flagged", tooLong.errors, [
  `${SECONDARY_INSURANCE_LABEL} exceeds 200 characters.`,
  `${SECONDARY_MEMBER_ID_LABEL} exceeds 100 characters.`,
]);
// Excel can hand back a number when the Text format was lost; it is kept as
// its string form (the template pre-formats both Member ID columns as Text).
const numeric = parseRows([
  [...TEMPLATE_HEADERS],
  ["Numeric Cell", "", "", "", "", "", "", "", "", "", 7],
]);
check("numeric Member ID cell read as text", numeric.rows[0].secondary_insurance_member_id, "7");

// --- older templates still accepted, secondary left empty ---
for (const [label, headers, row] of [
  ["9-column Referring Provider", PROVIDER_TEMPLATE_HEADERS, base],
  ["9-column Referring MD", LEGACY_MD_TEMPLATE_HEADERS, base],
  ["6-column", LEGACY_TEMPLATE_HEADERS, base.slice(0, 6)],
]) {
  const parsed = parseRows([[...headers], row]);
  check(`${label}: accepted, row valid`, [parsed.fileErrors, parsed.rows[0].errors], [[], []]);
  check(
    `${label}: secondary fields left empty`,
    [parsed.rows[0].secondary_insurance, parsed.rows[0].secondary_insurance_member_id],
    ["", ""],
  );
  check(`${label}: primary Member ID unchanged`, parsed.rows[0].member_id, "0001234");
}

// --- secondary Member ID is never a patient identifier ---
const sharedSecondary = parseRows([
  [...TEMPLATE_HEADERS],
  ["Alice Able", "", "01/01/1980", "", "", "", "", "", "", "Aetna", "SHARED-1"],
  ["Bob Baker", "", "02/02/1970", "", "", "", "", "", "", "Aetna", "SHARED-1"],
]);
ok(
  "two different patients sharing a secondary Member ID are not in-file duplicates",
  sharedSecondary.rows.every((r) => !r.duplicateInFile),
);
const existing = [
  {
    id: "existing-1",
    first_name: "Carol",
    last_name: "Cole",
    patient_id: "PT-9",
    date_of_birth: "1960-06-06",
    insurance_member_id: "PRIMARY-9",
    secondary_insurance_member_id: "SHARED-1",
    deleted_at: null,
  },
];
markDuplicatesAgainstExisting(sharedSecondary.rows, existing);
ok(
  "matching only an existing patient's secondary Member ID is not a possible match",
  sharedSecondary.rows.every((r) => r.duplicateExisting === null),
);
const secondaryAsPrimary = parseRows([
  [...TEMPLATE_HEADERS],
  ["Dan Dee", "SHARED-1", "03/03/1990", "", "", "", "", "", "", "", ""],
]);
markDuplicatesAgainstExisting(secondaryAsPrimary.rows, existing);
ok(
  "a primary Member ID equal to someone's secondary Member ID is not a match",
  secondaryAsPrimary.rows[0].duplicateExisting === null,
);

// --- retry reconciliation ---
check(
  "reconciliation reads back both secondary columns",
  ["secondary_insurance", "secondary_insurance_member_id"].every((c) =>
    IMPORTED_PATIENT_COLUMNS.split(", ").includes(c),
  ),
  true,
);
const stored = {
  first_name: "Round",
  last_name: "Trip",
  date_of_birth: "1980-03-14",
  phone: "555-0100",
  insurance: "Medicare",
  insurance_member_id: "0001234",
  referring_physician: "Dr. Lee",
  referring_physician_npi: "1234567893",
  referring_physician_office_phone: "555-0101",
  referring_physician_fax: "555-0102",
  secondary_insurance: "Aetna Supplemental",
  secondary_insurance_member_id: "00123-AB/4",
};
ok("retry: identical row is verified as already created", importedRowMatches(stored, rt));
ok(
  "retry: mismatched secondary insurance is a conflict",
  !importedRowMatches({ ...stored, secondary_insurance: "Cigna" }, rt),
);
ok(
  "retry: mismatched secondary Member ID is a conflict",
  !importedRowMatches({ ...stored, secondary_insurance_member_id: "123-AB/4" }, rt),
);
ok(
  "retry: stored secondary value vs blank upload is a conflict",
  !importedRowMatches({ ...stored, secondary_insurance: "Aetna" }, none) &&
    !importedRowMatches(stored, { ...rt, secondary_insurance_member_id: "" }),
);
ok(
  "retry: NULL stored vs blank upload matches",
  importedRowMatches(
    { ...stored, secondary_insurance: null, secondary_insurance_member_id: null },
    { ...rt, secondary_insurance: "", secondary_insurance_member_id: "" },
  ),
);

// --- search ---
const patient = {
  first_name: "Eve",
  last_name: "Evans",
  patient_id: "PT-1",
  insurance_member_id: "M1",
  secondary_insurance_member_id: "00123-AB/4",
};
ok(
  "Record Received Fax search finds secondary Member ID",
  matchesPatientQuery(patient, "00123-ab/4"),
);
ok("search still finds primary Member ID", matchesPatientQuery(patient, "m1"));
ok(
  "search without secondary Member ID still works",
  matchesPatientQuery({ ...patient, secondary_insurance_member_id: null }, "eve"),
);

// --- View History labels ---
check(
  "history labels for both fields",
  [
    fieldLabel("patient", "secondary_insurance"),
    fieldLabel("patient", "secondary_insurance_member_id"),
  ],
  [SECONDARY_INSURANCE_LABEL, SECONDARY_MEMBER_ID_LABEL],
);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll secondary insurance checks passed.");

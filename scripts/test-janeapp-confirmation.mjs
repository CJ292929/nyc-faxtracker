#!/usr/bin/env node
// Focused fixture test for P3-P24 "Uploaded to JaneApp?" confirmation -- no
// network, no Supabase, synthetic values only. Covers the three-state
// mapping, alert rules (only Yes clears it), strict choice parsing, View
// History label/values, independence from the existing Uploaded / received
// status, and the 0024 migration + journal shape.
// Run with:
//   node --experimental-strip-types scripts/test-janeapp-confirmation.mjs
import { readFileSync } from "node:fs";
import {
  JANEAPP_CHOICES,
  JANEAPP_FIELD_LABEL,
  janeAppAlertOf,
  janeAppChoiceOf,
  janeAppStatusText,
  janeAppValueOf,
} from "../src/lib/janeapp.ts";
import { fieldLabel, formatValue } from "../src/lib/audit-history.ts";
import { statusOf } from "../src/lib/fax.ts";

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

// --- three states ---
check("choices are Yes / No / Unconfirmed", [...JANEAPP_CHOICES], ["Yes", "No", "Unconfirmed"]);
check(
  "stored value -> choice",
  [true, false, null, undefined].map(janeAppChoiceOf),
  ["Yes", "No", "Unconfirmed", "Unconfirmed"],
);
check(
  "choice -> stored value (clear back to Unconfirmed is NULL)",
  ["Yes", "No", "Unconfirmed"].map(janeAppValueOf),
  [true, false, null],
);
for (const bad of ["", "yes", "true", "Maybe", "null"]) {
  let threw = false;
  try {
    janeAppValueOf(bad);
  } catch {
    threw = true;
  }
  check(`invalid choice ${JSON.stringify(bad)} is rejected, never written as Unconfirmed`, threw, true);
}

// --- alerts ---
check("Yes -> no alert", janeAppAlertOf(true), null);
check("No -> Not uploaded to JaneApp", janeAppAlertOf(false), "Not uploaded to JaneApp");
check("Unanswered -> JaneApp upload not confirmed", janeAppAlertOf(null), "JaneApp upload not confirmed");
check("legacy row without the column -> not confirmed", janeAppAlertOf(undefined), "JaneApp upload not confirmed");
check(
  "status text is readable for every state (not color alone)",
  [true, false, null].map(janeAppStatusText),
  ["Uploaded to JaneApp", "Not uploaded to JaneApp", "JaneApp upload not confirmed"],
);

// --- View History ---
check("history label", fieldLabel("document", "janeapp_uploaded"), JANEAPP_FIELD_LABEL);
check(
  "history values are readable, NULL shows Unconfirmed",
  [true, false, null].map((v) => formatValue("janeapp_uploaded", v)),
  ["Yes", "No", "Unconfirmed"],
);
check("other boolean fields still format as before", formatValue("uploaded", null), "(blank)");

// --- independence from existing upload / received status ---
const base = {
  id: "d24",
  direction: "outgoing",
  uploaded: false,
  received: false,
  status: "Pending",
};
for (const janeapp_uploaded of [true, false, null]) {
  check(
    `fax status ignores JaneApp=${janeapp_uploaded} (outgoing)`,
    statusOf({ ...base, janeapp_uploaded }, []),
    "Pending",
  );
  check(
    `fax status ignores JaneApp=${janeapp_uploaded} (incoming)`,
    statusOf({ ...base, direction: "incoming", received: true, janeapp_uploaded }, []),
    "Received",
  );
}
check(
  "Uploaded to patient system / attachments never imply JaneApp Yes",
  janeAppChoiceOf({ ...base, uploaded: true }.janeapp_uploaded),
  "Unconfirmed",
);

// --- migration + journal ---
const sql = readFileSync(
  new URL("../drizzle/migrations/0024_add_janeapp_upload_confirmation.sql", import.meta.url),
  "utf8",
);
const statements = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
check(
  "0024 adds a nullable boolean with no default",
  /ALTER TABLE public\.documents ADD COLUMN IF NOT EXISTS janeapp_uploaded boolean;/.test(statements) &&
    !/DEFAULT|NOT NULL/i.test(statements),
  true,
);
check("0024 never touches existing upload/received fields", /\b(uploaded|received|document_files)\b\s*=|UPDATE /i.test(statements), false);
const journal = JSON.parse(
  readFileSync(new URL("../drizzle/migrations/meta/_journal.json", import.meta.url), "utf8"),
);
const tags = journal.entries.map((e) => e.tag);
const i24 = tags.indexOf("0024_add_janeapp_upload_confirmation");
const e23 = journal.entries[tags.indexOf("0023_add_secondary_insurance")];
check("journal lists 0024 directly after 0023", i24 === tags.indexOf("0023_add_secondary_insurance") + 1, true);
check("0024 journal time is after 0023", journal.entries[i24]?.when > e23.when, true);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll JaneApp confirmation checks passed.");

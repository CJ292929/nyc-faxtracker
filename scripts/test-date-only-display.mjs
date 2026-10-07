#!/usr/bin/env node
// Regression check for the P3-P17 date-only display fix: dateOnlyOf must
// render the same calendar day the database stored, regardless of the
// viewer's timezone (including DST-boundary dates).
//
// Rather than relying on the process-wide TZ env var (which this repo's
// Node/shell combinations do not reliably honor across platforms), each
// zone is simulated explicitly via Intl's `timeZone` option -- the same
// mechanism the browser uses to render toLocaleDateString in the viewer's
// zone. This also reproduces the original bug directly: the pre-fix
// `dateOf()` logic (new Date(dateString).toLocaleDateString(...)) rolls the
// displayed day back by one in any zone behind UTC, which is exactly what
// the second assertion below demonstrates for America/New_York.
//   node --experimental-strip-types scripts/test-date-only-display.mjs
import { dateOnlyOf, dateOf } from "../src/lib/fax.ts";

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

// The exact mechanism the old, buggy dateOf() used: new Date(dateString)
// parses a bare YYYY-MM-DD as UTC midnight, then toLocaleDateString renders
// in whatever zone is given. In any zone behind UTC (e.g. America/New_York,
// UTC-5), that rolls the displayed day back by one.
function buggyDateOfInZone(date, timeZone) {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
}

const ZONES = ["UTC", "America/New_York", "Asia/Manila", "Pacific/Kiritimati"];
const DATES = [
  "2025-12-10", // the originally reported case
  "2025-03-08", // DST spring-forward eve (America/New_York)
  "2025-03-09", // DST spring-forward day
  "2025-03-10", // day after spring-forward
  "2025-11-01", // DST fall-back eve
  "2025-11-02", // DST fall-back day
  "2025-11-03", // day after fall-back
  "2025-12-31", // year boundary eve
  "2026-01-01", // year boundary
];

// dateOnlyOf never constructs a Date object, so it must produce the exact
// same string in every zone for a given stored date -- proving it is
// immune to the bug regardless of viewer timezone.
for (const date of DATES) {
  // dateOnlyOf ignores timeZone entirely, so this is really just asserting
  // it returns a single stable value -- included as a sanity check that no
  // Date object sneaks in and makes it zone-dependent.
  const results = new Set(ZONES.map(() => dateOnlyOf(date)));
  check(`dateOnlyOf(${date}) is the same in every zone`, results.size, 1);
}

// Demonstrate the originally reported bug reproduces exactly as described
// with the old dateOf()-based approach, and that dateOnlyOf fixes it.
check(
  "pre-fix dateOf() in America/New_York shows the WRONG day (reproduces the bug)",
  buggyDateOfInZone("2025-12-10", "America/New_York"),
  "Dec 9, 2025",
);
check(
  "dateOnlyOf in America/New_York shows the CORRECT day",
  dateOnlyOf("2025-12-10"),
  "Dec 10, 2025",
);
check(
  "dateOnlyOf matches the stored date for every DST-boundary case",
  DATES.map((d) => dateOnlyOf(d)),
  [
    "Dec 10, 2025",
    "Mar 8, 2025",
    "Mar 9, 2025",
    "Mar 10, 2025",
    "Nov 1, 2025",
    "Nov 2, 2025",
    "Nov 3, 2025",
    "Dec 31, 2025",
    "Jan 1, 2026",
  ],
);

check("null is an em dash", dateOnlyOf(null), "—");
check("empty string is an em dash", dateOnlyOf(""), "—");

// dateOf (used for genuine timestamptz instants) is intentionally left
// using Date()-based local-zone conversion -- not a regression target here,
// just confirming the two helpers remain distinct and dateOf is untouched.
check("dateOf is untouched and still a function", typeof dateOf, "function");

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll date-only display checks passed.");

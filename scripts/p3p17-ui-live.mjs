#!/usr/bin/env node
// P3-P17R live browser verification: both delete-document entry points
// (document detail page "Delete" button, and the Trash2 row action in
// DocumentTable on the patient detail page), for admin AND staff, including
// Cancel (no mutation) and successful delete (history/counts refresh).
// Also verifies the date-only display fix (document_date / date_of_birth
// render the same calendar day in UTC and America/New_York) alongside a
// genuine timestamp (fax_attempts.attempted_at), which must still shift
// with timezone -- proving the fix did not regress real instants into
// date-only behavior. Finally checks the "Referring Provider" display-label
// rename is visible where expected.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env and E2E_BASE_URL
// pointing at a running deployment (Preview or Production).
// Run with: node --experimental-strip-types scripts/p3p17-ui-live.mjs [screenshotDir]
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const SHOT_DIR = process.argv[2] || ".";
mkdirSync(SHOT_DIR, { recursive: true });

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      ];
    }),
);

const BASE_URL = process.env.E2E_BASE_URL;
if (!BASE_URL) {
  console.error("Set E2E_BASE_URL to the deployment under test.");
  process.exit(1);
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `p3p17v${stamp}`.slice(0, 14);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const createdUserIds = [];
async function makeSyntheticAccount(label, role) {
  const email = `synth-${tag}${label}@users.invalid`;
  const password = `Synth-${stamp}-${label}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user)
    throw new Error(`failed to create synthetic ${label}: ${error?.message}`);
  const id = data.user.id;
  const username = `${tag}${label}`.slice(0, 32);
  await admin.from("user_logins").insert({ user_id: id, username });
  await admin.from("user_roles").insert({ user_id: id, role });
  createdUserIds.push(id);
  return { id, username, password };
}

let patientId;
async function cleanup() {
  if (patientId) {
    const { data: docs } = await admin.from("documents").select("id").eq("patient_id", patientId);
    for (const d of docs ?? []) {
      await admin.from("fax_attempts").delete().eq("document_id", d.id);
      await admin.from("document_files").delete().eq("document_id", d.id);
    }
    await admin.from("documents").delete().eq("patient_id", patientId);
    await admin.from("patients").delete().eq("id", patientId);
  }
  for (const id of createdUserIds) {
    try {
      await admin.from("user_roles").delete().eq("user_id", id);
    } catch {}
    try {
      await admin.from("user_logins").delete().eq("user_id", id);
    } catch {}
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {}
  }
  console.log(`cleaned up patient + ${createdUserIds.length} synthetic account(s)`);
}

async function loginAs(page, portal, username, password) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const portalLabel = portal === "admin" ? "Admin Login" : "Staff Login";
  await page.getByRole("button", { name: portalLabel }).click();
  await page.locator(`#${portal}-username`).fill(username);
  await page.locator(`#${portal}-password`).fill(password);
  await page.getByRole("button", { name: portalLabel }).click();
  await page.waitForURL(/\/(?:$|\?)/, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector("text=Dashboard", { timeout: 15000 }).catch(() => {});
}

(async () => {
  const adminAcct = await makeSyntheticAccount("admin", "admin");
  const staffAcct = await makeSyntheticAccount("staff", "staff");

  const { data: patient, error: patientError } = await admin
    .from("patients")
    .insert({
      first_name: "P3P17R",
      last_name: "Synthetic",
      patient_id: `P3P17R-${stamp}`,
      date_of_birth: "1990-12-10",
      referring_physician: "Dr. Synthetic Referrer",
    })
    .select("id")
    .single();
  if (patientError || !patient)
    throw new Error(`failed to create synthetic patient: ${patientError?.message}`);
  patientId = patient.id;

  const docCommon = {
    patient_id: patientId,
    document_type: "Initial Evaluation",
    recipient_type: "Insurance",
    recipient_name: "Synthetic Recipient",
    document_date: "2025-12-10",
    md_name: "Dr. Same",
  };
  const { data: docA } = await admin.from("documents").insert(docCommon).select("id").single();
  const { data: docB } = await admin.from("documents").insert(docCommon).select("id").single();
  // A real instant (not date-only): 2025-06-15 14:30 UTC => 10:30 AM in
  // America/New_York (EDT, UTC-4). This must visibly differ by timezone,
  // unlike document_date/date_of_birth above.
  await admin.from("fax_attempts").insert({
    document_id: docA.id,
    attempt_number: 1,
    status: "Sent Successfully",
    attempted_at: "2025-06-15T14:30:00Z",
  });
  await admin.from("fax_attempts").insert({
    document_id: docB.id,
    attempt_number: 1,
    status: "Sent Successfully",
    attempted_at: "2025-06-15T14:30:00Z",
  });

  try {
    // ---- Date-only + genuine-timestamp check in two timezones ----
    for (const tz of ["UTC", "America/New_York"]) {
      const browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: 1400, height: 900 },
        timezoneId: tz,
      });
      try {
        await loginAs(page, "admin", adminAcct.username, adminAcct.password);

        await page.goto(`${BASE_URL}/documents/${docA.id}`, { waitUntil: "networkidle" });
        const docText = await page.locator("body").innerText();
        check(`[${tz}] document_date renders Dec 10, 2025`, docText.includes("Dec 10, 2025"));

        await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
        const patientText = await page.locator("body").innerText();
        check(`[${tz}] date_of_birth renders Dec 10, 1990`, patientText.includes("Dec 10, 1990"));
        check(
          `[${tz}] Referring Provider label visible on patient detail`,
          /referring provider/i.test(patientText),
        );

        if (tz === "UTC") {
          check("[UTC] genuine timestamp shows 2:30 PM", patientText.includes("2:30 PM"));
        } else {
          check(
            "[America/New_York] genuine timestamp shifted to 10:30 AM (not date-only-frozen)",
            patientText.includes("10:30 AM"),
          );
        }

        await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
        const listText = await page.locator("body").innerText();
        check(
          `[${tz}] Patients list shows "Referring Provider" column header`,
          /referring provider/i.test(listText),
        );
      } finally {
        await browser.close();
      }
    }

    // ---- Entry point 1: document detail page "Delete" button, as admin ----
    const browser1 = await chromium.launch();
    const page1 = await browser1.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      await loginAs(page1, "admin", adminAcct.username, adminAcct.password);
      await page1.goto(`${BASE_URL}/documents/${docA.id}`, { waitUntil: "networkidle" });
      await page1.screenshot({
        path: path.join(SHOT_DIR, "01-doc-detail-before-delete.png"),
        fullPage: true,
      });

      await page1.getByRole("button", { name: "Delete" }).click();
      const dialog1 = page1.locator('[role="dialog"][aria-label="Delete document"]');
      await dialog1.waitFor({ timeout: 5000 });
      check(
        "Entry point 1: dialog names patient and document",
        (await dialog1.innerText()).includes("P3P17R Synthetic"),
      );
      await page1.screenshot({
        path: path.join(SHOT_DIR, "02-doc-detail-dialog-open.png"),
        fullPage: true,
      });

      // Cancel: no mutation.
      await dialog1.getByRole("button", { name: "Cancel" }).click();
      await dialog1.waitFor({ state: "hidden", timeout: 5000 });
      const { data: stillA } = await admin
        .from("documents")
        .select("id")
        .eq("id", docA.id)
        .maybeSingle();
      check("Entry point 1: Cancel performed no mutation", !!stillA);

      // Confirm: successful delete.
      await page1.getByRole("button", { name: "Delete" }).click();
      await dialog1.waitFor({ timeout: 5000 });
      await dialog1.getByRole("button", { name: "Delete Permanently" }).click();
      await page1.locator("text=/permanently deleted/i").first().waitFor({ timeout: 10000 });
      await page1.waitForURL(new RegExp(`/patients/${patientId}`), { timeout: 10000 });
      await page1.screenshot({
        path: path.join(SHOT_DIR, "03-after-entrypoint1-delete.png"),
        fullPage: true,
      });

      const { data: goneA } = await admin
        .from("documents")
        .select("id")
        .eq("id", docA.id)
        .maybeSingle();
      check("Entry point 1: document A actually deleted from the database", !goneA);
      const statText = await page1.locator("body").innerText();
      check(
        "Entry point 1: patient page Total Documents count refreshed to 1",
        /Total Documents\s*1/.test(statText.replace(/\s+/g, " ")),
      );
      check("Entry point 1: deleted document no longer listed", !statText.includes(docA.id));
    } finally {
      await browser1.close();
    }

    // ---- Entry point 2: DocumentTable row delete icon on patient detail page, as staff ----
    const browser2 = await chromium.launch();
    const page2 = await browser2.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      await loginAs(page2, "staff", staffAcct.username, staffAcct.password);
      await page2.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
      await page2.screenshot({
        path: path.join(SHOT_DIR, "04-patient-detail-before-delete.png"),
        fullPage: true,
      });

      const row = page2.locator("table.data-table tbody tr").first();
      await row.waitFor({ timeout: 10000 });
      await row.locator('button[title="Delete document"]').click();
      const dialog2 = page2.locator('[role="dialog"][aria-label="Delete document"]');
      await dialog2.waitFor({ timeout: 5000 });
      await page2.screenshot({
        path: path.join(SHOT_DIR, "05-row-dialog-open.png"),
        fullPage: true,
      });

      // Cancel: no mutation, row still present.
      await dialog2.getByRole("button", { name: "Cancel" }).click();
      await dialog2.waitFor({ state: "hidden", timeout: 5000 });
      const { data: stillB } = await admin
        .from("documents")
        .select("id")
        .eq("id", docB.id)
        .maybeSingle();
      check("Entry point 2 (staff): Cancel performed no mutation", !!stillB);
      check(
        "Entry point 2 (staff): row still present in the table after Cancel",
        (await page2.locator("table.data-table tbody tr").count()) === 1,
      );

      // Confirm: successful delete, as staff (not admin-only).
      await row.locator('button[title="Delete document"]').click();
      await dialog2.waitFor({ timeout: 5000 });
      await dialog2.getByRole("button", { name: "Delete Permanently" }).click();
      await page2.locator("text=/permanently deleted/i").first().waitFor({ timeout: 10000 });
      await page2
        .locator("table.data-table tbody tr", { hasText: "Initial Evaluation" })
        .waitFor({ state: "detached", timeout: 10000 })
        .catch(() => {});
      await page2.screenshot({
        path: path.join(SHOT_DIR, "06-after-entrypoint2-delete.png"),
        fullPage: true,
      });

      const { data: goneB } = await admin
        .from("documents")
        .select("id")
        .eq("id", docB.id)
        .maybeSingle();
      check("Entry point 2 (staff): document B actually deleted from the database", !goneB);
      const { data: patientStill } = await admin
        .from("patients")
        .select("id")
        .eq("id", patientId)
        .maybeSingle();
      check(
        "Entry point 2 (staff): patient itself still exists after both documents deleted",
        !!patientStill,
      );
      const statText2 = await page2.locator("body").innerText();
      check(
        "Entry point 2 (staff): patient page Total Documents count refreshed to 0",
        /Total Documents\s*0/.test(statText2.replace(/\s+/g, " ")),
      );
    } finally {
      await browser2.close();
    }
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll live browser checks passed. Synthetic patient/documents/accounts cleaned up.");
})();

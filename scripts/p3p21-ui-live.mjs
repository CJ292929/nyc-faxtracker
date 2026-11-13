#!/usr/bin/env node
// Live browser verification of P3-P21 (incoming / received fax without a
// prior outbound fax) against a real deployment, using only synthetic
// accounts, patients and files that are removed again at the end (same
// discipline as p3p19-ui-live.mjs).
//
// Per actor (staff on desktop, admin on a phone): both entry points (patient
// profile with the patient preselected; Fax Tracker with patient search);
// Cancel writes nothing; validation messages; Other + custom type, sender,
// received time, document date and attachment persist; zero fax attempts;
// detail page shows Incoming/Received/sender and no send or attempt UI;
// failed attachment upload is retried without duplicating the document;
// edit; View History; search, direction filters, Reports counts (outbound
// totals unchanged) and the downloaded CSV / Excel / PDF; an outgoing fax +
// response still works; permanent deletion removes the attachment. Also:
// anon and role-less REST writes are denied; no unexpected console errors or
// failed requests.
//
// Env (file): P3P21_ENV_FILE or .env with SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY.
// Run with: E2E_BASE_URL=https://<deployment> node scripts/p3p21-ui-live.mjs [shot-dir]
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, devices } from "playwright";
import XLSX from "xlsx";

const SHOT_DIR = process.argv[2] || ".";
mkdirSync(SHOT_DIR, { recursive: true });
const env = Object.fromEntries(
  readFileSync(process.env.P3P21_ENV_FILE || ".env", "utf8")
    .split(/\r?\n/)
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
const BASE_URL = process.env.E2E_BASE_URL?.replace(/\/$/, "");
if (!BASE_URL) {
  console.error("Set E2E_BASE_URL to the deployment under test.");
  process.exit(1);
}
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const stamp = Date.now();
const tag = `p3p21${String(stamp).slice(-7)}`;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", String(JSON.stringify(detail)).slice(0, 700));
  }
}

const accounts = [];
const patientIds = [];
async function makeAccount(label, role) {
  const email = `synth-${tag}${label}@users.invalid`;
  const password = `Synth-${stamp}-${label}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`create ${label}: ${error?.message}`);
  const username = `${tag}${label}`.slice(0, 32);
  await admin.from("user_logins").insert({ user_id: data.user.id, username });
  if (role) await admin.from("user_roles").insert({ user_id: data.user.id, role });
  const acct = { id: data.user.id, username, password, email, role };
  accounts.push(acct);
  return acct;
}
async function apiClientFor(acct) {
  const c = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  if (acct) {
    const { error } = await c.auth.signInWithPassword({
      email: acct.email,
      password: acct.password,
    });
    if (error) throw new Error(`sign in ${acct.username}: ${error.message}`);
  }
  return c;
}
const docsOf = async (pid) =>
  (await admin.from("documents").select("*").eq("patient_id", pid).order("created_at")).data ?? [];
const filesOf = async (docId) =>
  (await admin.from("document_files").select("*").eq("document_id", docId)).data ?? [];
const attemptsOf = async (docId) =>
  (await admin.from("fax_attempts").select("id").eq("document_id", docId)).data ?? [];

// Requests we deliberately fail (simulated attachment outage) are expected.
let simulatingUploadFailure = false;
const problems = [];
async function session(browser, acct, mobile) {
  const context = await browser.newContext({
    ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1400, height: 900 } }),
    timezoneId: "America/New_York",
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const note = (msg) => {
    if (simulatingUploadFailure && /storage\/v1\/object|status of 500/.test(msg)) return;
    problems.push(msg);
  };
  page.on("console", (m) => {
    if (m.type() === "error") note(`${acct.username} console: ${m.text()}`);
  });
  page.on("pageerror", (e) => note(`${acct.username} pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(f))
      note(`${acct.username} requestfailed: ${r.url()} ${f}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) note(`${acct.username} HTTP ${r.status()}: ${r.url()}`);
  });
  const portal = acct.role === "admin" ? "admin" : "staff";
  const label = portal === "admin" ? "Admin Login" : "Staff Login";
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: label }).click();
  await page.locator(`#${portal}-username`).fill(acct.username);
  await page.locator(`#${portal}-password`).fill(acct.password);
  await page.getByRole("button", { name: label }).click();
  await page.waitForSelector("text=Dashboard", { timeout: 20000 });
  return { context, page };
}

const dialog = (page) => page.locator('[role="dialog"]').last();
const toast = (page, text) => page.getByText(text).first().waitFor({ timeout: 20000 });
const settle = (page) =>
  page.getByText("Loading records…").waitFor({ state: "detached", timeout: 20000 });
const results = (page) =>
  page.locator("main").evaluate((m) => {
    const c = m.cloneNode(true);
    c.querySelectorAll("select, option").forEach((e) => e.remove());
    return c.innerText ?? c.textContent;
  });
const noHorizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function stat(page, label) {
  return page.evaluate((l) => {
    for (const el of document.querySelectorAll("main div")) {
      if (el.children.length === 0 && el.textContent?.trim() === l) {
        return el.nextElementSibling?.textContent?.trim() ?? null;
      }
    }
    return null;
  }, label);
}
async function download(page, button) {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: button }).click(),
  ]);
  const p = path.join(SHOT_DIR, `${tag}-${dl.suggestedFilename()}`);
  await dl.saveAs(p);
  return readFileSync(p);
}
const pdfFile = (name) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4\n% synthetic P3-P21 test file ${name}\n%%EOF\n`),
});
async function fillIncoming(page, f) {
  const d = dialog(page);
  if (f.type) await d.locator('select[name="document_type"]').selectOption(f.type);
  if (f.custom !== undefined) await d.locator('input[name="document_type_other"]').fill(f.custom);
  if (f.receivedAt !== undefined) await d.locator('input[name="received_date"]').fill(f.receivedAt);
  if (f.documentDate) await d.locator('input[name="document_date"]').fill(f.documentDate);
  if (f.sender !== undefined) await d.locator('input[name="received_from"]').fill(f.sender);
  if (f.senderFax) await d.locator('input[name="received_fax"]').fill(f.senderFax);
  if (f.notes) await d.locator('textarea[name="notes"]').fill(f.notes);
  if (f.file) await d.locator('input[name="attachment"]').setInputFiles(f.file);
}
const saveIncoming = (page) =>
  dialog(page).getByRole("button", { name: "Save Received Fax" }).click();
const alertText = async (page) =>
  (await dialog(page).getByRole("alert").first().textContent({ timeout: 5000 })) ?? "";

async function actorFlow(browser, acct, mobile) {
  const L = acct.role;
  const view = mobile ? "mobile" : "desktop";
  const last = `P3P21 ${L} ${stamp}`;
  const code = `P3P21-${stamp}-${L}`;
  const { data: pat } = await admin
    .from("patients")
    .insert({
      first_name: "Synthetic",
      last_name: last,
      patient_id: code,
      referring_physician: `Dr. Referrer ${L}`,
    })
    .select()
    .single();
  patientIds.push(pat.id);
  const custom = `Outside Referral ${L} ${stamp}`;
  const sender = `Outside Ortho ${L} ${stamp}`;
  const { context, page } = await session(browser, acct, mobile);
  try {
    // ---- Entry point 1: patient profile (patient preselected) ------------
    await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
    await settle(page);
    await page.getByRole("button", { name: "Record Received Fax" }).click();
    await dialog(page).getByText("Record received fax").waitFor();
    // textContent, not innerText: field labels are CSS-uppercased.
    let dtext = await dialog(page).textContent();
    check(
      `${L}/${view}: profile entry preselects patient (shared Patient Information card)`,
      dtext.includes(`Synthetic ${last}`) && dtext.includes("Referring Provider"),
    );
    check(
      `${L}/${view}: form has no outbound recipient or fax-attempt fields`,
      (await dialog(page)
        .locator(
          'input[name="recipient_name"], input[name="recipient_fax"], select[name="recipient_type"], input[name="attempted_at"], input[name="confirmation_number"]',
        )
        .count()) === 0,
    );
    check(
      `${L}/${view}: sender labels shown`,
      dtext.includes("Sender / provider name") && dtext.includes("Sender fax number"),
    );
    if (mobile)
      check(`${L}/${view}: dialog fits the phone width`, await noHorizontalOverflow(page));
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-form.png`) });

    // Cancel writes nothing.
    await fillIncoming(page, { sender: "Should Not Save" });
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await page.locator('[role="dialog"]').waitFor({ state: "detached" });
    check(`${L}/${view}: Cancel writes nothing`, (await docsOf(pat.id)).length === 0);

    // Validation: sender required, Other text required, received time required.
    await page.getByRole("button", { name: "Record Received Fax" }).click();
    await fillIncoming(page, { sender: "   " });
    await saveIncoming(page);
    check(
      `${L}/${view}: blank sender rejected with a clear message`,
      /sender \/ provider name/i.test(await alertText(page)),
    );
    await fillIncoming(page, { sender, type: "Other", custom: "  " });
    await saveIncoming(page);
    check(
      `${L}/${view}: Other without text rejected`,
      /specify the document type/i.test(await alertText(page)),
    );
    await fillIncoming(page, { custom, receivedAt: "" });
    await saveIncoming(page);
    check(
      `${L}/${view}: missing received time rejected`,
      /date and time the fax was received/i.test(await alertText(page)),
    );
    check(`${L}/${view}: failed validation writes nothing`, (await docsOf(pat.id)).length === 0);

    // Valid save with attachment.
    await fillIncoming(page, {
      receivedAt: "2026-11-12T10:15",
      documentDate: "2026-11-10",
      sender: `  ${sender}  `,
      senderFax: "212-555-0142",
      notes: "Synthetic incoming fax",
      file: pdfFile(`incoming-${L}.pdf`),
    });
    await saveIncoming(page);
    await toast(page, "Received fax recorded with attachment.");
    await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 15000 });
    let docs = await docsOf(pat.id);
    const d1 = docs[0];
    check(`${L}/${view}: exactly one document saved`, docs.length === 1, docs.length);
    check(
      `${L}/${view}: saved as incoming + received with sender and times`,
      d1?.direction === "incoming" &&
        d1.received === true &&
        d1.document_type === custom &&
        d1.received_from === sender &&
        d1.received_fax === "212-555-0142" &&
        d1.document_date === "2026-11-10" &&
        new Date(d1.received_date).toISOString() === "2026-11-12T15:15:00.000Z",
      d1,
    );
    check(
      `${L}/${view}: no recipient fields and zero fax attempts`,
      d1.recipient_name === null &&
        d1.recipient_fax === null &&
        d1.recipient_type === null &&
        (await attemptsOf(d1.id)).length === 0,
    );
    check(
      `${L}/${view}: attributed to the signed-in user`,
      d1.created_by === acct.id && d1.created_by_name === acct.username,
      [d1.created_by_name],
    );
    let files = await filesOf(d1.id);
    check(
      `${L}/${view}: attachment recorded after a real upload`,
      files.length === 1 && files[0].file_name === `incoming-${L}.pdf`,
      files,
    );
    const stored = await admin.storage
      .from("patient-documents")
      .list(`${pat.id}/${d1.id}`, { limit: 10 });
    check(`${L}/${view}: attachment object exists in private storage`, stored.data?.length === 1);
    check(`${L}/${view}: not marked uploaded to patient system`, d1.uploaded === false);

    // Reload: list shows Incoming / sender / received date / Received / no attempts.
    await page.reload({ waitUntil: "networkidle" });
    await settle(page);
    let body = await results(page);
    check(
      `${L}/${view}: patient list shows Incoming, sender and Received`,
      body.includes("Incoming") &&
        body.includes(`From: ${sender}`) &&
        body.includes("Received Nov 12, 2026"),
      body.slice(0, 1500),
    );
    check(`${L}/${view}: Incoming Faxes stat = 1`, (await stat(page, "Incoming Faxes")) === "1");
    check(`${L}/${view}: Sent stat stays 0`, (await stat(page, "Sent")) === "0");
    check(
      `${L}/${view}: timeline shows received from sender`,
      body.includes(`received from ${sender}`),
    );
    if (mobile)
      check(`${L}/${view}: patient page fits the phone width`, await noHorizontalOverflow(page));

    // Detail page.
    await page.goto(`${BASE_URL}/documents/${d1.id}`, { waitUntil: "networkidle" });
    await page.getByText("Created by").first().waitFor({ timeout: 20000 });
    body = await page.locator("body").innerText();
    check(
      `${L}/${view}: detail shows Incoming, Received, sender, received time`,
      body.includes("Received Fax Information") &&
        body.includes("Incoming (received fax)") &&
        body.includes(sender) &&
        body.includes("212-555-0142") &&
        body.includes("Nov 12, 2026") &&
        /\bReceived\b/.test(body),
    );
    check(
      `${L}/${view}: detail has no send/attempt UI`,
      !body.includes("Fax Attempt History") &&
        !body.includes("Date faxed") &&
        (await page.getByRole("button", { name: "Add Attempt" }).count()) === 0 &&
        (await page.getByRole("button", { name: "Mark Received" }).count()) === 0,
    );
    check(
      `${L}/${view}: Tracking Summary adapted for incoming`,
      body.includes("Received fax recorded") &&
        body.includes("Fax received from sender") &&
        !body.includes("Fax sent"),
    );
    check(`${L}/${view}: attachment listed`, body.includes(`incoming-${L}.pdf`));
    check(`${L}/${view}: Created by shows the user`, body.includes(`Created by ${acct.username}`));
    await page.screenshot({
      path: path.join(SHOT_DIR, `${tag}-${L}-${view}-detail.png`),
      fullPage: true,
    });

    // Edit (incoming form, not the outbound form).
    await page
      .getByRole("button", { name: /^Edit$/ })
      .first()
      .click();
    await dialog(page).getByText("Edit received fax").waitFor();
    check(
      `${L}/${view}: edit reconstructs Other + text and sender`,
      (await dialog(page).locator('input[name="document_type_other"]').inputValue()) === custom &&
        (await dialog(page).locator('input[name="received_from"]').inputValue()) === sender,
    );
    await dialog(page).locator('input[name="received_from"]').fill(`${sender} LLC`);
    await dialog(page).getByRole("button", { name: "Save Changes" }).click();
    await toast(page, "Received fax updated.");
    await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 15000 });
    const [afterEdit] = await docsOf(pat.id);
    check(
      `${L}/${view}: edit saved, still incoming, last updated by user`,
      afterEdit.received_from === `${sender} LLC` &&
        afterEdit.direction === "incoming" &&
        afterEdit.updated_by === acct.id,
    );

    // View History.
    await settle(page);
    await page
      .getByRole("button", { name: /View History/ })
      .first()
      .click();
    const hist = page.locator('[aria-label="Record history"]');
    await hist.getByText("Incoming fax recorded").first().waitFor({ timeout: 20000 });
    const htext = await hist.innerText();
    check(
      `${L}/${view}: history shows incoming creation, attachment and sender edit by user`,
      htext.includes("Incoming fax recorded") &&
        htext.includes("File attached") &&
        htext.includes(`${sender} LLC`) &&
        htext.includes(acct.username),
      htext.slice(0, 1200),
    );
    await page.keyboard.press("Escape");
    await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
    await settle(page);

    // ---- Failed attachment, retried without duplicating ------------------
    await page.getByRole("button", { name: "Record Received Fax" }).click();
    simulatingUploadFailure = true;
    let failNext = true;
    await page.route("**/storage/v1/object/patient-documents/**", (route) => {
      if (failNext && route.request().method() === "POST")
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            statusCode: "500",
            error: "simulated",
            message: "simulated outage",
          }),
        });
      return route.continue();
    });
    await fillIncoming(page, {
      type: "Progress Note",
      sender: `Retry Sender ${L} ${stamp}`,
      file: pdfFile(`retry-${L}.pdf`),
    });
    await saveIncoming(page);
    await dialog(page).getByText("attachment not uploaded").waitFor({ timeout: 20000 });
    docs = await docsOf(pat.id);
    const d2 = docs.find((d) => d.received_from === `Retry Sender ${L} ${stamp}`);
    check(
      `${L}/${view}: failed upload keeps one saved fax with no attachment`,
      docs.length === 2 && !!d2 && (await filesOf(d2.id)).length === 0,
      docs.length,
    );
    failNext = false;
    await dialog(page).getByRole("button", { name: "Retry upload" }).click();
    await toast(page, "Attachment uploaded.");
    await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 15000 });
    await page.unroute("**/storage/v1/object/patient-documents/**");
    simulatingUploadFailure = false;
    docs = await docsOf(pat.id);
    files = d2 ? await filesOf(d2.id) : [];
    check(
      `${L}/${view}: retry attaches the file without duplicating the document`,
      docs.length === 2 && files.length === 1 && files[0].file_name === `retry-${L}.pdf`,
      { docs: docs.length, files },
    );

    // ---- Existing outgoing workflow still works ---------------------------
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await dialog(page).locator('select[name="document_type"]').selectOption("Discharge Note");
    await dialog(page).locator('input[name="recipient_name"]').fill(`Outbound Recipient ${L}`);
    await dialog(page).locator('input[name="attempted_at"]').fill("2026-11-12T09:00");
    await dialog(page).locator('select[name="fax_status"]').selectOption("Sent Successfully");
    await dialog(page).getByRole("button", { name: "Save Fax Record" }).click();
    await toast(page, "Fax record saved.");
    await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 15000 });
    const outgoing = (await docsOf(pat.id)).find((d) => d.document_type === "Discharge Note");
    check(
      `${L}/${view}: outgoing fax saved as outgoing with one attempt`,
      outgoing?.direction === "outgoing" && (await attemptsOf(outgoing.id)).length === 1,
    );
    await page.goto(`${BASE_URL}/documents/${outgoing.id}`, { waitUntil: "networkidle" });
    await page.getByText("Created by").first().waitFor({ timeout: 20000 });
    body = await page.locator("body").innerText();
    check(
      `${L}/${view}: outgoing detail keeps attempts + Mark Received + Awaiting Response`,
      body.includes("Fax Attempt History") &&
        body.includes("Awaiting Response") &&
        body.includes("Outgoing") &&
        (await page.getByRole("button", { name: "Mark Received" }).count()) === 1,
    );
    await page.getByRole("button", { name: "Mark Received" }).click();
    await dialog(page).locator('select[name="received"]').selectOption("Yes");
    await dialog(page).getByRole("button", { name: "Save Received Status" }).click();
    await toast(page, "Received status updated.");
    const outAfter = (await docsOf(pat.id)).find((d) => d.id === outgoing.id);
    check(
      `${L}/${view}: response received on outgoing stays outgoing`,
      outAfter.received === true && outAfter.direction === "outgoing",
    );

    // ---- Entry point 2: Fax Tracker with patient search -------------------
    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    await settle(page);
    await page.getByRole("button", { name: "Record Received Fax" }).click();
    await dialog(page).getByPlaceholder("Search by name, Patient ID or Member ID").fill(code);
    await dialog(page).locator("#incoming-patient-results button", { hasText: code }).click();
    dtext = await dialog(page).textContent();
    check(
      `${L}/${view}: Fax Tracker entry selects patient via search`,
      dtext.includes(`Synthetic ${last}`) && dtext.includes("Change patient"),
    );
    if (mobile)
      check(`${L}/${view}: tracker dialog fits the phone width`, await noHorizontalOverflow(page));
    await fillIncoming(page, { type: "Re-evaluation", sender: `Tracker Sender ${L} ${stamp}` });
    await saveIncoming(page);
    await toast(page, "Received fax recorded.");
    await page.waitForURL(/\/documents\//, { timeout: 20000 });
    const d3 = (await docsOf(pat.id)).find(
      (d) => d.received_from === `Tracker Sender ${L} ${stamp}`,
    );
    check(
      `${L}/${view}: tracker entry saved incoming for the chosen patient and opened it`,
      d3?.direction === "incoming" && page.url().endsWith(`/documents/${d3.id}`),
    );

    // Search + filters.
    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    await settle(page);
    const search = page.getByPlaceholder("Search documents, patients...");
    await search.fill(`Tracker Sender ${L} ${stamp}`);
    body = await results(page);
    check(`${L}/${view}: search by sender finds the incoming fax`, body.includes("Re-evaluation"));
    await search.fill(last);
    await page.getByLabel("Direction").selectOption("Incoming");
    body = await results(page);
    check(
      `${L}/${view}: Incoming filter shows incoming only`,
      body.includes(custom) && !body.includes("Discharge Note") && body.includes("3 documents"),
      body.slice(0, 800),
    );
    await page.getByLabel("Direction").selectOption("Outgoing");
    body = await results(page);
    check(
      `${L}/${view}: Outgoing filter shows outgoing only`,
      body.includes("Discharge Note") && !body.includes(custom),
    );
    await page.getByLabel("Direction").selectOption("All directions");
    await page.getByLabel("Recipient or sender").fill(`Outside Ortho ${L}`);
    body = await results(page);
    check(
      `${L}/${view}: recipient/sender filter matches sender`,
      body.includes(custom) && body.includes("1 documents"),
    );
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-tracker.png`) });

    // Reports: counts + exports for this synthetic patient only.
    await page.goto(`${BASE_URL}/reports`, { waitUntil: "networkidle" });
    await settle(page);
    await page.getByLabel("Patient").selectOption(pat.id);
    const counts = {};
    for (const label of [
      "Documents Faxed",
      "Total Attempts",
      "Successful Faxes",
      "Failed Faxes",
      "Responses Received",
      "Incoming Faxes",
      "Awaiting Response",
    ])
      counts[label] = await stat(page, label);
    check(
      `${L}/${view}: report counts incoming separately; outbound totals only from the outgoing fax`,
      JSON.stringify(counts) ===
        JSON.stringify({
          "Documents Faxed": "1",
          "Total Attempts": "1",
          "Successful Faxes": "1",
          "Failed Faxes": "0",
          "Responses Received": "1",
          "Incoming Faxes": "3",
          "Awaiting Response": "0",
        }),
      counts,
    );
    await page.getByLabel("Direction").selectOption("Incoming");
    const csv = (await download(page, "CSV")).toString("utf8");
    const csvLines = csv.split(/\r\n/);
    check(
      `${L}/${view}: CSV has direction + sender columns and incoming rows only`,
      csvLines[0].includes('"Direction"') &&
        csvLines[0].includes('"Sender"') &&
        csvLines[0].includes('"Date Received"') &&
        csvLines.length === 4 &&
        csv.includes(`"${sender} LLC"`) &&
        csv.includes('"Incoming"') &&
        !csv.includes("Discharge Note"),
      csvLines.slice(0, 3),
    );
    const wb = XLSX.read(await download(page, "Excel"));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const hdr = rows[0];
    const row = rows.find((r) => r.includes(custom));
    check(
      `${L}/${view}: Excel row has Incoming, sender, sender fax, 0 attempts`,
      !!row &&
        row[hdr.indexOf("Direction")] === "Incoming" &&
        row[hdr.indexOf("Sender")] === `${sender} LLC` &&
        row[hdr.indexOf("Sender Fax")] === "212-555-0142" &&
        row[hdr.indexOf("Attempts")] === "0" &&
        row[hdr.indexOf("Status")] === "Received" &&
        (row[hdr.indexOf("Recipient")] ?? "") === "",
      { hdr, row },
    );
    const pdf = (await download(page, "PDF")).toString("latin1");
    check(
      `${L}/${view}: PDF export contains Incoming and the sender`,
      pdf.includes("Incoming") && pdf.includes("Direction") && pdf.includes("Outside Ortho"),
      pdf.length,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-reports.png`) });

    // Permanent deletion of an incoming fax with an attachment.
    await page.goto(`${BASE_URL}/documents/${d2.id}`, { waitUntil: "networkidle" });
    await page.getByText("Created by").first().waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: /^Delete$/ }).click();
    await dialog(page).getByRole("button", { name: "Delete Permanently" }).click();
    await toast(page, "Document permanently deleted");
    await page.waitForURL(/\/patients\//, { timeout: 20000 });
    const gone = await admin.from("documents").select("id").eq("id", d2.id);
    const goneFiles = await admin.from("document_files").select("id").eq("document_id", d2.id);
    const goneObj = await admin.storage.from("patient-documents").list(`${pat.id}/${d2.id}`);
    check(
      `${L}/${view}: delete removes incoming fax, file record and stored object`,
      gone.data?.length === 0 && goneFiles.data?.length === 0 && goneObj.data?.length === 0,
      { doc: gone.data?.length, files: goneFiles.data?.length, obj: goneObj.data?.length },
    );
  } catch (e) {
    await page
      .screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-ERROR.png`), fullPage: true })
      .catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}

async function cleanup() {
  for (const pid of patientIds) {
    const docs = await docsOf(pid);
    for (const d of docs) {
      const files = await filesOf(d.id);
      if (files.length)
        await admin.storage.from("patient-documents").remove(files.map((f) => f.storage_path));
      await admin.from("fax_attempts").delete().eq("document_id", d.id);
      await admin.from("document_files").delete().eq("document_id", d.id);
    }
    await admin.from("documents").delete().eq("patient_id", pid);
    await admin.from("patients").delete().eq("id", pid);
    await admin.from("audit_logs").delete().eq("patient_id", pid);
    await admin.from("patient_file_cleanup_queue").delete().like("storage_path", `${pid}/%`);
    const leftover = await admin.storage.from("patient-documents").list(pid, { limit: 100 });
    for (const folder of leftover.data ?? []) {
      const inner = await admin.storage.from("patient-documents").list(`${pid}/${folder.name}`);
      const paths = (inner.data ?? []).map((o) => `${pid}/${folder.name}/${o.name}`);
      if (paths.length) await admin.storage.from("patient-documents").remove(paths);
    }
  }
  const ids = accounts.map((a) => a.id);
  if (ids.length) await admin.from("audit_logs").delete().in("user_id", ids);
  for (const a of accounts) {
    await admin.from("user_roles").delete().eq("user_id", a.id);
    await admin.from("user_logins").delete().eq("user_id", a.id);
    await admin.auth.admin.deleteUser(a.id).catch(() => {});
  }
  let objects = 0;
  for (const pid of patientIds)
    objects += (await admin.storage.from("patient-documents").list(pid)).data?.length ?? 0;
  const left = {
    patients: patientIds.length
      ? (await admin.from("patients").select("id").in("id", patientIds)).data?.length
      : 0,
    audit: ids.length
      ? (await admin.from("audit_logs").select("id").in("user_id", ids)).data?.length
      : 0,
    logins: (await admin.from("user_logins").select("user_id").like("username", `${tag}%`)).data
      ?.length,
    objects,
  };
  check(
    "cleanup: no synthetic records, files or accounts remain",
    !left.patients && !left.audit && !left.logins && !left.objects,
    left,
  );
}

const browser = await chromium.launch();
try {
  const staff = await makeAccount("st", "staff");
  const adm = await makeAccount("ad", "admin");
  const nr = await makeAccount("nr", null);
  await actorFlow(browser, staff, false);
  await actorFlow(browser, adm, true);

  // Anonymous and role-less callers are denied (REST, same path the app uses).
  const pid = patientIds[0];
  const incoming = {
    patient_id: pid,
    direction: "incoming",
    document_type: "Anon Incoming",
    received: true,
    received_date: new Date().toISOString(),
    received_from: "Anon Sender",
  };
  const anonC = await apiClientFor(null);
  const nrC = await apiClientFor(nr);
  const a1 = await anonC.from("documents").insert(incoming);
  const a2 = await nrC
    .from("documents")
    .insert({ ...incoming, document_type: "Roleless Incoming" });
  const [first] = (await docsOf(pid)).filter((d) => d.direction === "incoming");
  const a3 = await nrC
    .from("documents")
    .update({ received_from: "Roleless Edit" })
    .eq("id", first.id)
    .select();
  const a4 = await nrC.from("documents").select("id").eq("id", first.id);
  check("anon incoming insert denied", !!a1.error);
  check("role-less incoming insert denied", !!a2.error);
  check("role-less update affects no rows", !a3.error && (a3.data?.length ?? 0) === 0);
  check("role-less read returns nothing", (a4.data?.length ?? 0) === 0);
  check(
    "no denied write landed",
    !(await docsOf(pid)).some((d) => /Anon|Roleless/.test(`${d.document_type} ${d.received_from}`)),
  );

  const real = problems.filter((p) => !/favicon/.test(p));
  check("no unexpected console errors or failed requests", real.length === 0, real);
} finally {
  await browser.close();
  await cleanup();
}
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall P3-P21 browser checks passed (synthetic data removed)");

#!/usr/bin/env node
// P3-P22 browser verification of the "Provider" terminology rename, run ONLY
// against a local Supabase stack and a local dev server (refuses any
// non-localhost URL so it can never write to Production).
//
// Per actor (staff on desktop, admin on a phone): document create/edit,
// Add Attempt, Correct Attempt and Record Received Fax show Provider labels;
// the Recipient dropdown shows "Referring Provider" while storing the stable
// "Referring MD" value; editing provider info keeps the recipient fax
// destination and never touches the patient default, another document or an
// earlier attempt; detail, history, View History, Fax Tracker filter and the
// Reports CSV use Provider wording; raw keys (md_name) never appear.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY,
// E2E_BASE_URL (all localhost).
//   node scripts/p3p22-provider-terminology-local.mjs [shot-dir]
//
// Explicit Production mode (synthetic-only): requires --production,
// P3P22_CONFIRM_PRODUCTION=synthetic-only, P3P22_ENV_FILE (SUPABASE_URL must be
// the iobrhrefxeirrmbnaiob project) and E2E_BASE_URL set to one of the two
// production domains. Every account (@users.invalid), patient and document is
// created by this run, and cleanup deletes only those ids plus their audit rows.
//   P3P22_CONFIRM_PRODUCTION=synthetic-only P3P22_ENV_FILE=<file> \
//   E2E_BASE_URL=https://faxtracker.vercel.app \
//   node scripts/p3p22-provider-terminology-local.mjs --production [shot-dir]
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, devices } from "playwright";

const PRODUCTION = process.argv.includes("--production");
const SHOT_DIR = process.argv.slice(2).find((a) => !a.startsWith("--")) || ".";
mkdirSync(SHOT_DIR, { recursive: true });
const fileEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = PRODUCTION
  ? fileEnv(process.env.P3P22_ENV_FILE ?? "")
  : process.env;
const BASE_URL = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const isLocal = (u) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u ?? "");
const PROD_SUPABASE_URL = "https://iobrhrefxeirrmbnaiob.supabase.co";
const PROD_DOMAINS = ["https://faxtracker.vercel.app", "https://faxtracker.nychomerehab.com"];
if (PRODUCTION) {
  if (
    process.env.P3P22_CONFIRM_PRODUCTION !== "synthetic-only" ||
    SUPABASE_URL !== PROD_SUPABASE_URL ||
    !PROD_DOMAINS.includes(BASE_URL) ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error(
      "Refusing Production run: need P3P22_CONFIRM_PRODUCTION=synthetic-only, the production SUPABASE_URL and an allowed E2E_BASE_URL.",
    );
    process.exit(2);
  }
} else if (!isLocal(SUPABASE_URL) || !isLocal(BASE_URL) || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Refusing to run: SUPABASE_URL and E2E_BASE_URL must both be localhost.");
  process.exit(2);
}
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const stamp = Date.now().toString(36);
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("   ", String(JSON.stringify(detail)).slice(0, 500));
  }
}
const FORBIDDEN_LABELS = ["MD", "MD NPI", "MD Office Number", "MD Fax Number", "Document MD"];

const accounts = [];
const patientIds = [];
async function makeAccount(label, role) {
  const email = `p3p22-${stamp}-${label}@users.invalid`;
  const password = `P3p22-${stamp}-${label}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`create ${label}: ${error?.message}`);
  accounts.push(data.user.id);
  const username = `p22${stamp}${label}`.slice(0, 32);
  await admin.from("user_logins").insert({ user_id: data.user.id, username });
  await admin.from("user_roles").insert({ user_id: data.user.id, role });
  return { id: data.user.id, username, password, role };
}

const problems = [];
async function session(browser, acct, mobile) {
  const context = await browser.newContext({
    ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1400, height: 900 } }),
    timezoneId: "America/New_York",
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${acct.role} console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${acct.role} pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${acct.role} HTTP ${r.status()}: ${r.url()}`);
  });
  const portal = acct.role === "admin" ? "admin" : "staff";
  const label = portal === "admin" ? "Admin Login" : "Staff Login";
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: label }).click();
  await page.locator(`#${portal}-username`).fill(acct.username);
  await page.locator(`#${portal}-password`).fill(acct.password);
  await page.getByRole("button", { name: label }).click();
  await page.waitForSelector("text=Dashboard", { timeout: 30000 });
  return { context, page };
}
const dialog = (page) => page.locator('[role="dialog"]').last();
const toast = (page, text) => page.getByText(text).first().waitFor({ timeout: 20000 });
const settle = (page) =>
  page.getByText("Loading records…").waitFor({ state: "detached", timeout: 30000 });
const fieldLabels = (scope) =>
  scope.locator(".field-label").evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));
const mainText = (page) =>
  page.locator("main").evaluate((m) => {
    const c = m.cloneNode(true);
    c.querySelectorAll("select, option").forEach((e) => e.remove());
    return c.innerText ?? c.textContent ?? "";
  });
// Every visible form control and button in scope has an accessible name.
const unnamedControls = (scope) =>
  scope
    .locator("input:visible, select:visible, textarea:visible, button:visible")
    .evaluateAll((els) =>
      els
        .filter(
          (e) =>
            !(
              e.labels?.length ||
              e.getAttribute("aria-label") ||
              e.getAttribute("aria-labelledby") ||
              e.getAttribute("title") ||
              (e.tagName === "BUTTON" && e.textContent?.trim())
            ),
        )
        .map((e) => e.outerHTML.slice(0, 120)),
    );
async function checkNamed(name, scope) {
  const unnamed = await unnamedControls(scope);
  check(`${name}: all controls have accessible names`, unnamed.length === 0, unnamed);
}
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const one = async (table, id) => (await admin.from(table).select("*").eq("id", id).single()).data;

async function checkProviderLabels(name, scope) {
  const labels = await fieldLabels(scope);
  for (const l of ["Provider", "Provider NPI", "Provider Office Number", "Provider Fax Number"])
    check(`${name}: shows "${l}" label`, labels.includes(l), labels);
  check(`${name}: no MD labels`, !labels.some((l) => FORBIDDEN_LABELS.includes(l)), labels);
  check(`${name}: no raw md_* key labels`, !labels.some((l) => /md_/.test(l)), labels);
}
async function checkRecipientSelect(name, scope, expectedValue) {
  const sel = scope.locator('select[name="recipient_type"]');
  const opts = await sel
    .locator("option")
    .evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
  check(
    `${name}: Recipient options show "Referring Provider" over stored "Referring MD"`,
    opts.some(([v, t]) => v === "Referring MD" && t === "Referring Provider") &&
      !opts.some(([, t]) => t === "Referring MD"),
    opts,
  );
  check(
    `${name}: Recipient selected value is ${expectedValue}`,
    (await sel.inputValue()) === expectedValue,
  );
}

async function actorFlow(browser, acct, mobile) {
  const L = `${acct.role} ${stamp}`;
  const view = `${acct.role}-${mobile ? "mobile" : "desktop"}`;
  const patientDefaults = {
    referring_physician: `Dr. Default ${L}`,
    referring_physician_npi: "1111111111",
    referring_physician_office_phone: "555-100-0001",
    referring_physician_fax: "555-100-0002",
  };
  const { data: pat, error: pe } = await admin
    .from("patients")
    .insert({
      first_name: "Synthetic",
      last_name: `P3P22 ${L}`,
      patient_id: `P3P22-${stamp}-${acct.role}`,
      ...patientDefaults,
    })
    .select()
    .single();
  if (pe) throw new Error(`patient insert: ${pe.message}`);
  patientIds.push(pat.id);
  const customType = `P3P22 Custom Type ${stamp}`;
  const { data: otherDoc } = await admin
    .from("documents")
    .insert({
      patient_id: pat.id,
      document_type: customType,
      recipient_type: "Referring MD",
      recipient_name: "Other Office",
      recipient_fax: "555-900-0000",
      md_name: `Dr. Other ${L}`,
      md_npi: "3333333333",
      md_office_phone: "555-900-0001",
      md_fax: "555-900-0002",
    })
    .select()
    .single();
  const { context, page } = await session(browser, acct, mobile);
  try {
    // ---- Add Document / Fax ----
    await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
    await settle(page);
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    let d = dialog(page);
    await checkProviderLabels(`${view} create document`, d);
    await checkRecipientSelect(`${view} create document`, d, "Referring MD");
    check(
      `${view} create: provider prefills from patient default`,
      (await d.locator('input[name="md_name"]').inputValue()) ===
        patientDefaults.referring_physician,
    );
    check(
      `${view} create: recipient fax prefills from patient`,
      (await d.locator('input[name="recipient_fax"]').inputValue()) ===
        patientDefaults.referring_physician_fax,
    );
    const helpText = await d.innerText();
    check(
      `${view} create: explanatory text uses Provider`,
      helpText.includes("Referring Provider or other documents") &&
        !/\bReferring MD\b|"MD"/.test(helpText),
    );
    if (mobile) check(`${view} create dialog has no horizontal overflow`, await noOverflow(page));
    await checkNamed(`${view} create dialog`, d);
    await page.screenshot({ path: path.join(SHOT_DIR, `${view}-create.png`), fullPage: true });
    await d.locator('input[name="recipient_name"]').fill(`Destination Office ${L}`);
    await d.locator('input[name="recipient_fax"]').fill("555-222-3333");
    await d.getByRole("button", { name: "Save Fax Record" }).click();
    await toast(page, "Fax record saved.");
    const created = (
      await admin
        .from("documents")
        .select("*")
        .eq("patient_id", pat.id)
        .neq("id", otherDoc.id)
        .single()
    ).data;
    check(
      `${view} create: stored recipient_type stays "Referring MD"`,
      created?.recipient_type === "Referring MD",
      created?.recipient_type,
    );
    check(
      `${view} create: provider + contact saved from defaults`,
      created?.md_name === patientDefaults.referring_physician &&
        created?.md_fax === patientDefaults.referring_physician_fax,
    );
    check(
      `${view} create: recipient fax destination saved`,
      created?.recipient_fax === "555-222-3333",
    );

    // ---- Edit document: change provider, invalid NPI message, then save ----
    await page.goto(`${BASE_URL}/documents/${created.id}`, { waitUntil: "networkidle" });
    await settle(page);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    d = dialog(page);
    await checkProviderLabels(`${view} edit document`, d);
    await checkRecipientSelect(`${view} edit document`, d, "Referring MD");
    const newProvider = `Dr. New Provider ${L}`;
    await d.locator('input[name="md_name"]').fill(newProvider);
    check(
      `${view} edit: changing provider clears stale Provider NPI/Office/Fax`,
      (await d.locator('input[name="md_npi"]').inputValue()) === "" &&
        (await d.locator('input[name="md_office_phone"]').inputValue()) === "" &&
        (await d.locator('input[name="md_fax"]').inputValue()) === "",
    );
    check(
      `${view} edit: recipient fax field untouched by provider change`,
      (await d.locator('input[name="recipient_fax"]').inputValue()) === "555-222-3333",
    );
    await d.locator('input[name="md_npi"]').fill("123");
    await d.getByRole("button", { name: "Save Fax Record" }).click();
    await toast(page, "Provider NPI must be exactly 10 digits.");
    check(`${view} edit: NPI validation message says Provider NPI`, true);
    await d.locator('input[name="md_npi"]').fill("2222222222");
    await d.getByRole("button", { name: "Save Fax Record" }).click();
    await toast(page, "Document updated.");
    const edited = await one("documents", created.id);
    check(
      `${view} edit: provider saved on this document`,
      edited?.md_name === newProvider && edited?.md_npi === "2222222222",
    );
    check(
      `${view} edit: deliberately cleared provider contact saved empty`,
      !edited?.md_office_phone && !edited?.md_fax,
      edited,
    );
    check(
      `${view} edit: recipient fax destination preserved`,
      edited?.recipient_fax === "555-222-3333" && edited?.recipient_type === "Referring MD",
      edited,
    );
    const patAfter = await one("patients", pat.id);
    check(
      `${view} edit: patient default provider unchanged`,
      Object.entries(patientDefaults).every(([k, v]) => patAfter?.[k] === v),
    );
    const otherAfter = await one("documents", otherDoc.id);
    check(
      `${view} edit: other document unchanged`,
      otherAfter?.md_name === otherDoc.md_name &&
        otherAfter?.md_npi === otherDoc.md_npi &&
        otherAfter?.md_fax === otherDoc.md_fax &&
        otherAfter?.recipient_fax === otherDoc.recipient_fax,
    );

    // ---- Existing saved provider/contact + custom document type ----
    await page.goto(`${BASE_URL}/documents/${otherDoc.id}`, { waitUntil: "networkidle" });
    await settle(page);
    const otherText = await mainText(page);
    const otherMissing = [
      otherDoc.md_name,
      "3333333333",
      "555-900-0001",
      "555-900-0002",
      customType,
      "Document Provider",
    ].filter((s) => !otherText.includes(s));
    check(
      `${view} existing doc: saved provider contact + custom type render`,
      otherMissing.length === 0,
      otherMissing,
    );
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    d = dialog(page);
    check(
      `${view} existing doc edit: custom type reconstructs as Other + text`,
      (await d.locator('select[name="document_type"]').inputValue()) === "Other" &&
        (await d.locator('input[name="document_type_other"]').inputValue()) === customType,
    );
    check(
      `${view} existing doc edit: saved provider contact prefilled`,
      (await d.locator('input[name="md_npi"]').inputValue()) === "3333333333" &&
        (await d.locator('input[name="md_fax"]').inputValue()) === "555-900-0002",
    );
    await d.locator('textarea[name="notes"]').fill(`Unrelated note ${L}`);
    await d.getByRole("button", { name: "Save Fax Record" }).click();
    await toast(page, "Document updated.");
    const otherSaved = await one("documents", otherDoc.id);
    check(
      `${view} unrelated edit: type, provider contact and recipient fax unchanged`,
      otherSaved?.document_type === customType &&
        otherSaved?.md_name === otherDoc.md_name &&
        otherSaved?.md_npi === "3333333333" &&
        otherSaved?.md_fax === "555-900-0002" &&
        otherSaved?.recipient_fax === otherDoc.recipient_fax &&
        otherSaved?.recipient_type === "Referring MD",
      otherSaved,
    );
    check(
      `${view} unrelated edit: edited doc unchanged`,
      (await one("documents", created.id))?.md_name === newProvider,
    );
    await page.goto(`${BASE_URL}/documents/${created.id}`, { waitUntil: "networkidle" });
    await settle(page);

    // ---- Add Attempt ----
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    d = dialog(page);
    await checkProviderLabels(`${view} add attempt`, d);
    await checkNamed(`${view} add attempt dialog`, d);
    await checkRecipientSelect(`${view} add attempt`, d, "Referring MD");
    check(
      `${view} add attempt: section heading is Recipient / Provider`,
      (await d.innerText()).includes("RECIPIENT / PROVIDER") ||
        (await d.innerText()).includes("Recipient / Provider"),
    );
    check(
      `${view} add attempt: provider prefills from document`,
      (await d.locator('input[name="md_name"]').inputValue()) === newProvider,
    );
    check(
      `${view} add attempt: recipient fax prefills from document`,
      (await d.locator('input[name="recipient_fax"]').inputValue()) === "555-222-3333",
    );
    await d.locator('select[name="status"]').selectOption("Sent Successfully");
    await d.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, {
      timeout: 20000,
    });
    const attempts1 =
      (await admin.from("fax_attempts").select("*").eq("document_id", created.id)).data ?? [];
    const att1 = attempts1[0];
    check(
      `${view} add attempt: stored recipient_type "Referring MD" + recipient fax`,
      attempts1.length === 1 &&
        att1.recipient_type === "Referring MD" &&
        att1.recipient_fax === "555-222-3333",
      att1,
    );

    // ---- Detail page wording ----
    await page.reload({ waitUntil: "networkidle" });
    await settle(page);
    let text = await mainText(page);
    check(
      `${view} detail: Document Provider fields`,
      [
        "Document Provider",
        "Document Provider NPI",
        "Document Provider Office Number",
        "Document Provider Fax Number",
      ].every((s) => text.includes(s)),
    );
    check(
      `${view} detail: attempt history shows Provider: and (Referring Provider)`,
      text.includes(`Provider: ${newProvider}`) && text.includes("(Referring Provider)"),
    );
    check(
      `${view} detail: no MD wording or raw keys`,
      !/Document MD|\bMD:|\(Referring MD\)|md_name/.test(text),
    );
    if (mobile) check(`${view} detail has no horizontal overflow`, await noOverflow(page));
    await page.screenshot({ path: path.join(SHOT_DIR, `${view}-detail.png`), fullPage: true });

    // ---- Correct Attempt ----
    await page.getByTitle("Correct attempt").first().click();
    d = dialog(page);
    await checkProviderLabels(`${view} correct attempt`, d);
    if (mobile) check(`${view} correct dialog has no horizontal overflow`, await noOverflow(page));
    await checkNamed(`${view} correct dialog`, d);
    await checkRecipientSelect(`${view} correct attempt`, d, "Referring MD");
    const corrected = `Dr. Corrected ${L}`;
    await d.locator('input[name="md_name"]').fill(corrected);
    await d.locator('textarea[name="reason"]').fill("P3-P22 local verification");
    await d.getByRole("button", { name: "Save Correction" }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, {
      timeout: 20000,
    });
    const att1After = await one("fax_attempts", att1.id);
    check(
      `${view} correct: attempt provider corrected, recipient preserved`,
      att1After?.md_name === corrected &&
        att1After?.recipient_type === "Referring MD" &&
        att1After?.recipient_fax === "555-222-3333",
      att1After,
    );
    const docAfterCorrect = await one("documents", created.id);
    check(`${view} correct: document provider unchanged`, docAfterCorrect?.md_name === newProvider);
    check(
      `${view} correct: patient default unchanged`,
      (await one("patients", pat.id))?.referring_physician === patientDefaults.referring_physician,
    );

    // ---- Second attempt does not alter the earlier attempt ----
    await page.reload({ waitUntil: "networkidle" });
    await settle(page);
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    d = dialog(page);
    await d.locator('input[name="md_name"]').fill(`Dr. Second ${L}`);
    await d.locator('select[name="status"]').selectOption("Sent Successfully");
    await d.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, {
      timeout: 20000,
    });
    check(
      `${view} second attempt: earlier attempt unchanged`,
      (await one("fax_attempts", att1.id))?.md_name === corrected,
    );

    // ---- View History ----
    await page.reload({ waitUntil: "networkidle" });
    await settle(page);
    await page.getByRole("button", { name: "View History" }).first().click();
    const hist = page.locator('[aria-label="Record history"]');
    await hist.waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const histText = await hist.innerText();
    check(
      `${view} View History: Provider labels`,
      histText.includes("Document Provider"),
      histText.slice(0, 400),
    );
    check(
      `${view} View History: no MD labels or raw keys`,
      !/Document MD|\bMD NPI|md_name|md_npi|recipient_type/.test(histText),
      histText.slice(0, 400),
    );
    await page.screenshot({ path: path.join(SHOT_DIR, `${view}-history.png`), fullPage: true });
    await page.keyboard.press("Escape").catch(() => {});

    // ---- Fax Tracker table + Provider filter ----
    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    await settle(page);
    const headers = await page.locator("table.data-table th").allInnerTexts();
    check(
      `${view} Fax Tracker: Provider column`,
      headers.map((h) => h.trim().toLowerCase()).includes("provider") &&
        !headers.map((h) => h.trim().toLowerCase()).includes("md"),
      headers,
    );
    if (mobile) check(`${view} Fax Tracker has no horizontal overflow`, await noOverflow(page));
    await page.getByLabel("Provider", { exact: true }).fill(newProvider);
    await page.waitForTimeout(500);
    text = await mainText(page);
    check(
      `${view} Fax Tracker: Provider filter finds the document`,
      text.includes(`P3P22 ${L}`) && text.includes(newProvider),
    );
    await page.getByLabel("Provider", { exact: true }).fill(`no such provider ${stamp}`);
    await page.waitForTimeout(500);
    check(
      `${view} Fax Tracker: Provider filter excludes non-matches`,
      !(await mainText(page)).includes(newProvider),
    );

    // ---- Record Received Fax (incoming): Provider + sender labels, no recipient ----
    await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
    await settle(page);
    await page.getByRole("button", { name: "Record Received Fax" }).first().click();
    d = dialog(page);
    await checkProviderLabels(`${view} incoming fax`, d);
    const inLabels = await fieldLabels(d);
    check(
      `${view} incoming fax: sender fields present, no recipient select`,
      inLabels.includes("Sender fax number") &&
        (await d.locator('select[name="recipient_type"]').count()) === 0,
      inLabels,
    );
    const inText = await d.innerText();
    check(
      `${view} incoming fax: Sender wording retained`,
      /sender/i.test(inText) && !/referring md/i.test(inText),
      inLabels,
    );
    if (mobile) check(`${view} incoming dialog has no horizontal overflow`, await noOverflow(page));
    await checkNamed(`${view} incoming dialog`, d);
    await page.screenshot({ path: path.join(SHOT_DIR, `${view}-incoming.png`), fullPage: true });
    await d.getByRole("button", { name: "Cancel" }).click();

    // ---- Reports CSV header ----
    await page.goto(`${BASE_URL}/reports`, { waitUntil: "networkidle" });
    await settle(page);
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "CSV" }).click(),
    ]);
    const p = path.join(SHOT_DIR, `${view}-${dl.suggestedFilename()}`);
    await dl.saveAs(p);
    const header = readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/)[0];
    // Headings/labels only: real record values may legitimately contain "MD".
    const reportHeadings = await page
      .locator("main th, main h1, main h2, main h3, main .field-label, main label")
      .allInnerTexts();
    check(
      `${view} Reports page: no MD headings or labels`,
      !reportHeadings.some((h) => /\bMD\b|md_/.test(h)),
      reportHeadings,
    );
    check(
      `${view} Reports CSV: Provider column header`,
      /(^|,)"?Provider"?(,|$)/.test(header) && !/(^|,)"?MD"?(,|$)/.test(header),
      header,
    );
  } finally {
    await context.close();
  }
}

// Scoped cleanup: only ids created by this run (never broad filters).
async function cleanup() {
  for (const pid of patientIds) {
    const docIds = (
      (await admin.from("documents").select("id").eq("patient_id", pid)).data ?? []
    ).map((r) => r.id);
    if (docIds.length) {
      const attIds = (
        (await admin.from("fax_attempts").select("id").in("document_id", docIds)).data ?? []
      ).map((r) => r.id);
      if (attIds.length)
        await admin.from("fax_attempt_corrections").delete().in("attempt_id", attIds);
      await admin.from("fax_attempts").delete().in("document_id", docIds);
      await admin.from("document_files").delete().in("document_id", docIds);
      await admin.from("documents").delete().in("id", docIds);
      await admin.from("audit_logs").delete().in("document_id", docIds);
    }
    await admin.from("patients").delete().eq("id", pid);
    await admin.from("audit_logs").delete().eq("patient_id", pid);
  }
  if (accounts.length) await admin.from("audit_logs").delete().in("user_id", accounts);
  for (const id of accounts) {
    await admin.from("user_roles").delete().eq("user_id", id);
    await admin.from("user_logins").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  const count = async (q) => (await q).data?.length ?? 0;
  const anyP = patientIds.length > 0;
  const anyA = accounts.length > 0;
  const left = {
    patients: anyP ? await count(admin.from("patients").select("id").in("id", patientIds)) : 0,
    documents: anyP
      ? await count(admin.from("documents").select("id").in("patient_id", patientIds))
      : 0,
    auditByPatient: anyP
      ? await count(admin.from("audit_logs").select("id").in("patient_id", patientIds))
      : 0,
    auditByUser: anyA
      ? await count(admin.from("audit_logs").select("id").in("user_id", accounts))
      : 0,
    logins: anyA
      ? await count(admin.from("user_logins").select("user_id").in("user_id", accounts))
      : 0,
    roles: anyA
      ? await count(admin.from("user_roles").select("user_id").in("user_id", accounts))
      : 0,
    authUsers: 0,
  };
  for (const id of accounts)
    if ((await admin.auth.admin.getUserById(id)).data?.user) left.authUsers++;
  console.log(
    "cleanup evidence:",
    JSON.stringify({ created: { accounts: accounts.length, patients: patientIds.length }, left }),
  );
  check(
    "cleanup: no synthetic records, audit rows or accounts remain",
    Object.values(left).every((v) => v === 0),
    left,
  );
}

const browser = await chromium.launch();
try {
  const staff = await makeAccount("staff", "staff");
  const adm = await makeAccount("admin", "admin");
  await actorFlow(browser, staff, false);
  await actorFlow(browser, adm, true);
} catch (e) {
  failures++;
  console.log("FAIL - flow aborted:", e.message);
} finally {
  await browser.close();
  await cleanup();
}
check("no unexpected console errors or failed requests", problems.length === 0, problems);
console.log(failures ? `${failures} check(s) failed` : "all P3-P22 local browser checks passed");
process.exit(failures ? 1 : 0);

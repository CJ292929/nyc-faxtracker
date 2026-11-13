#!/usr/bin/env node
// Live browser verification of P3-P23 (optional Secondary / Supplemental
// Insurance) against a real deployment, using only synthetic accounts and
// patients that are removed again at the end (same discipline as
// p3p21-ui-live.mjs). No real patient is read or changed.
//
// Per actor (staff on desktop, admin on a phone): Add Patient with both
// secondary fields (whitespace trimmed, leading-zero Member ID preserved);
// shared Patient Information card on the patient and document pages; search
// by secondary Member ID; edit only the Member ID; clear both and reload
// ("Not specified"); View History shows the actor and fields; no horizontal
// overflow. Staff also: downloaded template has the 11 columns with both
// Member ID columns formatted as text, a filled copy round-trips through
// Bulk Upload, and a previous nine-column template is still accepted.
// Also: anon and role-less REST writes are denied; no unexpected console
// errors or failed requests.
//
// Env (file): P3P23_ENV_FILE or .env with SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY.
// Run with: E2E_BASE_URL=https://<deployment> node scripts/p3p23-ui-live.mjs [shot-dir]
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const SHOT_DIR = process.argv[2] || ".";
mkdirSync(SHOT_DIR, { recursive: true });
const env = Object.fromEntries(
  readFileSync(process.env.P3P23_ENV_FILE || ".env", "utf8")
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
const tag = `p3p23${String(stamp).slice(-7)}`;
const SEC = "Secondary / Supplemental Insurance";
const SEC_ID = "Secondary / Supplemental Insurance Member ID";

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
const patientRow = async (id) =>
  (await admin.from("patients").select("*").eq("id", id).single()).data;

const problems = [];
async function session(browser, acct, mobile) {
  const context = await browser.newContext({
    ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1400, height: 900 } }),
    timezoneId: "America/New_York",
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const note = (msg) => problems.push(msg);
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
const noHorizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// Value shown under an exact field label inside the page's main content
// (the shared Patient Information card renders label + value siblings).
const cardValue = (page, label) =>
  page.evaluate((l) => {
    for (const el of document.querySelectorAll("main .field-label")) {
      if (el.textContent?.trim() === l) return el.nextElementSibling?.textContent?.trim() ?? null;
    }
    return null;
  }, label);
async function open(page, url) {
  await page.goto(`${BASE_URL}${url}`, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await settle(page).catch(() => {});
}

async function actorFlow(browser, acct, mobile) {
  const who = `${acct.role}${mobile ? " (phone)" : " (desktop)"}`;
  const { context, page } = await session(browser, acct, mobile);
  try {
    // ---- create ----
    await open(page, "/patients");
    await page.getByRole("button", { name: "Add Patient" }).click();
    const d = dialog(page);
    const first = `S${tag}${acct.role[0]}`;
    await d.locator('[name="first_name"]').fill(first);
    await d.locator('[name="last_name"]').fill("Synthetic");
    await d.locator('[name="patient_id"]').fill(`${tag}-${acct.role}`);
    await d.locator('[name="insurance"]').fill("Medicare");
    await d.locator('[name="insurance_member_id"]').fill("0001234");
    await d.locator('[name="secondary_insurance"]').fill("  Aetna Supplemental  ");
    await d.locator('[name="secondary_insurance_member_id"]').fill(" 00123-AB/4 ");
    check(`${who}: Add Patient form shows both labels`, (await d.textContent()).includes(SEC_ID));
    if (mobile)
      check(
        `${who}: Add Patient form has no horizontal overflow`,
        await noHorizontalOverflow(page),
      );
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${acct.role}-form.png`) });
    await d.getByRole("button", { name: "Save Patient" }).click();
    await toast(page, "Patient successfully added.");
    const { data: created } = await admin
      .from("patients")
      .select("*")
      .eq("patient_id", `${tag}-${acct.role}`)
      .single();
    patientIds.push(created.id);
    check(
      `${who}: saved trimmed, leading zeros kept, primary unchanged`,
      created.secondary_insurance === "Aetna Supplemental" &&
        created.secondary_insurance_member_id === "00123-AB/4" &&
        created.insurance === "Medicare" &&
        created.insurance_member_id === "0001234",
      created,
    );
    check(
      `${who}: create attributed to ${acct.username}`,
      created.created_by_name === acct.username,
    );

    // ---- shared Patient Information card: patient + document pages ----
    const { data: doc } = await admin
      .from("documents")
      .insert({ patient_id: created.id, document_type: "Progress Note", status: "Draft" })
      .select("id")
      .single();
    await open(page, `/patients/${created.id}`);
    check(
      `${who}: patient page card shows both values`,
      (await cardValue(page, SEC)) === "Aetna Supplemental" &&
        (await cardValue(page, SEC_ID)) === "00123-AB/4",
    );
    if (mobile)
      check(`${who}: patient page has no horizontal overflow`, await noHorizontalOverflow(page));
    await page.screenshot({
      path: path.join(SHOT_DIR, `${tag}-${acct.role}-patient.png`),
      fullPage: true,
    });
    await open(page, `/documents/${doc.id}`);
    check(
      `${who}: document page card shows both values`,
      (await cardValue(page, SEC)) === "Aetna Supplemental" &&
        (await cardValue(page, SEC_ID)) === "00123-AB/4",
    );
    if (mobile)
      check(`${who}: document page has no horizontal overflow`, await noHorizontalOverflow(page));

    // ---- search by secondary Member ID, edit only the Member ID ----
    await open(page, "/patients");
    await page.getByPlaceholder("Search patient name...").fill("00123-ab/4");
    const row = page.locator("tbody tr", { hasText: first });
    check(`${who}: Patients search finds secondary Member ID`, (await row.count()) === 1);
    await page.getByPlaceholder("Search patient name...").fill("Aetna Supplemental");
    check(`${who}: Patients search finds secondary insurance`, (await row.count()) === 1);
    await row.getByTitle("Edit patient").click();
    const e = dialog(page);
    check(
      `${who}: Edit form prefilled`,
      (await e.locator('[name="secondary_insurance_member_id"]').inputValue()) === "00123-AB/4",
    );
    await e.locator('[name="secondary_insurance_member_id"]').fill("0007");
    await e.getByRole("button", { name: "Save Patient" }).click();
    await toast(page, "Patient updated.");
    let p = await patientRow(created.id);
    check(
      `${who}: edit saved "0007", insurance unchanged`,
      p.secondary_insurance_member_id === "0007" && p.secondary_insurance === "Aetna Supplemental",
      p,
    );

    // ---- clear both, reload ----
    await open(page, `/patients/${created.id}`);
    await page.getByRole("button", { name: "Edit Patient" }).click();
    const c = dialog(page);
    await c.locator('[name="secondary_insurance"]').fill("");
    await c.locator('[name="secondary_insurance_member_id"]').fill("   ");
    await c.getByRole("button", { name: "Save Patient" }).click();
    await toast(page, "Patient updated.");
    p = await patientRow(created.id);
    check(
      `${who}: cleared fields stored as NULL`,
      p.secondary_insurance === null && p.secondary_insurance_member_id === null,
      p,
    );
    await page.reload({ waitUntil: "networkidle" });
    await settle(page).catch(() => {});
    check(
      `${who}: after reload, patient card shows "Not specified"`,
      (await cardValue(page, SEC)) === "Not specified" &&
        (await cardValue(page, SEC_ID)) === "Not specified",
    );

    // ---- View History ----
    await page.getByRole("button", { name: "View History" }).first().click();
    // History loads asynchronously after the dialog opens.
    await dialog(page)
      .getByText(SEC_ID, { exact: false })
      .first()
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    const h = (await dialog(page).textContent()) ?? "";
    check(
      `${who}: View History shows both field labels and the actor`,
      h.includes(SEC) && h.includes(SEC_ID) && h.includes(acct.username),
      h.slice(0, 600),
    );
    await page.keyboard.press("Escape");
    const { data: logs } = await admin
      .from("audit_logs")
      .select("action, changes, actor_username")
      .eq("patient_id", created.id)
      .eq("action", "patients_update")
      .order("created_at");
    check(
      `${who}: history rows = [Member ID edit, clear both] by ${acct.username}`,
      logs.length === 2 &&
        logs.every((l) => l.actor_username === acct.username) &&
        JSON.stringify(Object.keys(logs[0].changes)) === '["secondary_insurance_member_id"]' &&
        Object.keys(logs[1].changes).sort().join() ===
          "secondary_insurance,secondary_insurance_member_id",
      logs,
    );
    await open(page, `/documents/${doc.id}`);
    check(
      `${who}: document card shows "Not specified" after clear`,
      (await cardValue(page, SEC)) === "Not specified",
    );

    if (!mobile) await templateFlow(page, who);
  } finally {
    await context.close();
  }
}

async function uploadWorkbook(page, aoa, name) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa.map((r) => r.map((v) => ({ t: "s", v }))));
  XLSX.utils.book_append_sheet(wb, ws, "Patients");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  await page.getByRole("button", { name: "Bulk Upload Patients" }).click();
  await dialog(page).locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
}

async function templateFlow(page, who) {
  await open(page, "/patients");
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download Bulk Template" }).click(),
  ]);
  const file = path.join(SHOT_DIR, `${tag}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  const wb = XLSX.read(readFileSync(file), { cellStyles: true, cellNF: true });
  const sheet = wb.Sheets.Patients;
  const header = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
  check(
    `${who}: template has 11 columns ending with the secondary pair`,
    header.length === 11 && header[9] === SEC && header[10] === SEC_ID,
    header,
  );
  check(
    `${who}: both Member ID template columns formatted as text`,
    sheet.B2?.z === "@" && sheet.K2?.z === "@",
    { B2: sheet.B2, K2: sheet.K2 },
  );

  // Round-trip a filled copy of the downloaded header.
  const bulkFirst = `B${tag}`;
  await uploadWorkbook(
    page,
    [
      header,
      [`${bulkFirst} Synthetic`, "", "", "", "Medicare", "", "", "", "", " Humana Supp ", "000456"],
    ],
    "p3p23-filled.xlsx",
  );
  const review = dialog(page);
  await review.getByRole("button", { name: "Import 1 Patient" }).waitFor({ timeout: 20000 });
  const reviewText = await review.textContent();
  check(
    `${who}: review shows secondary columns and values`,
    reviewText.includes(SEC_ID) && reviewText.includes("000456"),
  );
  await review.getByRole("button", { name: "Import 1 Patient" }).click();
  await review.getByRole("button", { name: "Done" }).waitFor({ timeout: 30000 });
  const { data: bulk } = await admin.from("patients").select("*").eq("first_name", bulkFirst);
  for (const b of bulk ?? []) patientIds.push(b.id);
  check(
    `${who}: bulk import stored trimmed insurance + leading-zero Member ID`,
    bulk?.length === 1 &&
      bulk[0].secondary_insurance === "Humana Supp" &&
      bulk[0].secondary_insurance_member_id === "000456",
    bulk,
  );
  await review.getByRole("button", { name: "Done" }).click();

  // A previous nine-column template is still accepted (nothing imported).
  await uploadWorkbook(
    page,
    [
      [
        "Name",
        "Member ID",
        "DOB",
        "Patient Phone",
        "Insurance",
        "Referring Provider",
        "Referring Provider NPI",
        "Referring Provider Office Number",
        "Referring Provider Fax Number",
      ],
      [`O${tag} Synthetic`, "", "", "", "Medicare", "", "", "", ""],
    ],
    "p3p23-old9.xlsx",
  );
  const old = dialog(page);
  const accepted = await old
    .getByRole("button", { name: "Import 1 Patient" })
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(`${who}: previous nine-column template accepted`, accepted);
  await old.getByRole("button", { name: "Cancel" }).click();
}

async function cleanup() {
  for (const pid of patientIds) {
    await admin.from("documents").delete().eq("patient_id", pid);
    await admin.from("patients").delete().eq("id", pid);
    await admin.from("audit_logs").delete().eq("patient_id", pid);
  }
  const ids = accounts.map((a) => a.id);
  if (ids.length) await admin.from("audit_logs").delete().in("user_id", ids);
  for (const a of accounts) {
    await admin.from("user_roles").delete().eq("user_id", a.id);
    await admin.from("user_logins").delete().eq("user_id", a.id);
    await admin.auth.admin.deleteUser(a.id).catch(() => {});
  }
  const left = {
    patients: (
      await admin
        .from("patients")
        .select("id")
        .or(`patient_id.like.${tag}%,first_name.like.%${tag}%`)
    ).data?.length,
    audit: ids.length
      ? (await admin.from("audit_logs").select("id").in("user_id", ids)).data?.length
      : 0,
    logins: (await admin.from("user_logins").select("user_id").like("username", `${tag}%`)).data
      ?.length,
  };
  check(
    "cleanup: no synthetic patients, history or accounts remain",
    !left.patients && !left.audit && !left.logins,
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
  const anonC = await apiClientFor(null);
  const nrC = await apiClientFor(nr);
  const a1 = await anonC
    .from("patients")
    .insert({
      first_name: "Anon",
      last_name: tag,
      patient_id: `${tag}-anon`,
      secondary_insurance: "X",
    });
  const a2 = await nrC
    .from("patients")
    .insert({
      first_name: "Roleless",
      last_name: tag,
      patient_id: `${tag}-nr`,
      secondary_insurance: "X",
    });
  const a3 = await nrC
    .from("patients")
    .update({ secondary_insurance: "Roleless Edit" })
    .eq("id", pid)
    .select();
  check("anon patient insert denied", !!a1.error);
  check("role-less patient insert denied", !!a2.error);
  check("role-less update affects no rows", !a3.error && (a3.data?.length ?? 0) === 0);
  check("no denied write landed", (await patientRow(pid)).secondary_insurance !== "Roleless Edit");

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
console.log("\nall P3-P23 browser checks passed (synthetic data removed)");

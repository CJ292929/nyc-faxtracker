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
// Also (P3-P23R): each secondary field blank independently, reopen Edit after
// clearing, Received Fax patient picker finds the secondary Member ID, primary
// insurance and Referring Provider details stay intact.
//
// Env (file): P3P23_ENV_FILE or .env with SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY.
// Local (default): SUPABASE_URL and E2E_BASE_URL must both be localhost.
//   E2E_BASE_URL=http://localhost:<port> node scripts/p3p23-ui-live.mjs [shot-dir]
// Production (explicit opt-in, exact project + domain allowlist):
//   P3P23_CONFIRM_PRODUCTION=synthetic-only P3P23_ENV_FILE=<file> \
//   E2E_BASE_URL=https://faxtracker.vercel.app \
//   node scripts/p3p23-ui-live.mjs --production [shot-dir]
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const PRODUCTION = process.argv.includes("--production");
const SHOT_DIR = process.argv.slice(2).find((a) => !a.startsWith("--")) || ".";
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
const isLocal = (u) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u ?? "");
const PROD_SUPABASE_URL = "https://iobrhrefxeirrmbnaiob.supabase.co";
const PROD_DOMAINS = ["https://faxtracker.vercel.app", "https://faxtracker.nychomerehab.com"];
if (PRODUCTION) {
  if (
    process.env.P3P23_CONFIRM_PRODUCTION !== "synthetic-only" ||
    env.SUPABASE_URL !== PROD_SUPABASE_URL ||
    !PROD_DOMAINS.includes(BASE_URL) ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error(
      "Refusing Production run: need P3P23_CONFIRM_PRODUCTION=synthetic-only, the production SUPABASE_URL and an allowed E2E_BASE_URL.",
    );
    process.exit(2);
  }
} else if (!isLocal(env.SUPABASE_URL) || !isLocal(BASE_URL) || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Refusing to run: SUPABASE_URL and E2E_BASE_URL must both be localhost.");
  process.exit(2);
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
const docIds = [];
const PROVIDER = {
  referring_physician: `Dr Synth ${tag}`,
  referring_physician_npi: "1234567893",
  referring_physician_office_phone: "212-555-0100",
  referring_physician_fax: "212-555-0199",
};
// Fields no secondary-insurance edit may touch.
const STABLE = [
  "first_name",
  "last_name",
  "patient_id",
  "insurance",
  "insurance_member_id",
  "status",
  ...Object.keys(PROVIDER),
];
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
    await d.locator('[name="referring_physician"]').fill(PROVIDER.referring_physician);
    await d.locator('[name="referring_physician_npi"]').fill(PROVIDER.referring_physician_npi);
    await d
      .locator('[name="referring_physician_office_phone"]')
      .fill(PROVIDER.referring_physician_office_phone);
    await d.locator('[name="referring_physician_fax"]').fill(PROVIDER.referring_physician_fax);
    const formText = await d.textContent();
    check(
      `${who}: Add Patient form shows both optional secondary labels`,
      formText.includes(SEC) &&
        formText.includes(SEC_ID) &&
        (await d.locator('[name="secondary_insurance"]').getAttribute("required")) === null &&
        (await d.locator('[name="secondary_insurance_member_id"]').getAttribute("required")) ===
          null,
    );
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
        created.insurance_member_id === "0001234" &&
        Object.entries(PROVIDER).every(([k, v]) => created[k] === v),
      created,
    );
    const baseline = Object.fromEntries(STABLE.map((k) => [k, created[k]]));
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
    docIds.push(doc.id);
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

    // ---- Received Fax patient picker (Fax Tracker entry); Cancel writes nothing ----
    await open(page, "/fax-tracker");
    await page.getByRole("button", { name: "Record Received Fax" }).click();
    await dialog(page)
      .getByPlaceholder("Search by name, Patient ID or Member ID")
      .fill("00123-ab/4");
    const pick = dialog(page).locator("#incoming-patient-results button", {
      hasText: `${tag}-${acct.role}`,
    });
    check(`${who}: Received Fax picker finds secondary Member ID`, (await pick.count()) === 1);
    if (mobile)
      check(
        `${who}: Received Fax dialog has no horizontal overflow`,
        await noHorizontalOverflow(page),
      );
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await page.locator('[role="dialog"]').waitFor({ state: "detached" });
    check(
      `${who}: Received Fax Cancel wrote nothing`,
      ((await admin.from("documents").select("id").eq("patient_id", created.id)).data ?? [])
        .length === 1,
    );

    await open(page, "/patients");
    await page.getByPlaceholder("Search patient name...").fill("Aetna Supplemental");
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

    // ---- each field blank independently, then clear both ----
    await open(page, `/patients/${created.id}`);
    const editOnProfile = async (ins, mid) => {
      await page.getByRole("button", { name: "Edit Patient" }).click();
      const c = dialog(page);
      await c.locator('[name="secondary_insurance"]').fill(ins);
      await c.locator('[name="secondary_insurance_member_id"]').fill(mid);
      await c.getByRole("button", { name: "Save Patient" }).click();
      await toast(page, "Patient updated.");
      await page.locator('[role="dialog"]').waitFor({ state: "detached" });
      return patientRow(created.id);
    };
    p = await editOnProfile("", "0007");
    check(
      `${who}: insurance blank, Member ID kept`,
      p.secondary_insurance === null && p.secondary_insurance_member_id === "0007",
      p,
    );
    // Record what the card shows the moment the dialog closes, then allow
    // the shared data refresh up to 5s to settle (diagnoses a stale card).
    const cardPair = async () => [await cardValue(page, SEC), await cardValue(page, SEC_ID)];
    const immediate = await cardPair();
    let settled = immediate;
    for (let i = 0; i < 20 && settled.join("|") !== "Not specified|0007"; i++) {
      await page.waitForTimeout(250);
      settled = await cardPair();
    }
    console.log(`   ${who}: card right after save ${JSON.stringify(immediate)}`);
    check(`${who}: card shows Not specified / 0007`, settled.join("|") === "Not specified|0007", {
      immediate,
      settled,
    });
    p = await editOnProfile(" Aetna Supplemental ", "");
    check(
      `${who}: Member ID blank, insurance kept`,
      p.secondary_insurance === "Aetna Supplemental" && p.secondary_insurance_member_id === null,
      p,
    );
    p = await editOnProfile("", "   ");
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
    await page.getByRole("button", { name: "Edit Patient" }).click();
    const r = dialog(page);
    check(
      `${who}: reopened Edit shows blank secondary, primary prefilled`,
      (await r.locator('[name="secondary_insurance"]').inputValue()) === "" &&
        (await r.locator('[name="secondary_insurance_member_id"]').inputValue()) === "" &&
        (await r.locator('[name="insurance"]').inputValue()) === "Medicare" &&
        (await r.locator('[name="insurance_member_id"]').inputValue()) === "0001234" &&
        (await r.locator('[name="referring_physician_npi"]').inputValue()) ===
          PROVIDER.referring_physician_npi,
    );
    await r.getByRole("button", { name: "Cancel" }).click();
    await page.locator('[role="dialog"]').waitFor({ state: "detached" });
    p = await patientRow(created.id);
    check(
      `${who}: primary insurance, names, status and provider unchanged`,
      STABLE.every((k) => p[k] === baseline[k]),
      { baseline, now: Object.fromEntries(STABLE.map((k) => [k, p[k]])) },
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
      h.includes(SEC) &&
        h.includes(SEC_ID) &&
        h.includes(acct.username) &&
        h.includes("Aetna Supplemental") &&
        h.includes("0007") &&
        !/secondary_insurance/.test(h),
      h.slice(0, 600),
    );
    await page.keyboard.press("Escape");
    const { data: logs } = await admin
      .from("audit_logs")
      .select("action, changes, actor_username")
      .eq("patient_id", created.id)
      .eq("action", "patients_update")
      .order("created_at");
    const keys = (l) =>
      Object.keys(l.changes ?? {})
        .sort()
        .join();
    check(
      `${who}: history rows = [Member ID, insurance, both, insurance] by ${acct.username}`,
      logs.length === 4 &&
        logs.every((l) => l.actor_username === acct.username) &&
        keys(logs[0]) === "secondary_insurance_member_id" &&
        keys(logs[1]) === "secondary_insurance" &&
        keys(logs[2]) === "secondary_insurance,secondary_insurance_member_id" &&
        keys(logs[3]) === "secondary_insurance",
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
  if (docIds.length) await admin.from("documents").delete().in("id", docIds);
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
    trackedPatients: patientIds.length
      ? (await admin.from("patients").select("id").in("id", patientIds)).data?.length
      : 0,
    documents: (
      await admin
        .from("documents")
        .select("id")
        .in("id", docIds.length ? docIds : ["00000000-0000-0000-0000-000000000000"])
    ).data?.length,
    patientAudit: patientIds.length
      ? (await admin.from("audit_logs").select("id").in("patient_id", patientIds)).data?.length
      : 0,
    users: (await Promise.all(accounts.map((a) => admin.auth.admin.getUserById(a.id)))).filter(
      (u) => u.data?.user,
    ).length,
  };
  console.log(
    `cleanup evidence: tracked ${patientIds.length} patients, ${docIds.length} documents, ${accounts.length} accounts; leftovers ${JSON.stringify(left)}`,
  );
  check(
    "cleanup: no synthetic patients, documents, history or accounts remain",
    Object.values(left).every((n) => !n),
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
  const a1 = await anonC.from("patients").insert({
    first_name: "Anon",
    last_name: tag,
    patient_id: `${tag}-anon`,
    secondary_insurance: "X",
  });
  const a2 = await nrC.from("patients").insert({
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

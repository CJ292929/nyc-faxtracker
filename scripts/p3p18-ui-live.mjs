#!/usr/bin/env node
// Live browser + API verification of P3-P18 (record attribution, View
// History, admin Activity Log) against a real deployment, using only
// synthetic accounts and records that are removed again at the end.
//
// Covers: staff A creates / staff B edits (creator stays A, editor becomes
// B) through the real UI; patient and document history with field-level
// changes and Referring Provider labels; follow-up attempt, received,
// upload, and correction events (each exactly once); bulk upload
// attribution; cancel and failed validation write nothing; spoofed actor
// values over REST are ignored; staff/anon/role-less cannot reach the
// admin log; legacy "Unknown — recorded before tracking." and system
// wording; admin filters, pagination, scroll area, time zone; account
// removal labelling; permanent deletion keeps only minimal evidence.
//
// Requires in .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_PUBLISHABLE_KEY, SUPABASE_DB_MIGRATION_URL (+ optional
// SUPABASE_DB_MIGRATION_ROLE) -- the DB connection is used only to give one
// synthetic patient legacy ("unknown") attribution.
// Run with: E2E_BASE_URL=https://<deployment> node scripts/p3p18-ui-live.mjs [shot-dir]
import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { chromium } from "playwright";
import XLSX from "xlsx";

const SHOT_DIR = process.argv[2] || ".";
mkdirSync(SHOT_DIR, { recursive: true });
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
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
const TZ = "America/New_York";
const LEGACY = "Unknown — recorded before tracking.";

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const stamp = Date.now();
const tag = `p3p18${String(stamp).slice(-7)}`;
const code = (s) => `P3P18-${stamp}-${s}`;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", String(JSON.stringify(detail)).slice(0, 600));
  }
}

const accounts = [];
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
  const { error } = await c.auth.signInWithPassword({ email: acct.email, password: acct.password });
  if (error) throw new Error(`sign in ${acct.username}: ${error.message}`);
  return c;
}
async function patientByCode(c) {
  const { data } = await admin.from("patients").select("*").eq("patient_id", c).maybeSingle();
  return data;
}
async function events(filter) {
  let q = admin.from("audit_logs").select("*").order("created_at", { ascending: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data } = await q;
  return data ?? [];
}

async function session(browser, acct) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    timezoneId: TZ,
  });
  const page = await context.newPage();
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
async function toast(page, text) {
  await page.getByText(text).first().waitFor({ timeout: 15000 });
}
// Click a dialog submit button, then wait until the dialog has closed (the
// form only closes after the save succeeded and the data refreshed).
async function submit(page, button, text) {
  await dialog(page).getByRole("button", { name: button }).click();
  await toast(page, text);
  await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 15000 });
  // refresh() swaps the workspace for "Loading records…" (which also
  // unmounts the dialog), so wait for the reloaded view as well.
  await page.getByText("Loading records…").waitFor({ state: "detached", timeout: 20000 });
}
async function openRecord(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByText("Created by").first().waitFor({ timeout: 20000 });
  return page.locator("body").innerText();
}
async function historyText(page) {
  await page.getByRole("button", { name: "View History" }).click();
  const d = dialog(page);
  await d
    .getByText(/Showing \d+ of \d+|No recorded history yet/)
    .first()
    .waitFor({ timeout: 15000 });
  const text = await d.innerText();
  return { d, text };
}
async function closeDialog(page) {
  await dialog(page).getByRole("button", { name: "Close" }).click();
}
// Filter controls by their visible field label (a wrapping label's
// accessible name also includes the select's current option text).
const field = (page, label) =>
  page
    .locator("label")
    .filter({ has: page.locator("span.field-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator("select, input");
const attribution = (text) =>
  text
    .split("\n")
    .filter((l) => /Created by|Last updated by/.test(l))
    .join(" | ") || text.slice(0, 300);
const count = (text, needle) => text.split(needle).length - 1;

const createdPatientCodes = new Set();
const xlsxPath = path.join(os.tmpdir(), `p3p18-bulk-${stamp}.xlsx`);

async function main() {
  const adm = await makeAccount("adm", "admin");
  const A = await makeAccount("sa", "staff");
  const B = await makeAccount("sb", "staff");
  const NR = await makeAccount("nr", null);
  const browser = await chromium.launch();
  try {
    // ---------------- Legacy and system wording ----------------
    const PL = code("LEGACY");
    const PSYS = code("SYS");
    createdPatientCodes.add(PL);
    createdPatientCodes.add(PSYS);
    await admin.from("patients").insert([
      { first_name: "Synthetic", last_name: "Legacy", patient_id: PL },
      { first_name: "Synthetic", last_name: "System", patient_id: PSYS },
    ]);
    const legacy = await patientByCode(PL);
    const system = await patientByCode(PSYS);
    check("service-role write recorded as system", system.created_by_kind === "system");
    const sql = postgres(env.SUPABASE_DB_MIGRATION_URL, { max: 1, onnotice: () => {} });
    try {
      if (env.SUPABASE_DB_MIGRATION_ROLE)
        await sql.unsafe(`set role "${env.SUPABASE_DB_MIGRATION_ROLE}"`);
      // Give this one synthetic row pre-tracking attribution. Done in one
      // transaction, so other sessions never observe the trigger disabled.
      await sql.begin(async (tx) => {
        await tx`alter table public.patients disable trigger set_patient_attribution`;
        await tx`update public.patients set created_by = null, created_by_name = null, created_by_kind = 'unknown', updated_by = null, updated_by_name = null, updated_by_kind = 'unknown' where id = ${legacy.id} and patient_id = ${PL}`;
        await tx`alter table public.patients enable trigger set_patient_attribution`;
      });
    } finally {
      await sql.end();
    }

    // ---------------- Staff A creates a patient and a document ----------------
    const a = await session(browser, A);
    const P = code("P");
    createdPatientCodes.add(P);
    await a.page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await a.page.getByRole("button", { name: "Add Patient" }).click();
    let d = dialog(a.page);
    await d.locator('[name="first_name"]').fill("Synthetic");
    await d.locator('[name="last_name"]').fill(`P3P18 ${stamp}`);
    await d.locator('[name="patient_id"]').fill(P);
    await d.locator('[name="referring_physician"]').fill("Dr. First Referrer");
    await submit(a.page, "Save Patient", "Patient successfully added.");
    const patient = await patientByCode(P);
    check("UI create: patient saved", !!patient);
    let body = await openRecord(a.page, `${BASE_URL}/patients/${patient.id}`);
    check(
      "patient page: Created by staff A",
      body.includes(`Created by ${A.username}`),
      body.slice(0, 400),
    );
    check(
      "patient page: Last updated by staff A after creation",
      body.includes(`Last updated by ${A.username}`),
    );
    check(
      "patient page: timestamps carry a time zone",
      /Created by \S+ · \w{3} \d+, \d{4}, \d+:\d\d [AP]M E[DS]T/.test(body),
    );

    await a.page.getByRole("button", { name: "Add Document / Fax" }).click();
    d = dialog(a.page);
    await d.locator('[name="attempted_at"]').fill("2026-10-15T09:30");
    await d.locator('[name="fax_status"]').selectOption("Busy");
    await submit(a.page, "Save Fax Record", "Fax record saved.");
    const { data: docs } = await admin.from("documents").select("*").eq("patient_id", patient.id);
    const doc = docs?.[0];
    check("UI create: document + first attempt saved", docs?.length === 1);
    body = await openRecord(a.page, `${BASE_URL}/documents/${doc.id}`);
    check("document page: Created by staff A", body.includes(`Created by ${A.username}`));
    check("attempt #1: Recorded by staff A", body.includes(`Recorded by ${A.username}`));
    await a.page.screenshot({
      path: path.join(SHOT_DIR, "01-document-created-by-staff-a.png"),
      fullPage: true,
    });

    // A second patient by staff A, used later for the account-removal check.
    const P2 = code("P2");
    createdPatientCodes.add(P2);
    await a.page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await a.page.getByRole("button", { name: "Add Patient" }).click();
    d = dialog(a.page);
    await d.locator('[name="first_name"]').fill("Synthetic");
    await d.locator('[name="last_name"]').fill(`P3P18 Two ${stamp}`);
    await d.locator('[name="patient_id"]').fill(P2);
    await submit(a.page, "Save Patient", "Patient successfully added.");
    const patient2 = await patientByCode(P2);
    await a.context.close();

    // ---------------- Staff B edits ----------------
    const b = await session(browser, B);
    await openRecord(b.page, `${BASE_URL}/patients/${patient.id}`);
    const before = (await events({ patient_id: patient.id })).length;

    // Cancel writes nothing.
    await b.page.getByRole("button", { name: "Edit Patient" }).click();
    d = dialog(b.page);
    await d.locator('[name="phone"]').fill("555-0199");
    await d.getByRole("button", { name: "Cancel" }).click();
    check("cancelled edit: no event", (await events({ patient_id: patient.id })).length === before);

    // Failed validation writes nothing.
    await b.page.getByRole("button", { name: "Edit Patient" }).click();
    d = dialog(b.page);
    await d.locator('[name="referring_physician_npi"]').fill("123");
    await d.getByRole("button", { name: "Save Patient" }).click();
    await toast(b.page, "MD NPI must be exactly 10 digits.");
    await d.getByRole("button", { name: "Cancel" }).click();
    check(
      "failed validation: no event",
      (await events({ patient_id: patient.id })).length === before,
    );

    // Real edit.
    await b.page.getByRole("button", { name: "Edit Patient" }).click();
    d = dialog(b.page);
    await d.locator('[name="phone"]').fill("555-0142");
    await d.locator('[name="referring_physician"]').fill("Dr. Second Referrer");
    await submit(b.page, "Save Patient", "Patient updated.");
    body = await b.page.locator("body").innerText();
    check(
      "after B edits: creator stays staff A",
      body.includes(`Created by ${A.username}`),
      attribution(body),
    );
    check(
      "after B edits: last updated by staff B",
      body.includes(`Last updated by ${B.username}`),
      attribution(body),
    );

    // Re-save unchanged: no event, editor unchanged.
    const afterEdit = (await events({ patient_id: patient.id })).length;
    await b.page.getByRole("button", { name: "Edit Patient" }).click();
    await submit(b.page, "Save Patient", "Patient updated.");
    check(
      "unchanged save: no event",
      (await events({ patient_id: patient.id })).length === afterEdit,
    );

    // Document workflow by staff B.
    await openRecord(b.page, `${BASE_URL}/documents/${doc.id}`);
    await b.page.getByRole("button", { name: "Add Attempt" }).first().click();
    d = dialog(b.page);
    await d.locator('[name="status"]').selectOption("Sent Successfully");
    await submit(b.page, "Save Attempt", "Fax attempt recorded.");
    await b.page.getByRole("button", { name: "Mark Received" }).click();
    d = dialog(b.page);
    await d.locator('[name="received"]').selectOption("Yes");
    await d.locator('[name="received_document_type"]').selectOption("Signed Initial Evaluation");
    await d.locator('[name="received_from"]').fill("Dr. Second Referrer");
    await submit(b.page, "Save Received Status", "Received status updated.");
    await b.page.getByRole("button", { name: "Update Upload" }).click();
    d = dialog(b.page);
    await d.locator('[name="uploaded"]').selectOption("Yes");
    await submit(b.page, "Save Upload Status", "Document marked uploaded.");
    await b.page.getByTitle("Correct attempt").first().click();
    d = dialog(b.page);
    await d.locator('[name="status"]').selectOption("No Answer");
    await d.locator('[name="reason"]').fill("P3P18 synthetic correction");
    await submit(b.page, "Save Correction", "Fax attempt corrected.");
    body = await b.page.locator("body").innerText();
    check("attempt #2: Recorded by staff B", body.includes(`Recorded by ${B.username}`));
    check(
      "document: creator A, last editor B",
      body.includes(`Created by ${A.username}`) && body.includes(`Last updated by ${B.username}`),
    );

    let h = await historyText(b.page);
    await b.page.screenshot({
      path: path.join(SHOT_DIR, "02-document-history.png"),
      fullPage: true,
    });
    check("doc history: follow-up attempt", h.text.includes("Follow-up fax attempt #2 recorded"));
    check("doc history: first attempt by A", h.text.includes("Fax attempt #1 recorded"));
    check(
      "doc history: correction once with reason",
      count(h.text, "Fax attempt #1 corrected") === 1 &&
        h.text.includes("Correction reason") &&
        h.text.includes("P3P18 synthetic correction"),
    );
    check(
      "doc history: correction shows previous → new status",
      /Fax status\s*Busy\s*→\s*No Answer/.test(h.text),
      h.text.slice(0, 900),
    );
    check(
      "doc history: received + upload status events once each",
      count(h.text, "Received status updated") === 1 &&
        count(h.text, "Upload status updated") === 1,
    );
    check(
      "doc history: actors shown",
      h.text.includes(`By ${A.username}`) && h.text.includes(`By ${B.username}`),
    );
    check("doc history: times in local zone", /E[DS]T/.test(h.text));
    const docEvents = await events({ document_id: doc.id });
    const perAction = docEvents.reduce(
      (m, e) => ({ ...m, [e.action]: (m[e.action] ?? 0) + 1 }),
      {},
    );
    check(
      "doc events: exactly one per action, nothing duplicated",
      JSON.stringify(perAction) ===
        JSON.stringify({
          documents_insert: 1,
          fax_attempts_insert: 2,
          document_received_updated: 1,
          document_upload_updated: 1,
          fax_attempt_corrected: 1,
        }),
      perAction,
    );
    await closeDialog(b.page);

    await openRecord(b.page, `${BASE_URL}/patients/${patient.id}`);
    h = await historyText(b.page);
    await b.page.screenshot({
      path: path.join(SHOT_DIR, "03-patient-history.png"),
      fullPage: true,
    });
    check(
      "patient history: edit by B with Referring Provider label",
      h.text.includes("Patient edited") &&
        /Referring Provider\s*Dr\. First Referrer\s*→\s*Dr\. Second Referrer/.test(h.text),
      h.text.slice(0, 900),
    );
    check(
      "patient history: Patient Phone change",
      /Patient Phone\s*\(blank\)\s*→\s*555-0142/.test(h.text),
    );
    check("patient history: creation by A", h.text.includes("Patient created"));
    check(
      "patient history: related document/attempt events identified",
      h.text.includes("Attempt #2 · Initial Evaluation") && h.text.includes("Document created"),
    );
    await closeDialog(b.page);

    // ---------------- Bulk upload by staff B ----------------
    const bulkNames = [`P3P18Bulk${stamp}`, `P3P18BulkTwo${stamp}`];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
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
        [`${bulkNames[0]} Synthetic`, "", "04/12/1975", "", "Medicare", "Dr. Bulk", "", "", ""],
        [`${bulkNames[1]} Synthetic`, "", "05/13/1976", "", "Aetna", "", "", "", ""],
      ]),
      "Patients",
    );
    XLSX.writeFile(wb, xlsxPath);
    await b.page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await b.page.getByRole("button", { name: "Bulk Upload Patients" }).click();
    await b.page.locator('input[type="file"]').setInputFiles(xlsxPath);
    await b.page.waitForSelector("text=Flags", { timeout: 15000 });
    await b.page.getByRole("button", { name: /^Import \d+ Patients?$/ }).click();
    await b.page.waitForSelector("text=Done", { timeout: 30000 });
    await b.page.getByRole("button", { name: "Done" }).click();
    const { data: bulk } = await admin
      .from("patients")
      .select("id, patient_id, created_by, created_by_name")
      .in("first_name", bulkNames);
    for (const r of bulk ?? []) createdPatientCodes.add(r.patient_id);
    check("bulk upload: both rows created", bulk?.length === 2);
    check(
      "bulk upload: attributed to staff B",
      (bulk ?? []).every((r) => r.created_by === B.id && r.created_by_name === B.username),
    );
    let bulkEventsOk = true;
    for (const r of bulk ?? []) {
      const ev = await events({ record_id: r.id });
      if (!(ev.length === 1 && ev[0].action === "patients_insert" && ev[0].user_id === B.id))
        bulkEventsOk = false;
    }
    check("bulk upload: exactly one creation event per row", bulkEventsOk);

    // ---------------- Staff cannot see the admin log ----------------
    await b.page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
    await b.page
      .getByText("Only administrators can manage staff roles.")
      .waitFor({ timeout: 15000 });
    body = await b.page.locator("body").innerText();
    check("staff settings: no Audit Activity section", !body.includes("Audit Activity"));
    await b.context.close();

    // ---------------- REST/RPC boundary ----------------
    const apiA = await apiClientFor(A);
    const apiB = await apiClientFor(B);
    const apiNR = await apiClientFor(NR);
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false },
    });
    const actFilters = {
      _actor_id: null,
      _actor_kind: null,
      _from: null,
      _to: null,
      _action: null,
      _record_type: null,
      _limit: 5,
      _offset: 0,
    };
    let r = await apiB.rpc("get_audit_activity", actFilters);
    check("staff REST: global activity log denied", !!r.error && /FORBIDDEN/.test(r.error.message));
    r = await apiB.rpc("list_audit_actors");
    check("staff REST: account list denied", !!r.error);
    r = await apiB.from("audit_logs").select("id").limit(5);
    check("staff REST: audit_logs returns nothing", !r.error && r.data.length === 0);
    r = await apiB.from("user_logins").select("username").limit(1);
    check("staff REST: user_logins not readable", !!r.error || r.data.length === 0);
    r = await apiB.rpc("get_record_history", {
      _record_type: "patient",
      _record_id: patient.id,
      _limit: 5,
      _offset: 0,
    });
    check("staff REST: own-access record history allowed", !r.error && r.data.length > 0);
    r = await apiNR.rpc("get_record_history", {
      _record_type: "patient",
      _record_id: patient.id,
      _limit: 5,
      _offset: 0,
    });
    check("role-less REST: record history denied", !!r.error && /FORBIDDEN/.test(r.error.message));
    r = await apiNR.rpc("get_audit_activity", actFilters);
    check("role-less REST: activity log denied", !!r.error);
    r = await anon.rpc("get_record_history", {
      _record_type: "patient",
      _record_id: patient.id,
      _limit: 5,
      _offset: 0,
    });
    check("anon REST: record history denied", !!r.error);
    r = await anon.rpc("get_audit_activity", actFilters);
    check("anon REST: activity log denied", !!r.error);

    const PS = code("SPOOF");
    createdPatientCodes.add(PS);
    r = await apiA
      .from("patients")
      .insert({
        first_name: "Synthetic",
        last_name: "Spoof",
        patient_id: PS,
        created_by: adm.id,
        created_by_name: adm.username,
        created_by_kind: "user",
        created_at: "2001-01-01T00:00:00Z",
      })
      .select("created_by, created_by_name, created_at")
      .single();
    check(
      "spoofed REST insert: creator forced to caller",
      r.data?.created_by === A.id &&
        r.data?.created_by_name === A.username &&
        !r.data?.created_at.startsWith("2001"),
      r,
    );
    r = await apiA
      .from("patients")
      .update({
        created_by: adm.id,
        created_by_name: "x",
        updated_by: adm.id,
        updated_by_name: "x",
      })
      .eq("id", patient.id)
      .select("created_by, updated_by")
      .single();
    check(
      "spoofed REST update: attribution unchanged",
      r.data?.created_by === A.id && r.data?.updated_by === B.id,
      r,
    );
    r = await apiA
      .from("fax_attempts")
      .insert({ document_id: doc.id, attempt_number: 9, status: "Pending", created_by: adm.id })
      .select("created_by, created_by_name")
      .single();
    check(
      "spoofed REST attempt: recorder forced to caller",
      r.data?.created_by === A.id && r.data?.created_by_name === A.username,
      r,
    );
    r = await apiA.from("audit_logs").insert({ user_id: adm.id, action: "patients_insert" });
    check("REST: audit_logs insert rejected", !!r.error);

    // ---------------- Admin: activity log ----------------
    await apiA.auth.signOut();
    const apiAdm = await apiClientFor(adm);
    r = await apiAdm.rpc("delete_staff_account", {
      _target_user_id: A.id,
      _expected_username: A.username,
    });
    check("account removal of staff A (setup for labelling check)", !r.error, r.error);
    const m = await session(browser, adm);
    body = await openRecord(m.page, `${BASE_URL}/patients/${legacy.id}`);
    check(
      "legacy record: required unknown wording",
      body.includes(`Created by ${LEGACY}`) && body.includes(`Last updated by ${LEGACY}`),
    );
    await m.page.screenshot({
      path: path.join(SHOT_DIR, "04-legacy-unknown.png"),
      fullPage: false,
    });
    body = await openRecord(m.page, `${BASE_URL}/patients/${system.id}`);
    check(
      "system record: System / maintenance wording",
      body.includes("Created by System / maintenance"),
    );
    body = await openRecord(m.page, `${BASE_URL}/patients/${patient2.id}`);
    await m.page.waitForTimeout(1500);
    body = await m.page.locator("body").innerText();
    check(
      "removed account: attribution labelled, name kept",
      body.includes(`Created by ${A.username} (account removed)`),
      body.slice(0, 500),
    );
    h = await historyText(m.page);
    check("removed account: history labelled", h.text.includes(`${A.username} (account removed)`));
    await closeDialog(m.page);

    await m.page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
    const region = m.page.getByRole("region", { name: "Audit activity log" });
    await region.waitFor({ timeout: 15000 });
    await m.page.getByText(/Showing 1–\d+ of \d+/).waitFor({ timeout: 20000 });
    let summary = await m.page.getByText(/Showing \d+–\d+ of \d+/).innerText();
    const total = Number(summary.match(/of (\d+)/)[1]);
    check("admin log: loads with total count", total > 0, summary);
    const box = await region.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    check(
      "admin log: bounded scroll area (≤480px, scrolls)",
      box.ch <= 480 && box.sh > box.ch,
      box,
    );
    await region.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const headingVisible = await m.page
      .getByRole("heading", { name: "Audit Activity" })
      .isVisible();
    const filterVisible = await field(m.page, "Account").isVisible();
    check(
      "admin log: heading and filters stay visible while scrolling",
      headingVisible && filterVisible,
    );
    if (total > 50) {
      await m.page.getByRole("button", { name: "Next" }).click();
      await m.page.getByText(new RegExp(`Showing 51–\\d+ of ${total}`)).waitFor({ timeout: 15000 });
      check("admin log: server-side pagination (page 2)", true);
      await m.page.getByRole("button", { name: "Previous" }).click();
      await m.page.getByText(/Showing 1–/).waitFor({ timeout: 15000 });
    }
    await field(m.page, "Account").selectOption(B.id);
    await m.page.getByText(/Showing 1–\d+ of \d+/).waitFor({ timeout: 15000 });
    await m.page.waitForTimeout(500);
    let rows = await region.locator("tbody tr").allInnerTexts();
    check(
      "admin log: account filter (staff B) server-side",
      rows.length > 0 && rows.every((t) => t.includes(B.username)),
      rows.slice(0, 3),
    );
    check(
      "admin log: accounts include admins",
      (await field(m.page, "Account").innerText()).includes(`${adm.username} (admin)`),
    );
    check(
      "admin log: removed account offered",
      (await field(m.page, "Account").innerText()).includes(`${A.username} (account removed)`),
    );
    await field(m.page, "Action").selectOption("patients_update");
    await m.page.waitForTimeout(1500);
    rows = await region.locator("tbody tr").allInnerTexts();
    check(
      "admin log: action filter",
      rows.length >= 1 && rows.every((t) => t.includes("Patient edited")),
      rows,
    );
    check(
      "admin log: details show friendly field labels",
      rows.some((t) => t.includes("Referring Provider:")),
    );
    await field(m.page, "Action").selectOption("");
    await field(m.page, "Record type").selectOption("fax_attempt");
    await m.page.waitForTimeout(1500);
    rows = await region.locator("tbody tr").allInnerTexts();
    check(
      "admin log: record type filter",
      rows.length >= 2 && rows.every((t) => /Attempt #\d/.test(t)),
      rows,
    );
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    await field(m.page, "From").fill(today);
    await field(m.page, "To").fill(today);
    await m.page.waitForTimeout(1500);
    rows = await region.locator("tbody tr").allInnerTexts();
    check("admin log: date range (today) keeps today's events", rows.length >= 2);
    check(
      "admin log: times shown with zone",
      rows.every((t) => /E[DS]T/.test(t)),
    );
    const tomorrow = new Date(Date.now() + 86400000);
    await m.page
      .getByLabel("From", { exact: true })
      .fill(new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(tomorrow));
    await m.page
      .getByLabel("To", { exact: true })
      .fill(
        new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
          new Date(Date.now() + 2 * 86400000),
        ),
      );
    await m.page.getByText("No activity matches these filters.").waitFor({ timeout: 15000 });
    check("admin log: empty state for out-of-range filters", true);
    await m.page.getByRole("button", { name: "Clear filters" }).click();
    await m.page.getByText(/Showing 1–\d+ of \d+/).waitFor({ timeout: 15000 });
    await m.page.screenshot({
      path: path.join(SHOT_DIR, "05-admin-activity-log.png"),
      fullPage: true,
    });
    await m.context.close();

    // ---------------- Permanent deletion through the UI (staff B) ----------------
    const b2 = await session(browser, B);
    await openRecord(b2.page, `${BASE_URL}/patients/${patient.id}`);
    await b2.page.getByTitle("Delete document").first().click();
    await dialog(b2.page).getByRole("button", { name: "Delete Permanently" }).click();
    await toast(b2.page, "Document permanently deleted");
    await b2.page.waitForTimeout(800);
    h = await historyText(b2.page);
    check(
      "patient history: document deletion identified",
      h.text.includes("Document permanently deleted") && h.text.includes("Initial Evaluation"),
    );
    await closeDialog(b2.page);
    const docRowsAfter = await events({ document_id: doc.id });
    check(
      "document delete: earlier field values scrubbed, skeleton kept",
      docRowsAfter
        .filter((e) => e.action !== "document_deleted_permanently")
        .every((e) => e.changes === null) &&
        !JSON.stringify(docRowsAfter).includes("P3P18 synthetic correction"),
    );
    await b2.page.getByRole("button", { name: "Delete Patient Permanently" }).click();
    d = dialog(b2.page);
    await d.locator("input.field").fill(P);
    await d.getByRole("button", { name: "Delete Permanently" }).click();
    await toast(b2.page, "Patient permanently deleted");
    await b2.context.close();
    const patientRowsAfter = await events({ patient_id: patient.id });
    const last = patientRowsAfter.at(-1);
    check(
      "patient delete: minimal deletion event by staff B",
      last?.action === "patient_deleted_permanently" && last?.actor_username === B.username,
    );
    check(
      "patient delete: no earlier event keeps field values",
      patientRowsAfter.slice(0, -1).every((e) => e.changes === null),
    );
    check(
      "patient delete: no patient details retained",
      !/555-0142|Dr\. (First|Second) Referrer|Synthetic|P3P18 synthetic correction/.test(
        JSON.stringify(patientRowsAfter),
      ),
    );
    check("patient delete: record gone", !(await patientByCode(P)));
    createdPatientCodes.delete(P);
  } finally {
    await browser.close();
  }
}

async function cleanup() {
  const ids = [];
  for (const c of createdPatientCodes) {
    const p = await patientByCode(c);
    if (!p) continue;
    ids.push(p.id);
    const { data: ds } = await admin.from("documents").select("id").eq("patient_id", p.id);
    for (const d of ds ?? []) {
      await admin.from("fax_attempts").delete().eq("document_id", d.id);
      await admin.from("document_files").delete().eq("document_id", d.id);
    }
    await admin.from("documents").delete().eq("patient_id", p.id);
    await admin.from("patients").delete().eq("id", p.id);
  }
  // Audit rows produced by this run's synthetic accounts/records only.
  const actorIds = accounts.map((a) => a.id);
  if (actorIds.length) await admin.from("audit_logs").delete().in("user_id", actorIds);
  if (ids.length) await admin.from("audit_logs").delete().in("patient_id", ids);
  for (const a of accounts) {
    await admin.from("user_roles").delete().eq("user_id", a.id);
    await admin.from("user_logins").delete().eq("user_id", a.id);
    await admin.auth.admin.deleteUser(a.id).catch(() => {});
  }
  try {
    unlinkSync(xlsxPath);
  } catch {
    /* not created */
  }
  const leftover = await admin.from("patients").select("id").like("patient_id", `P3P18-${stamp}-%`);
  const leftoverUsers = await admin
    .from("user_logins")
    .select("user_id")
    .like("username", `${tag}%`);
  console.log(
    `cleanup: patients left=${leftover.data?.length ?? "?"}, synthetic logins left=${leftoverUsers.data?.length ?? "?"}`,
  );
}

try {
  await main();
} catch (e) {
  failures++;
  console.log("FAIL - unexpected error:", e.message);
} finally {
  await cleanup();
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// Live browser verification of P3-P19 ("Other" Document Type with custom
// text) against a real deployment, using only synthetic accounts and records
// that are removed again at the end (same discipline as p3p18-ui-live.mjs).
//
// Per actor (staff on desktop, admin on mobile): blank/whitespace Other is
// rejected with a clear message and writes nothing; Other + custom text saves
// trimmed; reload and Edit reconstruct Other + text; edit text; switch
// Other -> predefined -> Other; a predefined type still saves unchanged;
// detail page, Fax Tracker search and "Other" filter, Reports filter and the
// actual downloaded CSV / Excel / PDF show the custom text; View History
// shows each change once with the right actor. Also: anon and role-less
// REST writes are denied; no console errors or failed requests.
//
// Requires in .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_PUBLISHABLE_KEY.
// Run with: E2E_BASE_URL=https://<deployment> node scripts/p3p19-ui-live.mjs [shot-dir]
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, devices } from "playwright";
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
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const stamp = Date.now();
const tag = `p3p19${String(stamp).slice(-7)}`;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", String(JSON.stringify(detail)).slice(0, 600));
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

const problems = [];
async function session(browser, acct, mobile) {
  const context = await browser.newContext({
    ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1400, height: 900 } }),
    timezoneId: "America/New_York",
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${acct.username} console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${acct.username} pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(f))
      problems.push(`${acct.username} requestfailed: ${r.url()} ${f}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${acct.username} HTTP ${r.status()}: ${r.url()}`);
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
// The patient page's action row does not wrap on narrow screens (pre-existing,
// outside P3-P19), so "Add Document / Fax" overflows under the header on
// mobile; activate it by keyboard there, as a real user tabbing would.
// The overflow also widens the mobile layout viewport, which misplaces
// Playwright's tap coordinates, so on mobile every button is activated by
// keyboard (focus + Enter); desktop uses real clicks.
let MOBILE = false;
async function tap(loc) {
  if (!MOBILE) return loc.click();
  await loc.focus();
  await loc.page().keyboard.press("Enter");
}
const addDocument = (page) => tap(page.getByRole("button", { name: "Add Document / Fax" }));
const dialog = (page) => page.locator('[role="dialog"]').last();
const toast = (page, text) => page.getByText(text).first().waitFor({ timeout: 15000 });
async function save(page, text) {
  await tap(dialog(page).getByRole("button", { name: "Save Fax Record" }));
  await toast(page, text);
  await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 15000 });
  await page.getByText("Loading records…").waitFor({ state: "detached", timeout: 20000 });
}
const results = (page) =>
  page.locator("main").evaluate((m) => {
    const c = m.cloneNode(true);
    c.querySelectorAll("select, option").forEach((e) => e.remove());
    return c.innerText ?? c.textContent;
  });
const typeSelect = (page) => dialog(page).locator('select[name="document_type"]');
const customInput = (page) => dialog(page).locator('input[name="document_type_other"]');
async function openDoc(page, id) {
  await page.goto(`${BASE_URL}/documents/${id}`, { waitUntil: "networkidle" });
  await page.getByText("Created by").first().waitFor({ timeout: 20000 });
  return page.locator("body").innerText();
}
async function openEdit(page, id) {
  await openDoc(page, id);
  await tap(page.getByRole("button", { name: /^Edit$/ }).first());
  await typeSelect(page).waitFor();
}
async function download(page, button) {
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    tap(page.getByRole("button", { name: button })),
  ]);
  const p = path.join(SHOT_DIR, `${tag}-${dl.suggestedFilename()}`);
  await dl.saveAs(p);
  return readFileSync(p);
}

async function actorFlow(browser, acct, mobile) {
  const L = acct.role;
  const custom = `Plan of Care ${L} ${stamp}`;
  const edited = `Home Exercise Program ${L} ${stamp}`;
  const { data: pat } = await admin
    .from("patients")
    .insert({
      first_name: "Synthetic",
      last_name: `P3P19 ${L} ${stamp}`,
      patient_id: `P3P19-${stamp}-${L}`,
    })
    .select()
    .single();
  patientIds.push(pat.id);
  const { context, page } = await session(browser, acct, mobile);
  const view = mobile ? "mobile" : "desktop";
  MOBILE = mobile;
  try {
    // Create: whitespace-only Other is rejected and writes nothing.
    await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
    await addDocument(page);
    await typeSelect(page).selectOption("Other");
    check(`${L}: custom input appears for Other`, await customInput(page).isVisible());
    await customInput(page).fill("   ");
    await customInput(page).evaluate((el) => el.blur());
    // onBlur trims to "" -> native required blocks; re-enter spaces without blur.
    await customInput(page).fill("   ");
    await tap(dialog(page).getByRole("button", { name: "Save Fax Record" }));
    const blankMsg = await page
      .getByText("Specify the document type.")
      .first()
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    const nativeMsg = await customInput(page).evaluate((el) => el.validationMessage);
    check(`${L}: whitespace-only rejected with a clear message`, blankMsg || !!nativeMsg, {
      nativeMsg,
    });
    check(`${L}: rejected Other wrote nothing`, (await docsOf(pat.id)).length === 0);
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-blank-rejected.png`) });

    // Create with custom text (padded) -> stored trimmed.
    await customInput(page).fill(`  ${custom}  `);
    await save(page, "Fax record saved.");
    let [doc] = await docsOf(pat.id);
    check(`${L}: custom type saved trimmed`, doc?.document_type === custom, doc?.document_type);

    // Reload + Edit reconstructs Other + text.
    let body = await openDoc(page, doc.id);
    await page.reload({ waitUntil: "networkidle" });
    body = await page.locator("body").innerText();
    check(`${L}: detail shows custom text after reload`, body.includes(custom));
    await openEdit(page, doc.id);
    check(`${L}: Edit selects Other`, (await typeSelect(page).inputValue()) === "Other");
    check(`${L}: Edit shows custom text`, (await customInput(page).inputValue()) === custom);
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-edit-other.png`) });

    // Edit custom text.
    await customInput(page).fill(edited);
    await save(page, "Document updated.");
    [doc] = await docsOf(pat.id);
    check(`${L}: custom text edited`, doc.document_type === edited, doc.document_type);

    // Other -> predefined -> Other.
    await openEdit(page, doc.id);
    await typeSelect(page).selectOption("Progress Note");
    check(`${L}: custom input hidden for predefined`, !(await customInput(page).count()));
    await save(page, "Document updated.");
    [doc] = await docsOf(pat.id);
    check(
      `${L}: switch to predefined stores only predefined`,
      doc.document_type === "Progress Note",
    );
    await openEdit(page, doc.id);
    check(`${L}: Edit shows predefined`, (await typeSelect(page).inputValue()) === "Progress Note");
    await typeSelect(page).selectOption("Other");
    await customInput(page).fill(custom);
    await save(page, "Document updated.");
    [doc] = await docsOf(pat.id);
    check(`${L}: switch back to Other text`, doc.document_type === custom, doc.document_type);

    // Predefined create still works.
    await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
    await addDocument(page);
    await typeSelect(page).selectOption("Discharge Note");
    await save(page, "Fax record saved.");
    const docs = await docsOf(pat.id);
    check(
      `${L}: predefined type saves unchanged`,
      docs.length === 2 && docs[1].document_type === "Discharge Note",
      docs.map((d) => d.document_type),
    );

    // View History: each type change once, correct actor.
    await openDoc(page, doc.id);
    await tap(page.getByRole("button", { name: "View History" }));
    await dialog(page)
      .getByText(/Showing \d+ of \d+|No recorded history yet/)
      .first()
      .waitFor({ timeout: 15000 });
    const hist = await dialog(page).innerText();
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-history.png`) });
    await tap(dialog(page).getByRole("button", { name: "Close" }));
    const { data: ev } = await admin
      .from("audit_logs")
      .select("action, actor_username, user_id, changes")
      .eq("document_id", doc.id)
      .order("created_at");
    const typeChanges = (ev ?? []).filter((e) => e.changes?.document_type);
    check(
      `${L}: create + 3 type changes audited once each`,
      typeChanges.length === 4,
      typeChanges.map((e) => e.changes.document_type),
    );
    check(
      `${L}: every audit event attributed to ${L}`,
      (ev ?? []).length > 0 && ev.every((e) => e.user_id === acct.id),
      ev?.map((e) => e.actor_username),
    );
    check(
      `${L}: history shows custom and edited text`,
      hist.includes(custom) && hist.includes(edited),
    );
    check(`${L}: history shows actor`, hist.includes(acct.username));
    const fromTo = hist.split(edited).length - 1;
    check(`${L}: edited text appears once per change (in, out)`, fromTo === 2, { fromTo });

    // Fax Tracker search + Other filter.
    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    const search = page.getByPlaceholder("Search documents, patients...");
    await search.fill(custom);
    body = await results(page);
    check(`${L}: Fax Tracker search finds custom type`, body.includes(custom));
    await search.fill(`P3P19 ${L} ${stamp}`);
    await page.getByLabel("Document type").selectOption("Other");
    body = await results(page);
    check(
      `${L}: Other filter shows custom, hides predefined`,
      body.includes(custom) && !body.includes("Discharge Note"),
    );
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-tracker-other.png`) });

    // Reports: filter + actual downloads.
    await page.goto(`${BASE_URL}/reports`, { waitUntil: "networkidle" });
    await page.getByLabel("Patient").selectOption(pat.id);
    await page.getByLabel("Document type").selectOption("Other");
    body = await results(page);
    check(
      `${L}: Reports Other filter shows custom only`,
      body.includes(custom) && !body.includes("Discharge Note"),
    );
    const csv = (await download(page, "CSV")).toString("utf8");
    check(
      `${L}: CSV export has custom text`,
      csv.includes(custom) && !csv.includes("Discharge Note"),
    );
    const wb = XLSX.read(await download(page, "Excel"));
    const xl = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }));
    check(
      `${L}: Excel export has custom text`,
      xl.includes(custom) && !xl.includes("Discharge Note"),
    );
    const pdf = (await download(page, "PDF")).toString("latin1");
    check(`${L}: PDF export has custom text`, pdf.includes(custom.slice(0, 24)), pdf.length);
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-${view}-reports.png`) });
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
      await admin.from("fax_attempts").delete().eq("document_id", d.id);
      await admin.from("document_files").delete().eq("document_id", d.id);
    }
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
    patients: patientIds.length
      ? (await admin.from("patients").select("id").in("id", patientIds)).data?.length
      : 0,
    audit: ids.length
      ? (await admin.from("audit_logs").select("id").in("user_id", ids)).data?.length
      : 0,
    logins: (await admin.from("user_logins").select("user_id").like("username", `${tag}%`)).data
      ?.length,
  };
  check(
    "cleanup: no synthetic records or accounts remain",
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

  // Anonymous and role-less writes stay denied (REST, same path the app uses).
  const pid = patientIds[0];
  const anonC = await apiClientFor(null);
  const nrC = await apiClientFor(nr);
  const a1 = await anonC.from("documents").insert({ patient_id: pid, document_type: "Anon Type" });
  const a2 = await nrC
    .from("documents")
    .insert({ patient_id: pid, document_type: "Roleless Type" });
  const [first] = await docsOf(pid);
  const a3 = await nrC
    .from("documents")
    .update({ document_type: "Roleless Edit" })
    .eq("id", first.id)
    .select();
  check("anon insert denied", !!a1.error);
  check("role-less insert denied", !!a2.error);
  check("role-less update affects no rows", !a3.error && (a3.data?.length ?? 0) === 0);
  check(
    "no denied write landed",
    !(await docsOf(pid)).some((d) => /Anon Type|Roleless/.test(d.document_type)),
  );

  const real = problems.filter((p) => !/favicon/.test(p));
  check("no console errors or failed requests", real.length === 0, real);
} finally {
  await browser.close();
  await cleanup();
}
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall P3-P19 browser checks passed (synthetic data removed)");

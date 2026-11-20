#!/usr/bin/env node
// Browser verification of P3-P24 ("Uploaded to JaneApp?" confirmation) on a
// real deployment, using only synthetic accounts, one synthetic patient and
// two synthetic documents with fixed ids. Nothing real is read or changed.
//
// Provisioning and every database check run as SQL through the Supabase CLI
// (`supabase db query`), the same connection the verify:*-db scripts use, so
// no service-role key or .env is needed. The synthetic password is random per
// run, only ever written into a 0600 temp SQL file that is deleted at once,
// and never printed. Cleanup deletes by the exact fixed ids only (never by
// pattern) and runs in `finally`; it then asserts zero leftovers.
//
// Covers: staff on desktop with the outgoing record and admin on an iPhone 13
// (taps) with the incoming record — Unconfirmed / No / Yes alerts and badges,
// reload persistence, JaneApp column in the patient's Document & Fax History,
// Fax Tracker, Dashboard (Recent Fax Activity) and Reports (patient-filtered
// list), unrelated edits (Uploaded-to-patient-system, Mark Received, notes)
// keep the answer, a forced 500 on save shows an error and leaves status and
// DB unchanged, Yes -> No -> cleared restores alerts, View History label /
// values / actor, attribution rows, no horizontal overflow, role-less login
// denied.
//
// Targets (refuses anything else):
//   Local:  E2E_BASE_URL=http://localhost:<port>  -> `supabase db query --local`
//   Live:   --live, P3P24_CONFIRM_LIVE=synthetic-only, the linked project
//           (supabase/.temp/project-ref) must be the allowlisted project, and
//           E2E_BASE_URL a Vercel Preview of this project. The browser must
//           also be observed talking to that same Supabase project.
//   Production domains additionally need --production and
//           P3P24_CONFIRM_PRODUCTION=synthetic-only.
//
//   P3P24_CONFIRM_LIVE=synthetic-only E2E_BASE_URL=https://nyc-faxtracker-<id>-cj178.vercel.app \
//     node scripts/p3p24-ui-live.mjs --live [shot-dir]
//   node scripts/p3p24-ui-live.mjs --live --cleanup-only   # remove leftovers by exact id
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, devices } from "playwright";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const PRODUCTION = args.includes("--production");
const CLEANUP_ONLY = args.includes("--cleanup-only");
const SHOT_DIR = args.find((a) => !a.startsWith("--"));
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

// ---------------------------------------------------------------- targets
const PROD_PROJECT_REF = "iobrhrefxeirrmbnaiob";
const PROD_DOMAINS = ["https://faxtracker.vercel.app", "https://faxtracker.nychomerehab.com"];
const PREVIEW_RE = /^https:\/\/nyc-faxtracker-[a-z0-9-]+-cj178\.vercel\.app$/;
const isLocal = (u) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u ?? "");
const BASE = process.env.E2E_BASE_URL?.replace(/\/$/, "");
function refuse(msg) {
  console.error(`Refusing to run: ${msg}`);
  process.exit(2);
}
let DB_TARGET;
let EXPECT_SUPABASE_HOST = null;
if (LIVE) {
  if (process.env.P3P24_CONFIRM_LIVE !== "synthetic-only")
    refuse("--live needs P3P24_CONFIRM_LIVE=synthetic-only.");
  const refFile = "supabase/.temp/project-ref";
  const ref = existsSync(refFile) ? readFileSync(refFile, "utf8").trim() : "";
  if (ref !== PROD_PROJECT_REF) refuse(`linked project '${ref || "none"}' is not allowlisted.`);
  if (!CLEANUP_ONLY) {
    if (PROD_DOMAINS.includes(BASE)) {
      if (!PRODUCTION || process.env.P3P24_CONFIRM_PRODUCTION !== "synthetic-only")
        refuse("Production domain needs --production and P3P24_CONFIRM_PRODUCTION=synthetic-only.");
    } else if (!PREVIEW_RE.test(BASE ?? "")) {
      refuse("E2E_BASE_URL must be a Vercel Preview of this project (or an allowlisted domain).");
    }
  }
  DB_TARGET = "--linked";
  EXPECT_SUPABASE_HOST = `${ref}.supabase.co`;
} else {
  if (PRODUCTION) refuse("--production requires --live.");
  if (!CLEANUP_ONLY && !isLocal(BASE)) refuse("without --live, E2E_BASE_URL must be localhost.");
  DB_TARGET = "--local";
}

// ---------------------------------------------------------- synthetic ids
// Fixed, recognisable ids so cleanup never needs a pattern match.
const u = (n) => `e2400000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ACCOUNTS = [
  { id: u(1), username: "p3p24uistaff", role: "staff" },
  { id: u(2), username: "p3p24uiadmin", role: "admin" },
  { id: u(3), username: "p3p24uinorole", role: null },
];
const [STAFF, ADMIN, NOROLE] = ACCOUNTS;
const PAT = u(101);
const PATIENT_CODE = "P3P24-UI-1";
const OUT = u(201);
const IN = u(202);
const DOCS = [OUT, IN];
const ACCOUNT_IDS = ACCOUNTS.map((a) => a.id);
const list = (ids) => ids.map((i) => `'${i}'`).join(",");
const ALL_RECORD_IDS = [PAT, ...DOCS];

// ------------------------------------------------------------- sql runner
const SUPABASE_BIN = process.env.SUPABASE_BIN || "supabase";
const tmp = mkdtempSync(path.join(tmpdir(), "p3p24-ui-"));
let seq = 0;
function db(sql) {
  const file = path.join(tmp, `q${++seq}.sql`);
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    // Windows needs a shell to run the npm `supabase.cmd` shim; the command
    // is built only from constants and our own temp path, never user input.
    const opts = { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 };
    const r =
      process.platform === "win32"
        ? spawnSync(`${SUPABASE_BIN} db query ${DB_TARGET} -f "${file}" -o json`, {
            ...opts,
            shell: true,
          })
        : spawnSync(SUPABASE_BIN, ["db", "query", DB_TARGET, "-f", file, "-o", "json"], opts);
    if (r.status !== 0)
      throw new Error(
        `supabase db query failed (exit ${r.status}): ${(r.stderr || "").slice(-400)}`,
      );
    const out = r.stdout;
    return JSON.parse(out.slice(out.indexOf("{"))).rows ?? [];
  } finally {
    rmSync(file, { force: true });
  }
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", String(JSON.stringify(detail)).slice(0, 400));
  }
}

// ------------------------------------------------------- provision/cleanup
function existing() {
  return db(`select
    (select count(*) from auth.users where id in (${list(ACCOUNT_IDS)})
       or email in (${ACCOUNTS.map((a) => `'${a.username}@users.invalid'`).join(",")}))::int users,
    (select count(*) from public.user_logins where user_id in (${list(ACCOUNT_IDS)})
       or username in (${ACCOUNTS.map((a) => `'${a.username}'`).join(",")}))::int logins,
    (select count(*) from public.patients where id = '${PAT}' or patient_id = '${PATIENT_CODE}')::int patients,
    (select count(*) from public.documents where id in (${list(DOCS)}))::int documents`)[0];
}
function leftovers() {
  return db(`select
    (select count(*) from auth.users where id in (${list(ACCOUNT_IDS)}))::int users,
    (select count(*) from public.user_logins where user_id in (${list(ACCOUNT_IDS)}))::int logins,
    (select count(*) from public.user_roles where user_id in (${list(ACCOUNT_IDS)}))::int roles,
    (select count(*) from public.patients where id = '${PAT}')::int patients,
    (select count(*) from public.documents where id in (${list(DOCS)}))::int documents,
    (select count(*) from public.fax_attempts where document_id in (${list(DOCS)}))::int attempts,
    (select count(*) from public.document_files where document_id in (${list(DOCS)}))::int files,
    (select count(*) from public.audit_logs where record_id in (${list(ALL_RECORD_IDS)})
       or document_id in (${list(DOCS)}) or patient_id = '${PAT}'
       or user_id in (${list(ACCOUNT_IDS)}))::int history`)[0];
}
function cleanup() {
  // Exact ids only. Children before parents; audit rows last (the deletes
  // above them write their own audit rows, which carry the same ids).
  db(`BEGIN;
DELETE FROM public.document_files WHERE document_id IN (${list(DOCS)});
DELETE FROM public.fax_attempts WHERE document_id IN (${list(DOCS)});
DELETE FROM public.documents WHERE id IN (${list(DOCS)});
DELETE FROM public.patients WHERE id = '${PAT}';
DELETE FROM public.audit_logs WHERE record_id IN (${list(ALL_RECORD_IDS)})
  OR document_id IN (${list(DOCS)}) OR patient_id = '${PAT}' OR user_id IN (${list(ACCOUNT_IDS)});
DELETE FROM public.user_roles WHERE user_id IN (${list(ACCOUNT_IDS)});
DELETE FROM public.user_logins WHERE user_id IN (${list(ACCOUNT_IDS)});
DELETE FROM auth.sessions WHERE user_id IN (${list(ACCOUNT_IDS)});
DELETE FROM auth.identities WHERE user_id IN (${list(ACCOUNT_IDS)});
DELETE FROM auth.users WHERE id IN (${list(ACCOUNT_IDS)});
COMMIT;`);
  const left = leftovers();
  const clean = Object.values(left).every((n) => n === 0);
  check(
    "cleanup: no synthetic accounts, patient, documents, attempts, files or history remain",
    clean,
    left,
  );
  return clean;
}
function provision(password) {
  // password is [A-Za-z0-9-]; safe inside a dollar-quoted literal.
  const pw = `$pw$${password}$pw$`;
  const accounts = ACCOUNTS.map(
    (a) => `('${a.id}'::uuid,'${a.username}',${a.role ? `'${a.role}'` : "NULL"})`,
  ).join(",");
  db(`BEGIN;
DO $s$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ${accounts}) v(id,u,role) LOOP
    INSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,phone_change,phone_change_token,reauthentication_token)
    VALUES ('00000000-0000-0000-0000-000000000000',r.id,'authenticated','authenticated',r.u||'@users.invalid',extensions.crypt(${pw},extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{}',now(),now(),'','','','','','','','');
    INSERT INTO auth.identities (id,user_id,provider_id,provider,identity_data,created_at,updated_at,last_sign_in_at)
    VALUES (gen_random_uuid(),r.id,r.id::text,'email',jsonb_build_object('sub',r.id::text,'email',r.u||'@users.invalid','email_verified',true),now(),now(),now());
    INSERT INTO public.user_logins (user_id,username) VALUES (r.id,r.u);
    IF r.role IS NOT NULL THEN INSERT INTO public.user_roles (user_id,role) VALUES (r.id,r.role::public.app_role); END IF;
  END LOOP;
  -- Records are created as the synthetic staff account so 0020 attribution applies.
  PERFORM set_config('request.jwt.claims', json_build_object('sub','${STAFF.id}','role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '${STAFF.id}', true);
  INSERT INTO public.patients (id,first_name,last_name,patient_id) VALUES ('${PAT}','P3P24','Synthetic','${PATIENT_CODE}');
  INSERT INTO public.documents (id,patient_id,document_type,recipient_name,recipient_fax)
    VALUES ('${OUT}','${PAT}','Progress Note','P3P24 Synthetic MD','212-555-0124');
  INSERT INTO public.documents (id,patient_id,document_type,direction,received,received_date,received_from,received_fax)
    VALUES ('${IN}','${PAT}','Initial Evaluation','incoming',true,now(),'P3P24 Sender','212-555-0125');
END $s$;
COMMIT;`);
}

if (CLEANUP_ONLY) {
  const ok = cleanup();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

const pre = existing();
if (Object.values(pre).some((n) => n > 0)) {
  rmSync(tmp, { recursive: true, force: true });
  refuse(
    `synthetic ids/usernames already exist (${JSON.stringify(pre)}). If they are leftovers of this script, run with --cleanup-only; otherwise investigate.`,
  );
}

// ----------------------------------------------------------- page helpers
const PW = `P3p24-${randomBytes(18).toString("hex")}`;
const saved = (id) =>
  db(
    `select janeapp_uploaded v, uploaded, received, direction from public.documents where id='${id}'`,
  )[0];
const shot = (page, name, full = true) =>
  SHOT_DIR ? page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: full }) : null;

const supabaseHosts = new Set();
async function session(browser, acct, mobile) {
  const context = await browser.newContext({
    ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1400, height: 900 } }),
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();
  page.on("request", (r) => {
    const h = new URL(r.url()).hostname;
    if (h.endsWith(".supabase.co")) supabaseHosts.add(h);
  });
  const portal = acct.role === "admin" ? "admin" : "staff";
  const label = portal === "admin" ? "Admin Login" : "Staff Login";
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: label }).click();
  await page.locator(`#${portal}-username`).fill(acct.username);
  await page.locator(`#${portal}-password`).fill(PW);
  await page.getByRole("button", { name: label }).click();
  const ok = await page.waitForSelector("text=Dashboard", { timeout: 20000 }).then(
    () => true,
    () => false,
  );
  return { context, page, ok };
}
const settle = (page) =>
  page
    .getByText("Loading records…")
    .waitFor({ state: "detached", timeout: 20000 })
    .catch(() => {});
async function open(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  await settle(page);
  await page.waitForTimeout(500);
}
const alertText = async (page) => {
  const a = page.getByTestId("janeapp-alert");
  return (await a.count()) ? (await a.textContent())?.trim() : null;
};
async function waitAlert(page, expected) {
  for (let i = 0; i < 32; i++) {
    if ((await alertText(page)) === expected) return expected;
    await page.waitForTimeout(250);
  }
  return alertText(page);
}
const sectionBadge = async (page) =>
  (
    await page
      .locator('section[aria-labelledby="janeapp-heading"] [data-testid="janeapp-badge"]')
      .textContent()
  )?.trim();
async function choose(page, value, tap) {
  await page.locator('select[name="janeapp_uploaded"]').selectOption(value);
  const btn = page.getByRole("button", { name: "Save JaneApp Confirmation" });
  if (tap) await btn.tap();
  else await btn.click();
}
async function rowBadge(page, docId) {
  const row = page.locator("tr", { has: page.locator(`a[href="/documents/${docId}"]`) }).first();
  if (!(await row.count())) return null;
  return (await row.getByTestId("janeapp-badge").textContent())?.trim();
}
// The tables scroll horizontally inside .table-wrap with a sticky Actions
// column, so the JaneApp cell can start off-screen. Scroll it into view and
// confirm the badge is actually the top-most element at its centre (not
// clipped or covered by the sticky column).
async function badgeReachable(page, docId) {
  const row = page.locator("tr", { has: page.locator(`a[href="/documents/${docId}"]`) }).first();
  const badge = row.getByTestId("janeapp-badge");
  await badge.scrollIntoViewIfNeeded();
  return badge.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.width > 0 && r.height > 0 && !!hit && el.contains(hit);
  });
}
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// Dashboard: Recent Fax Activity, narrowed with the global search.
async function dashboardBadge(page, docId) {
  await open(page, "/");
  await page.getByLabel("Global search").fill("P3P24");
  await page.waitForTimeout(600);
  return rowBadge(page, docId);
}
// Reports: patient-filtered list for the default range.
async function reportsBadge(page, docId) {
  await open(page, "/reports");
  await page.getByLabel("Patient").selectOption(PAT);
  await page.waitForTimeout(400);
  return rowBadge(page, docId);
}

// ----------------------------------------------------------------- run
const NC = "JaneApp upload not confirmed";
const NO = "Not uploaded to JaneApp";
const YES = "Uploaded to JaneApp";

let browser;
try {
  provision(PW);
  const START = db("select now()::text t")[0].t;
  browser = await chromium.launch();

  // ===================== Staff, desktop, outgoing =====================
  const s = await session(browser, STAFF, false);
  check("staff: login", s.ok);
  const p = s.page;
  await open(p, `/documents/${OUT}`);
  check("staff/outgoing: unanswered shows alert", (await alertText(p)) === NC, await alertText(p));
  check("staff/outgoing: saved status badge Unconfirmed", (await sectionBadge(p)) === NC);
  check(
    "staff/outgoing: control offers Yes/No/Unconfirmed",
    JSON.stringify(await p.locator('select[name="janeapp_uploaded"] option').allTextContents()) ===
      '["Yes","No","Unconfirmed"]',
  );
  check("staff/outgoing: no horizontal overflow (desktop)", await noOverflow(p));
  await shot(p, "staff-unconfirmed");
  await open(p, `/patients/${PAT}`);
  check("staff: patient document history row shows Unconfirmed", (await rowBadge(p, OUT)) === NC);
  await open(p, "/fax-tracker");
  check("staff: Fax Tracker row shows Unconfirmed", (await rowBadge(p, OUT)) === NC);
  check("staff: Dashboard row shows Unconfirmed", (await dashboardBadge(p, OUT)) === NC);
  check("staff: Reports row shows Unconfirmed", (await reportsBadge(p, OUT)) === NC);

  // No
  await open(p, `/documents/${OUT}`);
  await choose(p, "No");
  check("staff: No saved -> 'Not uploaded to JaneApp' alert", (await waitAlert(p, NO)) === NO);
  check("staff: No persisted in DB", saved(OUT).v === false);
  await open(p, `/documents/${OUT}`);
  check(
    "staff: No retained after reload (alert + badge)",
    (await alertText(p)) === NO && (await sectionBadge(p)) === NO,
  );
  await open(p, `/patients/${PAT}`);
  check("staff: patient list row shows Not uploaded", (await rowBadge(p, OUT)) === NO);
  const dashNo = await dashboardBadge(p, OUT);
  const repNo = await reportsBadge(p, OUT);
  check("staff: Dashboard and Reports rows show Not uploaded", dashNo === NO && repNo === NO, {
    dashNo,
    repNo,
  });

  // Yes
  await open(p, `/documents/${OUT}`);
  await choose(p, "Yes");
  check("staff: Yes saved -> alert removed", (await waitAlert(p, null)) === null);
  check("staff: Yes persisted in DB", saved(OUT).v === true);
  await open(p, `/documents/${OUT}`);
  check(
    "staff: Yes retained after reload (no alert, badge Yes)",
    (await alertText(p)) === null && (await sectionBadge(p)) === YES,
  );
  await shot(p, "staff-yes");
  await open(p, `/patients/${PAT}`);
  const patRow = await rowBadge(p, OUT);
  await open(p, "/fax-tracker");
  const ftRow = await rowBadge(p, OUT);
  check(
    "staff: Fax Tracker JaneApp badge visible after table scroll",
    await badgeReachable(p, OUT),
  );
  const dashRow = await dashboardBadge(p, OUT);
  check("staff: Dashboard JaneApp badge visible after table scroll", await badgeReachable(p, OUT));
  await shot(p, "staff-dashboard-yes");
  const repRow = await reportsBadge(p, OUT);
  check("staff: Reports JaneApp badge visible after table scroll", await badgeReachable(p, OUT));
  await shot(p, "staff-reports-yes");
  check(
    "staff: patient list, Fax Tracker, Dashboard and Reports agree on Yes",
    [patRow, ftRow, dashRow, repRow].every((v) => v === YES),
    { patRow, ftRow, dashRow, repRow },
  );
  check(
    "staff: Reports also lists the incoming row as Unconfirmed",
    (await rowBadge(p, IN)) === NC,
  );

  // Unrelated edit: Uploaded to patient system = Yes (separate field)
  await open(p, `/documents/${OUT}`);
  await p.getByRole("button", { name: "Update Upload" }).click();
  await p.locator('[role="dialog"] select[name="uploaded"]').selectOption("Yes");
  await p.getByRole("button", { name: "Save Upload Status" }).click();
  await p
    .getByText("Document marked uploaded.")
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  await open(p, `/documents/${OUT}`);
  const afterUpload = saved(OUT);
  check(
    "staff: unrelated Uploaded-to-patient-system edit keeps JaneApp Yes",
    afterUpload.v === true && afterUpload.uploaded === true && (await alertText(p)) === null,
    afterUpload,
  );
  // Mark Received (fax delivery/receipt) is independent too
  await p.getByRole("button", { name: "Mark Received" }).first().click();
  const dlg = p.locator('[role="dialog"]').last();
  await dlg
    .locator('select[name="received"]')
    .selectOption("No")
    .catch(() => {});
  await dlg.locator("button:not([type=button])").last().click();
  await p.waitForTimeout(2500);
  check("staff: Mark Received save keeps JaneApp Yes", saved(OUT).v === true);

  // Failed save keeps previous status and shows an error
  await open(p, `/documents/${OUT}`);
  await p.route("**/rest/v1/documents**", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"message":"synthetic failure"}',
        })
      : route.continue(),
  );
  await choose(p, "No");
  const err = await p
    .getByText("JaneApp confirmation was not saved")
    .first()
    .waitFor({ timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  check("staff: failed save shows an error", err);
  check(
    "staff: failed save keeps no alert / badge Yes",
    (await alertText(p)) === null && (await sectionBadge(p)) === YES,
  );
  check("staff: failed save left DB at Yes", saved(OUT).v === true);
  await p.unroute("**/rest/v1/documents**");
  await open(p, `/documents/${OUT}`);
  check("staff: after failed save + reload still Yes", (await sectionBadge(p)) === YES);

  // Yes -> No -> clear
  await choose(p, "No");
  check("staff: Yes -> No restores alert", (await waitAlert(p, NO)) === NO);
  await choose(p, "Unconfirmed");
  check(
    "staff: clear -> Unconfirmed restores 'not confirmed' alert",
    (await waitAlert(p, NC)) === NC,
  );
  check("staff: clear stored NULL", saved(OUT).v === null);
  await open(p, `/documents/${OUT}`);
  check("staff: Unconfirmed retained after reload", (await alertText(p)) === NC);

  // View History
  await p.getByRole("button", { name: "View History" }).first().click();
  const dialog = p.locator('[role="dialog"]').last();
  await dialog
    .getByText("Uploaded to JaneApp?")
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  const h = (await dialog.textContent()) ?? "";
  check(
    "staff: View History shows readable label, values and actor",
    h.includes("Uploaded to JaneApp?") &&
      h.includes(STAFF.username) &&
      h.includes("Unconfirmed") &&
      !h.includes("janeapp_uploaded"),
    h.slice(0, 500),
  );
  await shot(p, "staff-history", false);
  await s.context.close();

  // ===================== Admin, phone, incoming =====================
  const a = await session(browser, ADMIN, true);
  check("admin: login (phone)", a.ok);
  const m = a.page;
  await open(m, `/documents/${IN}`);
  check("admin/incoming: unanswered shows alert", (await alertText(m)) === NC);
  check("admin/incoming: no horizontal overflow (phone)", await noOverflow(m));
  await choose(m, "Yes", true);
  check("admin/incoming: Yes removes alert", (await waitAlert(m, null)) === null);
  const inRow = saved(IN);
  check(
    "admin/incoming: Yes saved; stays incoming, received, uploaded=false",
    inRow.v === true &&
      inRow.direction === "incoming" &&
      inRow.received === true &&
      inRow.uploaded === false,
    inRow,
  );
  await shot(m, "admin-phone-yes");
  await m.getByRole("button", { name: "Edit" }).first().tap();
  const ed = m.locator('[role="dialog"]').last();
  await ed.locator('textarea[name="notes"]').fill("P3P24 synthetic unrelated edit");
  await ed.locator("button:not([type=button])").last().tap();
  await m.waitForTimeout(2500);
  const afterNotes = db(
    `select janeapp_uploaded v, notes from public.documents where id='${IN}'`,
  )[0];
  check(
    "admin/incoming: unrelated notes edit keeps Yes",
    afterNotes.v === true && afterNotes.notes === "P3P24 synthetic unrelated edit",
    afterNotes,
  );
  await open(m, `/documents/${IN}`);
  check(
    "admin/incoming: reload keeps Yes, no alert",
    (await alertText(m)) === null && (await sectionBadge(m)) === YES,
  );
  await choose(m, "No", true);
  check("admin/incoming: No shows alert", (await waitAlert(m, NO)) === NO);
  await open(m, `/patients/${PAT}`);
  check(
    "admin: patient history rows show incoming No / outgoing Unconfirmed",
    (await rowBadge(m, IN)) === NO && (await rowBadge(m, OUT)) === NC,
  );
  check("admin: patient page no horizontal overflow (phone)", await noOverflow(m));
  const mDashIn = await dashboardBadge(m, IN);
  const mDashOut = await rowBadge(m, OUT);
  check(
    "admin: Dashboard (phone) shows incoming No / outgoing Unconfirmed",
    mDashIn === NO && mDashOut === NC,
    {
      mDashIn,
      mDashOut,
    },
  );
  const mRepIn = await reportsBadge(m, IN);
  const mRepOut = await rowBadge(m, OUT);
  check(
    "admin: Reports (phone) shows incoming No / outgoing Unconfirmed",
    mRepIn === NO && mRepOut === NC,
    {
      mRepIn,
      mRepOut,
    },
  );
  check(
    "admin: Reports JaneApp badge visible after table scroll (phone)",
    await badgeReachable(m, IN),
  );
  check("admin: Reports page no horizontal overflow (phone)", await noOverflow(m));
  await shot(m, "admin-phone-reports");
  await a.context.close();

  // ===================== Role-less =====================
  const n = await session(browser, NOROLE, false);
  check("role-less: login denied (no Dashboard)", !n.ok);
  await n.context.close();

  if (EXPECT_SUPABASE_HOST) {
    check(
      "target: browser used only the linked Supabase project",
      supabaseHosts.size > 0 && [...supabaseHosts].every((h) => h === EXPECT_SUPABASE_HOST),
      [...supabaseHosts],
    );
  }
  const logs = db(`select actor_username a from public.audit_logs
    where document_id in (${list(DOCS)}) and changes ? 'janeapp_uploaded' and created_at >= '${START}'
    order by created_at`);
  check(
    "history: 6 JaneApp changes with correct actors",
    logs.length === 6 &&
      logs.slice(0, 4).every((l) => l.a === STAFF.username) &&
      logs.slice(4).every((l) => l.a === ADMIN.username),
    logs,
  );
} catch (e) {
  failures++;
  console.log(`FAIL - unexpected error: ${e?.message ?? e}`);
} finally {
  if (browser) await browser.close();
  try {
    if (!cleanup()) failures++;
  } catch (e) {
    failures++;
    console.log(`FAIL - cleanup error: ${e?.message ?? e}; rerun with --cleanup-only`);
  }
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

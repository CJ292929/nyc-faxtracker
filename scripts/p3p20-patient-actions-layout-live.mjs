#!/usr/bin/env node
// Live browser verification of P3-P20 (patient-detail action row on narrow
// screens) against a real deployment, using only synthetic accounts and a
// synthetic patient with deliberately long, unbroken name / ID / field
// values, all removed again at the end.
//
// Per role (staff, admin) and per viewport (320, 375, 390, 768, 1400):
// the page never scrolls horizontally (document scrollWidth <= viewport);
// no element outside the horizontally scrolling document table extends past
// the viewport edge; every action button (Edit Patient, Delete Patient
// Permanently, Add Document / Fax) is present, fully on screen, and at least
// 36px tall; each opens its dialog with a real click/tap, the dialog fits the
// viewport, its Cancel button can be reached and closes it, and nothing is
// written (the patient is unchanged and still exists).
// Also: no console errors or failed requests.
//
// Requires in .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_PUBLISHABLE_KEY.
// Run with: E2E_BASE_URL=https://<deployment> node scripts/p3p20-patient-actions-layout-live.mjs [shot-dir]
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

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
const tag = `p3p20${String(stamp).slice(-7)}`;
const WIDTHS = [320, 375, 390, 768, 1400];
const ACTIONS = ["Edit Patient", "Delete Patient Permanently", "Add Document / Fax"];

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", String(JSON.stringify(detail)).slice(0, 900));
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
  await admin.from("user_roles").insert({ user_id: data.user.id, role });
  const acct = { id: data.user.id, username, password, email, role };
  accounts.push(acct);
  return acct;
}

const problems = [];
async function session(browser, acct, width) {
  const mobile = width < 1024;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 760 : 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();
  const who = `${acct.role}@${width}`;
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${who} console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${who} pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(f))
      problems.push(`${who} requestfailed: ${r.url()} ${f}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${who} HTTP ${r.status()}: ${r.url()}`);
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

// Horizontal overflow of the page itself, plus any element in <main> that
// extends past either viewport edge. The document table is a deliberate
// horizontal scroller (.table-wrap overflow-x:auto), so its contents are
// excluded; the scroller box itself is still checked.
const measure = (page, width) =>
  page.evaluate((vw) => {
    const off = [];
    for (const el of document.querySelectorAll("main *")) {
      if (el.parentElement?.closest(".table-wrap")) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5))
        off.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} [${Math.round(r.left)},${Math.round(r.right)}] ${(el.textContent ?? "").trim().slice(0, 30)}`,
        );
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      offenders: off.slice(0, 10),
      offenderCount: off.length,
    };
  }, width);

async function actionDialog(page, btn, name, L, width) {
  await btn.click(); // real click / tap at its coordinates
  const dlg = page.locator('[role="dialog"]').last();
  await dlg.waitFor({ timeout: 10000 });
  const db = await dlg.boundingBox();
  const vh = page.viewportSize()?.height ?? 0;
  check(
    `${L}: "${name}" dialog fits the viewport`,
    !!db &&
      db.x >= 0 &&
      db.x + db.width <= width + 0.5 &&
      db.y >= 0 &&
      db.y + db.height <= vh + 0.5,
    db,
  );
  const dm = await measure(page, width);
  check(`${L}: "${name}" dialog causes no horizontal scroll`, dm.scrollWidth <= width, dm);
  const cancel = dlg.getByRole("button", { name: "Cancel", exact: true });
  await cancel.scrollIntoViewIfNeeded();
  const cb = await cancel.boundingBox();
  check(
    `${L}: "${name}" dialog Cancel reachable on screen`,
    !!cb &&
      cb.x >= 0 &&
      cb.x + cb.width <= width + 0.5 &&
      cb.y >= 0 &&
      cb.y + cb.height <= vh + 0.5,
    cb,
  );
  if (name === "Add Document / Fax") {
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}-add-dialog.png`) });
  }
  await cancel.click();
  await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 10000 });
}

async function pass(browser, acct, pat, width) {
  const L = `${acct.role}@${width}`;
  const { context, page } = await session(browser, acct, width);
  try {
    await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 20000 });
    await page.screenshot({ path: path.join(SHOT_DIR, `${tag}-${L}.png`), fullPage: true });
    const m = await measure(page, width);
    check(
      `${L}: no horizontal page scroll (scrollWidth ${m.scrollWidth} <= ${width})`,
      m.scrollWidth <= width && m.bodyScroll <= width,
      m,
    );
    check(`${L}: nothing outside the table extends past the viewport`, m.offenderCount === 0, m);
    const h1 = await page.getByRole("heading", { level: 1 }).first().innerText();
    check(`${L}: full long patient name shown`, h1.includes(pat.last_name), h1);
    const idText = await page.getByText(`Patient ID: ${pat.patient_id}`).count();
    check(`${L}: full long patient ID shown`, idText === 1);

    for (const name of ACTIONS) {
      const btn = page.getByRole("button", { name, exact: true });
      const n = await btn.count();
      check(`${L}: "${name}" present once`, n === 1, n);
      if (n !== 1) continue;
      const box = await btn.boundingBox();
      check(
        `${L}: "${name}" fully on screen and >=36px tall`,
        !!box && box.x >= 0 && box.x + box.width <= width + 0.5 && box.height >= 36,
        box,
      );
      // Label is not truncated or clipped: the button's content fits.
      const fits = await btn.evaluate((b) => b.scrollWidth <= b.clientWidth + 1);
      check(`${L}: "${name}" label not clipped`, fits);
      try {
        await actionDialog(page, btn, name, L, width);
      } catch (e) {
        check(`${L}: "${name}" opens and cancels its dialog`, false, e.message.split("\n")[0]);
        await page.goto(`${BASE_URL}/patients/${pat.id}`, { waitUntil: "networkidle" });
      }
    }
    const { data: still } = await admin.from("patients").select("*").eq("id", pat.id).single();
    check(
      `${L}: patient unchanged after opening/cancelling every action`,
      !!still && still.last_name === pat.last_name && still.patient_id === pat.patient_id,
    );
  } finally {
    await context.close();
  }
}

async function cleanup() {
  for (const pid of patientIds) {
    const { data: docs } = await admin.from("documents").select("id").eq("patient_id", pid);
    for (const d of docs ?? []) await admin.from("fax_attempts").delete().eq("document_id", d.id);
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
  const long = "Supercalifragilisticexpialidocious";
  const { data: pat, error } = await admin
    .from("patients")
    .insert({
      first_name: `Synthetic${long}`,
      last_name: `P3P20${long}${long}${stamp}`,
      patient_id: `P3P20-${stamp}-${long}-${long}`,
      insurance: `Synthetic Insurance ${long}${long}`,
      referring_physician: `Dr ${long}${long}`,
    })
    .select()
    .single();
  if (error || !pat) throw new Error(`patient: ${error?.message}`);
  patientIds.push(pat.id);
  await admin.from("documents").insert({
    patient_id: pat.id,
    document_type: `Synthetic Type ${long}`,
    recipient_name: `Synthetic Recipient ${long}`,
  });
  for (const acct of [staff, adm]) for (const w of WIDTHS) await pass(browser, acct, pat, w);
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
console.log("\nall P3-P20 patient action layout checks passed (synthetic data removed)");

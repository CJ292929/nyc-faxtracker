#!/usr/bin/env node
// Database verification of P3-P19 (0021_document_type_other.sql): the
// "Other" Document Type write boundary.
//
// Runs inside ONE Postgres transaction on synthetic uuids that is always
// rolled back -- nothing is committed and no real patient/document/account
// is read or changed (same discipline as scripts/p3p18-attribution-live.mjs).
// Writes are executed as the real `authenticated` / `anon` roles with
// request.jwt.claims set, exactly how PostgREST runs direct REST calls, so
// RLS, the 0020 attribution/audit triggers and the 0021 validation trigger
// all apply.
//
// Connection: P3P19_DB_URL if set (e.g. a disposable local Postgres with
// migrations 0000-0021 applied), otherwise SUPABASE_DB_MIGRATION_URL from
// .env (only after 0021 has been applied there). Optional
// SUPABASE_DB_MIGRATION_ROLE is assumed like the P3-P18 script.
// Run with: node scripts/p3p19-document-type-live.mjs
import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

const fileEnv = existsSync(".env")
  ? Object.fromEntries(
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
              .replace(/^"(.*)"$/, "$1"),
          ];
        }),
    )
  : {};
const url = process.env.P3P19_DB_URL || fileEnv.SUPABASE_DB_MIGRATION_URL;
const assumeRole = process.env.P3P19_DB_URL ? undefined : fileEnv.SUPABASE_DB_MIGRATION_ROLE;
if (!url) {
  console.error("Set P3P19_DB_URL or SUPABASE_DB_MIGRATION_URL in .env");
  process.exit(2);
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

const ROLLBACK = new Error("rollback");
const id = (n) => `d1900000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const STAFF = id(1);
const ADMIN = id(2);
const NOROLE = id(3);

async function run(sql, owner) {
  await sql
    .begin(async (tx) => {
      let sp = 0;
      async function as(uid, fn) {
        const name = `sp_${sp++}`;
        await tx.unsafe(`savepoint ${name}`);
        try {
          await tx.unsafe(uid ? "set local role authenticated" : "set local role anon");
          await tx`select set_config('request.jwt.claims', ${uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : ""}, true)`;
          // Older auth.uid() builds (e.g. the local supabase/postgres image) read this instead.
          await tx`select set_config('request.jwt.claim.sub', ${uid ?? ""}, true)`;
          const rows = await fn();
          await tx.unsafe(`set local role "${owner}"`);
          await tx.unsafe(`release savepoint ${name}`);
          return rows;
        } catch (e) {
          await tx.unsafe(`rollback to savepoint ${name}`);
          throw e;
        }
      }
      async function rejected(uid, fn, pattern) {
        try {
          await as(uid, fn);
          return { ok: false, message: "accepted" };
        } catch (e) {
          return { ok: pattern ? pattern.test(e.message) : true, message: e.message };
        }
      }

      const [{ installed }] = await tx`select count(*)::int installed from pg_trigger
        where tgrelid = 'public.documents'::regclass and tgname = 'validate_document_type' and not tgisinternal`;
      check("validate_document_type trigger installed on public.documents", installed === 1);

      for (const [uid, username, role] of [
        [STAFF, "p3p19_staff", "staff"],
        [ADMIN, "p3p19_admin", "admin"],
        [NOROLE, "p3p19_norole", null],
      ]) {
        await tx`insert into auth.users (id) values (${uid})`;
        await tx`insert into public.user_logins (user_id, username) values (${uid}, ${username})`;
        if (role) await tx`insert into public.user_roles (user_id, role) values (${uid}, ${role})`;
      }
      const [p] = await as(
        STAFF,
        () =>
          tx`insert into public.patients (first_name, last_name, patient_id) values ('P3P19', 'Synthetic', 'P3P19-TEST') returning id`,
      );

      for (const [label, uid] of [
        ["staff", STAFF],
        ["admin", ADMIN],
      ]) {
        // Create Other with custom text (untrimmed, as a direct REST call might).
        const [d] = await as(
          uid,
          () =>
            tx`insert into public.documents (patient_id, document_type) values (${p.id}, ${"  Plan of Care \t"}) returning *`,
        );
        check(
          `${label}: custom type saved trimmed`,
          d.document_type === "Plan of Care",
          d.document_type,
        );
        let ev =
          await tx`select action, changes from public.audit_logs where document_id = ${d.id} order by created_at, id`;
        check(
          `${label}: one insert audit event with custom text`,
          ev.length === 1 && JSON.stringify(ev[0].changes ?? {}).includes("Plan of Care"),
          ev,
        );

        // Edit custom text.
        await as(
          uid,
          () =>
            tx`update public.documents set document_type = 'Home Exercise Program' where id = ${d.id}`,
        );
        ev =
          await tx`select changes from public.audit_logs where document_id = ${d.id} and action = 'documents_update' order by created_at, id`;
        check(
          `${label}: custom edit audited with readable from/to`,
          ev.length === 1 &&
            ev[0].changes?.document_type?.from === "Plan of Care" &&
            ev[0].changes?.document_type?.to === "Home Exercise Program",
          ev,
        );

        // Other -> predefined -> Other.
        await as(
          uid,
          () => tx`update public.documents set document_type = 'Progress Note' where id = ${d.id}`,
        );
        let [row] = await tx`select document_type from public.documents where id = ${d.id}`;
        check(
          `${label}: switch to predefined stores only predefined`,
          row.document_type === "Progress Note",
          row,
        );
        await as(
          uid,
          () => tx`update public.documents set document_type = 'Plan of Care' where id = ${d.id}`,
        );
        [row] = await tx`select document_type from public.documents where id = ${d.id}`;
        check(`${label}: switch back to Other text`, row.document_type === "Plan of Care", row);
        ev =
          await tx`select count(*)::int n from public.audit_logs where document_id = ${d.id} and action = 'documents_update'`;
        check(`${label}: exactly one audit event per change (3 updates)`, ev[0].n === 3, ev);

        // Unchanged re-save (Edit of another field) is not re-validated and not double-audited.
        await as(
          uid,
          () =>
            tx`update public.documents set document_type = 'Plan of Care', notes = 'synthetic' where id = ${d.id}`,
        );
        ev =
          await tx`select changes from public.audit_logs where document_id = ${d.id} and action = 'documents_update' order by created_at desc, id desc limit 1`;
        check(
          `${label}: unchanged type not in diff`,
          ev[0] && !("document_type" in ev[0].changes),
          ev,
        );

        // Rejections through the direct write path.
        for (const [what, value, pattern] of [
          ["empty", "", /required/],
          ["whitespace-only", "   \t ", /required/],
          ["nbsp-only", "  ", /required/],
          ["literal Other", "Other", /instead of "Other"/],
          ["literal other (case/space)", "  oTHer ", /instead of "Other"/],
          ["101 chars", "x".repeat(101), /100 characters/],
        ]) {
          const ins = await rejected(
            uid,
            () =>
              tx`insert into public.documents (patient_id, document_type) values (${p.id}, ${value})`,
            pattern,
          );
          check(`${label}: insert rejects ${what}`, ins.ok, ins.message);
          const upd = await rejected(
            uid,
            () => tx`update public.documents set document_type = ${value} where id = ${d.id}`,
            pattern,
          );
          check(`${label}: update rejects ${what}`, upd.ok, upd.message);
        }
        const ok100 = await as(
          uid,
          () =>
            tx`insert into public.documents (patient_id, document_type) values (${p.id}, ${"y".repeat(100)}) returning document_type`,
        );
        check(`${label}: 100 chars accepted`, ok100[0].document_type.length === 100);

        // Every predefined type still creates.
        for (const t of [
          "Initial Evaluation",
          "Progress Note",
          "Re-evaluation",
          "Re-certification Progress Note",
          "Discharge Note",
          "Authorization Packet",
          "Medical Necessity Packet",
          "Appeal Packet",
        ]) {
          const [r] = await as(
            uid,
            () =>
              tx`insert into public.documents (patient_id, document_type) values (${p.id}, ${t}) returning document_type`,
          );
          if (r.document_type !== t) check(`${label}: predefined ${t}`, false, r);
        }
        check(`${label}: all 8 predefined types create unchanged`, true);
      }

      // Legacy rows keep their meaning: an existing nonstandard value (inserted
      // here bypassing the trigger, as pre-0021 data could be) is not rewritten,
      // and its other fields stay editable.
      // Needs table ownership to disable the trigger; skipped (not failed) otherwise.
      await tx.unsafe("savepoint legacy");
      let legacy;
      try {
        await tx.unsafe("alter table public.documents disable trigger validate_document_type");
        [legacy] =
          await tx`insert into public.documents (patient_id, document_type) values (${p.id}, ${" Other "}) returning id`;
        await tx.unsafe("alter table public.documents enable trigger validate_document_type");
        await tx.unsafe("release savepoint legacy");
      } catch (e) {
        await tx.unsafe("rollback to savepoint legacy");
        console.log(`skip - legacy-row check (cannot disable trigger as ${owner}: ${e.message})`);
      }
      if (legacy) {
        await as(
          STAFF,
          () =>
            tx`update public.documents set document_type = ' Other ', notes = 'legacy edit' where id = ${legacy.id}`,
        );
        const [lr] =
          await tx`select document_type, notes from public.documents where id = ${legacy.id}`;
        check(
          "legacy nonstandard value preserved on unrelated edit",
          lr.document_type === " Other " && lr.notes === "legacy edit",
          lr,
        );
      }

      // Anonymous and role-less callers remain denied.
      const anon = await rejected(
        null,
        () =>
          tx`insert into public.documents (patient_id, document_type) values (${p.id}, 'Plan of Care')`,
      );
      check("anon cannot insert", anon.ok, anon.message);
      const noRoleIns = await rejected(
        NOROLE,
        () =>
          tx`insert into public.documents (patient_id, document_type) values (${p.id}, 'Plan of Care')`,
      );
      check("role-less cannot insert", noRoleIns.ok, noRoleIns.message);
      const noRoleUpd = await as(
        NOROLE,
        () =>
          tx`update public.documents set document_type = 'Hijack' where patient_id = ${p.id} returning id`,
      );
      check("role-less update affects no rows", noRoleUpd.length === 0, noRoleUpd.length);
      let anonReadDenied;
      try {
        anonReadDenied =
          (await as(null, () => tx`select id from public.documents where patient_id = ${p.id}`))
            .length === 0;
      } catch {
        anonReadDenied = true;
      }
      check("anon reads no documents", anonReadDenied);

      // Client cannot supply the actor.
      const [forged] = await as(
        STAFF,
        () =>
          tx`insert into public.documents (patient_id, document_type, created_by) values (${p.id}, 'Forged Actor Type', ${ADMIN}) returning id, created_by`,
      );
      check("client-supplied actor ignored", forged.created_by === STAFF, forged);

      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  if (assumeRole) await sql.unsafe(`set role "${assumeRole.replaceAll('"', "")}"`);
  const [{ current_database, owner }] = await sql`select current_database(), current_user as owner`;
  console.log(`connected: db=${current_database} as ${owner} (all writes rolled back)`);
  await run(sql, owner);
} finally {
  await sql.end();
}
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall P3-P19 database checks passed (transaction rolled back)");

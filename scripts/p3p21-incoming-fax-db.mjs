#!/usr/bin/env node
// Database verification of P3-P21 (0022_incoming_received_fax.sql): incoming
// / received fax recorded without a prior outbound fax.
//
// Runs inside ONE Postgres transaction on synthetic uuids that is always
// rolled back -- nothing is committed and no real patient/document/account
// is read or changed (same discipline as p3p19-document-type-live.mjs).
// Writes run as the real `authenticated` / `anon` roles with
// request.jwt.claims set, exactly how PostgREST runs direct REST calls, so
// RLS, the 0020 attribution/audit triggers, 0021 and the 0022 triggers all
// apply.
//
// Connection: P3P21_DB_URL if set, otherwise SUPABASE_DB_MIGRATION_URL from
// .env. P3P21_DB_ROLE / SUPABASE_DB_MIGRATION_ROLE is assumed if set (e.g.
// "postgres" when connecting as a Supabase CLI login role).
// Run with: node scripts/p3p21-incoming-fax-db.mjs
import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

const fileEnv = existsSync(".env")
  ? Object.fromEntries(
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
              .replace(/^"(.*)"$/, "$1"),
          ];
        }),
    )
  : {};
const url = process.env.P3P21_DB_URL || fileEnv.SUPABASE_DB_MIGRATION_URL;
const assumeRole = process.env.P3P21_DB_ROLE || fileEnv.SUPABASE_DB_MIGRATION_ROLE;
if (!url) {
  console.error("Set P3P21_DB_URL or SUPABASE_DB_MIGRATION_URL in .env");
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
const id = (n) => `d2100000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const STAFF = id(1);
const ADMIN = id(2);
const NOROLE = id(3);

async function run(sql, owner) {
  await sql
    .begin(async (tx) => {
      // Pre-apply dry run: P3P21_DRY_RUN_MIGRATION=1 executes 0022 inside this
      // same transaction first, so the migration and its behaviour can be
      // checked on a database where it is not applied yet -- and then rolled
      // back with everything else.
      if (process.env.P3P21_DRY_RUN_MIGRATION === "1") {
        await tx.unsafe("set local lock_timeout = '5s'");
        await tx.unsafe(
          readFileSync(
            new URL("../drizzle/migrations/0022_incoming_received_fax.sql", import.meta.url),
            "utf8",
          ),
        );
        console.log("(dry run: 0022 applied inside the rolled-back transaction)");
      }
      let sp = 0;
      async function as(uid, fn) {
        const name = `sp_${sp++}`;
        await tx.unsafe(`savepoint ${name}`);
        try {
          await tx.unsafe(uid ? "set local role authenticated" : "set local role anon");
          await tx`select set_config('request.jwt.claims', ${uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : ""}, true)`;
          await tx`select set_config('request.jwt.claim.sub', ${uid ?? ""}, true)`;
          const rows = await fn();
          await tx.unsafe(`set local role "${owner}"`);
          await tx.unsafe(`release savepoint ${name}`);
          return rows;
        } catch (e) {
          await tx.unsafe(`rollback to savepoint ${name}`);
          await tx.unsafe(`set local role "${owner}"`);
          throw e;
        }
      }
      async function rejected(uid, fn, pattern) {
        try {
          const rows = await as(uid, fn);
          // RLS-filtered UPDATE/SELECT returns no rows rather than throwing.
          if (Array.isArray(rows) && rows.length === 0 && !pattern)
            return { ok: true, message: "0 rows" };
          return { ok: false, message: "accepted" };
        } catch (e) {
          return { ok: pattern ? pattern.test(e.message) : true, message: e.message };
        }
      }

      const triggers = await tx`select tgrelid::regclass::text rel, tgname from pg_trigger
        where tgname in ('validate_document_direction','reject_attempt_on_incoming_document') and not tgisinternal order by 2`;
      check(
        "0022 triggers installed",
        triggers.length === 2 &&
          triggers[0].rel === "fax_attempts" &&
          triggers[1].rel === "documents",
        triggers,
      );
      const [col] = await tx`select column_default, is_nullable from information_schema.columns
        where table_schema='public' and table_name='documents' and column_name='direction'`;
      check(
        "documents.direction NOT NULL default 'outgoing'",
        col?.is_nullable === "NO" && /'outgoing'/.test(col?.column_default ?? ""),
        col,
      );
      const [legacy] =
        await tx`select count(*)::int n from public.documents where direction <> 'outgoing'`;
      check("every pre-existing document is outgoing", legacy.n === 0, legacy);
      const grants =
        await tx`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') auth_exec,
        has_function_privilege('anon', p.oid, 'execute') anon_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('validate_document_direction','reject_attempt_on_incoming_document')`;
      check(
        "0022 trigger functions not executable by anon/authenticated",
        grants.length === 2 && grants.every((g) => !g.auth_exec && !g.anon_exec),
        grants,
      );

      for (const [uid, username, role] of [
        [STAFF, "p3p21_staff", "staff"],
        [ADMIN, "p3p21_admin", "admin"],
        [NOROLE, "p3p21_norole", null],
      ]) {
        await tx`insert into auth.users (id) values (${uid})`;
        await tx`insert into public.user_logins (user_id, username) values (${uid}, ${username})`;
        if (role) await tx`insert into public.user_roles (user_id, role) values (${uid}, ${role})`;
      }
      const [p] = await as(
        STAFF,
        () =>
          tx`insert into public.patients (first_name, last_name, patient_id) values ('P3P21', 'Synthetic', 'P3P21-TEST') returning id`,
      );

      const incomingRow = (over = {}) => ({
        patient_id: p.id,
        direction: "incoming",
        document_type: "Referral",
        received: true,
        received_date: "2026-11-13T14:30:00Z",
        received_from: "  Outside Ortho Group \t",
        received_fax: " 212-555-0199 ",
        status: "Received",
        ...over,
      });

      for (const [label, uid, username] of [
        ["staff", STAFF, "p3p21_staff"],
        ["admin", ADMIN, "p3p21_admin"],
      ]) {
        const [d] = await as(
          uid,
          () => tx`insert into public.documents ${tx(incomingRow())} returning *`,
        );
        check(
          `${label}: incoming saved with trimmed sender + fax`,
          d.direction === "incoming" &&
            d.received === true &&
            d.received_from === "Outside Ortho Group" &&
            d.received_fax === "212-555-0199",
          d,
        );
        check(
          `${label}: no outbound recipient, status Received`,
          d.recipient_type === null &&
            d.recipient_name === null &&
            d.recipient_fax === null &&
            d.status === "Received",
          d,
        );
        check(
          `${label}: attributed to the authenticated user`,
          d.created_by === uid && d.created_by_name === username && d.created_by_kind === "user",
          d,
        );
        const [{ n: attempts }] =
          await tx`select count(*)::int n from public.fax_attempts where document_id = ${d.id}`;
        check(`${label}: zero fax attempts`, attempts === 0, attempts);
        let ev =
          await tx`select action, description, changes, actor_username from public.audit_logs where document_id = ${d.id} order by created_at, id`;
        check(
          `${label}: one creation event "Incoming fax recorded" with direction/sender/received time`,
          ev.length === 1 &&
            ev[0].action === "documents_insert" &&
            ev[0].description === "Incoming fax recorded" &&
            ev[0].actor_username === username &&
            ev[0].changes?.direction?.to === "incoming" &&
            ev[0].changes?.received_from?.to === "Outside Ortho Group" &&
            ev[0].changes?.received_fax?.to === "212-555-0199" &&
            !!ev[0].changes?.received_date?.to,
          ev,
        );

        // Fax attempts are outbound-only.
        let r = await rejected(
          uid,
          () =>
            tx`insert into public.fax_attempts (document_id, attempt_number, status) values (${d.id}, 1, 'Sent Successfully')`,
          /only for outgoing faxes/,
        );
        check(`${label}: fax attempt on incoming rejected`, r.ok, r.message);

        // Edit (sender + notes) is audited with from/to by the editor.
        const other = uid === STAFF ? ADMIN : STAFF;
        await as(
          other,
          () =>
            tx`update public.documents set received_from = 'Outside Ortho Group LLC', notes = 'synthetic' where id = ${d.id}`,
        );
        const [edited] = await tx`select * from public.documents where id = ${d.id}`;
        check(
          `${label}: edit keeps creator, records last editor`,
          edited.created_by === uid && edited.updated_by === other,
          edited,
        );
        ev =
          await tx`select action, changes from public.audit_logs where document_id = ${d.id} and action <> 'documents_insert' order by created_at, id`;
        check(
          `${label}: edit audited once with sender from/to`,
          ev.length === 1 &&
            ev[0].changes?.received_from?.from === "Outside Ortho Group" &&
            ev[0].changes?.received_from?.to === "Outside Ortho Group LLC",
          ev,
        );

        // Upload status + attachment record work like any document.
        await as(
          uid,
          () =>
            tx`update public.documents set uploaded = true, uploaded_date = now() where id = ${d.id}`,
        );
        await as(
          uid,
          () =>
            tx`insert into public.document_files (document_id, file_name, storage_path, file_type) values (${d.id}, 'fax.pdf', ${`${p.id}/${d.id}/synthetic-fax.pdf`}, 'application/pdf')`,
        );
        ev =
          await tx`select action from public.audit_logs where document_id = ${d.id} order by created_at, id`;
        check(
          `${label}: upload + attachment audited`,
          ev.map((e) => e.action).join(",") ===
            "documents_insert,document_received_updated,document_upload_updated,document_files_insert" ||
            ev.map((e) => e.action).join(",") ===
              "documents_insert,documents_update,document_upload_updated,document_files_insert",
          ev,
        );

        // Integrity rejections.
        for (const [what, over, pattern] of [
          ["not received", { received: false }, /always received/],
          ["no received date", { received_date: null }, /Received date and time is required/],
          ["blank sender", { received_from: "    " }, /Sender \/ provider name is required/],
          ["sender > 200 chars", { received_from: "x".repeat(201) }, /200 characters/],
          ["recipient name set", { recipient_name: "Insurer" }, /not an outbound recipient/],
          ["recipient fax set", { recipient_fax: "555" }, /not an outbound recipient/],
          ["literal Other type", { document_type: "Other" }, /instead of "Other"/],
        ]) {
          r = await rejected(
            uid,
            () => tx`insert into public.documents ${tx(incomingRow(over))}`,
            pattern,
          );
          check(`${label}: insert rejected — ${what}`, r.ok, r.message);
        }
        r = await rejected(
          uid,
          () => tx`update public.documents set received = false where id = ${d.id}`,
          /always received/,
        );
        check(`${label}: incoming cannot be un-received`, r.ok, r.message);
        r = await rejected(
          uid,
          () => tx`update public.documents set direction = 'outgoing' where id = ${d.id}`,
          /cannot be changed/,
        );
        check(`${label}: incoming cannot become outgoing`, r.ok, r.message);
        r = await rejected(
          uid,
          () => tx`insert into public.documents ${tx(incomingRow({ direction: "sideways" }))}`,
          /documents_direction_check/,
        );
        check(`${label}: unknown direction rejected`, r.ok, r.message);
      }

      // Outgoing workflow unchanged (no direction sent = outgoing).
      const [o] = await as(
        STAFF,
        () =>
          tx`insert into public.documents (patient_id, document_type, recipient_type, recipient_name, recipient_fax, status)
             values (${p.id}, 'Progress Note', 'Referring MD', 'Dr. Ref', '555-0100', 'Draft') returning *`,
      );
      check(
        "outgoing: default direction outgoing, recipient kept",
        o.direction === "outgoing" && o.recipient_name === "Dr. Ref",
        o,
      );
      await as(
        STAFF,
        () =>
          tx`insert into public.fax_attempts (document_id, attempt_number, status) values (${o.id}, 1, 'Sent Successfully')`,
      );
      const [{ n: oAttempts }] =
        await tx`select count(*)::int n from public.fax_attempts where document_id = ${o.id}`;
      check("outgoing: fax attempt still allowed", oAttempts === 1, oAttempts);
      await as(
        STAFF,
        () =>
          tx`update public.documents set received = true, received_date = now(), received_document_type = 'Signed Progress Note', received_from = 'Dr. Ref' where id = ${o.id}`,
      );
      const [oAfter] =
        await tx`select direction, received, recipient_name from public.documents where id = ${o.id}`;
      check(
        "outgoing: response received stays outgoing (direction not inferred from received)",
        oAfter.direction === "outgoing" &&
          oAfter.received === true &&
          oAfter.recipient_name === "Dr. Ref",
        oAfter,
      );
      let r = await rejected(
        STAFF,
        () => tx`update public.documents set direction = 'incoming' where id = ${o.id}`,
        /cannot be changed/,
      );
      check("outgoing cannot become incoming", r.ok, r.message);
      const [oEv] =
        await tx`select description, changes from public.audit_logs where document_id = ${o.id} and action = 'documents_insert'`;
      check(
        "outgoing creation event unchanged (Document created, no direction)",
        oEv.description === "Document created" && !("direction" in (oEv.changes ?? {})),
        oEv,
      );

      // Anonymous and role-less callers.
      r = await rejected(null, () => tx`insert into public.documents ${tx(incomingRow())}`);
      check("anon cannot record an incoming fax", r.ok, r.message);
      r = await rejected(NOROLE, () => tx`insert into public.documents ${tx(incomingRow())}`);
      check("role-less user cannot record an incoming fax", r.ok, r.message);
      const [someIncoming] =
        await tx`select id from public.documents where patient_id = ${p.id} and direction = 'incoming' limit 1`;
      const noRoleRead = await as(
        NOROLE,
        () => tx`select id from public.documents where id = ${someIncoming.id}`,
      );
      check("role-less user reads no incoming fax", noRoleRead.length === 0, noRoleRead.length);
      const noRoleUpd = await as(
        NOROLE,
        () =>
          tx`update public.documents set notes = 'x' where id = ${someIncoming.id} returning id`,
      );
      check("role-less update affects no rows", noRoleUpd.length === 0, noRoleUpd.length);
      let anonReadDenied;
      try {
        anonReadDenied =
          (await as(null, () => tx`select id from public.documents where id = ${someIncoming.id}`))
            .length === 0;
      } catch {
        anonReadDenied = true;
      }
      check("anon reads no incoming fax", anonReadDenied);

      // Client cannot supply the actor.
      const [forged] = await as(
        STAFF,
        () =>
          tx`insert into public.documents ${tx(incomingRow({ created_by: ADMIN, created_by_name: "p3p21_admin" }))} returning created_by, created_by_name`,
      );
      check(
        "client-supplied actor ignored",
        forged.created_by === STAFF && forged.created_by_name === "p3p21_staff",
        forged,
      );

      // Permanent deletion of an incoming fax with an attachment.
      const [del] = await as(
        STAFF,
        () =>
          tx`insert into public.documents ${tx(incomingRow({ received_from: "Delete Me Clinic" }))} returning id`,
      );
      await as(
        STAFF,
        () =>
          tx`insert into public.document_files (document_id, file_name, storage_path, file_type) values (${del.id}, 'del.pdf', ${`${p.id}/${del.id}/synthetic-del.pdf`}, 'application/pdf')`,
      );
      const delResult = await as(STAFF, () => tx`select * from public.delete_document(${del.id})`);
      const [{ n: left }] =
        await tx`select count(*)::int n from public.documents where id = ${del.id}`;
      const [{ n: filesLeft }] =
        await tx`select count(*)::int n from public.document_files where document_id = ${del.id}`;
      const queued =
        await tx`select storage_path from public.patient_file_cleanup_queue where storage_path = ${`${p.id}/${del.id}/synthetic-del.pdf`}`;
      check(
        "delete_document removes incoming fax + file row and queues storage cleanup",
        delResult.length === 1 && left === 0 && filesLeft === 0 && queued.length === 1,
        { delResult, left, filesLeft, queued },
      );
      const scrubbed =
        await tx`select action, description, changes from public.audit_logs where document_id = ${del.id} order by created_at, id`;
      check(
        "deleted incoming fax history scrubbed of sender details",
        scrubbed.every((e) => e.changes === null || e.action === "document_deleted_permanently") &&
          !JSON.stringify(scrubbed).includes("Delete Me Clinic"),
        scrubbed,
      );

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
console.log("\nall P3-P21 database checks passed (transaction rolled back)");

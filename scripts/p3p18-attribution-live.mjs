#!/usr/bin/env node
// Live verification of P3-P18 (0020_record_attribution_and_history.sql):
// record attribution, anti-forgery, field-level audit events, record
// history access, the admin activity log, account-removal attribution, and
// permanent-deletion scrubbing.
//
// Part 1 runs inside ONE Postgres transaction on synthetic uuids that is
// always rolled back at the end (same discipline as
// scripts/p3p17-delete-document-live.mjs) -- nothing is ever committed and
// no real patient/document/attempt/account is read or changed. Writes that
// RLS must gate are executed as the real `authenticated` role (SET LOCAL
// ROLE) with request.jwt.claims set, exactly how PostgREST runs them.
//
// Part 2 is read-only against real data and prints counts only (never any
// names or values): migration ledger, installed triggers, grants, and the
// shape of the legacy backfill.
//
// Requires SUPABASE_DB_MIGRATION_URL in .env.
// Run with: node scripts/p3p18-attribution-live.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
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
);

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

const ROLLBACK = new Error("rollback");
const id = (n) => `d1800000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const A = id(1); // staff A
const B = id(2); // staff B
const ADM = id(3); // admin
const NOROLE = id(4); // signed in, no role
const GONE = id(5); // staff later deleted

async function part1(sql) {
  await sql
    .begin(async (tx) => {
      let sp = 0;
      // Run a query as `uid` through the authenticated role (RLS applies).
      // null = anon. Each call is isolated in a savepoint so an expected
      // rejection does not abort the surrounding transaction.
      async function as(uid, run) {
        const name = `sp_${sp++}`;
        await tx.unsafe(`savepoint ${name}`);
        try {
          await tx.unsafe(uid ? "set local role authenticated" : "set local role anon");
          await tx`select set_config('request.jwt.claims', ${uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : ""}, true)`;
          const rows = await run();
          await tx.unsafe("reset role");
          await tx.unsafe(`release savepoint ${name}`);
          return rows;
        } catch (e) {
          await tx.unsafe(`rollback to savepoint ${name}`);
          throw e;
        }
      }
      async function rejected(uid, run, pattern) {
        try {
          await as(uid, run);
          return false;
        } catch (e) {
          return pattern ? pattern.test(e.message) : true;
        }
      }
      // Service-role/system write: no JWT subject.
      async function asSystem(run) {
        await tx`select set_config('request.jwt.claims', '', true)`;
        return run();
      }

      const users = [
        [A, "p3p18_staff_a", "staff"],
        [B, "p3p18_staff_b", "staff"],
        [ADM, "p3p18_admin_c", "admin"],
        [NOROLE, "p3p18_norole", null],
        [GONE, "p3p18_gone", "staff"],
      ];
      for (const [uid, username, role] of users) {
        await tx`insert into auth.users (id) values (${uid})`;
        await tx`insert into public.user_logins (user_id, username) values (${uid}, ${username})`;
        if (role) await tx`insert into public.user_roles (user_id, role) values (${uid}, ${role})`;
      }

      // --- creation / edit attribution, anti-forgery -------------------
      const [p] = await as(
        A,
        () => tx`insert into public.patients (first_name, last_name, patient_id, created_by, created_by_name, created_by_kind, created_at)
                 values ('P3P18', 'Synthetic', 'P3P18-TEST', ${ADM}, 'p3p18_admin_c', 'user', '2000-01-01')
                 returning *`,
      );
      check(
        "T1 staff A creates: creator A; spoofed creator/name/timestamp ignored",
        p.created_by === A &&
          p.created_by_name === "p3p18_staff_a" &&
          p.created_by_kind === "user" &&
          new Date(p.created_at).getFullYear() > 2000,
        { by: p.created_by, kind: p.created_by_kind },
      );
      let ev = await tx`select * from public.audit_logs where record_id = ${p.id}`;
      check(
        "T2 exactly one patients_insert event, actor snapshot A",
        ev.length === 1 &&
          ev[0].action === "patients_insert" &&
          ev[0].actor_username === "p3p18_staff_a" &&
          ev[0].actor_kind === "user",
      );

      const [p2] = await as(
        B,
        () => tx`update public.patients set phone = '555-0100', notes = '', created_by = ${ADM}, updated_by = ${ADM}, updated_by_name = 'p3p18_admin_c'
                 where id = ${p.id} returning *`,
      );
      check(
        "T3 staff B edits: creator stays A, latest editor B, spoof ignored",
        p2.created_by === A &&
          p2.created_by_name === "p3p18_staff_a" &&
          p2.updated_by === B &&
          p2.updated_by_name === "p3p18_staff_b",
      );
      ev =
        await tx`select * from public.audit_logs where record_id = ${p.id} and action = 'patients_update'`;
      check(
        "T4 one patients_update with only the real change (blank->'' ignored)",
        ev.length === 1 &&
          JSON.stringify(Object.keys(ev[0].changes)) === '["phone"]' &&
          ev[0].changes.phone.to === "555-0100",
      );

      const [p3] = await as(
        A,
        () => tx`update public.patients set phone = '555-0100' where id = ${p.id} returning *`,
      );
      ev = await tx`select count(*)::int n from public.audit_logs where record_id = ${p.id}`;
      check(
        "T5 unchanged save: no event, last editor unchanged",
        ev[0].n === 2 && p3.updated_by === B && +p3.updated_at === +p2.updated_at,
      );

      check(
        "T6 failed validation (bad NPI) rejected",
        await rejected(
          B,
          () => tx`update public.patients set referring_physician_npi = '12' where id = ${p.id}`,
        ),
      );
      check(
        "T7 role-less insert rejected",
        await rejected(
          NOROLE,
          () =>
            tx`insert into public.patients (first_name, last_name, patient_id) values ('x', 'y', 'P3P18-NR')`,
        ),
      );
      check(
        "T8 anon insert rejected",
        await rejected(
          null,
          () =>
            tx`insert into public.patients (first_name, last_name, patient_id) values ('x', 'y', 'P3P18-AN')`,
        ),
      );
      const nr = await as(
        NOROLE,
        () => tx`update public.patients set phone = '9' where id = ${p.id} returning id`,
      );
      check("T9 role-less update matches 0 rows", nr.length === 0);
      ev = await tx`select count(*)::int n from public.audit_logs where record_id = ${p.id}`;
      check("T10 rejected/failed writes left no events", ev[0].n === 2, ev[0]);

      // --- documents, received/upload, attempts, files, correction ------
      const [d] = await as(
        A,
        () => tx`insert into public.documents (patient_id, document_type, document_number, md_name, uploaded, uploaded_by)
                 values (${p.id}, 'Initial Evaluation', 1, 'Dr Synthetic', false, ${ADM}) returning *`,
      );
      check(
        "T11 document creator A; uploaded_by not forgeable",
        d.created_by === A && d.uploaded_by === null,
      );
      const [d2] = await as(
        B,
        () =>
          tx`update public.documents set md_name = 'Dr Other', md_npi = '1234567890' where id = ${d.id} returning *`,
      );
      check("T12 document editor B, creator A", d2.updated_by === B && d2.created_by === A);
      await as(
        A,
        () =>
          tx`update public.documents set received = true, received_date = now(), received_from = 'Dr Other' where id = ${d.id}`,
      );
      await as(
        B,
        () =>
          tx`update public.documents set uploaded = true, uploaded_date = now(), uploaded_by = ${ADM} where id = ${d.id}`,
      );
      const [d3] =
        await tx`select uploaded_by, updated_by from public.documents where id = ${d.id}`;
      check(
        "T13 uploaded_by derived from caller B, not the spoofed admin",
        d3.uploaded_by === B && d3.updated_by === B,
      );
      const [a1] = await as(
        B,
        () => tx`insert into public.fax_attempts (document_id, attempt_number, status, failure_reason, created_by)
                 values (${d.id}, 1, 'Failed', 'Busy', ${ADM}) returning *`,
      );
      check(
        "T14 attempt recorder = caller B, spoof ignored",
        a1.created_by === B && a1.created_by_name === "p3p18_staff_b",
      );
      await as(
        A,
        () =>
          tx`insert into public.fax_attempts (document_id, attempt_number, status) values (${d.id}, 2, 'Sent Successfully')`,
      );
      const [f] = await as(
        A,
        () => tx`insert into public.document_files (document_id, file_name, storage_path, uploaded_by)
                 values (${d.id}, 'synthetic.pdf', ${`${p.id}/${d.id}/synthetic.pdf`}, ${ADM}) returning *`,
      );
      check("T15 file uploaded_by = caller A", f.uploaded_by === A);
      check(
        "T16 correction concurrency (CONFLICT) check preserved",
        await rejected(
          A,
          () =>
            tx`select * from public.correct_fax_attempt(${a1.id}, '2000-01-01', now(), 'Sent Successfully', null, null, null, 'x', null, null, null, null, null, null, null)`,
          /CONFLICT/,
        ),
      );
      await as(
        A,
        () =>
          tx`select * from public.correct_fax_attempt(${a1.id}, ${a1.updated_at}, ${a1.attempted_at}, 'Sent Successfully', null, 'R9', null, 'wrong status', null, null, null, null, null, null, null)`,
      );
      ev =
        await tx`select action, changes from public.audit_logs where document_id = ${d.id} order by created_at, id`;
      check(
        "T17 one event per action, in order, no duplicates",
        JSON.stringify(ev.map((e) => e.action)) ===
          JSON.stringify([
            "documents_insert",
            "documents_update",
            "document_received_updated",
            "document_upload_updated",
            "fax_attempts_insert",
            "fax_attempts_insert",
            "document_files_insert",
            "fax_attempt_corrected",
          ]),
        ev.map((e) => e.action),
      );
      const corr = ev.find((e) => e.action === "fax_attempt_corrected");
      check(
        "T18 correction logged once with field diff + reason",
        corr.changes.status.from === "Failed" &&
          corr.changes.correction_reason.to === "wrong status" &&
          !("updated_at" in corr.changes),
      );
      const fileEv = ev.find((e) => e.action === "document_files_insert");
      check(
        "T19 file event has the file name only, never the storage path",
        fileEv.changes.file_name.to === "synthetic.pdf" &&
          !JSON.stringify(fileEv.changes).includes("/"),
      );

      // --- history access ------------------------------------------------
      let h = await as(
        B,
        () => tx`select * from public.get_record_history('document', ${d.id}, 50, 0)`,
      );
      check(
        "T20 staff reads document history (8 events)",
        h.length === 8 && Number(h[0].total_count) === 8,
        h.length,
      );
      h = await as(A, () => tx`select * from public.get_record_history('patient', ${p.id}, 3, 0)`);
      check(
        "T21 patient history includes document events, paginated",
        h.length === 3 && Number(h[0].total_count) === 10,
      );
      check(
        "T22 role-less denied record history",
        await rejected(
          NOROLE,
          () => tx`select * from public.get_record_history('patient', ${p.id})`,
          /FORBIDDEN/,
        ),
      );
      check(
        "T23 anon denied record history",
        await rejected(null, () => tx`select * from public.get_record_history('patient', ${p.id})`),
      );
      check(
        "T24 staff cannot read audit_logs directly",
        (await as(A, () => tx`select id from public.audit_logs limit 1`)).length === 0,
      );
      check(
        "T25 staff cannot insert audit_logs",
        await rejected(
          A,
          () =>
            tx`insert into public.audit_logs (user_id, action) values (${ADM}, 'patients_insert')`,
        ),
      );
      check(
        "T26 staff cannot read user_logins",
        await rejected(A, () => tx`select username from public.user_logins limit 1`),
      );

      // --- admin activity log ---------------------------------------------
      check(
        "T27 staff denied global activity log",
        await rejected(A, () => tx`select * from public.get_audit_activity()`, /FORBIDDEN/),
      );
      check(
        "T28 staff denied actor list",
        await rejected(B, () => tx`select * from public.list_audit_actors()`, /FORBIDDEN/),
      );
      check(
        "T29 anon denied activity log",
        await rejected(null, () => tx`select * from public.get_audit_activity()`),
      );
      check(
        "T30 role-less denied activity log",
        await rejected(NOROLE, () => tx`select * from public.get_audit_activity()`, /FORBIDDEN/),
      );
      let g = await as(
        ADM,
        () =>
          tx`select * from public.get_audit_activity(${B}, null, null, null, null, null, 50, 0)`,
      );
      check("T31 admin filter by account", g.length > 0 && g.every((x) => x.user_id === B));
      g = await as(
        ADM,
        () =>
          tx`select * from public.get_audit_activity(${A}, null, null, null, 'fax_attempt_corrected', 'fax_attempt', 50, 0)`,
      );
      check(
        "T32 admin filter by action + record type",
        g.length === 1 && g[0].actor_username === "p3p18_staff_a",
      );
      g = await as(
        ADM,
        () =>
          tx`select * from public.get_audit_activity(${A}, null, now() + interval '1 day', null, null, null, 50, 0)`,
      );
      check("T33 admin date range excludes out-of-range events", g.length === 0);
      g = await as(
        ADM,
        () => tx`select * from public.get_audit_activity(${A}, null, null, null, null, null, 2, 1)`,
      );
      check(
        "T34 admin pagination: page size + total",
        g.length === 2 && Number(g[0].total_count) >= 3,
      );
      const actors = await as(ADM, () => tx`select * from public.list_audit_actors()`);
      check(
        "T35 actor list includes admin accounts",
        actors.some((x) => x.user_id === ADM && x.role === "admin"),
      );

      // --- account removal keeps attribution honest ------------------------
      const [gp] = await as(
        GONE,
        () =>
          tx`insert into public.patients (first_name, last_name, patient_id) values ('P3P18', 'Gone', 'P3P18-GONE') returning id`,
      );
      await as(ADM, () => tx`select * from public.delete_staff_account(${GONE}, 'p3p18_gone')`);
      const [gpr] = await tx`select created_by_name from public.patients where id = ${gp.id}`;
      check(
        "T36 attribution keeps the removed account's name",
        gpr.created_by_name === "p3p18_gone",
      );
      h = await as(
        A,
        () => tx`select * from public.get_record_history('patient', ${gp.id}, 50, 0)`,
      );
      check(
        "T37 history flags the removed account",
        h.length === 1 &&
          h[0].actor_username === "p3p18_gone" &&
          h[0].actor_account_removed === true,
      );
      const st = await as(A, () => tx`select * from public.get_actor_status(${[A, GONE]}::uuid[])`);
      check(
        "T38 actor status flags only the removed account",
        st.find((x) => x.user_id === GONE)?.account_removed === true &&
          st.find((x) => x.user_id === A)?.account_removed === false,
      );

      // --- system/maintenance writes -----------------------------------------
      const [sp1] = await asSystem(
        () =>
          tx`insert into public.patients (first_name, last_name, patient_id) values ('P3P18', 'System', 'P3P18-SYS') returning *`,
      );
      ev = await tx`select actor_kind from public.audit_logs where record_id = ${sp1.id}`;
      check(
        "T39 maintenance write recorded as system, not as a user",
        sp1.created_by_kind === "system" &&
          sp1.created_by === null &&
          ev[0]?.actor_kind === "system",
      );

      // --- permanent deletion ---------------------------------------------------
      const [doc2] = await as(
        A,
        () =>
          tx`insert into public.documents (patient_id, document_type, notes) values (${p.id}, 'Discharge Note', 'synthetic secret') returning id`,
      );
      await as(
        A,
        () => tx`update public.documents set notes = 'synthetic secret 2' where id = ${doc2.id}`,
      );
      await as(A, () => tx`select * from public.delete_document(${doc2.id})`);
      ev =
        await tx`select action, changes from public.audit_logs where document_id = ${doc2.id} order by created_at, id`;
      check(
        "T40 document delete: earlier field values scrubbed, skeleton + deletion event kept",
        ev.length === 3 &&
          ev[0].changes === null &&
          ev[1].changes === null &&
          ev[2].action === "document_deleted_permanently" &&
          ev[2].changes.document.from === "Discharge Note" &&
          !JSON.stringify(ev).includes("secret"),
      );
      const before = (
        await tx`select count(*)::int n from public.audit_logs where patient_id = ${p.id}`
      )[0].n;
      await as(B, () => tx`select * from public.delete_patient_permanently(${p.id}, 'P3P18-TEST')`);
      ev =
        await tx`select action, changes, description, actor_username from public.audit_logs where patient_id = ${p.id} order by created_at, id`;
      check(
        "T41 patient delete: every earlier event stripped of field values",
        ev.slice(0, -1).every((e) => e.changes === null),
      );
      check(
        "T42 patient delete: no patient details or reasons retained",
        !/Synthetic|555-0100|Dr Synthetic|Dr Other|1234567890|wrong status|R9|synthetic\.pdf|Discharge/.test(
          JSON.stringify(ev),
        ),
      );
      check(
        "T43 patient delete: exactly one minimal deletion event added",
        ev.length === before + 1 &&
          ev.at(-1).action === "patient_deleted_permanently" &&
          ev.at(-1).actor_username === "p3p18_staff_b",
      );

      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
  const leftovers =
    await sql`select count(*)::int n from public.patients where patient_id like 'P3P18-%'`;
  check("T44 nothing committed (synthetic rows rolled back)", leftovers[0].n === 0);
}

async function part2(sql) {
  const ledger =
    await sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  check(
    "L1 ledger's latest entry is 0020 (when=1791400000000)",
    Number(ledger[0]?.created_at) === 1791400000000,
    ledger[0]?.created_at,
  );
  const triggers = await sql`
    select tgname from pg_trigger
    where not tgisinternal and tgrelid in ('public.patients'::regclass, 'public.documents'::regclass, 'public.fax_attempts'::regclass, 'public.document_files'::regclass, 'public.audit_logs'::regclass)
    order by tgname`;
  const names = triggers.map((t) => t.tgname);
  check(
    "L2 attribution/audit/scrub triggers installed",
    [
      "audit_attempts",
      "audit_documents",
      "audit_files",
      "audit_logs_fill_actor",
      "audit_patients",
      "scrub_audit_on_document_delete",
      "scrub_audit_on_patient_delete",
      "set_attempt_attribution",
      "set_document_attribution",
      "set_file_attribution",
      "set_patient_attribution",
    ].every((n) => names.includes(n)),
    names,
  );
  const [old] = await sql`select count(*)::int n from pg_proc where proname = 'log_fax_change'`;
  check("L3 old generic trigger function removed", old.n === 0);
  const grants = await sql`
    select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('get_record_history','get_audit_activity','list_audit_actors','get_actor_status')`;
  check(
    "L4 read RPCs: authenticated only, never anon",
    grants.length === 4 && grants.every((g) => g.auth && !g.anon),
    grants,
  );
  const internal = await sql`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('set_record_attribution','set_child_attribution','audit_record_change','audit_logs_fill_actor','scrub_audit_details_on_delete','audit_field_changes')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`;
  check("L5 trigger/helper functions not callable by clients", internal.length === 0, internal);
  for (const t of ["patients", "documents"]) {
    const [r] = await sql`
      select count(*)::int total,
             count(*) filter (where created_by_kind = 'user')::int users,
             count(*) filter (where created_by_kind = 'system')::int system,
             count(*) filter (where created_by_kind = 'unknown')::int unknown,
             count(*) filter (where created_by_kind = 'user' and created_by_name is null)::int bad,
             count(*) filter (where updated_at < created_at)::int backwards
      from ${sql(`public.${t}`)}`;
    console.log(
      `   ${t}: total=${r.total} user=${r.users} system=${r.system} unknown=${r.unknown}`,
    );
    check(
      `L6 ${t}: no user attribution without a name, no update before creation`,
      r.bad === 0 && r.backwards === 0,
      r,
    );
  }
  const [au] = await sql`
    select count(*)::int total, count(*) filter (where actor_kind is null)::int no_kind,
           count(*) filter (where record_type is null)::int no_type
    from public.audit_logs`;
  console.log(
    `   audit_logs: total=${au.total} missing_kind=${au.no_kind} missing_record_type=${au.no_type}`,
  );
  check("L7 every audit row has an actor kind", au.no_kind === 0, au);
}

const sql = postgres(env.SUPABASE_DB_MIGRATION_URL, { max: 1, onnotice: () => {} });
try {
  const [{ current_database, ref }] =
    await sql`select current_database(), current_setting('cluster_name', true) as ref`;
  console.log(`connected: db=${current_database}${ref ? ` cluster=${ref}` : ""}`);
  await part1(sql);
  await part2(sql);
} finally {
  await sql.end();
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);

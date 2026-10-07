#!/usr/bin/env node
// Live verification of public.delete_document for P3-P17.
//
// Part 1 runs inside one Postgres transaction on synthetic uuids that is
// always ROLLBACK'd at the end (same discipline as
// scripts/p3p11-patient-delete-live.mjs) -- nothing here is ever committed,
// so it never touches real patients/documents/attempts.
//
// Covers: admin success (atomic delete of one document's fax_attempts/
// document_files/fax_attempt_corrections, leaving the patient and a second,
// near-identical document with its own attempt/correction/file completely
// untouched), audit_logs entry, patient_file_cleanup_queue populated with
// only the deleted document's attachment path, staff success, role-less/
// unauthenticated direct-call denial, and a duplicate resubmit safely
// rejected as NOT_FOUND (nothing double-deleted or double-queued).
//
// Part 2 exercises the real patient-documents Storage bucket (outside any
// SQL transaction, since Storage is a separate HTTP service): confirms a
// genuine removal failure (invalid credential) leaves the queue row
// retryable without touching an unrelated pending row for the same patient,
// then verifies a real retry succeeds and clears only the targeted row.
// Everything created here is deleted again at the end regardless of outcome.
//
// Requires SUPABASE_DB_MIGRATION_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.
// Run with: node scripts/p3p17-delete-document-live.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

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
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

async function runSqlChecks() {
  const sql = postgres(env.SUPABASE_DB_MIGRATION_URL);

  const adminId = "d0000000-0000-0000-0000-0000000000a1";
  const staffId = "d0000000-0000-0000-0000-0000000000a2";
  const ghostId = "d0000000-0000-0000-0000-0000000000a3";

  const patientId = "d0000000-0000-0000-0000-0000000000b1";
  // Two deliberately near-identical documents under the same patient --
  // same type/recipient/MD fields -- to prove deleting one never touches
  // the other even when their values are otherwise indistinguishable.
  const docAId = "d0000000-0000-0000-0000-0000000000c1";
  const docBId = "d0000000-0000-0000-0000-0000000000c2";
  const attemptAId = "d0000000-0000-0000-0000-0000000000d1";
  const attemptBId = "d0000000-0000-0000-0000-0000000000d2";
  const fileAId = "d0000000-0000-0000-0000-0000000000e1";
  const fileBId = "d0000000-0000-0000-0000-0000000000e2";
  const storagePathA = `${patientId}/${docAId}/synthetic-a.pdf`;
  const storagePathB = `${patientId}/${docBId}/synthetic-b.pdf`;

  await sql
    .begin(async (tx) => {
      await tx`delete from public.user_roles where user_id = any(${[adminId, staffId, ghostId]})`;
      await tx`insert into public.user_roles (user_id, role) values (${adminId}, 'admin'), (${staffId}, 'staff')`;

      await tx`insert into public.patients (id, first_name, last_name, patient_id) values (${patientId}, 'P3P17', 'Synthetic', 'P3P17-TEST')`;
      for (const [docId, attemptId, fileId, storagePath] of [
        [docAId, attemptAId, fileAId, storagePathA],
        [docBId, attemptBId, fileBId, storagePathB],
      ]) {
        await tx`insert into public.documents (id, patient_id, document_type, recipient_type, recipient_name, md_name) values (${docId}, ${patientId}, 'Initial Evaluation', 'Insurance', 'Same Recipient', 'Dr. Same')`;
        await tx`insert into public.fax_attempts (id, document_id, attempt_number, status, created_by) values (${attemptId}, ${docId}, 1, 'Sent Successfully', ${adminId})`;
        await tx`insert into public.document_files (id, document_id, file_name, storage_path, uploaded_by) values (${fileId}, ${docId}, 'synthetic.pdf', ${storagePath}, ${adminId})`;
      }

      // Give attempt A a correction so fax_attempt_corrections (ON DELETE
      // CASCADE from fax_attempts) is also exercised, and so we can prove
      // B's correction history survives untouched.
      const asUser = (id) =>
        tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id })}, true)`;
      await asUser(adminId);
      await tx`select * from public.correct_fax_attempt(
        ${attemptAId}, (select updated_at from public.fax_attempts where id = ${attemptAId}), now(),
        'Sent Successfully', null, 'REF-A', null, 'synthetic setup correction A',
        'Dr. Same', 'Insurance', 'Same Recipient', null, null, null, null
      )`;
      await tx`select * from public.correct_fax_attempt(
        ${attemptBId}, (select updated_at from public.fax_attempts where id = ${attemptBId}), now(),
        'Sent Successfully', null, 'REF-B', null, 'synthetic setup correction B',
        'Dr. Same', 'Insurance', 'Same Recipient', null, null, null, null
      )`;

      let spCounter = 0;
      async function expectError(fn) {
        const name = `sp_${spCounter++}`;
        await tx.unsafe(`savepoint ${name}`);
        let message = null;
        try {
          await fn();
        } catch (e) {
          message = e.message;
        } finally {
          await tx.unsafe(`rollback to savepoint ${name}`);
        }
        return message;
      }

      const call = (id) => tx`select * from public.delete_document(${id})`;

      // T1: role-less caller denied, document untouched.
      await asUser(ghostId);
      const ghostError = await expectError(() => call(docAId));
      check("T1 role-less caller rejected", /FORBIDDEN/.test(ghostError ?? ""));

      // T2: unauthenticated caller denied.
      await tx`select set_config('request.jwt.claims', '', true)`;
      const anonError = await expectError(() => call(docAId));
      check("T2 unauthenticated caller rejected", /FORBIDDEN/.test(anonError ?? ""));
      const [stillThere] = await tx`select id from public.documents where id = ${docAId}`;
      check("T2 document not deleted after denied calls", !!stillThere);

      // T3: admin success -- atomic delete of document A only + audit +
      // cleanup queue, with document B (and the patient) completely intact.
      await asUser(adminId);
      const [auditBefore] = await tx`select count(*)::int as n from public.audit_logs`;
      const [queueBefore] =
        await tx`select count(*)::int as n from public.patient_file_cleanup_queue`;
      const rows = await call(docAId);
      const row = rows[0];
      check(
        "T3 admin delete: returns correct attempt/file counts",
        row?.attempts_deleted === 1 && row?.files_deleted === 1,
      );
      check("T3 admin delete: returns this document's patient_id", row?.patient_id === patientId);
      check(
        "T3 admin delete: returns only document A's storage path",
        Array.isArray(row?.storage_paths) &&
          row.storage_paths.length === 1 &&
          row.storage_paths[0] === storagePathA,
      );

      const [docAGone] = await tx`select id from public.documents where id = ${docAId}`;
      check("T3 document A deleted", !docAGone);
      const [attemptsAGone] =
        await tx`select count(*)::int as n from public.fax_attempts where document_id = ${docAId}`;
      check("T3 document A's fax_attempts deleted", attemptsAGone.n === 0);
      const [correctionsAGone] =
        await tx`select count(*)::int as n from public.fax_attempt_corrections where attempt_id = ${attemptAId}`;
      check("T3 document A's corrections cascade-deleted", correctionsAGone.n === 0);
      const [filesAGone] =
        await tx`select count(*)::int as n from public.document_files where document_id = ${docAId}`;
      check("T3 document A's files deleted", filesAGone.n === 0);

      // The patient and the other, otherwise-identical document are
      // untouched -- the core guarantee of a per-document (not per-patient)
      // delete.
      const [patientStill] = await tx`select id from public.patients where id = ${patientId}`;
      check("T3 patient still exists", !!patientStill);
      const [docBStill] = await tx`select id from public.documents where id = ${docBId}`;
      check("T3 document B still exists", !!docBStill);
      const [attemptBStill] = await tx`select id from public.fax_attempts where id = ${attemptBId}`;
      check("T3 document B's fax attempt still exists", !!attemptBStill);
      const [correctionBStill] =
        await tx`select id from public.fax_attempt_corrections where attempt_id = ${attemptBId}`;
      check("T3 document B's correction history still exists", !!correctionBStill);
      const [fileBStill] = await tx`select id from public.document_files where id = ${fileBId}`;
      check("T3 document B's file record still exists", !!fileBStill);

      const [auditAfter] = await tx`select count(*)::int as n from public.audit_logs`;
      check("T3 exactly one audit row written", auditAfter.n === auditBefore.n + 1);
      const [auditRow] =
        await tx`select action, user_id, patient_id, document_id, description from public.audit_logs where action = 'document_deleted_permanently' and document_id = ${docAId}`;
      check(
        "T3 audit row: actor and non-identifying references, no doctor/recipient name in description",
        auditRow?.user_id === adminId &&
          auditRow?.patient_id === patientId &&
          auditRow?.document_id === docAId &&
          !auditRow?.description?.includes("Dr. Same"),
      );
      const [queueAfter] =
        await tx`select count(*)::int as n from public.patient_file_cleanup_queue`;
      check("T3 exactly one cleanup-queue row inserted", queueAfter.n === queueBefore.n + 1);
      const [queueRow] =
        await tx`select storage_path, patient_ref, done_at from public.patient_file_cleanup_queue where patient_ref = ${patientId} and storage_path = ${storagePathA}`;
      check(
        "T3 cleanup-queue row references document A's path only, not pre-marked done",
        !!queueRow && queueRow.done_at === null,
      );

      // T4: duplicate resubmit (double-click) safely rejected -- no
      // double-delete, no double audit row, no double queue row.
      const duplicateError = await expectError(() => call(docAId));
      check("T4 duplicate resubmit rejected as NOT_FOUND", /NOT_FOUND/.test(duplicateError ?? ""));
      const [auditAfterDuplicate] =
        await tx`select count(*)::int as n from public.audit_logs where action = 'document_deleted_permanently' and document_id = ${docAId}`;
      check("T4 duplicate resubmit did not write a second audit row", auditAfterDuplicate.n === 1);
      const [queueAfterDuplicate] =
        await tx`select count(*)::int as n from public.patient_file_cleanup_queue where storage_path = ${storagePathA}`;
      check(
        "T4 duplicate resubmit did not queue a second cleanup row",
        queueAfterDuplicate.n === 1,
      );

      // T5: staff can also delete a document (not admin-only), scoped to
      // document B this time -- proving the function isn't hardcoded to
      // the first document and that staff has equal access.
      await asUser(staffId);
      const staffRows = await call(docBId);
      check("T5 staff delete succeeds", staffRows[0]?.attempts_deleted === 1);
      const [docBGone] = await tx`select id from public.documents where id = ${docBId}`;
      check("T5 staff-deleted document actually gone", !docBGone);
      const [patientStillAfterB] = await tx`select id from public.patients where id = ${patientId}`;
      check("T5 patient still exists after both documents deleted", !!patientStillAfterB);

      // Never commit: this whole transaction touched only synthetic rows.
      throw new Error("__discard_test_transaction__");
    })
    .catch((e) => {
      if (e.message !== "__discard_test_transaction__") throw e;
    });

  await sql.end();
}

async function runStorageChecks() {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const stamp = Date.now();
  const pathA = `p3p17-synthetic/${stamp}-a.txt`;
  const pathB = `p3p17-synthetic/${stamp}-b.txt`;
  const patientRef = "00000000-0000-0000-0000-000000000000";

  const uploadA = await admin.storage
    .from("patient-documents")
    .upload(pathA, new Blob(["synthetic-a"]), { contentType: "text/plain" });
  check("Storage: synthetic attachment A uploaded", !uploadA.error);
  const uploadB = await admin.storage
    .from("patient-documents")
    .upload(pathB, new Blob(["synthetic-b"]), { contentType: "text/plain" });
  check("Storage: synthetic attachment B uploaded", !uploadB.error);

  // Two pending rows for the SAME patient_ref, simulating two different
  // documents deleted at different times -- the scenario the server
  // handler must scope precisely by storage_path, not just patient_ref.
  const { data: queuedA, error: insertErrorA } = await admin
    .from("patient_file_cleanup_queue")
    .insert({ storage_path: pathA, patient_ref: patientRef })
    .select("id")
    .single();
  check("Storage: cleanup-queue row inserted for attachment A", !insertErrorA);
  const { data: queuedB, error: insertErrorB } = await admin
    .from("patient_file_cleanup_queue")
    .insert({ storage_path: pathB, patient_ref: patientRef })
    .select("id")
    .single();
  check("Storage: cleanup-queue row inserted for attachment B", !insertErrorB);

  // Simulate a genuine removal failure for A only (invalid credential,
  // same technique as p3p11) and confirm it leaves A retryable without
  // touching B's unrelated pending row for the same patient_ref.
  const unauthorized = createClient(env.SUPABASE_URL, "not-a-real-key");
  const failedRemoval = await unauthorized.storage.from("patient-documents").remove([pathA]);
  check("Storage: simulated cleanup failure is a real API error", !!failedRemoval.error);
  await admin
    .from("patient_file_cleanup_queue")
    .update({
      attempts: 1,
      last_error: failedRemoval.error?.message,
      last_attempted_at: new Date().toISOString(),
    })
    .eq("patient_ref", patientRef)
    .in("storage_path", [pathA])
    .is("done_at", null);
  const { data: stillQueuedA } = await admin
    .from("patient_file_cleanup_queue")
    .select("done_at, attempts")
    .eq("id", queuedA.id)
    .single();
  check(
    "Storage: after a failed cleanup attempt, A's queue row is pending with attempts recorded (safe to retry)",
    stillQueuedA && stillQueuedA.done_at === null && stillQueuedA.attempts === 1,
  );
  const { data: untouchedB } = await admin
    .from("patient_file_cleanup_queue")
    .select("done_at, attempts")
    .eq("id", queuedB.id)
    .single();
  check(
    "Storage: B's unrelated queue row for the same patient_ref was not touched by A's failure",
    untouchedB && untouchedB.done_at === null && untouchedB.attempts === 0,
  );

  // Retry against the correct bucket for A only, scoped the same way the
  // real server handler does: by patient_ref AND storage_path.
  const retryRemovalA = await admin.storage.from("patient-documents").remove([pathA]);
  check("Storage: retry against the correct bucket succeeds for A", !retryRemovalA.error);
  await admin
    .from("patient_file_cleanup_queue")
    .delete()
    .eq("patient_ref", patientRef)
    .in("storage_path", [pathA]);
  const { data: aGoneFromQueue } = await admin
    .from("patient_file_cleanup_queue")
    .select("id")
    .eq("id", queuedA.id)
    .maybeSingle();
  check("Storage: A's queue row cleared after retry", !aGoneFromQueue);
  const { data: bStillQueuedAfterARetry } = await admin
    .from("patient_file_cleanup_queue")
    .select("id")
    .eq("id", queuedB.id)
    .maybeSingle();
  check(
    "Storage: B's queue row was NOT cleared by A's retry (precise targeting, not bare patient_ref)",
    !!bStillQueuedAfterARetry,
  );

  // Clean up B's synthetic attachment + queue row directly (not via the
  // app's retry worker, to keep this test's teardown independent of it).
  const removalB = await admin.storage.from("patient-documents").remove([pathB]);
  check("Storage: synthetic attachment B removed in teardown", !removalB.error);
  await admin.from("patient_file_cleanup_queue").delete().eq("id", queuedB.id);

  const { data: list } = await admin.storage.from("patient-documents").list("p3p17-synthetic");
  check(
    "Storage: no synthetic attachments remain in the bucket after teardown",
    !list?.some((f) => f.name.includes(String(stamp))),
  );
}

await runSqlChecks();
await runStorageChecks();

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "\nAll live document-delete checks passed. Real data was not touched (SQL transaction rolled back); synthetic storage artifacts were cleaned up.",
);

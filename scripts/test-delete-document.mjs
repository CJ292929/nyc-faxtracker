#!/usr/bin/env node
// Isolated fixture test for the single-document-delete RPC wrapper: input
// validation and error-message mapping. No network, no real credentials —
// the authoritative checks (staff/admin recheck, atomic delete, audit,
// cleanup-queue insert) live in the database function and are covered by
// scripts/p3p17-delete-document-live.mjs against an isolated, synthetic
// patient.
//   node --experimental-strip-types scripts/test-delete-document.mjs
import { deleteDocument } from "../src/lib/delete-document-core.ts";

function fakeRpc(handler) {
  return { rpc: handler };
}

let failures = 0;
async function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok" : "FAIL"} - ${name}`);
  if (!pass) {
    failures++;
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
  }
}

const DOCUMENT = "22222222-2222-2222-2222-222222222222";
const PATIENT = "11111111-1111-1111-1111-111111111111";
const baseInput = { documentId: DOCUMENT };

async function run() {
  // Happy path: the database function returns the delete counts + paths.
  {
    const calls = [];
    const client = fakeRpc(async (fn, args) => {
      calls.push([fn, args]);
      return {
        data: [
          {
            document_id: DOCUMENT,
            patient_id: PATIENT,
            attempts_deleted: 2,
            files_deleted: 1,
            storage_paths: [`${PATIENT}/${DOCUMENT}/file.pdf`],
          },
        ],
        error: null,
      };
    });
    const result = await deleteDocument(baseInput, client);
    await check("success maps db row to result", result, {
      ok: true,
      documentId: DOCUMENT,
      patientId: PATIENT,
      attemptsDeleted: 2,
      filesDeleted: 1,
      storagePaths: [`${PATIENT}/${DOCUMENT}/file.pdf`],
    });
    await check("calls delete_document with snake_case args", calls, [
      ["delete_document", { _document_id: DOCUMENT }],
    ]);
  }

  // Null storage_paths from the db maps to an empty array, not null.
  {
    const client = fakeRpc(async () => ({
      data: [
        {
          document_id: DOCUMENT,
          patient_id: PATIENT,
          attempts_deleted: 0,
          files_deleted: 0,
          storage_paths: null,
        },
      ],
      error: null,
    }));
    const result = await deleteDocument(baseInput, client);
    await check("null storage_paths normalized to []", result.storagePaths, []);
  }

  // FORBIDDEN from the database (role-less/anonymous direct RPC calls that
  // bypass the UI entirely) maps to a friendly error.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "FORBIDDEN: only staff or admin accounts can delete documents" },
    }));
    await check("forbidden caller denied", await deleteDocument(baseInput, client), {
      ok: false,
      error: "Only admin or staff accounts can delete documents.",
    });
  }

  // Unknown document (e.g. a duplicate submit after the first already deleted it).
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "NOT_FOUND: document does not exist" },
    }));
    await check("missing document denied", await deleteDocument(baseInput, client), {
      ok: false,
      error: "That document no longer exists.",
    });
  }

  // Client-side validation happens before any network call.
  {
    let called = false;
    const client = fakeRpc(async () => {
      called = true;
      return { data: null, error: null };
    });
    await check(
      "invalid uuid rejected without a call",
      await deleteDocument({ documentId: "not-a-uuid" }, client),
      { ok: false, error: "Invalid document." },
    );
    await check("no rpc call made for invalid input", called, false);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll delete-document checks passed.");
}

await run();

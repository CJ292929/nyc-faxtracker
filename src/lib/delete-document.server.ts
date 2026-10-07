import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  deleteDocument,
  type DeleteDocumentInput,
  type DeleteDocumentResult,
} from "./delete-document-core";

function isDeleteDocumentInput(data: unknown): data is DeleteDocumentInput {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d["documentId"] === "string";
}

export type DeleteDocumentServerResult = DeleteDocumentResult & {
  filesPendingCleanup?: number;
};

// The caller's identity comes from context.supabase, which auth-middleware
// scopes to the request's verified Bearer token (auth.uid() inside the
// database function), never from anything in `data`. The database function
// itself performs the atomic delete + audit insert; this wrapper only
// handles the private-storage side effect that cannot live inside a SQL
// transaction (the Storage API is a separate HTTP service).
export const deleteDocumentAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): DeleteDocumentInput => {
    if (!isDeleteDocumentInput(data)) throw new Error("Invalid request");
    return data;
  })
  .handler(async ({ data, context }): Promise<DeleteDocumentServerResult> => {
    const result = await deleteDocument(data, context.supabase);
    if (!result.ok || result.storagePaths.length === 0) {
      return result;
    }

    // Service-role client, loaded only inside this server handler: the DB
    // row is already gone and durably queued in patient_file_cleanup_queue
    // (inserted in the same transaction as the delete), so a failure here
    // never produces a false "nothing was deleted" -- it only means the
    // attachment bytes remain queued for
    // scripts/retry-patient-file-cleanup.mjs to remove on the next run.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const removal = await supabaseAdmin.storage
      .from("patient-documents")
      .remove(result.storagePaths);

    // Scoped to the exact paths just inserted for *this* document, not the
    // whole patient_ref: a patient can have many documents deleted over
    // time, each queuing rows under the same patient_ref, so touching rows
    // by patient_ref alone (safe for whole-patient delete, where the
    // patient can only ever be deleted once) would risk updating/clearing
    // an unrelated pending cleanup row from a different deletion.
    if (removal.error) {
      await supabaseAdmin
        .from("patient_file_cleanup_queue")
        .update({
          attempts: 1,
          last_error: removal.error.message,
          last_attempted_at: new Date().toISOString(),
        })
        .eq("patient_ref", result.patientId)
        .in("storage_path", result.storagePaths)
        .is("done_at", null);
      return { ...result, filesPendingCleanup: result.storagePaths.length };
    }

    await supabaseAdmin
      .from("patient_file_cleanup_queue")
      .delete()
      .eq("patient_ref", result.patientId)
      .in("storage_path", result.storagePaths);

    return { ...result, filesPendingCleanup: 0 };
  });

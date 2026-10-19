// Follow-up audit events for the private-storage side of a permanent
// delete (P3-P18). The deletion event itself is written atomically with
// the row deletes by delete_patient_permanently / delete_document and only
// says attachment removal was *queued*; the Storage API is a separate HTTP
// service, so its result is recorded afterwards, here, as what was actually
// observed: "completed" only when the removal call succeeded, otherwise
// "pending" (the paths stay in patient_file_cleanup_queue for
// scripts/retry-patient-file-cleanup.mjs, which records its own completion).
//
// user_id is NULL: the removal is performed by the server, not by a person,
// so the event is attributed to the system rather than borrowed from the
// account that requested the delete. No paths or file names are written.

export type CleanupOutcome = "completed" | "pending";

export type CleanupAuditRow = {
  user_id: null;
  patient_id: string;
  document_id: string | null;
  record_type: "patient" | "document";
  record_id: string;
  action: "attachment_cleanup_completed" | "attachment_cleanup_pending";
  description: string;
};

export function cleanupAuditRow(
  target: { patientId: string; documentId?: string | null },
  fileCount: number,
  outcome: CleanupOutcome,
): CleanupAuditRow {
  const files = `${fileCount} attachment${fileCount === 1 ? "" : "s"}`;
  return {
    user_id: null,
    patient_id: target.patientId,
    document_id: target.documentId ?? null,
    record_type: target.documentId ? "document" : "patient",
    record_id: target.documentId ?? target.patientId,
    action: outcome === "completed" ? "attachment_cleanup_completed" : "attachment_cleanup_pending",
    description:
      outcome === "completed"
        ? `Removed ${files} from storage`
        : `Storage removal of ${files} failed; queued for retry`,
  };
}

export interface CleanupAuditClient {
  from(table: "audit_logs"): {
    insert(row: CleanupAuditRow): PromiseLike<{ error: { message: string } | null }>;
  };
}

// Best-effort by design: the deletion and its "queued" event are already
// committed, so failing to write this follow-up must not turn a successful
// delete into an error response. It can only leave the record saying
// "queued", which remains true.
export async function recordCleanupOutcome(
  admin: CleanupAuditClient,
  target: { patientId: string; documentId?: string | null },
  fileCount: number,
  outcome: CleanupOutcome,
): Promise<void> {
  try {
    await admin.from("audit_logs").insert(cleanupAuditRow(target, fileCount, outcome));
  } catch {
    // See comment above.
  }
}

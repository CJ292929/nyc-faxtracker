export type DeleteDocumentInput = { documentId: string };

export type DeleteDocumentResult =
  | {
      ok: true;
      documentId: string;
      patientId: string;
      attemptsDeleted: number;
      filesDeleted: number;
      storagePaths: string[];
    }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal shape of the caller-scoped Supabase client this flow needs, so
// tests can supply fakes without touching the network or real credentials.
export interface DeleteDocumentRpcClient {
  rpc(
    fn: "delete_document",
    args: { _document_id: string },
  ): PromiseLike<{
    data:
      | {
          document_id: string;
          patient_id: string;
          attempts_deleted: number;
          files_deleted: number;
          storage_paths: string[] | null;
        }[]
      | null;
    error: { message: string } | null;
  }>;
}

// The database function is the sole source of truth for these checks (it
// re-verifies the caller's role from auth.uid(), not anything the browser
// sent); these prefixes are its distinguishing error codes.
function friendlyError(message: string): string {
  if (message.startsWith("FORBIDDEN"))
    return "Only admin or staff accounts can delete documents.";
  if (message.startsWith("NOT_FOUND")) return "That document no longer exists.";
  return "Unable to delete this document. Please try again.";
}

export async function deleteDocument(
  data: DeleteDocumentInput,
  client: DeleteDocumentRpcClient,
): Promise<DeleteDocumentResult> {
  if (!UUID_RE.test(data.documentId)) {
    return { ok: false, error: "Invalid document." };
  }

  const { data: rows, error } = await client.rpc("delete_document", {
    _document_id: data.documentId,
  });
  if (error) {
    return { ok: false, error: friendlyError(error.message) };
  }
  const row = rows?.[0];
  if (!row) {
    return { ok: false, error: "Unable to delete this document. Please try again." };
  }
  return {
    ok: true,
    documentId: row.document_id,
    patientId: row.patient_id,
    attemptsDeleted: row.attempts_deleted,
    filesDeleted: row.files_deleted,
    storagePaths: row.storage_paths ?? [],
  };
}

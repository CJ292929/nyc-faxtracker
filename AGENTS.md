<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep patient records, fax history, and uploads in Lovable Cloud with staff-gated row and private-file policies; medical data must never use browser-only persistence.
- Keep the patient-first interface in a shared authenticated shell with dedicated content routes; this preserves direct navigation and route-specific metadata.
- Demo records are database-seeded with `is_demo`, not recreated by page loads; this keeps preview data distinct from actual records.

- Patient profile creation, editing, and permanent delete are allowed for both admin and staff; anonymous and role-less accounts are denied server-side. Delete is permanent: `public.delete_patient_permanently` (SECURITY DEFINER, re-checks the caller's role from `auth.uid()`) atomically removes the patient, their documents, fax attempts, correction history, and file records, records a minimal audit event, and queues attachment storage paths in `patient_file_cleanup_queue` for durable removal (drained by `scripts/retry-patient-file-cleanup.mjs`). There is no restore.
- Reports export from the currently filtered client-side dataset to CSV, Excel, and PDF; this mirrors visible records without a separate reporting service.
- Document Type "Other" stores the trimmed custom text directly in `documents.document_type` (never the literal "Other"); the edit form reconstructs Other from any non-predefined value, and the "Other" filter matches every non-predefined type. Rules (trim, required, max 100, not "Other") live in `src/lib/document-type.ts` and are enforced server-side by the `validate_document_type` trigger (0021), which only checks inserts and actual type changes so legacy values are never rewritten.
- Incoming faxes ("Record Received Fax", patient profile or Fax Tracker) are `documents` rows with `direction = 'incoming'` (0022); every other row is `'outgoing'` (the column default, never inferred from `received`). Sender details reuse `received_from` / `received_fax` / `received_date`; recipient fields stay NULL and `fax_attempts` are rejected for incoming rows, so nothing outbound is fabricated. `validate_document_direction` enforces received + received time + sender, no recipient, and immutable direction for every caller. "Mark Received" (ReceivedForm) remains the response to an outgoing fax. Rules live in `src/lib/incoming-fax.ts`; outbound totals (sent/attempts/failed/awaiting response) never count incoming rows.

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/lib/app-context";
import { Field, MdContactFields, Modal } from "@/components/forms";
import { PatientInfoCard } from "@/components/patient-info";
import {
  documentTypeFormState,
  documentTypeOptions,
  DOCUMENT_TYPE_MAX_LENGTH,
  OTHER_DOCUMENT_TYPE,
} from "@/lib/document-type";
import {
  buildIncomingFaxPayload,
  matchesPatientQuery,
  SENDER_NAME_MAX_LENGTH,
} from "@/lib/incoming-fax";
import {
  activePatients,
  canManagePatients,
  mdSuggestions,
  nameOf,
  type Document,
  type Patient,
} from "@/lib/fax";

// P3-P21 "Record Received Fax": records a fax the clinic RECEIVED from an
// outside provider with no prior outgoing fax. Creates one documents row with
// direction = 'incoming' (no fax_attempts, no recipient fields -- see
// src/lib/incoming-fax.ts and 0022). Distinct from ReceivedForm ("Mark
// Received"), which records a response to one of OUR outgoing faxes.
//
// Attachment: optional, uploaded with the existing private patient-documents
// bucket + document_files workflow after the document row exists. A
// document_files row is written only after the storage upload succeeds. If
// the upload fails the saved fax is kept and the dialog switches to a retry
// step that only re-uploads the file, so retrying never creates a second
// document.

const ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "doc", "docx"];
const localNow = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const toLocalInput = (iso: string | null | undefined) =>
  iso
    ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : localNow();
const fileProblem = (file: File | null) => {
  if (!file) return null;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension && ALLOWED_EXTENSIONS.includes(extension)
    ? null
    : "Choose a PDF, image, or Word document.";
};

async function attachFile(document: { id: string; patient_id: string }, file: File) {
  const path = `${document.patient_id}/${document.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const upload = await supabase.storage
    .from("patient-documents")
    .upload(path, file, { contentType: file.type });
  if (upload.error) return upload.error.message;
  const recorded = await supabase.from("document_files").insert({
    document_id: document.id,
    file_name: file.name,
    storage_path: path,
    file_type: file.type,
  });
  if (recorded.error) {
    // Don't leave an unrecorded object behind.
    await supabase.storage.from("patient-documents").remove([path]);
    return recorded.error.message;
  }
  return null;
}

function PatientPicker({
  patients,
  value,
  onChange,
}: {
  patients: Patient[];
  value: Patient | null;
  onChange: (p: Patient | null) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = patients.filter((p) => matchesPatientQuery(p, query)).slice(0, 8);
  if (value)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <strong>{nameOf(value)}</strong>{" "}
          <span className="text-muted-foreground">· {value.patient_id}</span>
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
          Change patient
        </Button>
      </div>
    );
  return (
    <div>
      <label className="block">
        <span className="field-label">Patient</span>
        <div className="relative">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            className="field pl-9"
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls="incoming-patient-results"
            placeholder="Search by name, Patient ID or Member ID"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </label>
      <ul
        id="incoming-patient-results"
        role="listbox"
        aria-label="Matching patients"
        className="mt-2 max-h-56 divide-y overflow-y-auto rounded-md border"
      >
        {matches.length ? (
          matches.map((p) => (
            <li key={p.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="block w-full px-3 py-2.5 text-left text-sm hover:bg-muted"
                onClick={() => onChange(p)}
              >
                <span className="font-semibold">{nameOf(p)}</span>{" "}
                <span className="text-muted-foreground">· {p.patient_id}</span>
              </button>
            </li>
          ))
        ) : (
          <li className="px-3 py-2.5 text-sm text-muted-foreground">No matching patients.</li>
        )}
      </ul>
    </div>
  );
}

export function IncomingFaxForm({
  patient: fixedPatient,
  document,
  onClose,
  onSaved,
}: {
  /** Preselected patient (patient profile). Omit to show the patient search. */
  patient?: Patient;
  /** Existing incoming fax to edit. */
  document?: Document;
  onClose: () => void;
  onSaved?: (documentId: string) => void;
}) {
  const { refresh, documents, patients, role } = useApp();
  const [busy, setBusy] = useState(false);
  const [patient, setPatient] = useState<Patient | null>(fixedPatient ?? null);
  const initialType = documentTypeFormState(document?.document_type ?? "Initial Evaluation");
  const [type, setType] = useState(initialType.selection);
  const [customType, setCustomType] = useState(initialType.custom);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  // Set once the document row exists but its attachment failed.
  const [saved, setSaved] = useState<{ id: string; patient_id: string } | null>(null);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const mdOptions = mdSuggestions(documents, patient);

  async function finish(id: string, message: string) {
    toast.success(message);
    await refresh();
    onSaved?.(id);
    onClose();
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!canManagePatients(role)) {
      setError("Only admin or staff accounts can record received faxes.");
      return;
    }
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "");
    const built = buildIncomingFaxPayload({
      patientId: patient?.id,
      documentTypeSelection: type,
      documentTypeCustom: customType,
      documentNumber: s("document_number"),
      documentDate: s("document_date"),
      receivedAt: s("received_date"),
      senderName: s("received_from"),
      senderFax: s("received_fax"),
      mdName: s("md_name"),
      mdNpi: s("md_npi"),
      mdOfficePhone: s("md_office_phone"),
      mdFax: s("md_fax"),
      notes: s("notes"),
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const badFile = fileProblem(file);
    if (badFile) {
      setError(badFile);
      return;
    }
    setBusy(true);
    const result = document
      ? await supabase
          .from("documents")
          .update(built.value)
          .eq("id", document.id)
          .select("id,patient_id")
          .single()
      : await supabase.from("documents").insert(built.value).select("id,patient_id").single();
    if (result.error || !result.data) {
      setBusy(false);
      setError(result.error?.message ?? "The received fax could not be saved.");
      return;
    }
    if (!document && file) {
      const attachError = await attachFile(result.data, file);
      if (attachError) {
        // No refresh() here: it swaps the page for "Loading records…", which
        // would unmount this dialog and lose the retry step (and a second
        // Save would then create a duplicate). The list refreshes when the
        // retry step is finished or closed.
        setBusy(false);
        setSaved(result.data);
        setRetryFile(file);
        return;
      }
    }
    setBusy(false);
    await finish(
      result.data.id,
      document
        ? "Received fax updated."
        : file
          ? "Received fax recorded with attachment."
          : "Received fax recorded.",
    );
  }

  async function retry() {
    if (!saved || !retryFile || busy) return;
    const badFile = fileProblem(retryFile);
    if (badFile) {
      setError(badFile);
      return;
    }
    setBusy(true);
    setError("");
    const attachError = await attachFile(saved, retryFile);
    setBusy(false);
    if (attachError) {
      setError(`Attachment upload failed again: ${attachError}`);
      return;
    }
    await finish(saved.id, "Attachment uploaded.");
  }

  async function finishWithoutAttachment() {
    if (!saved || busy) return;
    toast.message("Received fax saved without an attachment.");
    await refresh();
    onSaved?.(saved.id);
    onClose();
  }

  if (saved)
    return (
      <Modal
        title="Received fax saved — attachment not uploaded"
        onClose={() => void finishWithoutAttachment()}
      >
        <div className="space-y-5">
          <p className="text-sm">
            The received fax was saved, but the attachment did not upload. No file is attached yet.
            Retry the upload below; retrying will not create another fax record.
          </p>
          <label className="block">
            <span className="field-label">Attachment</span>
            <input
              className="field"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
              onChange={(e) => setRetryFile(e.target.files?.[0] ?? null)}
            />
            {retryFile && (
              <span className="mt-1 block text-xs text-muted-foreground">
                Selected: {retryFile.name}
              </span>
            )}
          </label>
          {error && (
            <p role="alert" className="text-sm font-semibold text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-5">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void finishWithoutAttachment()}
            >
              Finish without attachment
            </Button>
            <Button type="button" disabled={busy || !retryFile} onClick={retry}>
              {busy ? "Uploading…" : "Retry upload"}
            </Button>
          </div>
        </div>
      </Modal>
    );

  const selectable = activePatients(patients);
  return (
    <Modal title={document ? "Edit received fax" : "Record received fax"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-6" noValidate>
        <p className="text-sm text-muted-foreground">
          For a fax the clinic received from an outside provider. No outgoing fax or fax attempt is
          needed or created.
        </p>
        <div>
          <h3 className="mb-4 text-xs font-extrabold uppercase text-primary">
            Patient information
          </h3>
          {!fixedPatient && !document && (
            <div className="mb-4">
              <PatientPicker patients={selectable} value={patient} onChange={setPatient} />
            </div>
          )}
          {patient && <PatientInfoCard patient={patient} />}
        </div>
        <div className="border-t pt-5">
          <h3 className="mb-4 text-xs font-extrabold uppercase text-primary">Received fax</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="field-label">Document type</span>
              <select
                className="field"
                name="document_type"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {documentTypeOptions.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            {type === OTHER_DOCUMENT_TYPE && (
              <label className="block min-w-0">
                <span className="field-label">Specify document type</span>
                <input
                  className="field"
                  name="document_type_other"
                  required
                  maxLength={DOCUMENT_TYPE_MAX_LENGTH}
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value)}
                  onBlur={(e) => setCustomType(e.target.value.trim())}
                  placeholder="e.g. Referral"
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Required · up to {DOCUMENT_TYPE_MAX_LENGTH} characters
                </span>
              </label>
            )}
            {(type === "Initial Evaluation" || type === "Progress Note") && (
              <Field
                label="Document number"
                name="document_number"
                type="number"
                defaultValue={document?.document_number?.toString()}
              />
            )}
            <Field
              label="Received date & time"
              name="received_date"
              type="datetime-local"
              required
              defaultValue={toLocalInput(document?.received_date)}
            />
            <Field
              label="Document date"
              name="document_date"
              type="date"
              defaultValue={document?.document_date}
            />
          </div>
        </div>
        <div className="border-t pt-5">
          <h3 className="mb-4 text-xs font-extrabold uppercase text-primary">Sender / provider</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="field-label">Sender / provider name</span>
              <input
                className="field"
                name="received_from"
                required
                maxLength={SENDER_NAME_MAX_LENGTH}
                defaultValue={document?.received_from ?? ""}
                placeholder="Who sent this fax"
              />
            </label>
            <Field
              label="Sender fax number"
              name="received_fax"
              type="tel"
              defaultValue={document?.received_fax}
            />
            <MdContactFields
              key={patient?.id ?? "none"}
              mdField={{
                label: "Provider",
                name: "md_name",
                placeholder: "Provider this document is for",
                suggestions: mdOptions,
              }}
              npiField={{ label: "Provider NPI", name: "md_npi" }}
              officePhoneField={{ label: "Provider Office Number", name: "md_office_phone" }}
              faxField={{ label: "Provider Fax Number", name: "md_fax" }}
              mdValue={document ? document.md_name : patient?.referring_physician}
              npiValue={document ? document.md_npi : patient?.referring_physician_npi}
              officePhoneValue={
                document ? document.md_office_phone : patient?.referring_physician_office_phone
              }
              faxValue={document ? document.md_fax : patient?.referring_physician_fax}
            />
          </div>
          <div className="mt-4">
            <Field label="Notes" name="notes" type="textarea" defaultValue={document?.notes} />
          </div>
        </div>
        {!document && (
          <div className="border-t pt-5">
            <label className="block">
              <span className="field-label">Attach received fax (optional)</span>
              <input
                className="field"
                type="file"
                name="attachment"
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                PDF, image, or Word document. Stored privately with the patient's records.
              </span>
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm font-semibold text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t pt-5">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={busy}>
            {busy ? "Saving…" : document ? "Save Changes" : "Save Received Fax"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

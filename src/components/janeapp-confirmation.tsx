import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/lib/app-context";
import { canManagePatients, type Document } from "@/lib/fax";
import {
  JANEAPP_CHOICES,
  JANEAPP_FIELD_LABEL,
  janeAppAlertOf,
  janeAppChoiceOf,
  janeAppStatusText,
  janeAppValueOf,
} from "@/lib/janeapp";

// Status badge: icon + text, never color alone.
export function JaneAppBadge({ value }: { value: boolean | null | undefined }) {
  const confirmed = value === true;
  const Icon = confirmed ? CheckCircle2 : AlertTriangle;
  return (
    <span
      data-testid="janeapp-badge"
      data-janeapp={janeAppChoiceOf(value)}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-bold ${confirmed ? "bg-success/10 text-success" : value === false ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"}`}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {janeAppStatusText(value)}
    </span>
  );
}

// Document record section: alert, saved status and the Yes/No/Unconfirmed
// control. The displayed status always comes from the saved record (shared
// app data), so a failed save leaves the previous status and alert in place.
export function JaneAppConfirmation({ document }: { document: Document }) {
  const { refresh, role } = useApp();
  const saved = document.janeapp_uploaded;
  const [choice, setChoice] = useState(janeAppChoiceOf(saved));
  const [busy, setBusy] = useState(false);
  // Follow the saved value when the record reloads or changes elsewhere.
  useEffect(() => setChoice(janeAppChoiceOf(saved)), [saved]);
  const alert = janeAppAlertOf(saved);
  const canEdit = canManagePatients(role);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    let value: boolean | null;
    try {
      value = janeAppValueOf(choice);
    } catch (err) {
      toast.error((err as Error).message);
      return;
    }
    setBusy(true);
    // .select() returns the updated row: an RLS-filtered update affects zero
    // rows without an error, which must not look like a successful save.
    const { data, error } = await supabase
      .from("documents")
      .update({ janeapp_uploaded: value })
      .eq("id", document.id)
      .select("id, janeapp_uploaded");
    setBusy(false);
    if (error || !data?.length) {
      toast.error(
        `JaneApp confirmation was not saved${error ? `: ${error.message}` : "."} The previous status is unchanged.`,
      );
      setChoice(janeAppChoiceOf(saved));
      return;
    }
    toast.success(`${JANEAPP_FIELD_LABEL} saved as ${janeAppChoiceOf(data[0]?.janeapp_uploaded)}.`);
    await refresh();
  }

  return (
    <section className="rounded-md border bg-card p-6" aria-labelledby="janeapp-heading">
      <h2 id="janeapp-heading" className="page-title mb-2 text-lg">
        JaneApp Upload Confirmation
      </h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Upload the file directly in JaneApp, then confirm it here. This is separate from FaxTracker
        attachments and the patient-system upload status.
      </p>
      {alert && (
        <div
          role="alert"
          data-testid="janeapp-alert"
          className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm font-semibold text-warning"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{alert}</span>
        </div>
      )}
      <div className="mb-4 text-sm">
        <div className="field-label">Saved status</div>
        <JaneAppBadge value={saved} />
      </div>
      {canEdit && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className="block min-w-48 flex-1 sm:flex-none">
            <span className="field-label">{JANEAPP_FIELD_LABEL}</span>
            <select
              className="field"
              name="janeapp_uploaded"
              value={choice}
              onChange={(e) => setChoice(e.target.value as typeof choice)}
            >
              {JANEAPP_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <Button className="h-11 sm:h-9" disabled={busy || choice === janeAppChoiceOf(saved)}>
            {busy ? "Saving…" : "Save JaneApp Confirmation"}
          </Button>
        </form>
      )}
    </section>
  );
}

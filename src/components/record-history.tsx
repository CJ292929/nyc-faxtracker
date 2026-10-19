import { useCallback, useEffect, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/forms";
import { supabase } from "@/integrations/supabase/client";
import {
  actionLabel,
  actorLabel,
  attributionLabel,
  changeRows,
  dateTimeWithZone,
  fetchRecordHistory,
  fetchRemovedActors,
  type AuditRpcClient,
  type HistoryEvent,
  type HistoryRecordType,
} from "@/lib/audit-history";

// The database functions behind these calls re-check the caller from
// auth.uid() and the record's existence; this cast only bridges supabase-js's
// generic rpc() typing to the narrow interface the helpers are written for.
const rpcClient = supabase as unknown as AuditRpcClient;

type AttributedRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_name: string | null;
  created_by_kind: string;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_by_kind: string;
};

export function RecordAttribution({
  recordType,
  record,
  title,
}: {
  recordType: HistoryRecordType;
  record: AttributedRecord;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    void fetchRemovedActors(rpcClient, [record.created_by, record.updated_by]).then((ids) => {
      if (live) setRemoved(ids);
    });
    return () => {
      live = false;
    };
  }, [record.created_by, record.updated_by]);
  const createdBy = attributionLabel(
    record.created_by_kind,
    record.created_by_name,
    !!record.created_by && removed.has(record.created_by),
  );
  const updatedBy = attributionLabel(
    record.updated_by_kind,
    record.updated_by_name,
    !!record.updated_by && removed.has(record.updated_by),
  );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
      <span>
        Created by <strong className="text-foreground">{createdBy}</strong>
        {" · "}
        {dateTimeWithZone(record.created_at)}
      </span>
      <span>
        Last updated by <strong className="text-foreground">{updatedBy}</strong>
        {record.updated_by_kind !== "unknown" && <> · {dateTimeWithZone(record.updated_at)}</>}
      </span>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <History /> View History
      </Button>
      {open && (
        <HistoryDialog
          recordType={recordType}
          recordId={record.id}
          title={title}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

const UPDATE_ACTIONS = new Set([
  "patients_update",
  "documents_update",
  "document_received_updated",
  "document_upload_updated",
  "fax_attempt_corrected",
]);

function contextFor(recordType: HistoryRecordType, e: HistoryEvent): string | null {
  const attempt = e.attempt_number ? `Attempt #${e.attempt_number}` : "Fax attempt";
  if (recordType === "document") {
    if (e.record_type === "fax_attempt") return attempt;
    if (e.record_type === "document_file") return "Attachment";
    return null;
  }
  const doc = e.document_label ?? (e.document_id ? "Deleted document" : null);
  if (e.record_type === "fax_attempt") return doc ? `${attempt} · ${doc}` : attempt;
  if (e.record_type === "document_file") return doc ? `Attachment · ${doc}` : "Attachment";
  if (e.record_type === "document") return doc;
  return null;
}

export function HistoryDialog({
  recordType,
  recordId,
  title,
  onClose,
}: {
  recordType: HistoryRecordType;
  recordId: string;
  title: string;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError("");
      const result = await fetchRecordHistory(rpcClient, recordType, recordId, offset);
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEvents((prev) => (offset === 0 ? result.rows : [...prev, ...result.rows]));
      setTotal(result.total);
    },
    [recordType, recordId],
  );
  useEffect(() => {
    void load(0);
  }, [load]);
  return (
    <Modal title={`History · ${title}`} onClose={onClose}>
      <p className="mb-4 text-xs text-muted-foreground">
        {recordType === "patient"
          ? "Changes to this patient and to its documents, fax attempts, and attachments, newest first."
          : "Changes to this document and to its fax attempts and attachments, newest first."}{" "}
        Times are shown in your local time zone.
      </p>
      <div
        className="max-h-[55vh] overflow-y-auto rounded-md border"
        role="region"
        aria-label="Record history"
        tabIndex={0}
      >
        {events.length === 0 && loading && (
          <p className="p-6 text-center text-sm text-muted-foreground">Loading history…</p>
        )}
        {events.length === 0 && !loading && !error && (
          <p className="p-6 text-center text-sm text-muted-foreground">No recorded history yet.</p>
        )}
        {events.length > 0 && (
          <ol className="divide-y">
            {events.map((e) => {
              const rows = changeRows(e.record_type, e.changes);
              const context = contextFor(recordType, e);
              return (
                <li key={e.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-bold">{actionLabel(e)}</span>
                    <time className="text-xs text-muted-foreground" dateTime={e.created_at}>
                      {dateTimeWithZone(e.created_at)}
                    </time>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    By{" "}
                    <strong className="text-foreground">
                      {actorLabel(e.actor_username, e.actor_kind, e.actor_account_removed)}
                    </strong>
                    {context && <> · {context}</>}
                  </div>
                  {rows.length > 0 && (
                    <dl className="mt-2 space-y-1 text-xs">
                      {rows.map((r) => (
                        <div
                          key={r.field}
                          className="grid gap-x-2 sm:grid-cols-[11rem_minmax(0,1fr)]"
                        >
                          <dt className="font-semibold text-muted-foreground">{r.label}</dt>
                          <dd className="min-w-0 break-words">
                            {r.from !== null && (
                              <>
                                <span className="text-muted-foreground line-through">{r.from}</span>
                                {" → "}
                              </>
                            )}
                            <span>{r.to}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {rows.length === 0 && UPDATE_ACTIONS.has(e.action) && (
                    <p className="mt-1 text-xs italic text-muted-foreground">
                      Field details were not recorded for this event.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {error && (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-sm">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load(events.length)}>
              Try again
            </Button>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {events.length > 0 ? `Showing ${events.length} of ${total}` : loading ? "" : "0 events"}
        </span>
        {events.length < total && !error && (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void load(events.length)}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

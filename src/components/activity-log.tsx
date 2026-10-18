import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  ACTION_LABELS,
  ACTIVITY_PAGE_SIZE,
  RECORD_TYPE_LABELS,
  SYSTEM_ACTOR,
  actionLabel,
  actorLabel,
  changeRows,
  dateTimeWithZone,
  eventContext,
  fetchActivity,
  fetchActors,
  type ActivityEvent,
  type ActivityFilters,
  type AuditActor,
  type AuditRpcClient,
} from "@/lib/audit-history";

// get_audit_activity / list_audit_actors re-check the admin role from
// auth.uid() in the database on every call; this component is only the view.
const rpcClient = supabase as unknown as AuditRpcClient;

const EMPTY_FILTERS: ActivityFilters = { actor: "", from: "", to: "", action: "", recordType: "" };

function Details({ event }: { event: ActivityEvent }) {
  if (event.record_type === "account") return <span>{event.description ?? "—"}</span>;
  const rows = changeRows(event.record_type, event.changes);
  if (!rows.length) return <span className="text-muted-foreground">—</span>;
  const shown = rows.slice(0, 3);
  return (
    <ul className="space-y-0.5">
      {shown.map((r) => (
        <li key={r.field} className="break-words">
          <span className="font-semibold">{r.label}:</span> {r.from !== null && <>{r.from} → </>}
          {r.to}
        </li>
      ))}
      {rows.length > shown.length && (
        <li className="text-muted-foreground">+{rows.length - shown.length} more field(s)</li>
      )}
    </ul>
  );
}

function RecordCell({ event }: { event: ActivityEvent }) {
  if (event.record_type === "account") return <span>Account</span>;
  const context = eventContext(event);
  const patient = event.patient_code ?? (event.patient_id ? "Deleted patient" : null);
  return (
    <div className="space-y-0.5">
      {patient &&
        (event.patient_code && event.patient_id ? (
          <Link
            to="/patients/$patientId"
            params={{ patientId: event.patient_id }}
            className="font-semibold text-primary hover:underline"
          >
            {patient}
          </Link>
        ) : (
          <div className="text-muted-foreground">{patient}</div>
        ))}
      {context &&
        (event.document_id &&
        event.document_label &&
        !event.action.endsWith("_deleted_permanently") ? (
          <Link
            to="/documents/$documentId"
            params={{ documentId: event.document_id }}
            className="block hover:text-primary"
          >
            {context}
          </Link>
        ) : (
          <div>{context}</div>
        ))}
      {!patient && !context && <span className="text-muted-foreground">—</span>}
    </div>
  );
}

export function ActivityLog({ refreshKey }: { refreshKey: number }) {
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actors, setActors] = useState<AuditActor[]>([]);

  useEffect(() => {
    void fetchActors(rpcClient).then((r) => {
      if (r.ok) setActors(r.actors);
    });
  }, [refreshKey]);

  const load = useCallback(async () => {
    if (filters.from && filters.to && filters.from > filters.to) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const result = await fetchActivity(rpcClient, filters, page * ACTIVITY_PAGE_SIZE);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      setRows([]);
      setTotal(0);
      return;
    }
    setRows(result.rows);
    setTotal(result.total);
  }, [filters, page]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function update(patch: Partial<ActivityFilters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  }

  const invalidRange = !!filters.from && !!filters.to && filters.from > filters.to;
  const first = total ? page * ACTIVITY_PAGE_SIZE + 1 : 0;
  const last = Math.min(total, (page + 1) * ACTIVITY_PAGE_SIZE);
  const filtered = Object.values(filters).some(Boolean);

  return (
    <section className="mt-8">
      <h2 className="page-title mb-4 text-lg">Audit Activity</h2>
      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block min-w-0">
          <span className="field-label">Account</span>
          <select
            className="field"
            value={filters.actor}
            onChange={(e) => update({ actor: e.target.value })}
          >
            <option value="">All accounts</option>
            <option value="system">{SYSTEM_ACTOR}</option>
            {actors.map((a) => (
              <option key={a.user_id} value={a.user_id}>
                {a.username ?? "Removed account"}
                {a.account_removed ? " (account removed)" : a.role ? ` (${a.role})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="field-label">From</span>
          <input
            className="field"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => update({ from: e.target.value })}
          />
        </label>
        <label className="block min-w-0">
          <span className="field-label">To</span>
          <input
            className="field"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => update({ to: e.target.value })}
          />
        </label>
        <label className="block min-w-0">
          <span className="field-label">Action</span>
          <select
            className="field"
            value={filters.action}
            onChange={(e) => update({ action: e.target.value })}
          >
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="field-label">Record type</span>
          <select
            className="field"
            value={filters.recordType}
            onChange={(e) => update({ recordType: e.target.value })}
          >
            <option value="">All record types</option>
            {Object.entries(RECORD_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {invalidRange
            ? "The From date must be on or before the To date."
            : loading
              ? "Loading activity…"
              : error
                ? ""
                : total
                  ? `Showing ${first}–${last} of ${total} · times in your local time zone`
                  : ""}
        </span>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => update(EMPTY_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>
      <div
        className="table-wrap max-h-[480px] overflow-y-auto"
        tabIndex={0}
        role="region"
        aria-label="Audit activity log"
        aria-busy={loading}
      >
        {error ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-sm">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 && !loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {filtered ? "No activity matches these filters." : "No audit activity yet."}
          </p>
        ) : (
          <table className={`data-table ${loading ? "opacity-60" : ""}`}>
            <thead className="sticky top-0 z-10 bg-card">
              <tr>
                <th>Date & time</th>
                <th>Account</th>
                <th>Action</th>
                <th>Record</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && loading && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-muted-foreground">
                    Loading activity…
                  </td>
                </tr>
              )}
              {rows.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap">{dateTimeWithZone(e.created_at)}</td>
                  <td>{actorLabel(e.actor_username, e.actor_kind, e.actor_account_removed)}</td>
                  <td>{actionLabel(e)}</td>
                  <td>
                    <RecordCell event={e} />
                  </td>
                  <td className="max-w-[22rem] text-xs">
                    <Details event={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={loading || page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || last >= total}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </section>
  );
}

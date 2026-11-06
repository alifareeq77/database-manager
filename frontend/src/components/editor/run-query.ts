import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import type { Connection, ExecuteResult } from "@/lib/types";
import { useResults } from "@/stores/results";
import { useConnections } from "@/stores/connections";

function newQueryId() {
  return (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

const DDL_RE = /^\s*(create|alter|drop|rename|truncate|comment)\b/im;

/** Execute SQL for an editor tab and route results to the bottom panel and execution log. */
export async function runQuery(tabId: string, conn: Connection, database: string | null, sql: string, maxRows: number): Promise<ExecuteResult | null> {
  const store = useResults.getState();
  if (store.runs[tabId]?.running) return null;
  const queryId = newQueryId();
  store.start(tabId, queryId, sql);
  store.showBottom("results");
  try {
    const res = await api.query.execute(conn.id, { sql, database, query_id: queryId, max_rows: maxRows });
    useResults.getState().finish(tabId, res);
    const failed = res.results.find((r) => r.error);
    const last = res.results[res.results.length - 1];
    if (res.status === "success") {
      const summary = last?.returns_rows ? `${last.row_count ?? 0} row(s)` : last?.row_count !== null && last?.row_count !== undefined ? `${last.row_count} row(s) affected` : "OK";
      store.log({ level: "success", message: `${res.results.length > 1 ? `${res.results.length} statements · ` : ""}${summary}`, detail: sql, durationMs: res.duration_ms, connectionName: conn.name });
    } else {
      store.log({ level: res.status === "cancelled" ? "warning" : "error", message: failed?.error ?? res.status, detail: failed?.statement, durationMs: res.duration_ms, connectionName: conn.name });
    }
    if (res.results.some((r) => r.truncated)) {
      store.log({ level: "warning", message: `Result truncated to ${maxRows} rows. Use Export for the full result.`, connectionName: conn.name });
    }
    if (DDL_RE.test(sql) && res.status === "success") useConnections.getState().invalidateCatalog(conn.id);
    if (res.status === "cancelled") toast.info("Query cancelled", { description: formatDuration(res.duration_ms) });
    return res;
  } catch (e) {
    const msg = (e as Error).message;
    useResults.getState().finish(tabId, null, msg);
    store.log({ level: "error", message: msg, detail: sql, connectionName: conn.name });
    return null;
  }
}

export async function cancelQuery(tabId: string) {
  const run = useResults.getState().runs[tabId];
  if (!run?.running) return;
  try {
    const { cancelled } = await api.query.cancel(run.queryId);
    if (!cancelled) toast.info("The query could not be cancelled (it may have just finished).");
  } catch (e) {
    toast.error((e as Error).message);
  }
}

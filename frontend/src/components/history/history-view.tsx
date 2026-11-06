"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleSlash, Copy, History, Loader2, Pin, PinOff, RefreshCw, Search, SquareTerminal, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { formatDuration, formatNumber, relativeTime, utcDate } from "@/lib/format";
import type { HistoryItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { confirmAction } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { copyText } from "@/components/explorer/object-actions";

const PAGE = 50;

export function HistoryView() {
  const connections = useConnections((s) => s.connections);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [connectionId, setConnectionId] = useState("all");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [listKey, setListKey] = useState(0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <History className="ml-1 size-4 text-muted-foreground" />
        <span className="mr-2 font-medium">Query history</span>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search SQL" className="h-7 w-60 pl-7 text-[12px]" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="h-7 w-[112px] text-[12px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[12px]">Any status</SelectItem>
            <SelectItem value="success" className="text-[12px]">Succeeded</SelectItem>
            <SelectItem value="error" className="text-[12px]">Failed</SelectItem>
            <SelectItem value="cancelled" className="text-[12px]">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={connectionId} onValueChange={setConnectionId}>
          <SelectTrigger size="sm" className="h-7 max-w-48 text-[12px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[12px]">All connections</SelectItem>
            {connections.map((c) => <SelectItem key={c.id} value={c.id} className="text-[12px]">{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant={pinnedOnly ? "secondary" : "ghost"} size="sm" onClick={() => setPinnedOnly((v) => !v)}><Pin /> Pinned</Button>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setListKey((k) => k + 1)} aria-label="Refresh"><RefreshCw /></Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={async () => {
              const ok = await confirmAction({ title: "Clear query history?", description: "Removes all unpinned history entries for your account.", confirmText: "Clear history", destructive: true });
              if (!ok) return;
              try {
                await api.history.clear();
                setListKey((k) => k + 1);
                toast.success("History cleared");
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            <Trash2 /> Clear
          </Button>
        </div>
      </div>
      <HistoryList
        key={listKey}
        q={q}
        status={status === "all" ? undefined : status}
        connectionId={connectionId === "all" ? undefined : connectionId}
        pinned={pinnedOnly ? true : undefined}
      />
    </div>
  );
}

/** Paged history list. Used full-size in the History tab and compact in the bottom panel. */
export function HistoryList({ q = "", status, connectionId, pinned, compact = false }: { q?: string; status?: string; connectionId?: string; pinned?: boolean; compact?: boolean }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const fetchPage = useCallback(async (offset: number) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await api.history.list({ q: q.trim() || undefined, status, connection_id: connectionId, pinned, limit: compact ? 30 : PAGE, offset });
      if (id !== reqId.current) return;
      setItems((prev) => (offset ? [...prev, ...res.items] : res.items));
      setTotal(res.total);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError((e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [q, status, connectionId, pinned, compact]);

  // Debounce typing in the search box.
  useEffect(() => {
    const t = setTimeout(() => void fetchPage(0), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [fetchPage, q]);

  async function togglePin(h: HistoryItem) {
    try {
      const updated = await api.history.pin(h.id, !h.pinned);
      setItems((list) => list.map((x) => (x.id === h.id ? updated : x)));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function open(h: HistoryItem) {
    const conn = useConnections.getState().connections.find((c) => c.id === h.connection_id);
    if (!conn) return toast.error("That connection no longer exists", { description: "Copy the SQL instead." });
    useWorkspace.getState().openQuery(conn.id, h.database ?? conn.database, h.sql, `History #${h.id}`);
  }

  if (error) return <p className="p-4 text-[12px] text-destructive">{error}</p>;
  if (!loading && !items.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-muted-foreground">
        <History className="size-5" />
        <p>{q || status || connectionId || pinned ? "No queries match these filters." : "Queries you run will show up here."}</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul className="divide-y">
        {items.map((h) => (
          <li key={h.id} className={cn("group flex items-start gap-2.5 hover:bg-accent/40", compact ? "px-2 py-1.5" : "px-3 py-2")}>
            <StatusIcon status={h.status} />
            <button className="min-w-0 flex-1 text-left" onDoubleClick={() => open(h)} title="Double-click to open in a query tab">
              <pre className={cn("overflow-hidden font-mono text-[12px] leading-[18px] text-ellipsis whitespace-pre-wrap", compact ? "line-clamp-1" : "line-clamp-3")}>{h.sql}</pre>
              <div className="mt-0.5 flex flex-wrap gap-x-2.5 text-[11px] text-muted-foreground">
                <span title={utcDate(h.executed_at).toLocaleString()}>{relativeTime(h.executed_at)}</span>
                {h.connection_name && <span>{h.connection_name}{h.database ? ` · ${h.database}` : ""}</span>}
                <span>{formatDuration(h.duration_ms)}</span>
                {h.rows !== null && <span>{formatNumber(h.rows)} row(s)</span>}
                {h.error && <span className="max-w-[60ch] truncate text-destructive" title={h.error}>{h.error}</span>}
              </div>
            </button>
            <div className={cn("flex shrink-0 items-center", !h.pinned && "opacity-0 group-hover:opacity-100 focus-within:opacity-100")}>
              <IconAction label={h.pinned ? "Unpin" : "Pin"} onClick={() => void togglePin(h)}>{h.pinned ? <PinOff className="text-primary" /> : <Pin />}</IconAction>
              <IconAction label="Copy SQL" onClick={() => void copyText(h.sql, "SQL copied")}><Copy /></IconAction>
              <IconAction label="Open in query tab" onClick={() => open(h)}><SquareTerminal /></IconAction>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-center p-2 text-[11px] text-muted-foreground">
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : items.length < total ? (
          <Button variant="ghost" size="xs" onClick={() => void fetchPage(items.length)}>Load more ({formatNumber(total - items.length)} left)</Button>
        ) : (
          <span>{formatNumber(total)} entr{total === 1 ? "y" : "ies"}</span>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: HistoryItem["status"] }) {
  if (status === "success") return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-label="Succeeded" />;
  if (status === "cancelled") return <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="Cancelled" />;
  return <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label="Failed" />;
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onClick} aria-label={label}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

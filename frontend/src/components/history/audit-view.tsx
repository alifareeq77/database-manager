"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, RefreshCw, ScrollText, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatNumber, utcDate } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useSession } from "@/components/session-context";

const PAGE = 100;
// Action prefixes the backend records; the filter matches by prefix.
const ACTIONS = [
  { value: "auth", label: "Sign-ins & passwords" },
  { value: "user", label: "User management" },
  { value: "connection", label: "Connections" },
  { value: "query", label: "Queries" },
  { value: "data", label: "Data edits, import & export" },
  { value: "schema", label: "Schema changes" },
];

function actionTone(action: string): string {
  if (action.endsWith(".failed") || action.includes("fail")) return "bg-destructive/12 text-destructive";
  if (action.startsWith("schema") || action.startsWith("data.delete")) return "bg-warning/15 text-warning";
  if (action.startsWith("auth")) return "bg-primary/12 text-primary";
  return "bg-muted text-muted-foreground";
}

export function AuditView() {
  const { user } = useSession();
  const connections = useConnections((s) => s.connections);
  const [action, setAction] = useState("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const reqId = useRef(0);

  const fetchPage = useCallback(async (offset: number) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const res = await api.audit.list({ action: action === "all" ? undefined : action, q: q.trim() || undefined, limit: PAGE, offset });
      if (id !== reqId.current) return;
      setItems((prev) => (offset ? [...prev, ...res.items] : res.items));
      setTotal(res.total);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError((e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [action, q]);

  useEffect(() => {
    const t = setTimeout(() => void fetchPage(0), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [fetchPage, q]);

  const connName = (id: string | null) => (id ? (connections.find((c) => c.id === id)?.name ?? id.slice(0, 8)) : null);
  const toggle = (id: number) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <ScrollText className="ml-1 size-4 text-muted-foreground" />
        <span className="mr-1 font-medium">Audit log</span>
        <span className="mr-2 text-[11px] text-muted-foreground">{user.role === "admin" ? "All users" : "Your activity"}</span>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by target" className="h-7 w-52 pl-7 text-[12px]" />
        </div>
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger size="sm" className="h-7 w-52 text-[12px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[12px]">All actions</SelectItem>
            {ACTIONS.map((a) => <SelectItem key={a.value} value={a.value} className="text-[12px]">{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => void fetchPage(0)} aria-label="Refresh"><RefreshCw className={cn(loading && "animate-spin")} /></Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-4 text-[12px] text-destructive">{error}</p>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 z-10 bg-surface text-[11px] text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-medium">
                <th className="w-6" /><th>Time</th><th>User</th><th>Action</th><th>Connection</th><th>Target</th><th>IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const isOpen = open.has(e.id);
                const hasDetails = Object.keys(e.details).length > 0;
                const sql = typeof e.details.sql === "string" ? e.details.sql : null;
                return (
                  <Fragment key={e.id}>
                    <tr className={cn("border-t hover:bg-accent/40 [&>td]:px-3 [&>td]:py-1.5", hasDetails && "cursor-pointer")} onClick={() => hasDetails && toggle(e.id)}>
                      <td className="text-muted-foreground">{hasDetails && <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />}</td>
                      <td className="whitespace-nowrap tabular-nums" title={utcDate(e.created_at).toISOString()}>{utcDate(e.created_at).toLocaleString()}</td>
                      <td>{e.username ?? <span className="text-muted-foreground">—</span>}</td>
                      <td><Badge variant="outline" className={cn("border-0 font-mono text-[10.5px]", actionTone(e.action))}>{e.action}</Badge></td>
                      <td className="max-w-40 truncate">{connName(e.connection_id) ?? ""}</td>
                      <td className="max-w-72 truncate font-mono" title={e.target ?? undefined}>{e.target ?? ""}</td>
                      <td className="font-mono text-muted-foreground">{e.ip ?? ""}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-surface">
                        <td />
                        <td colSpan={6} className="px-3 pt-1 pb-2.5">
                          {sql && <pre className="mb-2 max-h-60 overflow-auto rounded border bg-background p-2 font-mono text-[11.5px] whitespace-pre-wrap">{sql}</pre>}
                          <pre className="max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
                            {JSON.stringify(sql ? { ...e.details, sql: undefined } : e.details, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="flex items-center justify-center p-2 text-[11px] text-muted-foreground">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : items.length < total ? (
            <Button variant="ghost" size="xs" onClick={() => void fetchPage(items.length)}>Load more ({formatNumber(total - items.length)} left)</Button>
          ) : (
            <span>{items.length ? `${formatNumber(total)} entries` : "No audit entries match."}</span>
          )}
        </div>
      </div>
    </div>
  );
}

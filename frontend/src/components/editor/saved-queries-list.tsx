"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bookmark, ChevronRight, Copy, FileCode2, MoreHorizontal, Pencil, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import type { SavedQuery } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { safeStorage } from "@/stores/storage";
import { confirmAction } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { copyText } from "@/components/explorer/object-actions";

const OPEN_KEY = "strata.savedOpen";
export const SAVED_CHANGED = "strata:saved-changed";

function readOpen(): boolean {
  try {
    return safeStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Collapsible "Saved queries" section at the bottom of the sidebar. */
export function SavedQueriesList() {
  const [open, setOpen] = useState(readOpen);
  const [items, setItems] = useState<SavedQuery[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const activeConn = useConnections((s) => s.activeId);

  const load = useCallback(() => {
    api.saved.list().then(setItems).catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(SAVED_CHANGED, load);
    return () => window.removeEventListener(SAVED_CHANGED, load);
  }, [load]);

  const setOpenPersist = (v: boolean) => {
    setOpen(v);
    try {
      safeStorage.setItem(OPEN_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable: keep in memory only */
    }
  };

  function openSaved(s: SavedQuery) {
    const ws = useWorkspace.getState();
    const existing = ws.tabs.find((t) => t.kind === "query" && t.savedId === s.id);
    if (existing) return ws.activate(existing.id);
    const { connections } = useConnections.getState();
    const conn = connections.find((c) => c.id === s.connection_id) ?? connections.find((c) => c.id === activeConn);
    if (!conn) return toast.info("Select a connection first");
    ws.openQuery(conn.id, conn.database, s.sql, s.name, s.is_snippet ? undefined : s.id);
  }

  async function rename(s: SavedQuery, name: string) {
    setRenaming(null);
    const n = name.trim();
    if (!n || n === s.name) return;
    try {
      const updated = await api.saved.update(s.id, { name: n, sql: s.sql, description: s.description, connection_id: s.connection_id, is_snippet: s.is_snippet });
      setItems((list) => list?.map((x) => (x.id === s.id ? updated : x)) ?? null);
      // Keep the title of an open tab in sync.
      const ws = useWorkspace.getState();
      ws.tabs.filter((t) => t.kind === "query" && t.savedId === s.id).forEach((t) => ws.update(t.id, { title: n }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove(s: SavedQuery) {
    const ok = await confirmAction({ title: `Delete “${s.name}”?`, description: "The saved query is removed. Open tabs keep their SQL.", confirmText: "Delete", destructive: true });
    if (!ok) return;
    try {
      await api.saved.remove(s.id);
      setItems((list) => list?.filter((x) => x.id !== s.id) ?? null);
      const ws = useWorkspace.getState();
      ws.tabs.filter((t) => t.kind === "query" && t.savedId === s.id).forEach((t) => ws.update(t.id, { savedId: undefined }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const sorted = [...(items ?? [])].sort((a, b) => Number(a.is_snippet) - Number(b.is_snippet) || a.name.localeCompare(b.name));

  return (
    <div className="flex shrink-0 flex-col border-t">
      <button className="flex h-8 items-center gap-1.5 px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground" onClick={() => setOpenPersist(!open)} aria-expanded={open}>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Saved queries
        {items && items.length > 0 && <span className="font-normal tabular-nums">{items.length}</span>}
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto pb-1">
          {items && items.length === 0 && (
            <p className="px-4 pb-2 text-[12px] text-muted-foreground">
              Save a query from the editor with <span className="kbd">Ctrl S</span>.
            </p>
          )}
          {sorted.map((s) => (
            <div key={s.id} className="group flex h-7 items-center gap-1.5 pr-1 pl-5 hover:bg-accent">
              {s.is_snippet ? <Sparkles className="size-3.5 shrink-0 text-muted-foreground" /> : <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />}
              {renaming === s.id ? (
                <input
                  autoFocus
                  defaultValue={s.name}
                  className="h-5 min-w-0 flex-1 rounded border bg-background px-1 text-[12px] outline-none focus:ring-1 focus:ring-ring"
                  onBlur={(e) => void rename(s, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(s, e.currentTarget.value);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <button className="min-w-0 flex-1 truncate text-left text-[12.5px]" onClick={() => openSaved(s)} title={s.description ?? s.sql.slice(0, 300)}>
                  {s.name}
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`Actions for ${s.name}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => openSaved(s)}><Bookmark /> Open</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRenaming(s.id)}><Pencil /> Rename</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void copyText(s.sql, "SQL copied")}><Copy /> Copy SQL</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => void remove(s)}><Trash2 /> Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { Key, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ColumnInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

type Mode = "value" | "default" | "null";

export function InsertRowDialog({
  open, onOpenChange, columns, onSubmit, title,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  columns: ColumnInfo[];
  onSubmit: (row: Record<string, unknown>) => Promise<void>;
  title: string;
}) {
  return open ? <Inner columns={columns} onSubmit={onSubmit} onOpenChange={onOpenChange} title={title} /> : null;
}

function Inner({ columns, onSubmit, onOpenChange, title }: { columns: ColumnInfo[]; onSubmit: (row: Record<string, unknown>) => Promise<void>; onOpenChange: (o: boolean) => void; title: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [modes, setModes] = useState<Record<string, Mode>>(() =>
    Object.fromEntries(columns.map((c) => [c.name, c.is_auto_increment || c.default !== null ? "default" : c.nullable ? "null" : "value"])),
  );
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const row: Record<string, unknown> = {};
    for (const c of columns) {
      const m = modes[c.name];
      if (m === "null") row[c.name] = null;
      else if (m === "value") row[c.name] = values[c.name] ?? "";
    }
    setBusy(true);
    try {
      await onSubmit(row);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <form onSubmit={submit}>
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Values are sent as parameters and cast by the database to each column&apos;s type.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 py-4">
            {columns.map((c) => {
              const m = modes[c.name];
              return (
                <div key={c.name} className="grid grid-cols-[170px_1fr] items-start gap-3">
                  <div className="pt-1.5">
                    <div className="flex items-center gap-1 truncate font-mono text-[12px] font-medium">
                      {c.is_primary_key && <Key className="size-3 text-warning" />} {c.name}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{c.data_type}{c.nullable ? "" : " not null"}</div>
                  </div>
                  <div className="space-y-1">
                    {c.category === "json" || c.category === "text" && (c.data_type.includes("text")) ? (
                      <Textarea rows={2} disabled={m !== "value"} className="font-mono text-[12px]" value={m === "value" ? (values[c.name] ?? "") : ""}
                        placeholder={m === "default" ? `DEFAULT ${c.default ?? ""}` : m === "null" ? "NULL" : ""}
                        onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))} />
                    ) : (
                      <Input disabled={m !== "value"} className="h-8 font-mono text-[12px]" value={m === "value" ? (values[c.name] ?? "") : ""}
                        placeholder={m === "default" ? `DEFAULT${c.default ? ` ${c.default}` : ""}` : m === "null" ? "NULL" : c.category === "boolean" ? "true / false" : ""}
                        onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))} />
                    )}
                    <div className="flex gap-1">
                      {(["value", "default", "null"] as Mode[]).filter((x) => x !== "null" || c.nullable).map((x) => (
                        <button type="button" key={x} onClick={() => setModes((s) => ({ ...s, [c.name]: x }))}
                          className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", m === x ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent")}>
                          {x}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter className="border-t px-5 py-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Insert row</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

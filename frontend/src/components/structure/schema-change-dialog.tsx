"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";
import { emitDataChanged, emitObjectsChanged } from "@/lib/events";
import type { SchemaPreview } from "@/lib/types";
import { connectionById, useConnections } from "@/stores/connections";
import { useResults } from "@/stores/results";
import { useUi, type SchemaChangeRequest } from "@/stores/ui";
import { copyText } from "@/components/explorer/object-actions";

/**
 * Every structural change goes through here: the backend renders the exact SQL, the user reviews it,
 * and apply sends the previewed statements back so the server can refuse if anything drifted.
 */
export function SchemaChangeDialog() {
  const req = useUi((s) => s.schemaChange);
  // Remount per request so state never leaks between changes.
  return req ? <Inner key={JSON.stringify(req.change)} req={req} /> : null;
}

function Inner({ req }: { req: SchemaChangeRequest }) {
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const conn = connectionById(req.connectionId);
  const close = () => useUi.getState().requestSchemaChange(null);

  useEffect(() => {
    let alive = true;
    api.schema
      .preview(req.connectionId, req.database, req.change)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [req]);

  const destructive = !!preview?.destructive;
  const blocked = !preview || applying || (destructive && !confirmed) || !!conn?.read_only;

  async function apply() {
    if (!preview) return;
    setApplying(true);
    const log = useResults.getState().log;
    try {
      const res = await api.schema.apply(req.connectionId, req.database, req.change, preview.statements, destructive);
      log({ level: "success", message: req.title, detail: res.statements.join(";\n"), connectionName: conn?.name });
      toast.success(`${req.title} · done`);
      useConnections.getState().invalidateCatalog(req.connectionId);
      const target = { connectionId: req.connectionId, database: req.database, schema: req.change.schema_name, table: req.change.table };
      emitObjectsChanged(target);
      emitDataChanged(target);
      req.onApplied?.();
      close();
    } catch (e) {
      const msg = (e as Error).message;
      log({ level: "error", message: `${req.title} failed`, detail: msg, connectionName: conn?.name });
      if (e instanceof ApiError && e.status === 409) {
        // The SQL drifted since preview (e.g. structure changed elsewhere): show the new statements.
        toast.warning("The generated SQL changed; review it again.");
        setPreview(null);
        setConfirmed(false);
        api.schema.preview(req.connectionId, req.database, req.change).then(setPreview).catch((err) => setError((err as Error).message));
      } else {
        setError(msg);
      }
    } finally {
      setApplying(false);
    }
  }

  const sql = preview?.statements.map((s) => s.trimEnd().replace(/;$/, "") + ";").join("\n\n") ?? "";

  return (
    <Dialog open onOpenChange={(o) => !o && !applying && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{req.title}</DialogTitle>
          <DialogDescription>
            Review the SQL that will run on <span className="font-medium text-foreground">{conn?.name ?? "this connection"}</span>
            {req.database ? <> · <span className="font-mono">{req.database}</span></> : null}.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          {!preview && !error && (
            <div className="flex h-28 items-center justify-center rounded-md border bg-surface text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}
          {preview && (
            <>
              <pre className="max-h-[45vh] overflow-auto rounded-md border bg-surface p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap">{sql}</pre>
              <Button variant="ghost" size="icon-xs" className="absolute top-1.5 right-1.5" onClick={() => copyText(sql, "SQL copied")} aria-label="Copy SQL">
                <Copy />
              </Button>
            </>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-2.5 text-[12px] text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {preview && (
          <div className="space-y-2 text-[12px]">
            {!preview.transactional && preview.statements.length > 1 && (
              <p className="flex items-start gap-2 text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                This engine does not support transactional DDL. If a statement fails, earlier ones stay applied.
              </p>
            )}
            {conn?.read_only && (
              <p className="flex items-start gap-2 text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                This connection is read-only. Copy the SQL to run it elsewhere.
              </p>
            )}
            {destructive && !conn?.read_only && (
              <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-2.5">
                <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
                <span>
                  <span className="font-medium text-destructive">This change is destructive.</span> Data or objects will be removed permanently. I have reviewed the SQL above.
                </span>
              </label>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={applying}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={() => void apply()} disabled={blocked}>
            {applying ? <Loader2 className="animate-spin" /> : <Check />} Apply
            {preview && preview.statements.length > 1 ? ` ${preview.statements.length} statements` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

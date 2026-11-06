"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, FileUp, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { emitDataChanged, emitObjectsChanged } from "@/lib/events";
import { formatBytes, formatNumber } from "@/lib/format";
import type { CatalogTable } from "@/lib/types";
import { cn } from "@/lib/utils";
import { connectionById, useConnections } from "@/stores/connections";
import { useResults } from "@/stores/results";
import { useUi } from "@/stores/ui";

type Format = "csv" | "json" | "sql";
const MAX_BYTES = 50 * 1024 * 1024; // mirrors backend max_import_bytes

export function ImportDialog() {
  const target = useUi((s) => s.importDialog);
  return target ? <Inner key={`${target.connectionId}:${target.database}:${target.schema}:${target.table}`} {...target} /> : null;
}

function detectFormat(name: string): Format | null {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "csv" ? "csv" : ext === "json" ? "json" : ext === "sql" ? "sql" : null;
}

function Inner({ connectionId, database, schema, table }: { connectionId: string; database: string | null; schema: string | null; table: string | null }) {
  const conn = connectionById(connectionId);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<Format>(table ? "csv" : "sql");
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [catalog, setCatalog] = useState<CatalogTable[] | null>(null);
  const [targetKey, setTargetKey] = useState(table ? `${schema ?? ""}\u0000${table}` : "");
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => !busy && useUi.getState().setImportDialog(null);

  useEffect(() => {
    useConnections.getState().loadCatalog(connectionId, database).then(setCatalog).catch(() => setCatalog([]));
  }, [connectionId, database]);

  const tables = useMemo(() => (catalog ?? []).filter((t) => t.kind === "table"), [catalog]);
  const keyOf = (t: { schema_name: string | null; name: string }) => `${t.schema_name ?? ""}\u0000${t.name}`;
  const [targetSchema, targetTable] = targetKey ? (targetKey.split("\u0000") as [string, string]) : ["", ""];
  const targetInfo = tables.find((t) => keyOf(t) === targetKey);

  // Peek at the CSV header row so the user can check it lines up with the table.
  useEffect(() => {
    if (!file || format !== "csv") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- derived from file selection
      setHeaders(null);
      return;
    }
    let alive = true;
    file.slice(0, 64 * 1024).text().then((t) => {
      if (!alive) return;
      const first = t.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
      setHeaders(parseCsvLine(first));
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [file, format]);

  function pick(f: File | null | undefined) {
    if (!f) return;
    setError(null);
    if (f.size > MAX_BYTES) {
      setError(`File is ${formatBytes(f.size)}; the limit is ${formatBytes(MAX_BYTES)}.`);
      return;
    }
    setFile(f);
    const det = detectFormat(f.name);
    if (det) setFormat(det);
  }

  const tableColumns = targetInfo?.columns.map(([n]) => n) ?? [];
  const unknownHeaders = headers && tableColumns.length ? headers.filter((h) => !tableColumns.includes(h)) : [];
  const needsTable = format !== "sql";
  const ready = !!file && (!needsTable || !!targetTable) && !conn?.read_only;

  async function submit() {
    if (!file || !ready) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("format", format);
    if (database) form.set("database", database);
    if (needsTable) {
      if (targetSchema) form.set("schema_name", targetSchema);
      form.set("table", targetTable);
      form.set("empty_as_null", String(emptyAsNull));
    }
    try {
      const res = await api.io.import(connectionId, form);
      const msg = format === "sql" ? `Ran ${res.statements} statement(s) · ${formatNumber(res.rows)} row(s) affected` : `Imported ${formatNumber(res.rows)} row(s) into ${targetTable}`;
      toast.success(msg);
      useResults.getState().log({ level: "success", message: msg, detail: file.name, connectionName: conn?.name });
      if (format === "sql") {
        // A script can touch anything: refresh every view of this connection.
        useConnections.getState().invalidateCatalog(connectionId);
        emitObjectsChanged({ connectionId });
        emitDataChanged({ connectionId });
      } else {
        emitDataChanged({ connectionId, database, schema: targetSchema || null, table: targetTable });
      }
      useUi.getState().setImportDialog(null);
    } catch (e) {
      const m = (e as Error).message;
      setError(m);
      useResults.getState().log({ level: "error", message: `Import of ${file.name} failed`, detail: m, connectionName: conn?.name });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Import data</DialogTitle>
            <DialogDescription>
              {conn?.name}
              {database ? ` · ${database}` : ""}. CSV and JSON rows are inserted into a table; SQL files are executed as a script.
            </DialogDescription>
          </DialogHeader>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]); }}
            className={cn("rounded-md border border-dashed p-4 text-center transition-colors", dragging ? "border-primary bg-primary/8" : "bg-surface")}
          >
            <input ref={inputRef} type="file" accept=".csv,.json,.sql,text/csv,application/json,application/sql" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
            {file ? (
              <div className="flex items-center justify-center gap-2 text-[13px]">
                <FileUp className="size-4 text-primary" />
                <span className="truncate font-medium">{file.name}</span>
                <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ""; }} aria-label="Remove file"><X /></Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Upload className="mx-auto size-5 text-muted-foreground" />
                <p className="text-[13px]">Drop a file here or <button type="button" className="text-primary hover:underline" onClick={() => inputRef.current?.click()}>browse</button></p>
                <p className="text-[11px] text-muted-foreground">.csv, .json or .sql · UTF-8 · up to {formatBytes(MAX_BYTES)}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-[120px_1fr] gap-3">
            <div className="space-y-1.5">
              <Label>Format</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="sql">SQL script</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {needsTable && (
              <div className="min-w-0 space-y-1.5">
                <Label>Target table</Label>
                <Select value={targetKey} onValueChange={setTargetKey}>
                  <SelectTrigger className="w-full font-mono"><SelectValue placeholder={catalog ? "Choose a table" : "Loading tables…"} /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {tables.map((t) => (
                      <SelectItem key={keyOf(t)} value={keyOf(t)} className="font-mono text-[12px]">
                        {t.schema_name && conn?.capabilities.schemas ? `${t.schema_name}.` : ""}{t.name}
                      </SelectItem>
                    ))}
                    {targetKey && !targetInfo && <SelectItem value={targetKey} className="font-mono text-[12px]">{targetTable}</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {format === "csv" && (
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={emptyAsNull} onCheckedChange={(v) => setEmptyAsNull(v === true)} /> Treat empty cells as NULL
            </label>
          )}
          {format === "json" && <p className="text-[12px] text-muted-foreground">Expects an array of objects whose keys are column names.</p>}
          {format === "csv" && <p className="text-[12px] text-muted-foreground">The first row must contain column names. Columns not in the file get their default value.</p>}

          {headers && headers.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">Columns in file</p>
              <div className="flex flex-wrap gap-1">
                {headers.map((h, i) => (
                  <span key={i} className={cn("rounded border px-1.5 font-mono text-[11px]", unknownHeaders.includes(h) && "border-destructive/50 bg-destructive/8 text-destructive")}>{h || "(empty)"}</span>
                ))}
              </div>
              {unknownHeaders.length > 0 && <p className="text-[11px] text-destructive">Highlighted columns do not exist in {targetTable}; the import will fail.</p>}
            </div>
          )}

          {format === "sql" && (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/8 p-2.5 text-[12px]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              Every statement in the file runs as-is, including DROP or DELETE. Review the script before importing.
            </p>
          )}
          {conn?.read_only && <p className="text-[12px] text-warning">This connection is read-only.</p>}
          {error && <p className="rounded-md border border-destructive/40 bg-destructive/8 p-2.5 text-[12px] break-words text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={!ready || busy}>{busy ? <Loader2 className="animate-spin" /> : <Upload />} Import</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Minimal CSV line parser for the header preview (handles quotes and escaped quotes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ColumnDef } from "@/lib/types";
import { connectionById } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { ColumnListEditor } from "./column-editor";
import { IDENT_HINT, blankColumn, defaultIdColumn, normalizeColumn } from "./column-types";

export function CreateTableDialog() {
  const target = useUi((s) => s.createTable);
  return target ? <Inner key={`${target.connectionId}:${target.database}:${target.schema}`} {...target} /> : null;
}

function Inner({ connectionId, database, schema }: { connectionId: string; database: string | null; schema: string | null }) {
  const conn = connectionById(connectionId);
  const engine = conn?.engine ?? "postgresql";
  const [name, setName] = useState("");
  const [schemaName, setSchemaName] = useState(schema ?? (engine === "postgresql" ? "public" : ""));
  const [ifNotExists, setIfNotExists] = useState(false);
  const [columns, setColumns] = useState<ColumnDef[]>(() => [defaultIdColumn(engine), { ...blankColumn(engine), name: "name" }]);
  const close = () => useUi.getState().setCreateTable(null);

  const cleaned = columns.map(normalizeColumn);
  const names = cleaned.map((c) => c.name);
  const problem =
    !name.trim() ? "Enter a table name."
    : cleaned.some((c) => !c.name) ? "Every column needs a name."
    : cleaned.some((c) => !c.type) ? "Every column needs a type."
    : new Set(names).size !== names.length ? "Column names must be unique."
    : null;

  function review() {
    if (problem || !conn) return;
    const table = name.trim();
    const schemaValue = conn.capabilities.schemas ? schemaName.trim() || null : null;
    useUi.getState().requestSchemaChange({
      connectionId,
      database,
      title: `Create table ${table}`,
      change: { schema_name: schemaValue, table, operations: [{ op: "create_table", columns: cleaned, if_not_exists: ifNotExists }] },
      onApplied: () => {
        close();
        useWorkspace.getState().openTable({ connectionId, database, schema: schemaValue, table, objectKind: "table", view: "structure" });
      },
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-3xl">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            review();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create table</DialogTitle>
            <DialogDescription>
              {conn?.name}
              {database ? ` · ${database}` : ""}. You will see the generated SQL before anything runs.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3">
            {conn?.capabilities.schemas && (
              <div className="w-44 space-y-1.5">
                <Label htmlFor="ct-schema">Schema</Label>
                <Input id="ct-schema" value={schemaName} onChange={(e) => setSchemaName(e.target.value)} className="font-mono" />
              </div>
            )}
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="ct-name">Table name</Label>
              <Input id="ct-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="customers" className="font-mono" title={IDENT_HINT} />
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Columns</Label>
              <Button type="button" variant="ghost" size="xs" onClick={() => setColumns((c) => [...c, blankColumn(engine)])}><Plus /> Add column</Button>
            </div>
            <ColumnListEditor engine={engine} columns={columns} onChange={setColumns} />
            <p className="text-[11px] text-muted-foreground">Defaults are SQL expressions, so quote string literals: <code className="font-mono">&apos;draft&apos;</code>, <code className="font-mono">now()</code>.</p>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox checked={ifNotExists} onCheckedChange={(v) => setIfNotExists(v === true)} /> Skip if the table already exists (IF NOT EXISTS)
          </label>
          <DialogFooter className="items-center">
            {problem && name && <span className="mr-auto text-[12px] text-muted-foreground">{problem}</span>}
            <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={!!problem || conn?.read_only}>Review SQL</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

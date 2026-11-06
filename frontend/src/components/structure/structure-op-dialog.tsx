"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CatalogTable, ColumnDef, ColumnInfo, Connection, FkAction, SchemaOp, TableStructure } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { TypeSuggestions } from "./column-editor";
import { FK_ACTIONS, IDENT_HINT, blankColumn, normalizeColumn } from "./column-types";

export type OpRequest =
  | { kind: "add_column" }
  | { kind: "rename_column"; column: ColumnInfo }
  | { kind: "alter_column"; column: ColumnInfo }
  | { kind: "create_index"; column?: ColumnInfo }
  | { kind: "add_foreign_key" }
  | { kind: "add_unique" }
  | { kind: "add_check" }
  | { kind: "rename_table" };

interface Props {
  request: OpRequest;
  conn: Connection;
  database: string | null;
  schema: string | null;
  table: string;
  structure: TableStructure;
  onClose: () => void;
}

const TITLES: Record<OpRequest["kind"], string> = {
  add_column: "Add column",
  rename_column: "Rename column",
  alter_column: "Change column",
  create_index: "Add index",
  add_foreign_key: "Add foreign key",
  add_unique: "Add unique constraint",
  add_check: "Add check constraint",
  rename_table: "Rename table",
};

/** Small forms that each produce one schema operation, which then goes to the SQL review dialog. */
export function StructureOpDialog(props: Props) {
  const { request, conn, database, schema, table, onClose } = props;
  const [built, setBuilt] = useState<{ title: string; op: SchemaOp } | null>(null);

  function review() {
    if (!built) return;
    const { op, title } = built;
    useUi.getState().requestSchemaChange({
      connectionId: conn.id,
      database,
      title,
      change: { schema_name: schema, table, operations: [op] },
      onApplied: () => {
        onClose();
        if (op.op === "rename_table") {
          const ws = useWorkspace.getState();
          ws.close(`table:${conn.id}:${database ?? ""}:${schema ?? ""}:${table}`);
          ws.openTable({ connectionId: conn.id, database, schema, table: op.new_name, objectKind: "table", view: "structure" });
        }
      },
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn(request.kind === "add_foreign_key" ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            review();
          }}
        >
          <DialogHeader>
            <DialogTitle>{TITLES[request.kind]}</DialogTitle>
            <DialogDescription className="font-mono">{schema ? `${schema}.` : ""}{table}</DialogDescription>
          </DialogHeader>
          <OpForm {...props} onBuilt={setBuilt} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!built}>Review SQL</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type FormProps = Props & { onBuilt: (b: { title: string; op: SchemaOp } | null) => void };

function OpForm(p: FormProps) {
  switch (p.request.kind) {
    case "add_column":
      return <AddColumnForm {...p} />;
    case "rename_column":
      return <RenameForm label="New column name" initial={p.request.column.name} onBuilt={(n) => p.onBuilt(n ? { title: `Rename column ${(p.request as { column: ColumnInfo }).column.name} → ${n}`, op: { op: "rename_column", column: (p.request as { column: ColumnInfo }).column.name, new_name: n } } : null)} />;
    case "rename_table":
      return <RenameForm label="New table name" initial={p.table} onBuilt={(n) => p.onBuilt(n ? { title: `Rename table ${p.table} → ${n}`, op: { op: "rename_table", new_name: n } } : null)} />;
    case "alter_column":
      return <AlterColumnForm {...p} column={p.request.column} />;
    case "create_index":
      return <IndexForm {...p} initialColumn={p.request.column?.name} />;
    case "add_unique":
      return <UniqueForm {...p} />;
    case "add_check":
      return <CheckForm {...p} />;
    case "add_foreign_key":
      return <ForeignKeyForm {...p} />;
  }
}

// ---- individual forms

function useEmit<T>(value: T, build: (v: T) => { title: string; op: SchemaOp } | null, onBuilt: FormProps["onBuilt"]) {
  const key = JSON.stringify(value);
  useEffect(() => {
    onBuilt(build(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only when the form value changes
  }, [key]);
}

function AddColumnForm({ conn, structure, onBuilt }: FormProps) {
  const [col, setCol] = useState<ColumnDef>(() => blankColumn(conn.engine));
  const listId = useId();
  const taken = new Set(structure.columns.map((c) => c.name));
  useEmit(col, (c) => {
    const n = normalizeColumn(c);
    if (!n.name || !n.type || taken.has(n.name)) return null;
    return { title: `Add column ${n.name}`, op: { op: "add_column", column: n } };
  }, onBuilt);
  const dupe = taken.has(col.name.trim());
  return (
    <div className="space-y-3">
      <TypeSuggestions id={listId} engine={conn.engine} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" error={dupe ? "A column with this name exists" : undefined}>
          <Input autoFocus value={col.name} onChange={(e) => setCol({ ...col, name: e.target.value })} className="font-mono" placeholder="column_name" title={IDENT_HINT} />
        </Field>
        <Field label="Type">
          <Input value={col.type} list={listId} onChange={(e) => setCol({ ...col, type: e.target.value })} className="font-mono" />
        </Field>
      </div>
      <Field label="Default" hint="SQL expression, e.g. 0, 'draft', now()">
        <Input value={col.default ?? ""} onChange={(e) => setCol({ ...col, default: e.target.value })} className="font-mono" placeholder="none" />
      </Field>
      <div className="flex flex-wrap gap-4 text-[13px]">
        <Check checked={col.nullable} onChange={(v) => setCol({ ...col, nullable: v })}>Allow NULL</Check>
        <Check checked={!!col.unique} onChange={(v) => setCol({ ...col, unique: v })}>Unique</Check>
      </div>
      {!col.nullable && !col.default?.trim() && structure.row_estimate !== 0 && (
        <p className="text-[12px] text-muted-foreground">Adding a NOT NULL column without a default fails if the table already has rows.</p>
      )}
    </div>
  );
}

function RenameForm({ label, initial, onBuilt }: { label: string; initial: string; onBuilt: (name: string | null) => void }) {
  const [name, setName] = useState(initial);
  useEffect(() => {
    const n = name.trim();
    onBuilt(n && n !== initial ? n : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild on input only
  }, [name]);
  return (
    <Field label={label}>
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} className="font-mono" title={IDENT_HINT} />
    </Field>
  );
}

function AlterColumnForm({ conn, column, onBuilt }: FormProps & { column: ColumnInfo }) {
  const [type, setType] = useState(column.data_type);
  const [nullable, setNullable] = useState(column.nullable);
  const [def, setDef] = useState(column.default ?? "");
  const listId = useId();
  useEmit({ type, nullable, def }, (v) => {
    const op: Extract<SchemaOp, { op: "alter_column" }> = { op: "alter_column", column: column.name };
    if (v.type.trim() && v.type.trim() !== column.data_type) op.type = v.type.trim();
    if (v.nullable !== column.nullable) op.nullable = v.nullable;
    const d = v.def.trim();
    if (d !== (column.default ?? "")) {
      if (d) op.default = d;
      else op.drop_default = true;
    }
    return Object.keys(op).length > 2 ? { title: `Change column ${column.name}`, op } : null;
  }, onBuilt);
  return (
    <div className="space-y-3">
      <TypeSuggestions id={listId} engine={conn.engine} />
      <Field label="Type" hint={type.trim() !== column.data_type ? "Changing the type rewrites the column; existing values must convert cleanly." : undefined}>
        <Input autoFocus value={type} list={listId} onChange={(e) => setType(e.target.value)} className="font-mono" />
      </Field>
      <Field label="Default" hint="Leave empty to remove the default.">
        <Input value={def} onChange={(e) => setDef(e.target.value)} className="font-mono" placeholder="none" />
      </Field>
      <Check checked={nullable} onChange={setNullable} disabled={column.is_primary_key}>Allow NULL</Check>
    </div>
  );
}

function IndexForm({ structure, table, initialColumn, onBuilt }: FormProps & { initialColumn?: string }) {
  const [columns, setColumns] = useState<string[]>(initialColumn ? [initialColumn] : []);
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const auto = `${unique ? "ux" : "ix"}_${table}_${columns.join("_")}`.slice(0, 63);
  const finalName = touched ? name.trim() : auto;
  useEmit({ columns, unique, finalName }, (v) =>
    v.columns.length && v.finalName ? { title: `Create ${v.unique ? "unique " : ""}index ${v.finalName}`, op: { op: "create_index", name: v.finalName, columns: v.columns, unique: v.unique } } : null,
  onBuilt);
  return (
    <div className="space-y-3">
      <Field label="Columns" hint="Click in the order the index should use.">
        <ColumnPicker options={structure.columns.map((c) => c.name)} value={columns} onChange={setColumns} />
      </Field>
      <Field label="Index name">
        <Input value={touched ? name : auto} onChange={(e) => { setTouched(true); setName(e.target.value); }} className="font-mono" />
      </Field>
      <Check checked={unique} onChange={setUnique}>Unique</Check>
    </div>
  );
}

function UniqueForm({ structure, table, onBuilt }: FormProps) {
  const [columns, setColumns] = useState<string[]>([]);
  const [name, setName] = useState("");
  const finalName = name.trim() || `uq_${table}_${columns.join("_")}`.slice(0, 63);
  useEmit({ columns, finalName }, (v) => (v.columns.length ? { title: `Add unique constraint ${v.finalName}`, op: { op: "add_unique", name: v.finalName, columns: v.columns } } : null), onBuilt);
  return (
    <div className="space-y-3">
      <Field label="Columns">
        <ColumnPicker options={structure.columns.map((c) => c.name)} value={columns} onChange={setColumns} />
      </Field>
      <Field label="Constraint name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={finalName} className="font-mono" />
      </Field>
    </div>
  );
}

function CheckForm({ table, onBuilt }: FormProps) {
  const [name, setName] = useState(`ck_${table}_`);
  const [expr, setExpr] = useState("");
  useEmit({ name, expr }, (v) => (v.name.trim() && v.expr.trim() ? { title: `Add check constraint ${v.name.trim()}`, op: { op: "add_check", name: v.name.trim(), expression: v.expr.trim() } } : null), onBuilt);
  return (
    <div className="space-y-3">
      <Field label="Constraint name">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
      </Field>
      <Field label="Expression" hint="Must hold for every existing row, e.g. price >= 0">
        <Input autoFocus value={expr} onChange={(e) => setExpr(e.target.value)} className="font-mono" placeholder="price >= 0" />
      </Field>
    </div>
  );
}

function ForeignKeyForm({ conn, database, schema, table, structure, onBuilt }: FormProps) {
  const [catalog, setCatalog] = useState<CatalogTable[] | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [refKey, setRefKey] = useState<string>("");
  const [refColumns, setRefColumns] = useState<string[]>([]);
  const [onDelete, setOnDelete] = useState<FkAction>("NO ACTION");
  const [onUpdate, setOnUpdate] = useState<FkAction>("NO ACTION");
  const [name, setName] = useState("");

  useEffect(() => {
    useConnections.getState().loadCatalog(conn.id, database).then(setCatalog).catch(() => setCatalog([]));
  }, [conn.id, database]);

  const tables = useMemo(() => (catalog ?? []).filter((t) => t.kind === "table"), [catalog]);
  const keyOf = (t: CatalogTable) => `${t.schema_name ?? ""}\u0000${t.name}`;
  const ref = tables.find((t) => keyOf(t) === refKey);
  const finalName = name.trim() || (ref ? `fk_${table}_${ref.name}`.slice(0, 63) : "");

  useEmit({ columns, refKey, refColumns, onDelete, onUpdate, finalName }, (v) => {
    if (!ref || !v.columns.length || v.columns.length !== v.refColumns.length || !v.finalName) return null;
    return {
      title: `Add foreign key ${v.finalName}`,
      op: {
        op: "add_foreign_key", name: v.finalName, columns: v.columns, ref_schema: ref.schema_name, ref_table: ref.name, ref_columns: v.refColumns,
        on_delete: v.onDelete, on_update: v.onUpdate,
      },
    };
  }, onBuilt);

  return (
    <div className="space-y-3">
      <Field label="Columns in this table">
        <ColumnPicker options={structure.columns.map((c) => c.name)} value={columns} onChange={setColumns} />
      </Field>
      <Field label="Referenced table">
        <Select value={refKey} onValueChange={(v) => { setRefKey(v); setRefColumns([]); }}>
          <SelectTrigger className="w-full font-mono"><SelectValue placeholder={catalog ? "Choose a table" : "Loading tables…"} /></SelectTrigger>
          <SelectContent className="max-h-72">
            {tables.map((t) => (
              <SelectItem key={keyOf(t)} value={keyOf(t)} className="font-mono text-[12px]">
                {t.schema_name && t.schema_name !== schema ? `${t.schema_name}.` : ""}{t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {ref && (
        <Field label="Referenced columns" hint={columns.length !== refColumns.length ? `Pick ${columns.length || "the same number of"} column(s), in matching order.` : undefined}>
          <ColumnPicker options={ref.columns.map(([n]) => n)} value={refColumns} onChange={setRefColumns} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="On delete"><FkSelect value={onDelete} onChange={setOnDelete} /></Field>
        <Field label="On update"><FkSelect value={onUpdate} onChange={setOnUpdate} /></Field>
      </div>
      <Field label="Constraint name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={finalName || "fk_…"} className="font-mono" />
      </Field>
    </div>
  );
}

// ---- small building blocks

function FkSelect({ value, onChange }: { value: FkAction; onChange: (v: FkAction) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as FkAction)}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{FK_ACTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
    </Select>
  );
}

/** Ordered multi-select: click to add in order, click again to remove. */
function ColumnPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded-md border p-1.5">
      {options.map((o) => {
        const idx = value.indexOf(o);
        return (
          <button
            type="button"
            key={o}
            onClick={() => onChange(idx >= 0 ? value.filter((v) => v !== o) : [...value, o])}
            className={cn(
              "flex h-6 items-center gap-1 rounded border px-1.5 font-mono text-[11.5px] transition-colors",
              idx >= 0 ? "border-primary/50 bg-primary/12 text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {idx >= 0 && <span className="text-[10px] font-semibold text-primary">{idx + 1}</span>}
            {o}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label className={cn("flex items-center gap-2 text-[13px]", disabled && "opacity-50")}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} /> {children}
    </label>
  );
}
